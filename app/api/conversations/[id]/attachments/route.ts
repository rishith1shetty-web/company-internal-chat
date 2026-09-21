/**
 * Files in a conversation.
 *
 *   POST  /api/conversations/:id/attachments   upload a file and post it as a message
 *   GET   /api/conversations/:id/attachments   the Shared files panel
 *
 * THE UPLOAD IS A RAW BODY, NOT A MULTIPART FORM, and that is the central decision here.
 *
 * `request.formData()` reads the whole request into memory before the handler sees a byte of it,
 * so a 500 MB video would cost 500 MB of server memory per concurrent upload — several of those
 * at once is the server, not a slow request. Sending the file as the request body instead lets it
 * be piped straight to disk through a counter and a hash, so an upload of any size costs a
 * buffer's worth of memory (`lib/files/storage.ts`).
 *
 * It also removes the need for a multipart parser, which would be a new dependency doing nothing
 * this application needs (CLAUDE.md §3). The two things a form would have carried travel as
 * headers instead: the filename, percent-encoded because a header cannot hold arbitrary Unicode,
 * and the idempotency key.
 *
 * ORDER OF OPERATIONS, which is what keeps storage and the database consistent:
 *
 *   authorize → stream to a temporary file, counting → move into place → write both rows in one
 *   transaction → notify. A failure at any step leaves nothing behind: before the move there is
 *   only a temporary file that is deleted, and after it a failed transaction deletes the stored
 *   file before answering. There is no state in which a row points at a file that is not there,
 *   or a file exists that no row will ever name.
 */

import { Readable } from 'node:stream';

import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { AttachmentWire, ConversationAttachmentsWire, MessageWire } from '@/lib/chat/wire';
import { getDb } from '@/lib/db/prisma';
import {
  AttachmentError,
  MAX_FILENAME_LENGTH,
  SIGNATURE_BYTES,
  createAttachmentMessage,
  detectContentType,
  extensionOf,
  listConversationAttachments,
  sanitizeFilename,
} from '@/lib/files/service';
import {
  StorageError,
  deleteStoredFile,
  ensureStorageReady,
  generateStorageKey,
  storeStream,
} from '@/lib/files/storage';
import { MAX_MESSAGE_LENGTH } from '@/lib/messages/service';
import {
  apiError,
  forbidden,
  internalError,
  invalidRequest,
  routeLogger as logger,
  storageConfig,
  withIdentity,
} from '@/lib/http/route-helpers';
import { toMessageWire } from '@/lib/realtime/events';
import { notifyMessagePosted } from '@/lib/realtime/notify';

export const dynamic = 'force-dynamic';

const uuid = z.uuid({ version: 'v4' });

/** Header names. Lower-case because that is how they arrive. */
const FILENAME_HEADER = 'x-filename';
const CLIENT_MESSAGE_ID_HEADER = 'x-client-message-id';
const CAPTION_HEADER = 'x-caption';

/**
 * Reads a percent-encoded header value.
 *
 * Filenames and captions are Unicode and headers are not, so both are sent percent-encoded. A
 * value that will not decode is treated as absent rather than as an error: it is the client's
 * mistake, the filename is a label, and there is a sane fallback for it.
 */
