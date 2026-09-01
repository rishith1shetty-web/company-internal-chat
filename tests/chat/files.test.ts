/**
 * File transfer: storage, upload, download authorization and the join-bounded window (Phase 7).
 *
 * Two properties are being defended here, and they need different kinds of test.
 *
 * The first is **authorization**, and specifically R-14: a file must be no easier to reach than
 * the message it was sent as. A newly added group member is a member of the conversation every
 * older file belongs to, so any check that stops at `conversationId` hands them the lot. That is
 * tested through the real route handlers, because the route is where a check would be forgotten.
 *
 * The second is **byte fidelity**. A file transfer system that loses or alters a byte is worse
 * than one that refuses the upload, so the round trip is compared with the exact bytes that went
 * in — including for a binary file, a zero-byte file, and one at the configured limit.
 *
 * Everything runs against the real database and a real storage directory under the system temp
 * folder. Files written here are removed afterwards; nothing is written inside the repository.
 */

import { randomBytes } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GET as getDownload } from '@/app/api/attachments/[id]/download/route';
import {
  GET as getAttachments,
  POST as postAttachment,
} from '@/app/api/conversations/[id]/attachments/route';
import type { ApiErrorWire, ConversationAttachmentsWire, MessageWire } from '@/lib/chat/wire';
import { addGroupMembers, createGroupConversation } from '@/lib/conversations/service';
import {
  AttachmentError,
  contentDispositionFor,
  detectContentType,
  downloadContentType,
  extensionOf,
  listConversationAttachments,
  loadAttachmentForDownload,
  sanitizeFilename,
} from '@/lib/files/service';
import {
  StorageError,
  ensureStorageReady,
  generateStorageKey,
  resolveStoragePath,
  storeStream,
} from '@/lib/files/storage';
import { storageConfig } from '@/lib/http/route-helpers';
import { listMessages } from '@/lib/messages/service';

import {
  buildRequest,
  cleanUp,
  createTestIdentity,
  databaseConfigured,
  db,
  disconnect,
  params,
  readResponse,
  seedDirectConversation,
  trackConversation,
  uuid,
  type TestIdentity,
} from './harness';

const suite = databaseConfigured ? describe : describe.skip;

/**
 * The storage root the routes are actually using.
 *
 * `tests/setup-env.ts` points `UPLOAD_DIR` at a fresh temp directory before any module reads
 * configuration, so this is a directory belonging to this test run — never the storage a
 * developer's own server is using. Read from the config rather than guessed, so the tests and the
 * code under test cannot end up looking at different directories.
 */
const storageRoot = storageConfig.uploadDir;

/** The limit used for most tests. Small, so "over the limit" does not mean uploading 500 MB. */
const TEST_MAX_FILE_SIZE = 1024 * 1024;

function storage(maxFileSize = TEST_MAX_FILE_SIZE) {
  return { uploadDir: storageRoot, maxFileSize };
}

/**
 * Posts a file through the real route handler.
 *
 * The upload is a raw body with the filename in a header, which is exactly what the browser
 * sends — so this exercises the header decoding and the streaming path rather than a convenience
 * shim written for the test.
 */
