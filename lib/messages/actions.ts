/**
 * Message actions — react, pin, delete, forward (Batch 1).
 *
 * Everything here mutates a message that already exists, which makes all of it a target for the
 * same attack: a valid session plus a message id guessed, copied from a screenshot, or kept from
 * a conversation the caller has since been removed from. So every function in this module starts
 * at `loadAccessibleMessage`, and none of them takes a conversation id from the caller — the
 * conversation is read from the message row, and the caller's membership of THAT conversation is
 * then proved from the database.
 *
 * THE THREE RULES, applied identically everywhere (docs/02-database.md, CLAUDE.md §9, §10):
 *
 *   1. The message must exist.
 *   2. The caller must be an ACTIVE member of its conversation — `leftAt IS NULL`, not merely a
 *      membership row.
 *   3. The message must be inside the caller's D-03 window: `createdAt >= joinedAt`. A member who
 *      joined a group today has no business reacting to, pinning, forwarding or quoting what was
 *      said before they arrived, and every one of those actions would otherwise disclose it.
 *
 * Failures are deliberately indistinguishable. "No such message", "not a member" and "before you
 * joined" all answer `NOT_ACCESSIBLE`, because distinguishing them turns this into an oracle for
 * which message ids exist.
 */

import { Prisma, type PrismaClient } from '../../prisma/generated/client';
import { findActiveMembership, type ActiveMembership } from '../authz/membership';
import {
  deleteStoredFile,
  generateStorageKey,
  openStoredFile,
  statStoredFile,
  storeStream,
  type StorageConfig,
  type StoredFile,
} from '../files/storage';
import { MAX_MESSAGE_LENGTH, messageSelection, type StoredMessage } from './service';

/** Prisma's unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

/**
 * The emoji the server will store.
 *
 * An allow-list rather than "any short string", because the column is free text and an open
 * column is not an open API: without this a client could store arbitrary text — including text
 * designed to be rendered somewhere it should not be — as a "reaction". Extending the palette is
 * a change to this array and nothing else; no migration, because the column was never an enum.
 */
export const ALLOWED_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

export type AllowedReaction = (typeof ALLOWED_REACTIONS)[number];

export function isAllowedReaction(value: string): value is AllowedReaction {
  return (ALLOWED_REACTIONS as readonly string[]).includes(value);
}

export type MessageActionFailure =
  /** No such message, not a member, or outside the caller's window. Deliberately one code. */
  | 'NOT_ACCESSIBLE'
  /** Delete-for-everyone attempted by somebody who did not send the message. */
  | 'NOT_THE_SENDER'
  /** The action is meaningless on this message — a tombstone, or a server-written SYSTEM row. */
  | 'NOT_ACTIONABLE'
  | 'INVALID_EMOJI'
  /** Forwarding was asked for with no usable destination. */
  | 'NO_DESTINATIONS'
  /** An edit that would leave a text message with nothing in it (Batch 1.1). */
  | 'EMPTY_BODY'
  /** An edit past `MAX_MESSAGE_LENGTH` (Batch 1.1). */
  | 'BODY_TOO_LONG';

export class MessageActionError extends Error {
  readonly reason: MessageActionFailure;

  constructor(reason: MessageActionFailure, message: string) {
    super(message);
    this.name = 'MessageActionError';
    this.reason = reason;
  }
}

export interface AccessibleMessage {
  message: {
    id: string;
    conversationId: string;
    senderId: string | null;
    type: 'TEXT' | 'FILE' | 'SYSTEM';
    body: string | null;
    createdAt: Date;
    deletedAt: Date | null;
    pinnedAt: Date | null;
  };
  membership: ActiveMembership;
}

/**
 * Resolves a message id into a message the caller is actually allowed to act on.
 *
 * **This is the function every action in this module depends on, and the only place the three
 * rules above are implemented.** A future action that authorizes itself some other way is a bug,
 * however carefully it is written.
 *
 * Note the order: the message is read first, and its `conversationId` is what membership is then
 * checked against. Accepting a conversation id from the caller instead would let somebody pair a
 * message from one conversation with a conversation they *are* in, and pass the check.
 */