function decodeHeader(value: string | null): string | undefined {
  if (value === null || value.length === 0) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withIdentity(request, async (current) => {
    const { id: conversationId } = await context.params;
    if (!uuid.safeParse(conversationId).success) {
      return invalidRequest('That conversation is not valid.');
    }

    const clientMessageId = request.headers.get(CLIENT_MESSAGE_ID_HEADER);
    if (!clientMessageId || !uuid.safeParse(clientMessageId).success) {
      return invalidRequest('That upload could not be identified.');
    }

    const caption = decodeHeader(request.headers.get(CAPTION_HEADER));
    if (caption !== undefined && caption.length > MAX_MESSAGE_LENGTH) {
      return invalidRequest('That message is too long to send with the file.');
    }

    const filename = sanitizeFilename(
      (decodeHeader(request.headers.get(FILENAME_HEADER)) ?? '').slice(0, MAX_FILENAME_LENGTH * 4),
    );

    if (!request.body) return invalidRequest('No file was received.');

    const db = getDb();
    const config = storageConfig;

    /*
     * Authorize BEFORE reading a byte.
     *
     * Not merely tidy: it means somebody with no access to a conversation cannot make the server
     * write 500 MB to its disk before being told no. The membership check is repeated inside
     * `createAttachmentMessage`, which is the one that actually guards the write.
     */
    const membership = await db.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId: current.userId } },
      select: { leftAt: true },
    });
    if (!membership || membership.leftAt !== null) return forbidden();

    try {
      await ensureStorageReady(config);
    } catch (error) {
      // A missing or unwritable storage directory is an operator problem, and the message the
      // employee sees says nothing about paths (CLAUDE.md §13).
      logger.error('File storage is not usable', {
        error: error instanceof Error ? error.message : 'unknown',
      });
      return apiError(503, 'STORAGE_UNAVAILABLE', 'File storage is not available right now.');
    }

    const storageKey = generateStorageKey();

    // The first bytes, kept for content-type detection. Bounded to a few dozen bytes, so this is
    // not a buffer of the file — it is a glimpse of its head as it goes past.
    let head = Buffer.alloc(0);

    let stored;
    try {
      stored = await storeStream(
        config,
        storageKey,
        Readable.fromWeb(request.body as never).map((chunk: Buffer) => {
          if (head.length < SIGNATURE_BYTES) {
            head = Buffer.concat([head, chunk]).subarray(0, SIGNATURE_BYTES);
          }
          return chunk;
        }),
      );
    } catch (error) {
      if (error instanceof StorageError && error.reason === 'TOO_LARGE') {
        return apiError(
          413,
          'FILE_TOO_LARGE',
          `That file is larger than the ${formatLimit(config.maxFileSize)} limit.`,
        );
      }

      logger.error('Upload failed while writing to storage', {
        userId: current.userId,
        conversationId,
        error: error instanceof Error ? error.message : 'unknown',
      });
      return apiError(500, 'UPLOAD_FAILED', 'The file could not be saved. Please try again.');
    }

    let result;
    try {
      result = await createAttachmentMessage(db, {
        uploaderId: current.userId,
        conversationId,
        clientMessageId,
        originalFilename: filename,
        storageKey,
        byteSize: stored.byteSize,
        mimeType: detectContentType(head),
        extension: extensionOf(filename),
        checksumSha256: stored.checksumSha256,
        body: caption,
      });
    } catch (error) {
      /*
       * The database refused after the bytes landed. Delete them: a stored file no row will ever
       * name is unreachable but not harmless — it is disk nobody will account for.
       */
      await deleteStoredFile(config, storageKey);

      if (error instanceof AttachmentError && error.reason === 'NOT_A_MEMBER') return forbidden();

      logger.error('Upload stored but could not be recorded', {
        userId: current.userId,
        conversationId,
        error: error instanceof Error ? error.message : 'unknown',
      });
      return internalError();
    }

    if (result.duplicate) {
      /*
       * A retry of an upload that already succeeded — the same idempotency key. The stored
       * message is the right answer, and the bytes just uploaded are a second copy of a file that
       * is already saved, so they are removed rather than left orphaned. Nothing is broadcast a
       * second time.
       */
      await deleteStoredFile(config, storageKey);
      logger.debug('Duplicate upload suppressed', { userId: current.userId, conversationId });
    } else {
      const wire = toMessageWire(
        { ...result.message, attachment: result.attachment },
        result.viewerJoinedAt,
      );

      /*
       * Metadata only. The bytes never travel over the socket — they are fetched over HTTP by
       * whoever chooses to download the file, through an endpoint that authorizes them again.
       */
      notifyMessagePosted({
        conversationId,
        senderId: current.userId,
        message: wire,
      });

      logger.info('File uploaded', {
        conversationId,
        attachmentId: result.attachment.id,
        byteSize: stored.byteSize,
      });
    }

    return NextResponse.json(
      toMessageWire(
        { ...result.message, attachment: result.attachment },
        result.viewerJoinedAt,
      ) satisfies MessageWire,
      { status: result.duplicate ? 200 : 201 },
    );
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withIdentity(request, async (current) => {
    const { id } = await context.params;
    if (!uuid.safeParse(id).success) return invalidRequest('That conversation is not valid.');

    try {
      const attachments = await listConversationAttachments(getDb(), current.userId, id);

      return NextResponse.json({
        attachments: attachments.map((attachment) => ({
          id: attachment.id,
          filename: attachment.originalFilename,
          byteSize: attachment.byteSize.toString(),
          mimeType: attachment.mimeType,
          extension: attachment.extension,
          createdAt: attachment.createdAt.toISOString(),
          uploaderId: attachment.uploaderId,
          messageId: attachment.messageId,
        })) satisfies (AttachmentWire & { uploaderId: string | null; messageId: string | null })[],
      } satisfies ConversationAttachmentsWire);
    } catch (error) {
      if (error instanceof AttachmentError && error.reason === 'NOT_A_MEMBER') return forbidden();
      throw error;
    }
  });
}

/** "500 MB" from a byte count, for a message an employee reads. */
function formatLimit(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 1024
    ? `${(megabytes / 1024).toFixed(megabytes % 1024 === 0 ? 0 : 1)} GB`
    : `${Math.round(megabytes)} MB`;
}
