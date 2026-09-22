/**
 * Searching the sidebar still finds BOTH kinds of conversation (Batch 1.4).
 *
 * WHY THIS FILE EXISTS. The matcher itself — `selectVisibleConversations` — is not changed by this
 * batch, but it had no test of its own, and the batch makes a specific promise about it: one
 * search box that keeps searching groups AND direct chats, with the results landing in the right
 * sections. A promise about untested code is worth testing before relying on it.
 *
 * It runs through the real reducer so the search term arrives the way the interface sets it, and
 * the results are put through `splitConversationSections` so what is asserted is what the sidebar
 * would actually render.
 */

import { describe, expect, it } from 'vitest';

import {
  chatReducer,
  initialChatState,
  selectConversationListEntries,
  type ChatAction,
  type ChatState,
} from '@/lib/chat/state';
import { splitConversationSections } from '@/lib/chat/sidebar-sections';
import type { ConversationWire, UserWire } from '@/lib/chat/wire';

const ME = '11111111-1111-4111-8111-111111111111';
const RAJ = '22222222-2222-4222-8222-222222222222';
const SAIF = '33333333-3333-4333-8333-333333333333';
/** In no group at all, so a search for this name can only produce a CHATS result. */
const MITESH = '44444444-4444-4444-8444-444444444444';

function apply(state: ChatState, ...actions: ChatAction[]): ChatState {
  return actions.reduce(chatReducer, state);
}

function user(id: string, displayName: string): UserWire {
  return { id, displayName, lastSeenAt: '2026-09-22T09:00:00.000Z' };
}

function member(userId: string) {
  return { userId, role: 'MEMBER' as const, joinedAt: '2026-09-01T09:00:00.000Z', lastReadAt: null };
}

function conversation(
  id: string,
  type: 'DIRECT' | 'GROUP',
  name: string | null,
  memberIds: string[],
  lastMessageAt: string,
): ConversationWire {
  return {
    id,
    type,
    name,
    createdAt: '2026-09-01T09:00:00.000Z',
    lastMessageAt,
    members: memberIds.map(member),
    lastMessage: null,
    unreadCount: 0,
  };
}

/** Two groups and two direct chats, as an employee would actually have them. */
function workspace(searchTerm?: string): ChatState {
  const loaded = apply(
    initialChatState,
    {
      type: 'identity-ready',
      userId: ME,
      displayName: 'Purvesh Akhani',
      deviceLabel: 'PC-1',
      maxFileSize: 1024,
    },
    {
      type: 'conversations-loaded',
      conversations: [
        conversation('g-updates', 'GROUP', 'RPR Updates', [ME, RAJ, SAIF], '2026-09-22T15:00:00.000Z'),
        conversation('g-hr', 'GROUP', 'HR', [ME, RAJ], '2026-09-22T14:40:00.000Z'),
        conversation('d-raj', 'DIRECT', null, [ME, RAJ], '2026-09-22T14:50:00.000Z'),
        conversation('d-saif', 'DIRECT', null, [ME, SAIF], '2026-09-22T14:20:00.000Z'),
        conversation('d-mitesh', 'DIRECT', null, [ME, MITESH], '2026-09-22T14:10:00.000Z'),
      ],
      users: [
        user(ME, 'Purvesh Akhani'),
        user(RAJ, 'Raj Mahabdi'),
        user(SAIF, 'Saif Khan'),
        user(MITESH, 'Mitesh Naik'),
      ],
    },
  );

  return searchTerm === undefined ? loaded : apply(loaded, { type: 'set-search', term: searchTerm });
}

/** What the two sections would contain for a given search term. */
function sectioned(searchTerm?: string): { groups: string[]; chats: string[] } {
  const sections = splitConversationSections(selectConversationListEntries(workspace(searchTerm)));
  return {
    groups: sections[0]?.entries.map((entry) => entry.id) ?? [],
    chats: sections[1]?.entries.map((entry) => entry.id) ?? [],
  };
}

describe('the search box searches both sections', () => {
  it('shows everything with no search term', () => {
    expect(sectioned()).toEqual({
      groups: ['g-updates', 'g-hr'],
      chats: ['d-raj', 'd-saif', 'd-mitesh'],
    });
  });

  it('MATCHES A GROUP by its name, and files it under GROUPS', () => {
    expect(sectioned('updates')).toEqual({ groups: ['g-updates'], chats: [] });
  });

  it('MATCHES A DIRECT CHAT by the other person’s name, and files it under CHATS', () => {
    /*
     * Mitesh is in no group, so this term can only produce a CHATS result — which is what makes
     * the assertion about classification rather than about who happens to be in what.
     *
     * A direct conversation has no name of its own; its title is resolved from the counterpart,
     * and that is what the matcher compares against.
     */
    expect(sectioned('mitesh')).toEqual({ groups: [], chats: ['d-mitesh'] });
  });

  it('matches a direct chat AND a group when the person is in both', () => {
    // Saif has a direct chat and is a member of RPR Updates. One term, a result in each section.
    expect(sectioned('saif')).toEqual({ groups: ['g-updates'], chats: ['d-saif'] });
  });

  it('matches a group by a MEMBER’s name too', () => {
    /*
     * "Raj" is in both groups and has a direct chat. One search term, results in both sections —
     * which is the behaviour the two-section layout must not have broken.
     */
    const result = sectioned('raj');
    expect(result.groups).toEqual(['g-updates', 'g-hr']);
    expect(result.chats).toEqual(['d-raj']);
  });

  it('is case-insensitive', () => {
    expect(sectioned('RPR')).toEqual(sectioned('rpr'));
    expect(sectioned('RPR').groups).toEqual(['g-updates']);
  });

  it('ignores surrounding whitespace', () => {
    expect(sectioned('  hr  ')).toEqual(sectioned('hr'));
  });

  it('returns nothing in either section when nothing matches', () => {
    expect(sectioned('nobody-by-that-name')).toEqual({ groups: [], chats: [] });
  });

  it('keeps each section in newest-first order while searching', () => {
    // `g-updates` is newer than `g-hr`; both match "raj" through their members.
    expect(sectioned('raj').groups).toEqual(['g-updates', 'g-hr']);
  });

  it('keeps GROUPS above CHATS for every one of these terms', () => {
    for (const term of ['', 'raj', 'hr', 'saif', 'mitesh', 'rpr', 'no-match']) {
      const sections = splitConversationSections(
        selectConversationListEntries(workspace(term)),
      );
      expect(sections.map((section) => section.key), term).toEqual(['groups', 'chats']);
    }
  });

  it('clearing the search brings everything back', () => {
    const narrowed = workspace('saif');
    const cleared = apply(narrowed, { type: 'set-search', term: '' });

    const sections = splitConversationSections(selectConversationListEntries(cleared));
    expect(sections[0]?.entries.map((e) => e.id)).toEqual(['g-updates', 'g-hr']);
    expect(sections[1]?.entries.map((e) => e.id)).toEqual(['d-raj', 'd-saif', 'd-mitesh']);
  });
});