export async function loadAccessibleMessage(
  db: PrismaClient,
  userId: string,
  messageId: string,
): Promise<AccessibleMessage> {
  const message = await db.message.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      conversationId: true,
      senderId: true,
      type: true,
      body: true,
      createdAt: true,
      deletedAt: true,
      pinnedAt: true,
    },
  });

  if (!message) throw notAccessible();

  const membership = await findActiveMembership(db, userId, message.conversationId);
  if (!membership) throw notAccessible();

  // D-03. Without this, every action here becomes a way to touch history from before the caller
  // joined — and a reaction or a pin on such a message would then be broadcast to everyone.
  if (message.createdAt < membership.joinedAt) throw notAccessible();

  return { message, membership };
}

function notAccessible(): MessageActionError {
  return new MessageActionError('NOT_ACCESSIBLE', 'That message is not available.');
}

/** Re-reads a message with everything the wire needs. Used after every mutation. */
export async function readMessageForWire(
  db: PrismaClient,
  messageId: string,
): Promise<StoredMessage> {
  const message = await db.message.findUnique({
    where: { id: messageId },
    select: messageSelection,
  });

  // The row was just written inside this request; its absence is a genuine internal fault.
  if (!message) throw new Error(`Message ${messageId} disappeared during an action`);
  return message;
}

/**
 * What every single-message action returns.
 *
 * The membership travels back with the message so the caller can serialize it for the actor
 * without a second authorization query — `toMessageWire` needs the reader's `joinedAt` to gate
 * the quoted reply preview, and re-reading it would be both wasteful and a second place for the
 * two to disagree.
 */
export interface MessageActionResult {
  message: StoredMessage;
  membership: ActiveMembership;
}

/* --------------------------------------------------------------------------------------------- */
/* Reactions                                                                                       */
/* --------------------------------------------------------------------------------------------- */

/**
 * Adds or changes the caller's reaction to a message.
 *
 * ONE reaction per person per message, enforced by the unique index on `(messageId, userId)` —
 * so this is an upsert, not an insert. Picking a different emoji replaces the previous one in a
 * single round trip, and a double-tap cannot produce two rows however many times the request is
 * retried.
 *
 * Reacting deliberately does NOT touch `Conversation.lastMessageAt`. That column orders the
 * sidebar and feeds the unread count; bumping it would push a conversation to the top and, worse,
 * make a reaction look like an unread message. A reaction is not a message and must not become
 * one (requirement: reactions must not inflate unread counts).
 */
export async function setReaction(
  db: PrismaClient,
  input: { userId: string; messageId: string; emoji: string },
): Promise<MessageActionResult> {
  if (!isAllowedReaction(input.emoji)) {
    throw new MessageActionError('INVALID_EMOJI', 'That reaction is not available.');
  }

  const { message, membership } = await loadAccessibleMessage(db, input.userId, input.messageId);

  // A tombstone has no content to react to, and a SYSTEM row is the server talking.
  if (message.deletedAt !== null || message.type === 'SYSTEM') {
    throw new MessageActionError('NOT_ACTIONABLE', 'That message cannot be reacted to.');
  }

  await db.messageReaction.upsert({
    where: { messageId_userId: { messageId: input.messageId, userId: input.userId } },
    create: { messageId: input.messageId, userId: input.userId, emoji: input.emoji },
    update: { emoji: input.emoji },
  });

  return { message: await readMessageForWire(db, input.messageId), membership };
}

/**
 * Removes the caller's own reaction.
 *
 * `deleteMany` scoped to this user, not `delete` by id: a request that names somebody else's
 * reaction simply removes nothing. There is no code path here that can delete a reaction the
 * caller did not make, which is a stronger guarantee than checking ownership first and trusting
 * the check to stay.
 *
 * Removing a reaction that is not there is a success, not an error — the desired state is
 * reached either way, and a retry after a lost response must not fail.
 */
export async function clearReaction(
  db: PrismaClient,
  input: { userId: string; messageId: string },
): Promise<MessageActionResult> {
  const { membership } = await loadAccessibleMessage(db, input.userId, input.messageId);

  await db.messageReaction.deleteMany({
    where: { messageId: input.messageId, userId: input.userId },
  });

  return { message: await readMessageForWire(db, input.messageId), membership };
}

