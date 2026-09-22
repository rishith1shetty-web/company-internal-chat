/**
 * The GROUPS / CHATS sidebar (Batch 1.4).
 *
 * Pure: no database, no socket, no DOM. Everything that decides what the sidebar shows lives in
 * `lib/chat/sidebar-sections.ts`, which is why it can be tested exhaustively here rather than
 * asserted at by poking a rendered tree.
 *
 * THE THINGS MOST WORTH GETTING RIGHT, and each has tests below:
 *
 *   1. **Classification comes from the server's enum, never from a name.** A group called
 *      "Raj Mahabdi" and a direct chat with somebody called "HR" must both land correctly, or
 *      the sidebar quietly reorganises itself when somebody renames a group.
 *   2. **A collapse must never hide something the employee needs.** Search results and the open
 *      conversation both force their section open — without overwriting the preference, so it
 *      comes back the moment the reason does not apply.
 *   3. **A collapsed section still reports unread activity.** Collapsing is presentation. It must
 *      not become a way to miss a message.
 */

import { describe, expect, it } from 'vitest';

import type { ConversationListEntry } from '@/lib/chat/state';
import {
  DEFAULT_SECTION_PREFERENCES,
  SIDEBAR_SECTIONS_KEY,
  SIDEBAR_SECTION_ORDER,
  isSectionVisible,
  loadSectionPreferences,
  resolveSectionOpen,
  saveSectionPreferences,
  sectionUnreadCount,
  splitConversationSections,
  type PreferenceStore,
} from '@/lib/chat/sidebar-sections';

function entry(overrides: Partial<ConversationListEntry> & { id: string }): ConversationListEntry {
  return {
    type: 'DIRECT',
    title: 'Someone',
    preview: 'hello',
    timestamp: '2026-09-22T14:00:00.000Z',
    unreadCount: 0,
    counterpart: null,
    memberCount: 2,
    discriminator: null,
    ...overrides,
  };
}

/** A workspace with two groups and three direct chats, newest first as the reducer supplies. */
function mixedEntries(): ConversationListEntry[] {
  return [
    entry({ id: 'g1', type: 'GROUP', title: 'RPR Updates', timestamp: '2026-09-22T15:00:00.000Z' }),
    entry({ id: 'd1', title: 'Raj Mahabdi', timestamp: '2026-09-22T14:50:00.000Z' }),
    entry({ id: 'g2', type: 'GROUP', title: 'HR', timestamp: '2026-09-22T14:40:00.000Z' }),
    entry({ id: 'd2', title: 'Purvesh Akhani', timestamp: '2026-09-22T14:30:00.000Z' }),
    entry({ id: 'd3', title: 'Saif Khan', timestamp: '2026-09-22T14:20:00.000Z' }),
  ];
}

/** A `localStorage` stand-in. Faults are injectable because they are the interesting paths. */
function store(initial: Record<string, string> = {}): PreferenceStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

const throwingStore: PreferenceStore = {
  getItem() {
    throw new Error('site data blocked');
  },
  setItem() {
    throw new Error('quota exceeded');
  },
};

/* -------------------------------------------------------------------------------------------- */
/* Classification and order                                                                       */
/* -------------------------------------------------------------------------------------------- */