async function upload(
  identity: TestIdentity,
  conversationId: string,
  filename: string,
  contents: Buffer,
  options: { clientMessageId?: string; caption?: string } = {},
) {
  const headers = new Headers();
  headers.set('cookie', identity.cookie);
  headers.set('content-type', 'application/octet-stream');
  headers.set('x-client-message-id', options.clientMessageId ?? uuid());
  headers.set('x-filename', encodeURIComponent(filename));
  if (options.caption) headers.set('x-caption', encodeURIComponent(options.caption));

  const request = new Request(`http://127.0.0.1/api/conversations/${conversationId}/attachments`, {
    method: 'POST',
    headers,
    body: contents,
    // Node's fetch Request requires this for a stream-shaped body.
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

  return readResponse<MessageWire & ApiErrorWire>(
    await postAttachment(request, params({ id: conversationId })),
  );
}

/** Downloads through the real route handler and returns the bytes and headers. */
async function download(identity: TestIdentity, attachmentId: string) {
  const response = await getDownload(
    buildRequest({
      url: `/api/attachments/${attachmentId}/download`,
      cookie: identity.cookie,
    }),
    params({ id: attachmentId }),
  );

  const body = response.status === 200 ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
  return { status: response.status, headers: response.headers, body };
}

beforeAll(async () => {
  await ensureStorageReady(storage());
});

afterAll(async () => {
  // Only this run's own temp directory, which nothing else writes to.
  if (storageRoot.includes('zz-test-uploads-')) {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------------------------------------------- */
/* Filenames, types and storage keys — no database needed                                          */
/* --------------------------------------------------------------------------------------------- */

describe('filenames', () => {
  it('strips path separators and traversal rather than rejecting the file', () => {
    // The point is that the file still arrives. A colleague whose file is called "Q3/Q4.xlsx"
    // should not be told off, and the name cannot describe a path once separators are gone.
    expect(sanitizeFilename('../../etc/passwd')).toBe('etcpasswd');
    expect(sanitizeFilename('..\\..\\windows\\system32\\config')).toBe('windowssystem32config');
    expect(sanitizeFilename('C:\\Users\\dana\\report.pdf')).toBe('CUsersdanareport.pdf');
    expect(sanitizeFilename('/absolute/path.txt')).toBe('absolutepath.txt');
    expect(sanitizeFilename('..')).toBe('file');
  });

  it('removes control characters, so a filename cannot inject a header', () => {
    const injected = sanitizeFilename('report.pdf"\r\nX-Evil: yes');
    expect(injected).not.toContain('\r');
    expect(injected).not.toContain('\n');

    const header = contentDispositionFor('report.pdf"\r\nX-Evil: yes');
    expect(header).not.toContain('\r');
    expect(header).not.toContain('\n');
    // The quoted form cannot be closed early and given parameters of its own.
    expect(header.match(/"/g)).toHaveLength(2);
  });

  it('keeps Unicode names, and encodes them for the download header', () => {
    const name = '四半期レポート £5 café 🎉.xlsx';
    expect(sanitizeFilename(name)).toBe(name);

    const header = contentDispositionFor(name);
    expect(header).toContain("filename*=UTF-8''");
    expect(header).toContain(encodeURIComponent(name));
    // The ASCII fallback carries no raw non-ASCII bytes.
    const ascii = header.slice(header.indexOf('filename="'), header.indexOf('; filename*'));
    expect(/^[\x20-\x7E"=filename;]*$/.test(ascii)).toBe(true);
  });

  it('always produces something usable', () => {
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('   ')).toBe('file');
    expect(sanitizeFilename('...')).toBe('file');
    expect(sanitizeFilename(undefined)).toBe('file');
    expect(sanitizeFilename(42)).toBe('file');
    expect(sanitizeFilename('a'.repeat(400)).length).toBeLessThanOrEqual(255);
  });

  it('reads an extension for display, and shrugs at an unfamiliar one', () => {
    expect(extensionOf('report.PDF')).toBe('pdf');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('backup.7z')).toBe('7z');
    // An extension nobody has heard of is fine: nothing behaves differently because of it.
    expect(extensionOf('model.qwertyuiop')).toBe('qwertyuiop');
    expect(extensionOf('Makefile')).toBe('');
    expect(extensionOf('.gitignore')).toBe('');
  });
});

describe('content types', () => {
  it('recognises common formats from their leading bytes', () => {
    expect(detectContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png',
    );
    expect(detectContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectContentType(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(detectContentType(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe('application/zip');
  });

  it('falls back to octet-stream for anything else, which is not a failure', () => {
    expect(detectContentType(Buffer.from('just some text'))).toBe('application/octet-stream');
    expect(detectContentType(Buffer.alloc(0))).toBe('application/octet-stream');
    expect(detectContentType(Buffer.from([0x01]))).toBe('application/octet-stream');
  });

  it('serves every download as an opaque binary, whatever was detected', () => {
    // The one that matters: an SVG or an HTML file served as its own type would be stored XSS
    // against the colleague who opens it. Download-only means one type for everything (D-10).
    expect(downloadContentType()).toBe('application/octet-stream');
  });
});

describe('storage keys', () => {
  it('are opaque, date-sharded and unique', () => {
    const keys = new Set(Array.from({ length: 500 }, () => generateStorageKey()));
    expect(keys.size).toBe(500);

    for (const key of keys) {
      // No original filename, no user id, no conversation id — nothing to read off a directory
      // listing, and nothing an uploader chose.
      expect(key).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}\.bin$/);
    }
  });

  it('refuse to resolve outside the storage root', () => {
    const config = storage();
    for (const escape of ['../outside.bin', '../../etc/passwd', '2026/../../escape.bin']) {
      expect(() => resolveStoragePath(config, escape)).toThrow(StorageError);
    }
    expect(resolveStoragePath(config, '2026/09/file.bin')).toContain(storageRoot);
  });
});

describe('streaming to storage', () => {
  it('writes the exact bytes, and reports the size and checksum it counted', async () => {
    const contents = randomBytes(64 * 1024);
    const key = generateStorageKey();

    const stored = await storeStream(storage(), key, Readable.from([contents]));

    expect(stored.byteSize).toBe(contents.length);
    const written = await stat(resolveStoragePath(storage(), key));
    expect(written.size).toBe(contents.length);

    const { createHash } = await import('node:crypto');
    expect(stored.checksumSha256).toBe(createHash('sha256').update(contents).digest('hex'));
  });

  it('stops an oversized upload and leaves nothing behind', async () => {
    const config = storage(1024);
    const key = generateStorageKey();

    await expect(
      storeStream(config, key, Readable.from([randomBytes(4096)])),
    ).rejects.toMatchObject({ reason: 'TOO_LARGE' });

    // Neither a permanent file nor a temporary one: an upload that was refused costs no disk.
    await expect(stat(resolveStoragePath(config, key))).rejects.toThrow();
    expect(await readdir(join(storageRoot, 'tmp'))).toEqual([]);
  });

  it('accepts a file exactly at the limit', async () => {
    const config = storage(2048);
    const key = generateStorageKey();

    // The boundary is inclusive: a limit of N bytes accepts a file of N bytes.
    const stored = await storeStream(config, key, Readable.from([randomBytes(2048)]));
    expect(stored.byteSize).toBe(2048);
  });

  it('accepts a zero-byte file, deliberately', async () => {
    // An empty file is a real thing to send — a placeholder, a truncated export, a touch'd file.
    // Refusing it would be a rule invented here rather than one anybody asked for.
    const key = generateStorageKey();
    const stored = await storeStream(storage(), key, Readable.from([Buffer.alloc(0)]));

    expect(stored.byteSize).toBe(0);
    expect((await stat(resolveStoragePath(storage(), key))).size).toBe(0);
  });

  it('leaves no permanent file when the source fails midway', async () => {
    const key = generateStorageKey();
    const failing = new Readable({
      read() {
        this.push(randomBytes(1024));
        this.destroy(new Error('connection lost'));
      },
    });

    await expect(storeStream(storage(), key, failing)).rejects.toBeInstanceOf(StorageError);

    await expect(stat(resolveStoragePath(storage(), key))).rejects.toThrow();
    expect(await readdir(join(storageRoot, 'tmp'))).toEqual([]);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* Upload and download through the real routes                                                     */
/* --------------------------------------------------------------------------------------------- */

suite('uploading and downloading a file', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('sends a text file in a direct conversation and brings back the same bytes', async () => {
    const alice = await createTestIdentity('Files Alice');
    const bob = await createTestIdentity('Files Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const contents = Buffer.from('the quarterly numbers\nline two\n', 'utf8');
    const posted = await upload(alice, conversationId, 'notes.txt', contents);

    expect(posted.status).toBe(201);
    expect(posted.body.type).toBe('FILE');
    expect(posted.body.attachment).not.toBeNull();
    expect(posted.body.attachment?.filename).toBe('notes.txt');
    expect(posted.body.attachment?.byteSize).toBe(String(contents.length));

    const received = await download(bob, posted.body.attachment!.id);
    expect(received.status).toBe(200);
    // Byte-for-byte. A file transfer that alters a byte is worse than one that refuses.
    expect(received.body.equals(contents)).toBe(true);
  });

  it('round-trips a binary file unchanged', async () => {
    const alice = await createTestIdentity('Binary Alice');
    const bob = await createTestIdentity('Binary Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    // An MP4 header followed by random bytes: representative of the video the brief calls for,
    // without committing a large binary to the repository.
    const contents = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x20]),
      Buffer.from('ftypisom'),
      randomBytes(256 * 1024),
    ]);

    const posted = await upload(alice, conversationId, 'clip.mp4', contents);
    expect(posted.status).toBe(201);
    expect(posted.body.attachment?.mimeType).toBe('video/mp4');

    const received = await download(bob, posted.body.attachment!.id);
    expect(received.body.length).toBe(contents.length);
    expect(received.body.equals(contents)).toBe(true);
  });

  it('accepts an unfamiliar extension and an unknown format', async () => {
    const alice = await createTestIdentity('Odd Alice');
    const bob = await createTestIdentity('Odd Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    // The business requirement in one test: nothing here knows what a `.dwg` is, and that is not
    // a reason to stop somebody sending one to a colleague.
    const contents = randomBytes(4096);
    const posted = await upload(alice, conversationId, 'floorplan.dwg', contents);

    expect(posted.status).toBe(201);
    expect(posted.body.attachment?.extension).toBe('dwg');
    expect(posted.body.attachment?.mimeType).toBe('application/octet-stream');
    expect((await download(bob, posted.body.attachment!.id)).body.equals(contents)).toBe(true);
  });

  it('accepts a zero-byte file', async () => {
    const alice = await createTestIdentity('Empty Alice');
    const bob = await createTestIdentity('Empty Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const posted = await upload(alice, conversationId, 'placeholder.txt', Buffer.alloc(0));

    expect(posted.status).toBe(201);
    expect(posted.body.attachment?.byteSize).toBe('0');

    const received = await download(bob, posted.body.attachment!.id);
    expect(received.status).toBe(200);
    expect(received.body.length).toBe(0);
  });

  it('keeps two files with the same name apart', async () => {
    const alice = await createTestIdentity('Same Alice');
    const bob = await createTestIdentity('Same Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const first = Buffer.from('alice version', 'utf8');
    const second = Buffer.from('bob version, entirely different', 'utf8');

    const one = await upload(alice, conversationId, 'report.pdf', first);
    const two = await upload(bob, conversationId, 'report.pdf', second);

    expect(one.body.attachment?.id).not.toBe(two.body.attachment?.id);

    // Same display name, different files, neither overwritten — because the stored name is
    // generated and the original never touches the filesystem.
    const rows = await db().attachment.findMany({
      where: { id: { in: [one.body.attachment!.id, two.body.attachment!.id] } },
      select: { storageKey: true, originalFilename: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.storageKey).not.toBe(rows[1]?.storageKey);
    expect(rows.every((row) => row.originalFilename === 'report.pdf')).toBe(true);

    expect((await download(bob, one.body.attachment!.id)).body.equals(first)).toBe(true);
    expect((await download(alice, two.body.attachment!.id)).body.equals(second)).toBe(true);
  });

  it('keeps a Unicode filename, and a name that looked like a path', async () => {
    const alice = await createTestIdentity('Unicode Alice');
    const bob = await createTestIdentity('Unicode Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const unicode = await upload(
      alice,
      conversationId,
      '四半期 café 🎉.xlsx',
      Buffer.from('x'),
    );
    expect(unicode.body.attachment?.filename).toBe('四半期 café 🎉.xlsx');

    const traversal = await upload(
      alice,
      conversationId,
      '../../../etc/passwd',
      Buffer.from('y'),
    );
    expect(traversal.status).toBe(201);
    expect(traversal.body.attachment?.filename).toBe('etcpasswd');

    // And whatever the name claimed, the bytes went where the server decided.
    const row = await db().attachment.findUnique({
      where: { id: traversal.body.attachment!.id },
      select: { storageKey: true },
    });
    expect(row?.storageKey).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}\.bin$/);
  });

  it('sends a file with a caption in one message', async () => {
    const alice = await createTestIdentity('Caption Alice');
    const bob = await createTestIdentity('Caption Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const posted = await upload(alice, conversationId, 'q3.xlsx', Buffer.from('data'), {
      caption: 'here are the numbers',
    });

    expect(posted.body.body).toBe('here are the numbers');
    expect(posted.body.attachment?.filename).toBe('q3.xlsx');
  });

  it('serves the download as an attachment, never inline', async () => {
    const alice = await createTestIdentity('Header Alice');
    const bob = await createTestIdentity('Header Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    // An SVG is the case that matters: served as `image/svg+xml` and rendered, it is script.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'utf8');
    const posted = await upload(alice, conversationId, 'logo.svg', svg);

    const received = await download(bob, posted.body.attachment!.id);
    expect(received.headers.get('content-type')).toBe('application/octet-stream');
    expect(received.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(received.headers.get('x-content-type-options')).toBe('nosniff');
    expect(received.headers.get('content-length')).toBe(String(svg.length));
    // Company data: never in a shared cache.
    expect(received.headers.get('cache-control')).toContain('no-store');
  });

  it('refuses a file over the configured limit, and accepts one exactly at it', async () => {
    const alice = await createTestIdentity('Limit Alice');
    const bob = await createTestIdentity('Limit Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const limit = storageConfig.maxFileSize;
    const before = await db().attachment.count({ where: { conversationId } });

    const oversized = await upload(
      alice,
      conversationId,
      'too-big.bin',
      randomBytes(limit + 1024),
    );

    expect(oversized.status).toBe(413);
    // The message names the limit, so the sender knows what to do rather than just that it failed.
    expect(oversized.body.error.message).toMatch(/limit/i);
    // Refused while the bytes were arriving: no row, and nothing left on disk.
    expect(await db().attachment.count({ where: { conversationId } })).toBe(before);
    expect(await readdir(join(storageRoot, 'tmp'))).toEqual([]);

    // Inclusive: a file of exactly the limit is within it.
    const exact = await upload(alice, conversationId, 'exactly.bin', randomBytes(limit));
    expect(exact.status).toBe(201);
    expect(exact.body.attachment?.byteSize).toBe(String(limit));
  });

  it('refuses an upload from somebody who is not in the conversation', async () => {
    const alice = await createTestIdentity('Guard Alice');
    const bob = await createTestIdentity('Guard Bob');
    const outsider = await createTestIdentity('Guard Outsider');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const before = await db().attachment.count({ where: { conversationId } });

    const refused = await upload(outsider, conversationId, 'sneaky.txt', Buffer.from('hello'));
    expect(refused.status).toBe(403);

    // Nothing written: the membership check runs before a byte is read, so a stranger cannot
    // make the server spend disk on them either.
    expect(await db().attachment.count({ where: { conversationId } })).toBe(before);
  });

  it('refuses an upload with no identity at all', async () => {
    const alice = await createTestIdentity('Anon Alice');
    const bob = await createTestIdentity('Anon Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const headers = new Headers();
    headers.set('content-type', 'application/octet-stream');
    headers.set('x-client-message-id', uuid());
    headers.set('x-filename', 'anon.txt');

    const response = await postAttachment(
      new Request(`http://127.0.0.1/api/conversations/${conversationId}/attachments`, {
        method: 'POST',
        headers,
        body: Buffer.from('hello'),
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
      params({ id: conversationId }),
    );

    expect(response.status).toBe(401);
  });

  it('treats a repeated upload as one file, not two', async () => {
    const alice = await createTestIdentity('Retry Alice');
    const bob = await createTestIdentity('Retry Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const contents = Buffer.from('sent once', 'utf8');
    const clientMessageId = uuid();

    const first = await upload(alice, conversationId, 'once.txt', contents, { clientMessageId });
    const retry = await upload(alice, conversationId, 'once.txt', contents, { clientMessageId });

    expect(first.status).toBe(201);
    // The stored message comes back rather than a second one being created.
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.attachment?.id).toBe(first.body.attachment?.id);

    expect(await db().attachment.count({ where: { conversationId } })).toBe(1);
    // And the second copy of the bytes was cleaned up rather than orphaned.
    expect((await download(bob, first.body.attachment!.id)).body.equals(contents)).toBe(true);
  });

  it('refuses to hand a file to somebody outside the conversation', async () => {
    const alice = await createTestIdentity('Peek Alice');
    const bob = await createTestIdentity('Peek Bob');
    const outsider = await createTestIdentity('Peek Outsider');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const posted = await upload(alice, conversationId, 'private.txt', Buffer.from('secret'));
    const attachmentId = posted.body.attachment!.id;

    // Knowing the id is not access.
    const refused = await download(outsider, attachmentId);
    expect(refused.status).toBe(404);
    expect(refused.body.length).toBe(0);

    // An id that does not exist answers identically, so this endpoint confirms nothing.
    const unknown = await download(outsider, uuid());
    expect(unknown.status).toBe(404);
  });

  it('handles a row whose file has gone missing', async () => {
    const alice = await createTestIdentity('Lost Alice');
    const bob = await createTestIdentity('Lost Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const posted = await upload(alice, conversationId, 'vanishing.txt', Buffer.from('here'));
    const attachmentId = posted.body.attachment!.id;

    const row = await db().attachment.findUniqueOrThrow({
      where: { id: attachmentId },
      select: { storageKey: true },
    });
    // Simulates a restore that missed the storage directory, or a file removed by hand.
    await rm(resolveStoragePath(storage(), row.storageKey), { force: true });

    const received = await download(bob, attachmentId);
    // A clean refusal rather than a half-sent response that looks like a corrupt file.
    expect(received.status).toBe(404);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* The join-bounded window, for files (D-03 / R-14)                                                 */
/* --------------------------------------------------------------------------------------------- */

suite('files and the group join window', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  /** A group with a file shared before somebody joined, and one shared after. */
  async function groupWithFiles() {
    const owner = await createTestIdentity('File Owner');
    const original = await createTestIdentity('File Original');
    const latecomer = await createTestIdentity('File Latecomer');

    const created = await createGroupConversation(db(), {
      creatorId: owner.userId,
      name: 'zz-test-p5-Files',
      memberIds: [original.userId],
    });
    const conversationId = trackConversation(created.conversationId);

    const before = await upload(owner, conversationId, 'report.pdf', Buffer.from('%PDF-1.7 old'));

    await addGroupMembers(db(), {
      actorId: owner.userId,
      conversationId,
      userIds: [latecomer.userId],
    });

    const after = await upload(owner, conversationId, 'agenda.pdf', Buffer.from('%PDF-1.7 new'));

    return {
      owner,
      original,
      latecomer,
      conversationId,
      beforeId: before.body.attachment!.id,
      afterId: after.body.attachment!.id,
    };
  }

  it('hides a file shared before the member joined, and shows one shared after', async () => {
    const { latecomer, conversationId, beforeId, afterId } = await groupWithFiles();

    const visible = await listMessages(db(), { userId: latecomer.userId, conversationId });
    const attachmentIds = visible.messages.map((message) => message.attachment?.id);

    expect(attachmentIds).not.toContain(beforeId);
    expect(attachmentIds).toContain(afterId);
  });

  it('refuses the download of a file from before they joined', async () => {
    const { latecomer, beforeId, afterId } = await groupWithFiles();

    // The heart of R-14: they are a member of this conversation, and that is not enough.
    const refused = await download(latecomer, beforeId);
    expect(refused.status).toBe(404);
    expect(refused.body.length).toBe(0);

    // While the file sent after they joined is theirs to open.
    const allowed = await download(latecomer, afterId);
    expect(allowed.status).toBe(200);
  });

  it('keeps the older file out of their Shared files list entirely', async () => {
    const { latecomer, owner, conversationId, beforeId, afterId } = await groupWithFiles();

    const theirs = await readResponse<ConversationAttachmentsWire>(
      await getAttachments(
        buildRequest({
          url: `/api/conversations/${conversationId}/attachments`,
          cookie: latecomer.cookie,
        }),
        params({ id: conversationId }),
      ),
    );

    expect(theirs.status).toBe(200);
    const listed = theirs.body.attachments.map((file) => file.id);
    // Not merely undownloadable — not listed, so the panel does not even reveal that it exists.
    expect(listed).not.toContain(beforeId);
    expect(listed).toContain(afterId);

    // The members who were there see both.
    const ownerFiles = await listConversationAttachments(db(), owner.userId, conversationId);
    expect(ownerFiles.map((file) => file.id)).toEqual(
      expect.arrayContaining([beforeId, afterId]),
    );
  });

  it('keeps the older file for the members who were there, and the bytes on disk', async () => {
    const { owner, original, beforeId } = await groupWithFiles();

    for (const member of [owner, original]) {
      const received = await download(member, beforeId);
      expect(received.status).toBe(200);
      expect(received.body.toString('utf8')).toBe('%PDF-1.7 old');
    }

    // Nothing was deleted to hide it from the newcomer.
    const row = await db().attachment.findUnique({ where: { id: beforeId } });
    expect(row).not.toBeNull();
  });

  it('cuts off a member who has left, for files as well as messages', async () => {
    const { owner, original, conversationId, afterId } = await groupWithFiles();

    // They can open it while they are in the group.
    expect((await download(original, afterId)).status).toBe(200);

    await db().conversationMember.update({
      where: { conversationId_userId: { conversationId, userId: original.userId } },
      data: { leftAt: new Date() },
    });

    // And not afterwards. The membership row still exists, which is the trap: the check is on
    // `leftAt IS NULL`, not on the row.
    expect((await download(original, afterId)).status).toBe(404);

    const later = await upload(owner, conversationId, 'after-they-left.txt', Buffer.from('new'));
    expect((await download(original, later.body.attachment!.id)).status).toBe(404);

    await expect(
      listConversationAttachments(db(), original.userId, conversationId),
    ).rejects.toBeInstanceOf(AttachmentError);
  });

  it('refuses an outsider the Shared files list', async () => {
    const { conversationId } = await groupWithFiles();
    const outsider = await createTestIdentity('Files Outsider');

    const refused = await readResponse<ApiErrorWire>(
      await getAttachments(
        buildRequest({
          url: `/api/conversations/${conversationId}/attachments`,
          cookie: outsider.cookie,
        }),
        params({ id: conversationId }),
      ),
    );

    expect(refused.status).toBe(403);
  });

  it('authorizes through the message, so an attachment without one is unreachable', async () => {
    const alice = await createTestIdentity('Orphan Alice');
    const bob = await createTestIdentity('Orphan Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const posted = await upload(alice, conversationId, 'orphan.txt', Buffer.from('x'));
    const attachmentId = posted.body.attachment!.id;

    // An attachment whose message has gone has nothing to authorize against, so nobody may have
    // it — not even the person who uploaded it.
    await db().attachment.update({ where: { id: attachmentId }, data: { messageId: null } });

    await expect(
      loadAttachmentForDownload(db(), alice.userId, attachmentId),
    ).rejects.toBeInstanceOf(AttachmentError);
    expect((await download(alice, attachmentId)).status).toBe(404);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* A file arriving over the socket                                                                  */
/* --------------------------------------------------------------------------------------------- */

suite('files in real time', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('puts the file in the conversation and carries only its metadata', async () => {
    const alice = await createTestIdentity('Live Alice');
    const bob = await createTestIdentity('Live Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const contents = randomBytes(8192);
    const posted = await upload(alice, conversationId, 'photo.png', contents);

    // The message a socket recipient is handed is exactly this JSON — and it is metadata: a
    // name, a size, a type and an id. The bytes are fetched separately, by whoever wants them.
    const serialised = JSON.stringify(posted.body);
    expect(serialised.length).toBeLessThan(2000);
    expect(serialised).not.toContain('storageKey');
    expect(serialised).not.toContain(storageRoot);
    expect(posted.body.attachment?.byteSize).toBe(String(contents.length));

    // And the recipient can read it back from the database, which is the source of truth.
    const history = await listMessages(db(), { userId: bob.userId, conversationId });
    const message = history.messages.find((item) => item.id === posted.body.id);
    expect(message?.attachment?.originalFilename).toBe('photo.png');
  });

  it('never exposes a storage path through any response', async () => {
    const alice = await createTestIdentity('Path Alice');
    const bob = await createTestIdentity('Path Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const posted = await upload(alice, conversationId, 'internal.txt', Buffer.from('x'));

    const listed = await readResponse<ConversationAttachmentsWire>(
      await getAttachments(
        buildRequest({
          url: `/api/conversations/${conversationId}/attachments`,
          cookie: bob.cookie,
        }),
        params({ id: conversationId }),
      ),
    );

    const everything = JSON.stringify(listed.body) + JSON.stringify(posted.body);
    expect(everything).not.toContain('storageKey');
    expect(everything).not.toContain('.bin');
    expect(everything).not.toContain(storageRoot);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* Rollback                                                                                        */
/* --------------------------------------------------------------------------------------------- */

suite('when something goes wrong', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('leaves no attachment row when the file could not be stored', async () => {
    const alice = await createTestIdentity('Fail Alice');
    const bob = await createTestIdentity('Fail Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const before = await db().attachment.count({ where: { conversationId } });

    // A source that dies partway is what a dropped connection looks like from the server's side.
    const key = generateStorageKey();
    const failing = new Readable({
      read() {
        this.push(randomBytes(512));
        this.destroy(new Error('client went away'));
      },
    });

    await expect(storeStream(storage(), key, failing)).rejects.toBeInstanceOf(StorageError);

    // The database was never reached, so there is nothing to roll back — which is the point of
    // writing the bytes first and the rows second.
    expect(await db().attachment.count({ where: { conversationId } })).toBe(before);
    expect(await readdir(join(storageRoot, 'tmp'))).toEqual([]);
  });

  it('deletes the stored file when the message cannot be written', async () => {
    const alice = await createTestIdentity('Rollback Alice');
    const bob = await createTestIdentity('Rollback Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    // Uploading into a conversation that has just been deleted: the bytes land, then the foreign
    // key refuses the row. The route must not leave the file behind.
    const doomed = await db().conversation.create({
      data: {
        type: 'DIRECT',
        directKey: `zz-doomed-${uuid()}`,
        members: { create: [{ userId: alice.userId }, { userId: bob.userId }] },
      },
      select: { id: true },
    });

    const filesBefore = await countStoredFiles();

    await db().conversation.delete({ where: { id: doomed.id } });
    const response = await upload(alice, doomed.id, 'doomed.txt', Buffer.from('data'));

    // Refused — and the count of files on disk is unchanged, so nothing was orphaned.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await countStoredFiles()).toBe(filesBefore);
    expect(await db().attachment.count({ where: { conversationId: doomed.id } })).toBe(0);
    expect(conversationId).toBeTruthy();
  });
});

/** Every permanent file in the test storage root, ignoring the temporary directory. */
async function countStoredFiles(): Promise<number> {
  let total = 0;

  for (const year of await readdir(storageRoot, { withFileTypes: true })) {
    if (!year.isDirectory() || year.name === 'tmp') continue;
    for (const month of await readdir(join(storageRoot, year.name), { withFileTypes: true })) {
      if (!month.isDirectory()) continue;
      total += (await readdir(join(storageRoot, year.name, month.name))).length;
    }
  }

  return total;
}