/* --------------------------------------------------------------------------------------------- */
/* Pinning                                                                                         */
/* --------------------------------------------------------------------------------------------- */

/**
 * Pins or unpins a message in its conversation.
 *
 * Conversation-level, not per person: a pin is how a group marks something everyone should find
 * again, so any active member may pin and any active member may unpin. That is a deliberate
 * choice over "only the pinner may unpin", which strands a pin when somebody leaves.
 *
 * Like reacting, this does not touch `lastMessageAt` and creates no message, so pinning cannot
 * reorder the sidebar or produce an unread.
 */
export async function setPinned(
  db: PrismaClient,
  input: { userId: string; messageId: string; pinned: boolean },
): Promise<MessageActionResult> {
  const { message, membership } = await loadAccessibleMessage(db, input.userId, input.messageId);

  // Pinning a tombstone would leave misleading content in the pinned panel — the requirement is
  // explicit that deleted messages must not remain as active pinned content.
  if (input.pinned && message.deletedAt !== null) {
    throw new MessageActionError('NOT_ACTIONABLE', 'A deleted message cannot be pinned.');
  }

  await db.message.update({
    where: { id: input.messageId },
    data: input.pinned
      ? { pinnedAt: new Date(), pinnedById: input.userId }
      : { pinnedAt: null, pinnedById: null },
  });

  return { message: await readMessageForWire(db, input.messageId), membership };
}

/**
 * The pinned messages of a conversation, newest pin first.
 *
 * Filtered by the caller's own window and hides, exactly like history: a pinned message from
 * before somebody joined is not theirs to read, and pinning must not become a way around D-03.
 */
export async function listPinnedMessages(
  db: PrismaClient,
  input: { userId: string; conversationId: string },
): Promise<{ membership: ActiveMembership; messages: StoredMessage[] }> {
  const membership = await findActiveMembership(db, input.userId, input.conversationId);
  if (!membership) throw notAccessible();

  const messages = await db.message.findMany({
    where: {
      conversationId: input.conversationId,
      pinnedAt: { not: null },
      createdAt: { gte: membership.joinedAt },
      deletedAt: null,
      hiddenFor: { none: { userId: input.userId } },
    },
    orderBy: { pinnedAt: 'desc' },
    select: messageSelection,
  });

  return { membership, messages };
}

/* --------------------------------------------------------------------------------------------- */
/* Editing (Batch 1.1)                                                                             */
/* --------------------------------------------------------------------------------------------- */

/**
 * Rewrites the text of a message the caller sent.
 *
 * ONLY THE ORIGINAL SENDER, and only the text. Editing is the one action here that changes what a
 * message *says*, so it is also the one where getting authorization wrong rewrites history in
 * somebody else's name — which is why the rules below are checked twice: once as ordinary
 * preconditions, and again inside the `where` of the write itself.
 *
 * THE RULES, in the order they are applied:
 *
 *   1. `loadAccessibleMessage` — the message exists, the caller is an active member of ITS
 *      conversation, and it is inside their D-03 window. One answer for all three.
 *   2. Not a `SYSTEM` message. Those are the server's own record of what happened to a group;
 *      nobody may put words in the server's mouth.
 *   3. Not a tombstone. Delete-for-everyone cleared the text, and an edit must not resurrect it.
 *   4. The caller is the stored `senderId`. Read from the row, never from the request.
 *   5. There is text to edit. A file sent with no caption offers nothing to change — adding a
 *      caption after the fact would be a different feature, and this is deliberately not it. The
 *      interface hides Edit in exactly this case, and the server agrees rather than being more
 *      permissive than the menu.
 *
 * WHAT AN EDIT WRITES: `body` and `editedAt`. That is the entire `data` clause, so there is no
 * code path here by which a request could reach `senderId`, `createdAt`, `conversationId`,
 * `replyToId`, `isForwarded`, `pinnedAt`, `deletedAt` or an attachment — mass assignment is
 * prevented by there being nothing to assign, not by a list of fields to ignore.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH: `Conversation.lastMessageAt`. An edit is not a new message.
 * Bumping it would reorder the sidebar, change the unread reckoning and make an edit to something
 * said last week arrive like a fresh one. Reactions, pins, hides, replies and the attachment are
 * all untouched for the same reason — none of them is what changed.
 *
 * THE WRITE IS GUARDED, not merely preceded by checks. `updateMany` with `senderId` and
 * `deletedAt: null` in its `where` means a message deleted for everyone in the moment between the
 * read and the write is not edited at all: the delete wins, the count comes back 0, and the caller
 * is told the message is gone. A `update` by id would have quietly written text onto a tombstone.
 */
