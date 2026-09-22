/**
 * The sidebar's two sections — GROUPS above CHATS — and the rules for when each one is open.
 *
 * Pure. No React, no DOM, no data access. The interface renders what this decides, which is what
 * makes the interesting part testable in a project whose suite runs under `environment: 'node'`
 * and deliberately has no DOM test infrastructure.
 *
 * WHY THE OPEN/CLOSED STATE IS DERIVED RATHER THAN STORED. There are three things that can want a
 * section open, and only one of them is a preference:
 *
 *   1. The employee collapsed or expanded it. That is a preference, and it is remembered.
 *   2. A search is running and this section has matches. Results must not be hidden behind a
 *      collapse the employee set an hour ago for an unrelated reason.
 *   3. The selected conversation lives in it. Leaving somebody reading a conversation whose
 *      sidebar row is hidden is disorienting — they cannot see where they are.
 *
 * Only (1) is written down. (2) and (3) are computed from state that already exists, so they
 * apply while they are true and stop applying when they are not — which is exactly the behaviour
 * asked for on search ("when search is cleared, restore the previous preference") and the honest
 * reading of it for selection too. Storing them would mean a collapse silently rewriting itself
 * whenever somebody ran a search, and no way back to what the employee actually chose.
 *
 * A collapsed section is PRESENTATION ONLY. It changes nothing about delivery, notifications,
 * unread counts or authorization; `sectionUnreadCount` exists precisely so that a collapsed
 * section can still say that something happened inside it.
 */

import type { ConversationListEntry } from '@/lib/chat/state';

/** The two sections, in the order they are rendered. GROUPS is always first. */
export type SidebarSectionKey = 'groups' | 'chats';

/**
 * Render order, stated once as data.
 *
 * "Groups above chats" is a requirement rather than a preference, so it is expressed as a
 * constant the renderer walks instead of a sort that could be handed a different comparator.
 */
export const SIDEBAR_SECTION_ORDER = ['groups', 'chats'] as const satisfies readonly SidebarSectionKey[];

export interface SidebarSection {
  key: SidebarSectionKey;
  /** The heading, e.g. "Groups". Rendered uppercase by CSS, not by shouting in the data. */
  label: string;
  /** Conversations of this kind, in the order they arrived — see `splitConversationSections`. */
  entries: ConversationListEntry[];
  /** Sum of the unread counts inside. What a collapsed header shows. */
  unreadCount: number;
  /** Shown under an expanded, empty section when no search is running. */
  emptyLabel: string;
}

const SECTION_LABELS: Record<SidebarSectionKey, { label: string; emptyLabel: string }> = {
  groups: { label: 'Groups', emptyLabel: 'No groups yet' },
  chats: { label: 'Chats', emptyLabel: 'No chats yet' },
};

/**
 * Splits the sidebar's entries into the two sections.
 *
 * CLASSIFICATION COMES FROM `entry.type`, which is `Conversation.type` — the `DIRECT` | `GROUP`
 * enum the server already sends and the database already enforces. Nothing here looks at a name,
 * a member count, or whether a counterpart could be resolved. A group of one and a direct chat
 * with somebody whose display name happens to read like a team are both classified correctly,
 * and a renamed group does not migrate between sections.
 *
 * ORDER IS PRESERVED, NOT RECOMPUTED. The incoming list is already sorted newest-activity-first
 * by `sortConversations`, and a stable partition keeps each section in exactly that order. No
 * comparator is applied here, so the two sections cannot drift from the ordering the rest of the
 * application uses — and there is no second sort to keep in step with the first.
 *
 * Every entry lands in exactly one section: the type is an enum with two values, and each is
 * routed by an explicit check rather than by "group, otherwise chat".
 */
export function splitConversationSections(
  entries: readonly ConversationListEntry[],
): SidebarSection[] {
  const bucketed: Record<SidebarSectionKey, ConversationListEntry[]> = { groups: [], chats: [] };

  for (const entry of entries) {
    bucketed[entry.type === 'GROUP' ? 'groups' : 'chats'].push(entry);
  }

  return SIDEBAR_SECTION_ORDER.map((key) => ({
    key,
    label: SECTION_LABELS[key].label,
    emptyLabel: SECTION_LABELS[key].emptyLabel,
    entries: bucketed[key],
    unreadCount: sectionUnreadCount(bucketed[key]),
  }));
}

/**
 * Unread messages inside a section.
 *
 * Summed from the same `unreadCount` each row already shows, so a collapsed header and the rows
 * beneath it can never disagree, and nothing new is asked of the database for this.
 */
