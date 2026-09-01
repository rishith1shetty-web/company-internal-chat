/**
 * Attachment service — filenames, content types, and who may see which file.
 *
 * The business rule this phase is built around: **the company transfers arbitrary files.**
 * Documents, spreadsheets, video, archives, database dumps, source, screenshots, and formats
 * nobody here has heard of. So there is no extension allowlist and no MIME allowlist, and an
 * unfamiliar file is not a suspicious one — it is Tuesday.
 *
 * That is not a relaxation of security, because an allowlist was never the control. An extension
 * is a string the sender chose; a `Content-Type` header is a string the sender's browser chose.
 * Neither is evidence, and a system whose safety depends on either is unsafe for the files it
 * *does* accept. Safety here comes from what the server refuses to do with the bytes:
 *
 *   - never execute them, never import them, never pass them to a shell
 *   - never derive a filesystem path from anything the client sent (lib/files/storage.ts)
 *   - never serve them inline, and never with a type the browser might act on
 *   - never let anyone read one without checking the conversation it belongs to, on every request
 *
 * A file is a sequence of bytes with a row in PostgreSQL. Everything else is metadata.
 */

import type { PrismaClient } from '../../prisma/generated/client';
import { Prisma } from '../../prisma/generated/client';
import { findActiveMembership } from '../authz/membership';

/** Prisma's unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

/** `Attachment.originalFilename` is varchar(255). */
export const MAX_FILENAME_LENGTH = 255;

/** `Attachment.extension` is varchar(16), including the dot-less form stored here. */
const MAX_EXTENSION_LENGTH = 16;

/** `Attachment.mimeType` is varchar(127). */
const MAX_MIME_LENGTH = 127;

/** What a file is called when the client sent nothing usable. */
const FALLBACK_FILENAME = 'file';

/**
 * The type recorded, and served, when the bytes are not recognised.
 *
 * Also the type every download is served as, whatever is stored here — see `downloadContentType`.
 */
export const BINARY_CONTENT_TYPE = 'application/octet-stream';

export type AttachmentFailure =
  | 'NOT_A_MEMBER'
  | 'ATTACHMENT_NOT_FOUND'
  | 'INVALID_FILENAME'
  | 'FILE_MISSING';

export class AttachmentError extends Error {
  readonly reason: AttachmentFailure;

  constructor(reason: AttachmentFailure, message: string) {
    super(message);
    this.name = 'AttachmentError';
    this.reason = reason;
  }
}

/* --------------------------------------------------------------------------------------------- */
/* Filenames                                                                                       */
/* --------------------------------------------------------------------------------------------- */

/*
 * Characters removed from a filename before it is stored.
 *
 * Control characters (which include CR and LF, the ones that would let a filename inject a
 * response header), the path separators of both platforms, and the drive-letter colon. What is
 * left is a display label, and it is displayed by React and encoded into the download header —
 * it is never a path, because nothing anywhere joins it onto a directory.
 */
const UNSAFE_FILENAME_CHARACTERS = /[\u0000-\u001F\u007F/\\:]/g;

/**
 * Reduces a client-supplied filename to something safe to store, show and put in a header.
 *
 * Deliberately NOT a rejection: a colleague whose file is called `Q3/Q4 summary.xlsx` should have
 * it arrive, not be told off. Unicode is preserved — staff名前, accents and emoji are ordinary in
 * real filenames, and the download header encodes them properly (RFC 5987).
 *
 * `..` is neutralised by removing separators rather than by pattern-matching traversal: a name
 * with no separator in it cannot describe a path however it is assembled, and there is nothing
 * left for a clever encoding to smuggle through. It is belt and braces regardless, because
 * `lib/files/storage.ts` never uses this value to build a path at all.
 */
export function sanitizeFilename(raw: unknown): string {
  if (typeof raw !== 'string') return FALLBACK_FILENAME;

  const cleaned = raw
    .replace(UNSAFE_FILENAME_CHARACTERS, '')
    // Collapse whitespace, including the tabs and newlines removed above.
    .replace(/\s+/g, ' ')
    // A leading dot hides the file on Unix listings; leading/trailing dots and spaces are also
    // where Windows filename edge cases live.
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, MAX_FILENAME_LENGTH)
    .trim();

  return cleaned.length > 0 ? cleaned : FALLBACK_FILENAME;
}

/**
 * The extension, lower-cased and without its dot, or an empty string.
 *
 * Recorded for display and for a future search, never for a decision. Nothing in this
 * application behaves differently because of it, which is why an unknown one is fine.
 */