describe('splitConversationSections', () => {
  it('puts GROUPS above CHATS', () => {
    expect(splitConversationSections(mixedEntries()).map((s) => s.key)).toEqual(['groups', 'chats']);
    // Stated as data rather than produced by a sort, so there is no comparator to get wrong.
    expect(SIDEBAR_SECTION_ORDER).toEqual(['groups', 'chats']);
  });

  it('puts group conversations ONLY in GROUPS', () => {
    const [groups, chats] = splitConversationSections(mixedEntries());
    expect(groups?.entries.map((e) => e.id)).toEqual(['g1', 'g2']);
    expect(chats?.entries.map((e) => e.id)).not.toContain('g1');
    expect(chats?.entries.map((e) => e.id)).not.toContain('g2');
  });

  it('puts direct conversations ONLY in CHATS', () => {
    const [groups, chats] = splitConversationSections(mixedEntries());
    expect(chats?.entries.map((e) => e.id)).toEqual(['d1', 'd2', 'd3']);
    expect(groups?.entries.map((e) => e.id)).not.toContain('d1');
  });

  it('never lists a conversation twice', () => {
    const sections = splitConversationSections(mixedEntries());
    const ids = sections.flatMap((section) => section.entries.map((e) => e.id));
    expect(ids).toHaveLength(new Set(ids).size);
    expect(ids).toHaveLength(mixedEntries().length);
  });

  it('classifies by the SERVER TYPE, not by the name', () => {
    /*
     * The trap this guards. A group named after a person and a direct chat with somebody whose
     * display name reads like a team are both ordinary. Classifying on anything but the enum
     * would move conversations between sections when somebody renames a group.
     */
    const sections = splitConversationSections([
      entry({ id: 'g', type: 'GROUP', title: 'Raj Mahabdi' }),
      entry({ id: 'd', type: 'DIRECT', title: 'HR' }),
    ]);

    expect(sections[0]?.entries.map((e) => e.id)).toEqual(['g']);
    expect(sections[1]?.entries.map((e) => e.id)).toEqual(['d']);
  });

  it('does not classify by member count either', () => {
    // A group of one is still a group; a direct chat always has two members.
    const sections = splitConversationSections([
      entry({ id: 'lonely-group', type: 'GROUP', memberCount: 1 }),
      entry({ id: 'direct', type: 'DIRECT', memberCount: 2 }),
    ]);
    expect(sections[0]?.entries.map((e) => e.id)).toEqual(['lonely-group']);
    expect(sections[1]?.entries.map((e) => e.id)).toEqual(['direct']);
  });

  it('preserves the incoming order INSIDE each section', () => {
    /*
     * The list arrives sorted newest-activity-first. A stable partition keeps each section in
     * that order, so there is no second sort that could drift from `sortConversations`.
     */
    const [groups, chats] = splitConversationSections(mixedEntries());

    expect(groups?.entries.map((e) => e.timestamp)).toEqual([
      '2026-09-22T15:00:00.000Z',
      '2026-09-22T14:40:00.000Z',
    ]);
    expect(chats?.entries.map((e) => e.timestamp)).toEqual([
      '2026-09-22T14:50:00.000Z',
      '2026-09-22T14:30:00.000Z',
      '2026-09-22T14:20:00.000Z',
    ]);
  });

  it('keeps both sections, and their order, when one is empty', () => {
    const sections = splitConversationSections([entry({ id: 'd1' })]);
    expect(sections.map((s) => s.key)).toEqual(['groups', 'chats']);
    expect(sections[0]?.entries).toEqual([]);
    expect(sections[0]?.emptyLabel).toBe('No groups yet');
    expect(sections[1]?.emptyLabel).toBe('No chats yet');
  });

  it('keeps both sections, and their order, with nothing at all', () => {
    expect(splitConversationSections([]).map((s) => s.key)).toEqual(['groups', 'chats']);
  });

  it('carries the row data through untouched', () => {
    // The rows are not rebuilt here, only grouped — so nothing a row displays can be lost.
    const original = entry({ id: 'd1', preview: 'You: sent a file', unreadCount: 3 });
    const [, chats] = splitConversationSections([original]);
    expect(chats?.entries[0]).toBe(original);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Unread while collapsed                                                                         */
/* -------------------------------------------------------------------------------------------- */

describe('sectionUnreadCount', () => {
  it('totals the unread messages in a section', () => {
    const sections = splitConversationSections([
      entry({ id: 'g1', type: 'GROUP', unreadCount: 3 }),
      entry({ id: 'g2', type: 'GROUP', unreadCount: 1 }),
      entry({ id: 'd1', unreadCount: 2 }),
    ]);

    // What a collapsed "▸ GROUPS 4" header reports.
    expect(sections[0]?.unreadCount).toBe(4);
    expect(sections[1]?.unreadCount).toBe(2);
  });

  it('is zero when everything is read', () => {
    expect(sectionUnreadCount([entry({ id: 'a' }), entry({ id: 'b' })])).toBe(0);
  });

  it('ignores a negative count rather than subtracting it', () => {
    // Defensive: a bad count must not let one conversation cancel out another's unread.
    expect(sectionUnreadCount([entry({ id: 'a', unreadCount: -5 }), entry({ id: 'b', unreadCount: 2 })])).toBe(2);
  });

  it('uses the SAME counts the rows show, so header and rows cannot disagree', () => {
    const entries = [entry({ id: 'g1', type: 'GROUP', unreadCount: 7 })];
    const [groups] = splitConversationSections(entries);
    expect(groups?.unreadCount).toBe(entries[0]?.unreadCount);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Open / closed                                                                                  */
/* -------------------------------------------------------------------------------------------- */

describe('resolveSectionOpen', () => {
  const base = { preference: true, searching: false, hasMatches: true, containsSelected: false };

  it('is open by default', () => {
    expect(resolveSectionOpen(base)).toBe(true);
  });

  it('closes when the employee collapsed it', () => {
    expect(resolveSectionOpen({ ...base, preference: false })).toBe(false);
  });

  it('opens again when the employee expands it', () => {
    expect(resolveSectionOpen({ ...base, preference: true })).toBe(true);
  });

  it('OPENS A COLLAPSED SECTION that has search matches', () => {
    // A result nobody can see is not a result.
    expect(
      resolveSectionOpen({ ...base, preference: false, searching: true, hasMatches: true }),
    ).toBe(true);
  });

  it('leaves a collapsed section closed when the search matches nothing in it', () => {
    expect(
      resolveSectionOpen({ ...base, preference: false, searching: true, hasMatches: false }),
    ).toBe(false);
  });

  it('OPENS A COLLAPSED SECTION containing the selected conversation', () => {
    // Never strand somebody reading a conversation whose sidebar row is hidden.
    expect(resolveSectionOpen({ ...base, preference: false, containsSelected: true })).toBe(true);
  });

  it('restores the collapse once the search is cleared', () => {
    const collapsed = { ...base, preference: false };

    expect(resolveSectionOpen({ ...collapsed, searching: true, hasMatches: true })).toBe(true);
    // Same preference, search over. The override was never written down, so it simply stops.
    expect(resolveSectionOpen({ ...collapsed, searching: false, hasMatches: true })).toBe(false);
  });

  it('restores the collapse once a different section is selected from', () => {
    const collapsed = { ...base, preference: false };
    expect(resolveSectionOpen({ ...collapsed, containsSelected: true })).toBe(true);
    expect(resolveSectionOpen({ ...collapsed, containsSelected: false })).toBe(false);
  });

  it('keeps an expanded section expanded whatever else is true', () => {
    for (const searching of [true, false]) {
      for (const hasMatches of [true, false]) {
        for (const containsSelected of [true, false]) {
          expect(
            resolveSectionOpen({ preference: true, searching, hasMatches, containsSelected }),
          ).toBe(true);
        }
      }
    }
  });
});

describe('isSectionVisible', () => {
  const groups = () => splitConversationSections([entry({ id: 'd1' })])[0]!;

  it('always shows both headers when no search is running', () => {
    // An absent header would read as "this application has no groups", which is a different
    // statement from "you have none yet" — and that is what the empty label is for.
    expect(isSectionVisible(groups(), false)).toBe(true);
  });

  it('hides a section with no matches during a search', () => {
    expect(isSectionVisible(groups(), true)).toBe(false);
  });

  it('shows a section that has matches during a search', () => {
    const withGroup = splitConversationSections([entry({ id: 'g1', type: 'GROUP' })])[0]!;
    expect(isSectionVisible(withGroup, true)).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* The two sections behave independently                                                          */
/* -------------------------------------------------------------------------------------------- */

describe('the two sections are independent', () => {
  it('collapsing GROUPS leaves CHATS open', () => {
    const preferences = { groups: false, chats: true };
    const sections = splitConversationSections(mixedEntries());

    const open = sections.map((section) =>
      resolveSectionOpen({
        preference: preferences[section.key],
        searching: false,
        hasMatches: true,
        containsSelected: false,
      }),
    );

    expect(open).toEqual([false, true]);
  });

  it('collapsing CHATS leaves GROUPS open', () => {
    const preferences = { groups: true, chats: false };
    const sections = splitConversationSections(mixedEntries());

    expect(
      sections.map((section) =>
        resolveSectionOpen({
          preference: preferences[section.key],
          searching: false,
          hasMatches: true,
          containsSelected: false,
        }),
      ),
    ).toEqual([true, false]);
  });

  it('GROUPS stays above CHATS collapsed, expanded, and mid-search', () => {
    for (const searching of [false, true]) {
      const sections = splitConversationSections(mixedEntries());
      expect(sections.map((s) => s.key)).toEqual(['groups', 'chats']);
      // Order is a property of the list, not of whether anything is open.
      expect(sections.filter((s) => isSectionVisible(s, searching)).map((s) => s.key)).toEqual([
        'groups',
        'chats',
      ]);
    }
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Persistence                                                                                    */
/* -------------------------------------------------------------------------------------------- */

describe('collapse preferences', () => {
  it('defaults to BOTH EXPANDED on first use', () => {
    expect(loadSectionPreferences(store())).toEqual({ groups: true, chats: true });
    expect(DEFAULT_SECTION_PREFERENCES).toEqual({ groups: true, chats: true });
  });

  it('remembers a collapsed section', () => {
    const memory = store();
    saveSectionPreferences({ groups: false, chats: true }, memory);
    expect(loadSectionPreferences(memory)).toEqual({ groups: false, chats: true });
  });

  it('round-trips both sections collapsed', () => {
    const memory = store();
    saveSectionPreferences({ groups: false, chats: false }, memory);
    expect(loadSectionPreferences(memory)).toEqual({ groups: false, chats: false });
  });

  it('stores under one namespaced key', () => {
    const memory = store();
    saveSectionPreferences({ groups: false, chats: true }, memory);
    expect(Object.keys(memory.data)).toEqual([SIDEBAR_SECTIONS_KEY]);
    expect(SIDEBAR_SECTIONS_KEY).toBe('cic.sidebar.sections');
  });

  it('falls back to expanded when storage is unavailable', () => {
    expect(loadSectionPreferences(null)).toEqual(DEFAULT_SECTION_PREFERENCES);
  });

  it('falls back to expanded when reading THROWS', () => {
    // A private window, or site data blocked. Reading localStorage does not merely return null.
    expect(loadSectionPreferences(throwingStore)).toEqual(DEFAULT_SECTION_PREFERENCES);
  });

  it('falls back to expanded on invalid JSON', () => {
    expect(loadSectionPreferences(store({ [SIDEBAR_SECTIONS_KEY]: 'not json' }))).toEqual(
      DEFAULT_SECTION_PREFERENCES,
    );
  });

  it('falls back to expanded on a non-object', () => {
    for (const raw of ['null', '"collapsed"', '42', '[]']) {
      expect(loadSectionPreferences(store({ [SIDEBAR_SECTIONS_KEY]: raw })), raw).toEqual(
        DEFAULT_SECTION_PREFERENCES,
      );
    }
  });

  it('reads FIELD BY FIELD, so one bad value cannot poison the other', () => {
    /*
     * What comes back is a string somebody could have edited by hand. `{"groups":"no"}` must not
     * produce a section that is neither open nor closed.
     */
    const partial = loadSectionPreferences(
      store({ [SIDEBAR_SECTIONS_KEY]: '{"groups":"no","chats":false}' }),
    );
    expect(partial).toEqual({ groups: true, chats: false });
  });

  it('fills in a missing field with the default', () => {
    expect(loadSectionPreferences(store({ [SIDEBAR_SECTIONS_KEY]: '{"chats":false}' }))).toEqual({
      groups: true,
      chats: false,
    });
  });

  it('never throws when writing fails', () => {
    // Quota exceeded. The choice still applies for this page's lifetime.
    expect(() => saveSectionPreferences({ groups: false, chats: false }, throwingStore)).not.toThrow();
    expect(() => saveSectionPreferences({ groups: false, chats: false }, null)).not.toThrow();
  });

  it('returns a fresh object each time, so a caller cannot mutate the defaults', () => {
    const first = loadSectionPreferences(null);
    first.groups = false;
    expect(loadSectionPreferences(null).groups).toBe(true);
    expect(DEFAULT_SECTION_PREFERENCES.groups).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Whole-sidebar scenarios                                                                        */
/* -------------------------------------------------------------------------------------------- */

describe('sidebar scenarios', () => {
  /** What the sidebar would render for a given set of entries and circumstances. */
  function render(
    entries: ConversationListEntry[],
    options: {
      preferences?: { groups: boolean; chats: boolean };
      searching?: boolean;
      selectedId?: string | null;
    } = {},
  ) {
    const preferences = options.preferences ?? DEFAULT_SECTION_PREFERENCES;
    const searching = options.searching ?? false;
    const selectedId = options.selectedId ?? null;

    return splitConversationSections(entries)
      .filter((section) => isSectionVisible(section, searching))
      .map((section) => ({
        key: section.key,
        unread: section.unreadCount,
        open: resolveSectionOpen({
          preference: preferences[section.key],
          searching,
          hasMatches: section.entries.length > 0,
          containsSelected:
            selectedId !== null && section.entries.some((entry) => entry.id === selectedId),
        }),
        visibleRows: section.entries.map((entry) => entry.id),
      }));
  }

  it('shows a new group under GROUPS, expanding it if it was collapsed', () => {
    // A group has just been created and selected, with GROUPS collapsed beforehand.
    const rendered = render([...mixedEntries(), entry({ id: 'new-group', type: 'GROUP' })], {
      preferences: { groups: false, chats: true },
      selectedId: 'new-group',
    });

    expect(rendered[0]?.key).toBe('groups');
    expect(rendered[0]?.open).toBe(true);
    expect(rendered[0]?.visibleRows).toContain('new-group');
  });

  it('shows a new direct chat under CHATS, expanding it if it was collapsed', () => {
    const rendered = render([...mixedEntries(), entry({ id: 'new-chat' })], {
      preferences: { groups: true, chats: false },
      selectedId: 'new-chat',
    });

    expect(rendered[1]?.key).toBe('chats');
    expect(rendered[1]?.open).toBe(true);
    expect(rendered[1]?.visibleRows).toContain('new-chat');
  });

  it('reports unread on a collapsed GROUPS header', () => {
    const rendered = render(
      [entry({ id: 'g1', type: 'GROUP', unreadCount: 4 }), entry({ id: 'd1' })],
      { preferences: { groups: false, chats: true } },
    );

    // "▸ GROUPS 4" — closed, but not silent.
    expect(rendered[0]).toMatchObject({ key: 'groups', open: false, unread: 4 });
  });

  it('reports unread on a collapsed CHATS header', () => {
    const rendered = render(
      [entry({ id: 'g1', type: 'GROUP' }), entry({ id: 'd1', unreadCount: 2 })],
      { preferences: { groups: true, chats: false } },
    );

    expect(rendered[1]).toMatchObject({ key: 'chats', open: false, unread: 2 });
  });

  it('a search reveals matching rows in BOTH collapsed sections', () => {
    // Both collapsed; the search matched one of each.
    const rendered = render([entry({ id: 'g1', type: 'GROUP' }), entry({ id: 'd1' })], {
      preferences: { groups: false, chats: false },
      searching: true,
    });

    expect(rendered.map((section) => section.key)).toEqual(['groups', 'chats']);
    expect(rendered.every((section) => section.open)).toBe(true);
  });

  it('a search that matches only groups hides the CHATS header entirely', () => {
    const rendered = render([entry({ id: 'g1', type: 'GROUP' })], { searching: true });
    expect(rendered.map((section) => section.key)).toEqual(['groups']);
  });

  it('a search that matches only chats hides the GROUPS header entirely', () => {
    const rendered = render([entry({ id: 'd1' })], { searching: true });
    expect(rendered.map((section) => section.key)).toEqual(['chats']);
  });

  it('clearing the search puts both collapses back', () => {
    const entries = [entry({ id: 'g1', type: 'GROUP' }), entry({ id: 'd1' })];
    const preferences = { groups: false, chats: false };

    expect(render(entries, { preferences, searching: true }).every((s) => s.open)).toBe(true);
    expect(render(entries, { preferences, searching: false }).every((s) => s.open)).toBe(false);
  });

  it('keeps GROUPS above CHATS in every one of these states', () => {
    const entries = mixedEntries();
    const states = [
      { preferences: { groups: true, chats: true } },
      { preferences: { groups: false, chats: true } },
      { preferences: { groups: true, chats: false } },
      { preferences: { groups: false, chats: false } },
      { preferences: { groups: false, chats: false }, searching: true },
      { preferences: { groups: false, chats: false }, selectedId: 'd1' },
    ];

    for (const state of states) {
      expect(render(entries, state).map((section) => section.key)).toEqual(['groups', 'chats']);
    }
  });

  it('updates previews and unread counts without any notion of collapse', () => {
    /*
     * Realtime arrives as new entries; the sections are derived fresh from them. A collapsed
     * section therefore cannot go stale, and cannot suppress an unread count either — which is
     * what keeps expand/collapse presentation-only.
     */
    const before = render([entry({ id: 'g1', type: 'GROUP', preview: 'old', unreadCount: 0 })], {
      preferences: { groups: false, chats: true },
    });
    const after = render([entry({ id: 'g1', type: 'GROUP', preview: 'new message', unreadCount: 1 })], {
      preferences: { groups: false, chats: true },
    });

    expect(before[0]?.unread).toBe(0);
    expect(after[0]?.unread).toBe(1);
    expect(after[0]?.open).toBe(false);
  });
});