export async function editMessage(
  db: PrismaClient,
  input: { userId: string; messageId: string; body: string },
): Promise<MessageActionResult> {
  const { message, membership } = await loadAccessibleMessage(db, input.userId, input.messageId);

  if (message.type === 'SYSTEM') {
    throw new MessageActionError('NOT_ACTIONABLE', 'That message cannot be edited.');
  }
  if (message.deletedAt !== null) {
    throw new MessageActionError('NOT_ACTIONABLE', 'A deleted message cannot be edited.');
  }
  if (message.senderId === null || message.senderId !== input.userId) {
    throw new MessageActionError(
      'NOT_THE_SENDER',
      'Only the person who sent a message can edit it.',
    );
  }

  const current = message.body?.trim() ?? '';
  if (current.length === 0) {
    throw new MessageActionError('NOT_ACTIONABLE', 'That message has no text to edit.');
  }

  // The same normalisation `sendMessage` applies, so an edited message is stored exactly as a
  // newly sent one would be. The text is stored as text and rendered as text — nothing here
  // parses, interprets or escapes it, which is why there is no markup to inject (docs/04 §XSS).
  const body = input.body.trim();

  if (body.length > MAX_MESSAGE_LENGTH) {
    throw new MessageActionError(
      'BODY_TOO_LONG',
      `A message may be at most ${MAX_MESSAGE_LENGTH} characters.`,
    );
  }

  /*
   * Clearing the text is allowed only when something is left behind.
   *
   * A `FILE` message is still a message with its file gone from the caption — the model already
   * supports an attachment with no caption, because that is what sending a file without typing
   * anything produces. A `TEXT` message with no text is not a message at all, so emptying one is
   * refused rather than silently turned into a blank bubble; deleting is the action for that.
   *
   * The attachment's status is checked, not merely its existence: bytes removed by a
   * delete-for-everyone elsewhere would leave nothing behind after all.
   */
  let nextBody: string | null = body;
  if (body.length === 0) {
    const attachment =
      message.type === 'FILE'
        ? await db.attachment.findUnique({
            where: { messageId: input.messageId },
            select: { status: true },
          })
        : null;

    if (!attachment || attachment.status !== 'READY') {
      throw new MessageActionError('EMPTY_BODY', 'A message cannot be empty.');
    }
    nextBody = null;
  }

  /*
   * Saving without having changed anything is a no-op, not an edit.
   *
   * Stamping `editedAt` here would put a permanent "edited" label on a message whose text is
   * exactly what it always was — visible to everybody, and impossible for the sender to take back.
   */
  if ((message.body ?? null) === nextBody) {
    return { message: await readMessageForWire(db, input.messageId), membership };
  }

  const updated = await db.message.updateMany({
    where: { id: input.messageId, senderId: input.userId, deletedAt: null },
    data: { body: nextBody, editedAt: new Date() },
  });

  // Nothing matched: the message was deleted for everyone between the read above and this write.
  if (updated.count === 0) {
    throw new MessageActionError('NOT_ACTIONABLE', 'A deleted message cannot be edited.');
  }

  return { message: await readMessageForWire(db, input.messageId), membership };
}

/* --------------------------------------------------------------------------------------------- */
/* Deletion                                                                                        */
/* --------------------------------------------------------------------------------------------- */

/**
 * "Delete for me" — hides one message from one person's view.
 *
 * The shared row is not touched. Everybody else goes on seeing the message, which is the entire
 * difference between this and delete-for-everyone, and the reason this is a row in a side table
 * rather than a flag on the message.
 *
 * Idempotent: hiding something already hidden succeeds, because the unique index makes the second
 * insert a no-op rather than a duplicate.
 */