export function extensionOf(filename: string): string {
  const index = filename.lastIndexOf('.');
  if (index <= 0 || index === filename.length - 1) return '';

  return filename
    .slice(index + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, MAX_EXTENSION_LENGTH);
}

/**
 * Encodes a filename for `Content-Disposition`.
 *
 * Both forms, as RFC 6266 advises: a quoted ASCII fallback for anything old, and `filename*`
 * with RFC 5987 percent-encoding for the real name. The ASCII form has quotes and backslashes
 * stripped rather than escaped — a filename cannot be allowed to close the quoted string and
 * append parameters of its own.
 */
export function contentDispositionFor(filename: string): string {
  const safe = sanitizeFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  const encoded = encodeURIComponent(safe);

  return `attachment; filename="${ascii || FALLBACK_FILENAME}"; filename*=UTF-8''${encoded}`;
}

/* --------------------------------------------------------------------------------------------- */
/* Content type                                                                                    */
/* --------------------------------------------------------------------------------------------- */

/**
 * Signatures recognised from a file's leading bytes.
 *
 * A short list on purpose. This exists so the interface can show a sensible label and icon, and
 * for nothing else: an upload is never accepted or refused on what it matches, and a download is
 * never served as what it matches. Adding a format here changes a label, never a permission.
 *
 * Matching on bytes rather than on the client's `Content-Type` because the latter is a claim, and
 * the value here is stored and displayed to other employees.
 */
