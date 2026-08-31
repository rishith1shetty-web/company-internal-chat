/**
 * User directory (Phase 5).
 *
 * The rule under test is D-02: a display name is a label, not an identifier. Two colleagues may
 * share one, and nothing in this application may resolve a person from a name. The directory
 * exists to *find* someone to talk to; what is submitted afterwards is always an id.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { listDirectory, listUsersByIds } from '@/lib/users/directory';

import {
  TEST_NAME_PREFIX,
  cleanUp,
  createTestIdentity,
  databaseConfigured,
  db,
  disconnect,
} from './harness';

const suite = databaseConfigured ? describe : describe.skip;

suite('user directory', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('lists other users and never the caller', async () => {
    const me = await createTestIdentity('Directory Caller');
    const other = await createTestIdentity('Directory Other');

    const entries = await listDirectory(db(), me.userId, { search: TEST_NAME_PREFIX });
    const ids = entries.map((entry) => entry.id);

    expect(ids).toContain(other.userId);
    expect(ids).not.toContain(me.userId);
  });

  it('treats two users with the same display name as two different people (D-02)', async () => {
    const caller = await createTestIdentity('Someone Else');
    const first = await createTestIdentity('Sarah Chen');
    const second = await createTestIdentity('Sarah Chen');

    expect(first.userId).not.toBe(second.userId);
    expect(first.displayName).toBe(second.displayName);

    const entries = await listDirectory(db(), caller.userId, { search: 'sarah chen' });
    const matching = entries.filter((entry) => entry.displayName === first.displayName);

    // Both are returned, as separate rows with separate ids. Neither is "the" Sarah Chen.
    expect(matching.map((entry) => entry.id).sort()).toEqual(
      [first.userId, second.userId].sort(),
    );
  });

  it('offers no way to resolve a user from a display name alone', async () => {
    const caller = await createTestIdentity('Name Lookup');
    const a = await createTestIdentity('Ambiguous Name');
    const b = await createTestIdentity('Ambiguous Name');

    const entries = await listDirectory(db(), caller.userId, { search: 'ambiguous name' });

    // The only honest answer to "who is Ambiguous Name?" is "these two people".
    const ids = entries.filter((entry) => entry.displayName === a.displayName).map((e) => e.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids)).toEqual(new Set([a.userId, b.userId]));
  });

  it('filters on the normalised name, case-insensitively', async () => {
    const caller = await createTestIdentity('Case Caller');
    const target = await createTestIdentity('Uppercase Person');

    const upper = await listDirectory(db(), caller.userId, { search: 'UPPERCASE PERSON' });
    expect(upper.map((entry) => entry.id)).toContain(target.userId);
  });

  it('excludes retired users from the picker but keeps their row', async () => {
    const caller = await createTestIdentity('Active Caller');
    const retired = await createTestIdentity('Retired Person');

    await db().user.update({ where: { id: retired.userId }, data: { isActive: false } });

    const entries = await listDirectory(db(), caller.userId, { search: 'retired person' });
    expect(entries.map((entry) => entry.id)).not.toContain(retired.userId);

    // The user still exists: retirement is not deletion, because messages must stay attributable.
    const stillThere = await db().user.findUnique({ where: { id: retired.userId } });
    expect(stillThere).not.toBeNull();
  });

  it('resolves users by id for rendering conversation members', async () => {
    const one = await createTestIdentity('Member One');
    const two = await createTestIdentity('Member Two');

    const users = await listUsersByIds(db(), [one.userId, two.userId, one.userId]);

    expect(users).toHaveLength(2);
    expect(new Set(users.map((user) => user.id))).toEqual(new Set([one.userId, two.userId]));
  });

  it('returns nothing for an empty id list rather than every user', async () => {
    expect(await listUsersByIds(db(), [])).toEqual([]);
  });
});