export async function hideMessageForUser(
  db: PrismaClient,
  input: { userId: string; messageId: string },
): Promise<{ conversationId: string }> {
  const { message } = await loadAccessibleMessage(db, input.userId, input.messageId);

  try {
    await db.messageHide.create({
      data: { messageId: input.messageId, userId: input.userId },
    });
  } catch (error) {
    // Already hidden. The desired state is reached, so this is a success.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION)) {
      throw error;
    }
  }

  return { conversationId: message.conversationId };
}

export interface DeleteForEveryoneResult {
  message: StoredMessage;
  membership: ActiveMembership;
  /**
   * The storage key whose bytes should now be removed, if any.
   *
   * Returned rather than deleted inside the transaction on purpose: the row must be committed
   * first. Deleting the file and then failing to commit would leave a READY attachment pointing
   * at bytes that are gone — a broken download for everyone, caused by a delete that did not
   * happen.
   */
  orphanedStorageKey: string | null;
}

/**
 * "Delete for everyone" — replaces a message with a tombstone.
 *
 * ONLY THE ORIGINAL SENDER. There is no administrator override, because the existing
 * authorization architecture defines none for conversation content: `/admin` manages devices, not
 * messages. Adding one here would be inventing a policy rather than implementing one.
 *
 * WHY A TOMBSTONE AND NOT A DELETE. The row stays, with `body` cleared:
 *
 *   - Replies that quote it keep a valid `replyToId` and render "Message deleted", rather than
 *     losing their parent to `ON DELETE SET NULL` and silently becoming ordinary messages.
 *   - Keyset pagination stays stable. Removing a row mid-history shifts nothing, but removing the
 *     row a cursor points at invalidates that cursor.
 *   - `ConversationMember.lastReadMessageId` may name it, and that column is a plain id with no
 *     foreign key — a physical delete would leave a read marker pointing at nothing.
 *
 * WHAT IS CLEARED, and why each:
 *   - `body`         — the text itself is gone from the database, not merely hidden by the UI.
 *   - `pinnedAt`     — a tombstone must not sit in the pinned panel as if it still said something.
 *   - reactions      — they decorate content that no longer exists, and a count under a tombstone
 *                      is a residue of it.
 *   - the attachment — status becomes `DELETED` and the bytes are removed. Forwarded copies are
 *                      independent files (see `forwardMessage`), so this cannot break them.
 *
 * `MessageHide` rows are deliberately kept. Someone who hid the message should not have it
 * reappear as a tombstone; their view does not change.
 */
export async function deleteMessageForEveryone(
  db: PrismaClient,
  input: { userId: string; messageId: string },
): Promise<DeleteForEveryoneResult> {
  const { message, membership } = await loadAccessibleMessage(db, input.userId, input.messageId);

  // A SYSTEM message has no sender, so this also refuses those — nobody may delete the server's
  // own record of who joined a group.
  if (message.senderId === null || message.senderId !== input.userId) {
    throw new MessageActionError(
      'NOT_THE_SENDER',
      'Only the person who sent a message can delete it for everyone.',
    );
  }

  // Already a tombstone. Idempotent rather than an error, so a retry after a lost response is
  // harmless — but nothing is re-broadcast and no file is deleted twice.
  if (message.deletedAt !== null) {
    return {
      message: await readMessageForWire(db, input.messageId),
      membership,
      orphanedStorageKey: null,
    };
  }

  const orphanedStorageKey = await db.$transaction(async (tx) => {
    const attachment = await tx.attachment.findUnique({
      where: { messageId: input.messageId },
      select: { id: true, storageKey: true, status: true },
    });

    await tx.message.update({
      where: { id: input.messageId },
      data: {
        deletedAt: new Date(),
        deletedById: input.userId,
        body: null,
        pinnedAt: null,
        pinnedById: null,
      },
    });

    await tx.messageReaction.deleteMany({ where: { messageId: input.messageId } });

    if (attachment) {
      await tx.attachment.update({
        where: { id: attachment.id },
        data: { status: 'DELETED' },
      });
    }

    return attachment?.storageKey ?? null;
  });

  return { message: await readMessageForWire(db, input.messageId), membership, orphanedStorageKey };
}