export function sectionUnreadCount(entries: readonly ConversationListEntry[]): number {
  return entries.reduce((total, entry) => total + Math.max(0, entry.unreadCount), 0);
}

export interface SectionOpenInput {
  /** What the employee last chose for this section. */
  preference: boolean;
  /** True while the search box has a term in it. */
  searching: boolean;
  /** Whether this section has anything matching that term. */
  hasMatches: boolean;
  /** Whether the currently selected conversation is in this section. */
  containsSelected: boolean;
}

/**
 * Whether a section is open right now.
 *
 * The two overrides deliberately do NOT write to the preference — see the note at the top of the
 * file. Both are conditions that stop being true on their own, and when they do the employee's
 * own choice is simply in force again.
 */
export function resolveSectionOpen({
  preference,
  searching,
  hasMatches,
  containsSelected,
}: SectionOpenInput): boolean {
  // A result the employee cannot see is not a result. Overrides a manual collapse.
  if (searching && hasMatches) return true;

  // Never strand somebody in a conversation whose row is hidden.
  if (containsSelected) return true;

  return preference;
}

/**
 * Whether a section is rendered at all.
 *
 * Only ever false during a search, and only for a section with no matches: a bare "Groups" header
 * above nothing is noise when the employee is plainly looking for something else. With no search
 * running both headers always show, because their absence would read as "this application has no
 * groups" rather than "you have none yet" — which is what the empty label is for.
 */
export function isSectionVisible(section: SidebarSection, searching: boolean): boolean {
  return !searching || section.entries.length > 0;
}

/* -------------------------------------------------------------------------------------------- */
/* Persistence                                                                                    */
/* -------------------------------------------------------------------------------------------- */

export type SectionPreferences = Record<SidebarSectionKey, boolean>;

/**
 * Both sections start open.
 *
 * A first-time employee should see their conversations, not two closed drawers they have to
 * discover. Collapsing is the deliberate act, and it is the one worth remembering.
 */
export const DEFAULT_SECTION_PREFERENCES: SectionPreferences = { groups: true, chats: true };

/**
 * One namespaced key holding both flags, matching `cic.notifications` in
 * lib/notifications/preferences.ts rather than inventing a second convention. Two separate keys
 * would also have to be kept in step when one of them is missing or corrupt.
 */
export const SIDEBAR_SECTIONS_KEY = 'cic.sidebar.sections';

/**
 * The storage this module uses. Injectable so the tests can exercise the paths that matter —
 * a store that throws, a store holding junk — which is most of them.
 */
export interface PreferenceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function defaultSectionStore(): PreferenceStore | null {
  try {
    // Touching `localStorage` at all can throw, so even reaching for it is guarded. In a private
    // window, with site data blocked, or during SSR, this is the normal path and not an error.
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Reads the stored preferences, falling back to "expanded" for anything missing or malformed.
 *
 * Field by field rather than trusting the parsed object: what comes back is a string somebody
 * could have edited by hand, and `{"groups": "no"}` must not produce a section that is neither
 * open nor closed. Every failure mode — absent storage, a throwing read, invalid JSON, a
 * non-object, a non-boolean field — lands on the same safe default.
 */
export function loadSectionPreferences(
  store: PreferenceStore | null = defaultSectionStore(),
): SectionPreferences {
  if (!store) return { ...DEFAULT_SECTION_PREFERENCES };

  let raw: string | null;
  try {
    raw = store.getItem(SIDEBAR_SECTIONS_KEY);
  } catch {
    return { ...DEFAULT_SECTION_PREFERENCES };
  }

  if (raw === null) return { ...DEFAULT_SECTION_PREFERENCES };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SECTION_PREFERENCES };
  }

  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_SECTION_PREFERENCES };

  const source = parsed as Record<string, unknown>;
  const read = (key: SidebarSectionKey): boolean =>
    typeof source[key] === 'boolean' ? (source[key] as boolean) : DEFAULT_SECTION_PREFERENCES[key];

  return { groups: read('groups'), chats: read('chats') };
}

/** Writes the preferences. A storage failure is silent: this is a disclosure triangle. */
export function saveSectionPreferences(
  preferences: SectionPreferences,
  store: PreferenceStore | null = defaultSectionStore(),
): void {
  if (!store) return;

  try {
    store.setItem(SIDEBAR_SECTIONS_KEY, JSON.stringify(preferences));
  } catch {
    // Quota exceeded, or site data blocked. The choice still applies for this page's lifetime;
    // it simply will not be remembered, which is better than an error over a collapsed list.
  }
}