const SIGNATURES: readonly { readonly type: string; readonly test: (head: Buffer) => boolean }[] = [
  { type: 'image/png', test: (h) => h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/jpeg', test: (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff },
  { type: 'image/gif', test: (h) => h.subarray(0, 6).toString('latin1').startsWith('GIF8') },
  { type: 'image/webp', test: (h) => h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP' },
  { type: 'image/bmp', test: (h) => h[0] === 0x42 && h[1] === 0x4d },
  { type: 'application/pdf', test: (h) => h.subarray(0, 5).toString('latin1') === '%PDF-' },
  // Office documents and many other formats are ZIP containers; the container is what is visible
  // from the first bytes, and that is all this claims to report.
  { type: 'application/zip', test: (h) => h[0] === 0x50 && h[1] === 0x4b && (h[2] === 0x03 || h[2] === 0x05 || h[2] === 0x07) },
  { type: 'application/x-rar-compressed', test: (h) => h.subarray(0, 6).toString('latin1') === 'Rar!\u001a\u0007' },
  { type: 'application/x-7z-compressed', test: (h) => h.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) },
  { type: 'application/gzip', test: (h) => h[0] === 0x1f && h[1] === 0x8b },
  { type: 'video/mp4', test: (h) => h.subarray(4, 8).toString('latin1') === 'ftyp' },
  { type: 'video/x-matroska', test: (h) => h.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) },
  { type: 'video/x-msvideo', test: (h) => h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'AVI ' },
  { type: 'audio/wav', test: (h) => h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WAVE' },
  { type: 'audio/mpeg', test: (h) => (h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) || (h[0] === 0xff && ((h[1] ?? 0) & 0xe0) === 0xe0) },
  { type: 'application/x-msdownload', test: (h) => h[0] === 0x4d && h[1] === 0x5a },
];

/** How many leading bytes are looked at. Every signature above fits well inside this. */
export const SIGNATURE_BYTES = 32;

/**
 * Best guess at what a file is, from its first bytes.
 *
 * Falls back to `application/octet-stream`, which is not a failure — it is the honest answer for
 * a format this application has no opinion about, and most of what a company sends is exactly
 * that. **This value never gates an upload and never becomes a download's `Content-Type`.**
 */
export function detectContentType(head: Buffer): string {
  if (head.length === 0) return BINARY_CONTENT_TYPE;

  for (const signature of SIGNATURES) {
    try {
      if (signature.test(head)) return signature.type.slice(0, MAX_MIME_LENGTH);
    } catch {
      // A short buffer can make a signature test read past the end. Not a match, not an error.
    }
  }

  return BINARY_CONTENT_TYPE;
}

/**
 * The `Content-Type` a download is served with, which is always the same one.
 *
 * Deliberately not the detected type. Phase 7 is download-only (D-10): nothing uploaded is ever
 * rendered inside the application, and serving a file as `image/svg+xml` or `text/html` is what
 * turns an uploaded file into stored XSS against a colleague. `application/octet-stream` plus
 * `Content-Disposition: attachment` plus `X-Content-Type-Options: nosniff` means the browser
 * saves the file and does not try to be helpful about it.
 *
 * Inline preview would need per-type decisions and an isolated origin, and is out of scope
 * (docs/04-security.md R-07).
 */
export function downloadContentType(): string {
  return BINARY_CONTENT_TYPE;
}

/* --------------------------------------------------------------------------------------------- */
/* Persistence                                                                                     */
/* --------------------------------------------------------------------------------------------- */

export interface AttachmentRecord {
  id: string;
  conversationId: string;
  messageId: string | null;
  uploaderId: string | null;
  originalFilename: string;
  storageKey: string;
  byteSize: bigint;
  mimeType: string;
  extension: string;
  createdAt: Date;
}

const attachmentSelection = {
  id: true,
  conversationId: true,
  messageId: true,
  uploaderId: true,
  originalFilename: true,
  storageKey: true,
  byteSize: true,
  mimeType: true,
  extension: true,
  createdAt: true,
} as const;

export interface CreateAttachmentInput {
  /** Server-derived, from the session. Never from the request body. */
  uploaderId: string;
  conversationId: string;
  /** Browser-minted idempotency key, exactly as for a text message. */
  clientMessageId: string;
  originalFilename: string;
  storageKey: string;
  /** Counted by the storage layer as the bytes arrived; never a client-supplied number. */
  byteSize: number;
  mimeType: string;
  extension: string;
  checksumSha256: string;
  /** Optional caption typed alongside the file. */
  body?: string | undefined;
}

export interface CreateAttachmentResult {
  message: {
    id: string;
    conversationId: string;
    senderId: string | null;
    clientMessageId: string;
    type: 'TEXT' | 'FILE' | 'SYSTEM';
    body: string | null;
    createdAt: Date;
  };
  attachment: AttachmentRecord;
  /** True when this matched an existing upload rather than creating one — a retried request. */
  duplicate: boolean;
}

/**
 * Records a stored file as a message in a conversation.
 *
 * Called only after the bytes are safely in permanent storage, and everything it writes goes in
 * one transaction: the `FILE` message, the `Attachment` row linked to it, and the conversation's
 * `lastMessageAt`. So there is no window in which a message exists without its attachment, or an
 * attachment exists without a message to authorize it through.
 *
 * The `PENDING` status in the schema anticipated a two-step upload — reserve a row, then fill it
 * in. Doing it in one step instead means there is no half-finished row to sweep up, so rows are
 * written `READY` and `PENDING` stays unused (docs/14-phase-7-file-transfer.md §5).
 *
 * Idempotency is the same guard text messages use: unique `(senderId, clientMessageId)`. A retry
 * after a dropped response finds the stored message instead of sending the file twice — and the
 * caller is told, so it can delete the bytes it just uploaded for nothing.
 */
export async function createAttachmentMessage(
  db: PrismaClient,
  input: CreateAttachmentInput,
): Promise<CreateAttachmentResult> {
  // Re-checked here, not taken on trust from the caller: this is the last point before the write.
  const membership = await findActiveMembership(db, input.uploaderId, input.conversationId);
  if (!membership) {
    throw new AttachmentError('NOT_A_MEMBER', 'You are not a member of this conversation.');
  }

  const caption = input.body?.trim();

  try {
    return await db.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          conversationId: input.conversationId,
          senderId: input.uploaderId,
          type: 'FILE',
          body: caption && caption.length > 0 ? caption : null,
          clientMessageId: input.clientMessageId,
        },
        select: {
          id: true,
          conversationId: true,
          senderId: true,
          clientMessageId: true,
          type: true,
          body: true,
          createdAt: true,
        },
      });

      const attachment = await tx.attachment.create({
        data: {
          conversationId: input.conversationId,
          messageId: message.id,
          uploaderId: input.uploaderId,
          originalFilename: input.originalFilename,
          storageKey: input.storageKey,
          byteSize: BigInt(input.byteSize),
          mimeType: input.mimeType,
          extension: input.extension,
          checksumSha256: input.checksumSha256,
          status: 'READY',
        },
        select: attachmentSelection,
      });

      await tx.conversation.update({
        where: { id: input.conversationId },
        data: { lastMessageAt: message.createdAt },
      });

      return { message, attachment, duplicate: false };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION) {
      const existing = await db.message.findUnique({
        where: {
          senderId_clientMessageId: {
            senderId: input.uploaderId,
            clientMessageId: input.clientMessageId,
          },
        },
        select: {
          id: true,
          conversationId: true,
          senderId: true,
          clientMessageId: true,
          type: true,
          body: true,
          createdAt: true,
          attachment: { select: attachmentSelection },
        },
      });

      if (existing?.attachment) {
        const { attachment, ...message } = existing;
        return { message, attachment, duplicate: true };
      }
    }

    throw error;
  }
}