/**
 * Removes the bytes of a deleted attachment, after its row has been committed.
 *
 * Never throws. The database is already correct — the attachment is `DELETED` and no download
 * will be served — so a file left on disk is inert rather than dangerous, and must not turn a
 * successful delete into a failed request. It is logged by the caller instead.
 */
export async function removeOrphanedBytes(
  storage: StorageConfig,
  storageKey: string | null,
): Promise<boolean> {
  if (!storageKey) return false;
  return deleteStoredFile(storage, storageKey);
}

/* --------------------------------------------------------------------------------------------- */
/* Forwarding                                                                                      */
/* --------------------------------------------------------------------------------------------- */

export interface ForwardFailure {
  conversationId: string;
  reason: 'FORBIDDEN' | 'UNAVAILABLE' | 'FAILED';
}

export interface ForwardResult {
  /** One per destination that accepted the forward. */
  delivered: {
    conversationId: string;
    message: StoredMessage;
    /** The forwarder's window in THAT destination, for serializing the response. */
    viewerJoinedAt: Date;
  }[];
  failures: ForwardFailure[];
}

export interface ForwardInput {
  /** Server-derived. */
  userId: string;
  messageId: string;
  /** Destination conversations. Each is authorized independently. */
  destinations: { conversationId: string; clientMessageId: string }[];
}

/**
 * Forwards a message into one or more conversations.
 *
 * **THE ATTACHMENT DESIGN, which is the part that matters.**
 *
 * A forwarded file is a REAL, INDEPENDENT file in the destination: new `Attachment` row, new
 * `storageKey`, new bytes on disk. It is not a pointer to the original and not a text stub
 * naming it.
 *
 * Sharing one stored file between the original and its copies would have saved disk, and was
 * rejected:
 *
 *   - `Attachment.storageKey` is `@unique`, so sharing would mean dropping that constraint and
 *     hand-rolling reference counting — the classic source of "deleted a file somebody else was
 *     still using" and of files nothing ever collects.
 *   - Lifecycles would couple across conversations. The requirement is explicit that deleting the
 *     original must not break a forwarded copy; with shared bytes, it would.
 *   - Authorization would have to reason about which message a shared file is being reached
 *     through, instead of the current rule: one attachment, one message, one conversation.
 *
 * So every copy is standalone, and every existing guarantee survives untouched —
 * `loadAttachmentForDownload` authorizes the copy through ITS message in ITS conversation, and
 * knows nothing about where it came from.
 *
 * The cost is disk: forwarding a 500 MB file to three groups writes 1.5 GB. That is the correct
 * trade for a system where deleting a message must actually delete a file, and it is bounded by
 * the same `MAX_FILE_SIZE` as any upload because the copy goes through `storeStream`.
 *
 * DESTINATIONS ARE AUTHORIZED ONE AT A TIME, and a refusal does not fail the others: forwarding
 * to three groups when you have just been removed from one should deliver two, and say so.
 */
