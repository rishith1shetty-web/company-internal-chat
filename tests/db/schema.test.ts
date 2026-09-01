/**
 * Database schema tests (Phase 3).
 *
 * These verify that the rules the architecture depends on are enforced by PostgreSQL rather than
 * by application code that a later phase might forget to write: identity by id and never by name
 * (D-02), one direct conversation per pair, membership uniqueness, the duplicate-send guard, the
 * join-bounded history window (D-03), and the persistence guarantee that session and device rows
 * own no data (D-14).
 *
 * They run against `company_chat_db`, create only their own rows, and delete them afterwards.
 * Nothing is truncated and no other database is contacted — see tests/db/helpers.ts.
 *
 * The whole suite skips when DATABASE_URL is not configured.
 */

import { afterAll, describe, expect, it } from 'vitest';

import {
  cleanUp,
  clientMessageId,
  createDirectConversation,
  createGroup,
  createUser,
  databaseConfigured,
  db,
  directKeyFor,
  disconnect,
} from './helpers';

/** Prisma's unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

async function expectUniqueViolation(operation: Promise<unknown>): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
}

describe.skipIf(!databaseConfigured)('database schema', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  describe('identity (D-02)', () => {
    it('allows two different users to share a display name', async () => {
      const first = await createUser('Sarah Chen');
      const second = await createUser('Sarah Chen');

      expect(first.id).not.toBe(second.id);
      expect(first.displayName).toBe(second.displayName);

      // A name lookup returns more than one row, which is exactly why nothing in the
      // application may resolve a user by name.
      const byName = await db().user.findMany({ where: { displayName: first.displayName } });
      expect(byName.length).toBeGreaterThanOrEqual(2);
    });

    it('gives every user a stable uuid and default timestamps', async () => {
      const user = await createUser('Timestamps');
      const stored = await db().user.findUniqueOrThrow({ where: { id: user.id } });

      expect(stored.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(stored.createdAt).toBeInstanceOf(Date);
      expect(stored.lastSeenAt).toBeInstanceOf(Date);
      expect(stored.isActive).toBe(true);

      // Re-reading by id returns the same person; the id is the identity.
      const again = await db().user.findUniqueOrThrow({ where: { id: user.id } });
      expect(again.id).toBe(user.id);
    });
  });

  describe('conversations', () => {
    it('permits only one direct conversation per pair of users', async () => {
      const alice = await createUser('Alice Direct');
      const bob = await createUser('Bob Direct');

      await createDirectConversation(alice.id, bob.id);

      // The same pair again — including with the arguments reversed, since the key is sorted.
      await expectUniqueViolation(
        db().conversation.create({
          data: { type: 'DIRECT', directKey: directKeyFor(bob.id, alice.id) },
        }),
      );
    });

    it('allows many group conversations with no directKey', async () => {
      const owner = await createUser('Group Owner');

      const first = await createGroup(owner.id, 'Group One');
      const second = await createGroup(owner.id, 'Group Two');

      expect(first.id).not.toBe(second.id);
      const stored = await db().conversation.findUniqueOrThrow({ where: { id: first.id } });
      expect(stored.directKey).toBeNull();
      expect(stored.type).toBe('GROUP');
    });

    it('records the group owner and its members', async () => {
      const owner = await createUser('Owner');
      const member = await createUser('Member');
      const group = await createGroup(owner.id, 'Roles', [member.id]);

      const members = await db().conversationMember.findMany({
        where: { conversationId: group.id },
        orderBy: { role: 'asc' },
      });

      expect(members).toHaveLength(2);
      expect(members.filter((m) => m.role === 'OWNER')).toHaveLength(1);
      expect(members.every((m) => m.leftAt === null)).toBe(true);
      expect(members.every((m) => m.joinedAt instanceof Date)).toBe(true);
    });

    it('rejects the same user joining one conversation twice', async () => {
      const owner = await createUser('Duplicate Member Owner');
      const group = await createGroup(owner.id, 'Duplicate Membership');

      await expectUniqueViolation(
        db().conversationMember.create({ data: { conversationId: group.id, userId: owner.id } }),
      );
    });

    it('keeps the membership row when a member leaves, so history stays attributable', async () => {
      const owner = await createUser('Leaver Owner');
      const leaver = await createUser('Leaver');
      const group = await createGroup(owner.id, 'Leaving', [leaver.id]);

      const left = await db().conversationMember.update({
        where: { conversationId_userId: { conversationId: group.id, userId: leaver.id } },
        data: { leftAt: new Date() },
      });

      expect(left.leftAt).toBeInstanceOf(Date);

      // The row still exists: authorization must test `leftAt IS NULL`, not row existence.
      const active = await db().conversationMember.findMany({
        where: { conversationId: group.id, leftAt: null },
      });
      expect(active).toHaveLength(1);
    });
  });

  describe('messages', () => {
    it('stores messages against their conversation and sender', async () => {
      const sender = await createUser('Sender');
      const other = await createUser('Recipient');
      const conversation = await createDirectConversation(sender.id, other.id);

      const message = await db().message.create({
        data: {
          conversationId: conversation.id,
          senderId: sender.id,
          type: 'TEXT',
          body: 'Phase 3 message',
          clientMessageId: clientMessageId(),
        },
      });

      expect(message.createdAt).toBeInstanceOf(Date);
      expect(message.body).toBe('Phase 3 message');

      const loaded = await db().message.findUniqueOrThrow({
        where: { id: message.id },
        include: { sender: true, conversation: true },
      });
      expect(loaded.sender?.id).toBe(sender.id);
      expect(loaded.conversation.id).toBe(conversation.id);
    });

    it('rejects a repeated clientMessageId from the same sender (the duplicate-send guard)', async () => {
      const sender = await createUser('Idempotent Sender');
      const other = await createUser('Idempotent Recipient');
      const conversation = await createDirectConversation(sender.id, other.id);
      const key = clientMessageId();

      await db().message.create({
        data: {
          conversationId: conversation.id,
          senderId: sender.id,
          type: 'TEXT',
          body: 'first',
          clientMessageId: key,
        },
      });

      // A retry after a dropped acknowledgement must collide rather than insert twice.
      await expectUniqueViolation(
        db().message.create({
          data: {
            conversationId: conversation.id,
            senderId: sender.id,
            type: 'TEXT',
            body: 'retry of the same message',
            clientMessageId: key,
          },
        }),
      );

      // The same key from a different sender is a different message and is allowed.
      const second = await db().message.create({
        data: {
          conversationId: conversation.id,
          senderId: other.id,
          type: 'TEXT',
          body: 'different sender, same key',
          clientMessageId: key,
        },
      });
      expect(second.id).toBeDefined();
    });

    it('allows repeated SYSTEM messages, which have no sender', async () => {
      const owner = await createUser('System Owner');
      const group = await createGroup(owner.id, 'System Messages');
      const key = clientMessageId();

      // PostgreSQL treats NULLs as distinct in a unique index, so server-written messages do not
      // collide with each other on (senderId, clientMessageId).
      for (const body of ['created the group', 'added a member']) {
        await db().message.create({
          data: { conversationId: group.id, type: 'SYSTEM', body, clientMessageId: key },
        });
      }

      const systemMessages = await db().message.findMany({
        where: { conversationId: group.id, type: 'SYSTEM' },
      });
      expect(systemMessages).toHaveLength(2);
      expect(systemMessages.every((m) => m.senderId === null)).toBe(true);
    });

    it('supports the join-bounded history window (D-03)', async () => {
      const owner = await createUser('History Owner');
      const latecomer = await createUser('Latecomer');
      const group = await createGroup(owner.id, 'Join Window');

      const early = new Date(Date.now() - 60 * 60_000);
      const joinTime = new Date(Date.now() - 30 * 60_000);
      const late = new Date(Date.now() - 5 * 60_000);

      await db().message.createMany({
        data: [
          {
            conversationId: group.id,
            senderId: owner.id,
            type: 'TEXT',
            body: 'before the join',
            clientMessageId: clientMessageId(),
            createdAt: early,
          },
          {
            conversationId: group.id,
            senderId: owner.id,
            type: 'TEXT',
            body: 'after the join',
            clientMessageId: clientMessageId(),
            createdAt: late,
          },
        ],
      });

      const membership = await db().conversationMember.create({
        data: { conversationId: group.id, userId: latecomer.id, joinedAt: joinTime },
      });

      // The query every later phase must use: membership alone is not enough.
      const visible = await db().message.findMany({
        where: { conversationId: group.id, createdAt: { gte: membership.joinedAt } },
        orderBy: { createdAt: 'asc' },
      });

      expect(visible.map((m) => m.body)).toEqual(['after the join']);
    });

    it('cascades messages when their conversation is deleted', async () => {
      const owner = await createUser('Cascade Owner');
      const group = await createGroup(owner.id, 'Cascade');

      await db().message.create({
        data: {
          conversationId: group.id,
          senderId: owner.id,
          type: 'TEXT',
          body: 'goes with the conversation',
          clientMessageId: clientMessageId(),
        },
      });

      await db().conversation.delete({ where: { id: group.id } });

      expect(await db().message.count({ where: { conversationId: group.id } })).toBe(0);
      expect(await db().conversationMember.count({ where: { conversationId: group.id } })).toBe(0);
      // The user is untouched: containers cascade, people do not.
      expect(await db().user.findUnique({ where: { id: owner.id } })).not.toBeNull();
    });

    it('keeps messages when their author is deleted, with the sender set to null', async () => {
      const author = await createUser('Departing Author');
      const other = await createUser('Remaining Colleague');
      const conversation = await createDirectConversation(other.id, author.id);

      const message = await db().message.create({
        data: {
          conversationId: conversation.id,
          senderId: author.id,
          type: 'TEXT',
          body: 'survives its author',
          clientMessageId: clientMessageId(),
        },
      });

      await db().user.delete({ where: { id: author.id } });

      const surviving = await db().message.findUniqueOrThrow({ where: { id: message.id } });
      expect(surviving.body).toBe('survives its author');
      expect(surviving.senderId).toBeNull();
    });
  });

  describe('attachments', () => {
    it('stores metadata only, with a server-generated storage key', async () => {
      const uploader = await createUser('Uploader');
      const other = await createUser('Downloader');
      const conversation = await createDirectConversation(uploader.id, other.id);
      const storageKey = `2026/08/${crypto.randomUUID()}.bin`;

      const attachment = await db().attachment.create({
        data: {
          conversationId: conversation.id,
          uploaderId: uploader.id,
          originalFilename: 'quarterly report.pdf',
          storageKey,
          byteSize: BigInt(524_288_000),
          mimeType: 'application/pdf',
          extension: 'pdf',
          status: 'PENDING',
        },
      });

      // 500 MB fits because byteSize is bigint; a 32-bit column would be a ceiling.
      expect(attachment.byteSize).toBe(BigInt(524_288_000));
      expect(attachment.status).toBe('PENDING');
      expect(attachment.messageId).toBeNull();

      await expectUniqueViolation(
        db().attachment.create({
          data: {
            conversationId: conversation.id,
            originalFilename: 'another.pdf',
            storageKey,
            byteSize: BigInt(10),
            mimeType: 'application/pdf',
            extension: 'pdf',
          },
        }),
      );
    });

    it('allows at most one attachment per message', async () => {
      const uploader = await createUser('Single Attachment Uploader');
      const other = await createUser('Single Attachment Peer');
      const conversation = await createDirectConversation(uploader.id, other.id);

      const message = await db().message.create({
        data: {
          conversationId: conversation.id,
          senderId: uploader.id,
          type: 'FILE',
          clientMessageId: clientMessageId(),
        },
      });

      const attachmentData = (suffix: string) => ({
        conversationId: conversation.id,
        messageId: message.id,
        uploaderId: uploader.id,
        originalFilename: `file-${suffix}.pdf`,
        storageKey: `2026/08/${crypto.randomUUID()}.bin`,
        byteSize: BigInt(1024),
        mimeType: 'application/pdf',
        extension: 'pdf',
        status: 'READY' as const,
      });

      await db().attachment.create({ data: attachmentData('one') });
      await expectUniqueViolation(db().attachment.create({ data: attachmentData('two') }));
    });
  });

  describe('session and device rows own no application data (D-14)', () => {
    it('deletes only the session row when a session is removed', async () => {
      const user = await createUser('Session Owner');
      const peer = await createUser('Session Peer');
      const conversation = await createDirectConversation(user.id, peer.id);
      const message = await db().message.create({
        data: {
          conversationId: conversation.id,
          senderId: user.id,
          type: 'TEXT',
          body: 'outlives the session',
          clientMessageId: clientMessageId(),
        },
      });

      const session = await db().session.create({
        data: {
          userId: user.id,
          tokenHash: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });

      await db().session.delete({ where: { id: session.id } });

      // Everything that matters is still there.
      expect(await db().user.findUnique({ where: { id: user.id } })).not.toBeNull();
      expect(await db().message.findUnique({ where: { id: message.id } })).not.toBeNull();
      expect(await db().conversationMember.count({ where: { conversationId: conversation.id } })).toBe(2);
    });

    it('keeps a revoked device row distinguishable from an active one', async () => {
      const user = await createUser('Device Owner');

      const active = await db().device.create({
        data: {
          userId: user.id,
          label: `zz-test-active-${crypto.randomUUID().slice(0, 8)}`,
          tokenHash: 'b'.repeat(64),
          expiresAt: new Date(Date.now() + 90 * 86_400_000),
        },
      });
      const revoked = await db().device.create({
        data: {
          userId: user.id,
          label: `zz-test-revoked-${crypto.randomUUID().slice(0, 8)}`,
          tokenHash: 'c'.repeat(64),
          expiresAt: new Date(Date.now() + 90 * 86_400_000),
          revokedAt: new Date(),
        },
      });

      // The resolution rule: revokedAt IS NULL AND expiresAt > now(). Row existence is not enough.
      const resolvable = await db().device.findMany({
        where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
      });

      expect(resolvable.map((device) => device.id)).toEqual([active.id]);
      expect(await db().device.findUnique({ where: { id: revoked.id } })).not.toBeNull();
    });

    it('rejects a duplicate session token hash', async () => {
      const user = await createUser('Token Owner');
      const tokenHash = 'd'.repeat(64);
      const expiresAt = new Date(Date.now() + 86_400_000);

      await db().session.create({ data: { userId: user.id, tokenHash, expiresAt } });
      await expectUniqueViolation(
        db().session.create({ data: { userId: user.id, tokenHash, expiresAt } }),
      );
    });
  });

  describe('indexes', () => {
    it('creates the indexes the authorization and history queries depend on', async () => {
      const rows = await db().$queryRaw<{ indexdef: string; tablename: string }[]>`
        SELECT tablename, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename IN ('User', 'Session', 'Device', 'Conversation', 'ConversationMember', 'Message', 'Attachment')
      `;

      // Quotes are stripped before matching: PostgreSQL quotes identifiers only when it has to,
      // so `"createdAt"` comes back quoted while `id` does not. Comparing the unquoted form
      // keeps these assertions about the index rather than about rendering rules.
      const definitions = rows.map((row) => row.indexdef.replace(/\s+/g, ' ').replace(/"/g, ''));
      const hasIndexOn = (table: string, columns: string) =>
        definitions.some(
          (definition) =>
            definition.includes(`ON public.${table} `) && definition.includes(`(${columns})`),
        );

      // Every authorization check reads this one.
      expect(hasIndexOn('ConversationMember', 'userId, conversationId')).toBe(true);
      // Membership uniqueness.
      expect(hasIndexOn('ConversationMember', 'conversationId, userId')).toBe(true);
      // History pagination, in the exact column order keyset pagination needs.
      expect(hasIndexOn('Message', 'conversationId, createdAt DESC, id DESC')).toBe(true);
      // The duplicate-send guard.
      expect(hasIndexOn('Message', 'senderId, clientMessageId')).toBe(true);
      // Conversation list ordering.
      expect(hasIndexOn('Conversation', 'lastMessageAt DESC')).toBe(true);
      // At most one direct conversation per pair.
      expect(hasIndexOn('Conversation', 'directKey')).toBe(true);
      // Directory search and ordering — and it must NOT be unique (D-02).
      expect(hasIndexOn('User', 'normalizedName')).toBe(true);
      expect(
        definitions.some(
          (definition) =>
            definition.includes('ON public.User ') &&
            definition.includes('(normalizedName)') &&
            definition.includes('UNIQUE'),
        ),
      ).toBe(false);
      // Session and device sweeps.
      expect(hasIndexOn('Session', 'expiresAt')).toBe(true);
      expect(hasIndexOn('Device', 'expiresAt')).toBe(true);
    });
  });
});