/* --------------------------------------------------------------------------------------------- */
/* Authorization                                                                                   */
/* --------------------------------------------------------------------------------------------- */

export interface AuthorizedAttachment {
  attachment: AttachmentRecord;
  /** The message the file was sent as. Its `createdAt` is what D-03 is applied to. */
  messageCreatedAt: Date;
}

/**
 * Loads an attachment the caller is allowed to have, or refuses.
 *
 * **This is the function R-14 is about, and it has two checks rather than one.**
 *
 * Membership alone is not sufficient. A member added to a group today is a member of the
 * conversation every one of its older files belongs to, so a check that stopped at
 * `conversationId` would hand them every file ever shared in it — the exact leak D-03 closes for
 * messages, reopened by asking for the file instead of the message.
 *
 * So the attachment is authorized **through its message**: the message must exist, must belong to
 * a conversation the caller is an active member of, and must have been sent at or after the
 * caller's `joinedAt`. An attachment with no message is not downloadable by anyone.
 *
 * Every refusal is the same refusal. "No such attachment", "not your conversation" and "before
 * you joined" are one answer, because distinguishing them would confirm that an id exists and
 * roughly when — which is most of what an attacker guessing ids wants to learn.
 */
export async function loadAttachmentForDownload(
  db: PrismaClient,
  userId: string,
  attachmentId: string,
): Promise<AuthorizedAttachment> {
  // One refusal for every reason. Building it once keeps the checks below from drifting into
  // saying different things, which is how an endpoint becomes an oracle.
  const refused = new AttachmentError('ATTACHMENT_NOT_FOUND', 'That file is not available.');

  const attachment = await db.attachment.findUnique({
    where: { id: attachmentId },
    select: {
      ...attachmentSelection,
      status: true,
      message: { select: { conversationId: true, createdAt: true } },
    },
  });

  if (!attachment || attachment.status !== 'READY') throw refused;

  // An attachment with no message is not downloadable by anybody: the message is what carries the
  // authorization, so without one there is nothing to authorize against.
  const { message } = attachment;
  if (!message) throw refused;

  /*
   * The conversation comes from the MESSAGE, not from the attachment's own column.
   *
   * They agree today, and the transaction in `createAttachmentMessage` is what keeps them
   * agreeing. Reading it from the message anyway means the membership check and the `joinedAt`
   * comparison below are made against one row rather than two — so no future edit can make the
   * check pass for one conversation while the window is computed for another.
   */
  const membership = await findActiveMembership(db, userId, message.conversationId);
  if (!membership) throw refused;

  // D-03, and the whole reason this function exists rather than a membership check at the route.
  if (message.createdAt < membership.joinedAt) throw refused;

  return {
    // Rebuilt rather than spread: `status` and the joined message are working values, and an
    // explicit shape is what keeps them from travelling any further than this function.
    attachment: {
      id: attachment.id,
      conversationId: attachment.conversationId,
      messageId: attachment.messageId,
      uploaderId: attachment.uploaderId,
      originalFilename: attachment.originalFilename,
      storageKey: attachment.storageKey,
      byteSize: attachment.byteSize,
      mimeType: attachment.mimeType,
      extension: attachment.extension,
      createdAt: attachment.createdAt,
    },
    messageCreatedAt: message.createdAt,
  };
}

/**
 * Every file the caller may see in a conversation, newest first. Drives the Shared files panel.
 *
 * Bounded the same way and for the same reason: the join is onto the attachment's message, and
 * the window clause is on that message's `createdAt`. A newly added group member's list starts
 * where their history starts, so the panel cannot become a way to enumerate files they cannot
 * open — or to learn that they exist.
 */
export async function listConversationAttachments(
  db: PrismaClient,
  userId: string,
  conversationId: string,
  limit = 100,
): Promise<AttachmentRecord[]> {
  const membership = await findActiveMembership(db, userId, conversationId);
  if (!membership) {
    throw new AttachmentError('NOT_A_MEMBER', 'You do not have access to this conversation.');
  }

  return db.attachment.findMany({
    where: {
      conversationId,
      status: 'READY',
      message: { is: { createdAt: { gte: membership.joinedAt } } },
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(Math.trunc(limit), 1), 200),
    select: attachmentSelection,
  });
}