export async function forwardMessage(
  db: PrismaClient,
  storage: StorageConfig,
  input: ForwardInput,
): Promise<ForwardResult> {
  if (input.destinations.length === 0) {
    throw new MessageActionError('NO_DESTINATIONS', 'Choose at least one conversation.');
  }

  // Rule 1–3 against the SOURCE. Forwarding reads a message, so it needs exactly the same access
  // as reading one.
  const { message: source } = await loadAccessibleMessage(db, input.userId, input.messageId);

  if (source.deletedAt !== null || source.type === 'SYSTEM') {
    throw new MessageActionError('NOT_ACTIONABLE', 'That message cannot be forwarded.');
  }

  const sourceAttachment = await db.attachment.findUnique({
    where: { messageId: source.id },
    select: {
      storageKey: true,
      originalFilename: true,
      mimeType: true,
      extension: true,
      byteSize: true,
      status: true,
    },
  });

  // A file whose bytes were removed by a delete-for-everyone elsewhere, or an upload that failed.
  if (sourceAttachment && sourceAttachment.status !== 'READY') {
    throw new MessageActionError('NOT_ACTIONABLE', 'That file is no longer available.');
  }

  const delivered: ForwardResult['delivered'] = [];
  const failures: ForwardFailure[] = [];

  for (const destination of input.destinations) {
    // Authorized independently, from the database, for every destination. Membership of the
    // source conversation grants nothing here.
    const membership = await findActiveMembership(db, input.userId, destination.conversationId);
    if (!membership) {
      failures.push({ conversationId: destination.conversationId, reason: 'FORBIDDEN' });
      continue;
    }

    let copied: StoredFile | null = null;

    try {
      if (sourceAttachment) {
        copied = await copyStoredBytes(storage, sourceAttachment.storageKey);
        if (copied === null) {
          // The original bytes are missing. Better to refuse this destination than to create an
          // attachment row whose download would 404 for everyone in it.
          failures.push({ conversationId: destination.conversationId, reason: 'UNAVAILABLE' });
          continue;
        }
      }

      const file = copied;

      const created = await db.$transaction(async (tx) => {
        const forwarded = await tx.message.create({
          data: {
            conversationId: destination.conversationId,
            senderId: input.userId,
            type: source.type,
            body: source.body,
            clientMessageId: destination.clientMessageId,
            isForwarded: true,
          },
          select: { id: true, createdAt: true },
        });

        if (file !== null && sourceAttachment) {
          await tx.attachment.create({
            data: {
              conversationId: destination.conversationId,
              messageId: forwarded.id,
              // The forwarder is the uploader of THIS copy: they are the person who put these
              // bytes into this conversation, and they are who its members can hold responsible.
              uploaderId: input.userId,
              originalFilename: sourceAttachment.originalFilename,
              storageKey: file.storageKey,
              // Size and checksum are MEASURED over the copy as it was written, not inherited
              // from the source row. The same principle as an upload: these columns describe the
              // bytes that are actually on disk, so `scripts/verify-attachments.ts` can check a
              // forwarded file exactly as it checks an uploaded one.
              byteSize: BigInt(file.byteSize),
              mimeType: sourceAttachment.mimeType,
              extension: sourceAttachment.extension,
              checksumSha256: file.checksumSha256,
              status: 'READY',
            },
          });
        }

        await tx.conversation.update({
          where: { id: destination.conversationId },
          data: { lastMessageAt: forwarded.createdAt },
        });

        return forwarded;
      });

      copied = null; // Committed: it is no longer this function's to clean up.
      delivered.push({
        conversationId: destination.conversationId,
        message: await readMessageForWire(db, created.id),
        viewerJoinedAt: membership.joinedAt,
      });
    } catch (error) {
      // The bytes landed but the row did not. Remove them: an attachment with no row is
      // unreachable, but it is still a company file sitting on disk for no reason.
      if (copied) await deleteStoredFile(storage, copied.storageKey);

      // A retry of a forward the client already made — the unique (senderId, clientMessageId)
      // guard caught it. Report the message that already exists rather than sending a second.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION) {
        const existing = await db.message.findUnique({
          where: {
            senderId_clientMessageId: {
              senderId: input.userId,
              clientMessageId: destination.clientMessageId,
            },
          },
          select: { id: true },
        });

        if (existing) {
          delivered.push({
            conversationId: destination.conversationId,
            message: await readMessageForWire(db, existing.id),
            viewerJoinedAt: membership.joinedAt,
          });
          continue;
        }
      }

      failures.push({ conversationId: destination.conversationId, reason: 'FAILED' });
    }
  }

  return { delivered, failures };
}

/**
 * Copies a stored file to a new key, returning the key or null when the source is gone.
 *
 * Goes through `storeStream` rather than a filesystem copy so the duplicate is subject to exactly
 * the same rules as an upload: the same `MAX_FILE_SIZE` ceiling, the same streaming (a 500 MB
 * forward costs a buffer, not 500 MB of memory), the same checksum, and the same temp-file
 * cleanup if anything fails part way.
 */
async function copyStoredBytes(
  storage: StorageConfig,
  sourceKey: string,
): Promise<StoredFile | null> {
  const stats = await statStoredFile(storage, sourceKey);
  if (!stats) return null;

  return storeStream(storage, generateStorageKey(), openStoredFile(storage, sourceKey));
}
