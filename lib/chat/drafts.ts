/**
 * Per-conversation drafts (Batch 1.9) — the unsent text in each conversation's composer.
 *
 * WHERE THESE LIVE, AND WHY NOT POSTGRESQL. A draft is private, unfinished, and belongs to the
 * device it was typed on. Nobody else may see it, nothing needs it backed up, and sending it to
 * the server before the employee presses Send would turn "I have not said this yet" into "the
 * server has a copy". So: `localStorage`, under one namespaced key, read defensively exactly like
 * the sidebar and notification preferences — reading storage can THROW in a private window or
 * with site data blocked, and a draft must never be the reason the chat fails to open. No model,
 * no migration, no endpoint, no socket event. The desktop client keeps its storage in a
 * persistent partition (desktop/main.ts), so drafts survive closing the application there too.
 *
 * KEYED BY CONVERSATION ID, the stable server id — never by a title, which changes when a group
 * is renamed and collides when two colleagues share a name.
 *
 * OWNED BY ONE USER. The stored value records whose drafts these are. A browser profile assigned
 * to somebody else reads nothing back (and its first save replaces the lot), so a shared group
 * can never show one employee's half-written sentence in another employee's composer.
 *
 * WHAT IS STORED: the text, plus the MINIMUM mention metadata needed for a restored draft to
 * behave like the one that was left — which names were actually chosen from the picker (see
 * `ConfirmedMention`). Re-parsing the text is not enough: "@Rahul" typed by hand is plain text,
 * and only a choice from the picker makes it a mention (lib/chat/mentions.ts). Restored mentions
 * are re-checked against the group's CURRENT members before the composer gets them, because the
 * server refuses a whole message that mentions somebody who has left or been renamed.
 *
 * Not stored: reply targets, edit state, or attachments. A browser `File` cannot be put back after
 * a reload, and pretending otherwise would be worse than not trying; a reply quotes a message the
 * session may no longer have loaded. Both stay exactly as they were before this batch.
 *
 * SEND SAFETY. A draft is not removed when Send is pressed — the composer empties at once, as it
 * always has, but the stored copy is held until the server accepts the message (the existing
 * acknowledgement in lib/chat/useChatSession.ts) and is removed only then, and only if the
 * employee has not typed something new in the meantime. A failed text message already stays on
 * screen with Retry, so while this page is open the held copy is not put back into the composer
 * as well (that would invite sending it twice); after a reload, when that failed bubble is gone,
 * the held copy is restored as the draft and nothing typed is lost.
 *
 * BOUNDED. Empty drafts are deleted rather than stored, at most `MAX_DRAFTS` conversations are
 * kept (the most recently edited win), text beyond `MAX_DRAFT_LENGTH` is not persisted, and
 * drafts for conversations the employee can no longer open are pruned when the conversation list
 * is loaded.
 *
 * NEVER LOGGED. Nothing in this module logs, and nothing here reports draft text anywhere.
 */

import type { ConfirmedMention } from '@/lib/chat/mentions';

/** One namespaced key, matching `cic.notifications` and `cic.sidebar.sections`. */
export const DRAFTS_KEY = 'cic.chat.drafts';

/**
 * How long typing must pause before the draft is written.
 *
 * Short enough that a crash or a closed laptop loses at most a few keystrokes, long enough that a
 * burst of typing is one write instead of one per key. Pending writes are also flushed when the
 * composer closes and when the page is hidden, so the delay never costs a draft on its own.
 */
export const DRAFT_SAVE_DELAY_MS = 300;

/** Conversations whose drafts are kept. Far more than anybody leaves half-written at once. */
export const MAX_DRAFTS = 50;

/**
 * Longest draft that is persisted, in characters.
 *
 * Several times the 4,000-character message limit, so anything a person could plausibly be
 * working down to a sendable length is kept, while a pasted megabyte cannot fill the storage that
 * every other draft shares. A longer text still stays in the composer; it is just not saved.
 */
export const MAX_DRAFT_LENGTH = 20_000;

/** The same cap the server applies to one message (lib/messages/mentions.ts). */
const MAX_STORED_MENTIONS = 20;

const STORE_VERSION = 1;

export interface ConversationDraft {
  text: string;
  /** Picker choices still present in `text`. Empty for a draft with no mentions. */
  mentions: ConfirmedMention[];
}

interface StoredDraft extends ConversationDraft {
  /** Epoch milliseconds. Decides which drafts survive the cap. */
  updatedAt: number;
}

/**
 * The storage this module uses. Injectable so the tests can exercise the paths that matter —
 * a store that throws, a store holding junk.
 */
export interface DraftStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function defaultDraftStore(): DraftStore | null {
  try {
    // Touching `localStorage` at all can throw, so even reaching for it is guarded.
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Text that this page has sent and the server has not yet accepted, by user and conversation.
 *
 * In memory on purpose. It exists so a composer reopened while that text is in flight — or still
 * shown as a failed bubble with Retry — does not put the same words back for a second send. A
 * reload empties it, and that is the point: after a reload there is no bubble, so the held draft
 * is restored. Set only by `holdDraftForSend`; any other save of the draft clears it.
 */
const sending = new Map<string, string>();

function sendingKey(userId: string, conversationId: string): string {
  return `${userId}\u0000${conversationId}`;
}

/* -------------------------------------------------------------------------------------------- */
/* Reading and writing the stored value                                                           */
/* -------------------------------------------------------------------------------------------- */

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

function readMention(value: unknown): ConfirmedMention | null {
  if (typeof value !== 'object' || value === null) return null;
  const source = value as Record<string, unknown>;

  if (typeof source.label !== 'string' || source.label.length === 0) return null;
  if (source.kind === 'EVERYONE' && source.userId === null) {
    return { kind: 'EVERYONE', userId: null, label: source.label };
  }
  if (source.kind === 'USER' && typeof source.userId === 'string' && source.userId.length > 0) {
    return { kind: 'USER', userId: source.userId, label: source.label };
  }
  return null;
}

function readEntry(value: unknown): StoredDraft | null {
  if (typeof value !== 'object' || value === null) return null;
  const source = value as Record<string, unknown>;

  if (typeof source.text !== 'string' || isBlank(source.text)) return null;
  if (source.text.length > MAX_DRAFT_LENGTH) return null;

  const mentions = Array.isArray(source.mentions)
    ? source.mentions
        .slice(0, MAX_STORED_MENTIONS)
        .map(readMention)
        .filter((mention): mention is ConfirmedMention => mention !== null)
    : [];

  const updatedAt =
    typeof source.updatedAt === 'number' && Number.isFinite(source.updatedAt) ? source.updatedAt : 0;

  return { text: source.text, mentions, updatedAt };
}

/**
 * Every stored draft belonging to `userId`, entry by entry.
 *
 * Each field is checked rather than trusting the parsed object: the value is a string anybody can
 * edit in the browser's storage inspector. Anything unreadable — absent storage, a throwing read,
 * invalid JSON, another user's drafts, a malformed entry — reads as "no draft", never as an error.
 */
function readAll(userId: string, store: DraftStore | null): Map<string, StoredDraft> {
  const drafts = new Map<string, StoredDraft>();
  if (!store) return drafts;

  let raw: string | null;
  try {
    raw = store.getItem(DRAFTS_KEY);
  } catch {
    return drafts;
  }
  if (raw === null) return drafts;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return drafts;
  }

  if (typeof parsed !== 'object' || parsed === null) return drafts;
  const root = parsed as Record<string, unknown>;
  if (root.v !== STORE_VERSION || root.userId !== userId) return drafts;
  if (typeof root.drafts !== 'object' || root.drafts === null || Array.isArray(root.drafts)) {
    return drafts;
  }

  for (const [conversationId, value] of Object.entries(root.drafts as Record<string, unknown>)) {
    const entry = readEntry(value);
    if (entry) drafts.set(conversationId, entry);
  }
  return drafts;
}

/** Writes the drafts back, newest `MAX_DRAFTS` only. A storage failure is silent. */
function writeAll(userId: string, drafts: Map<string, StoredDraft>, store: DraftStore | null): void {
  if (!store) return;

  try {
    if (drafts.size === 0) {
      store.removeItem(DRAFTS_KEY);
      return;
    }

    const kept = [...drafts]
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_DRAFTS);

    store.setItem(
      DRAFTS_KEY,
      JSON.stringify({ v: STORE_VERSION, userId, drafts: Object.fromEntries(kept) }),
    );
  } catch {
    // Quota exceeded, or site data blocked. The text is still in the composer; it simply will
    // not be remembered, which is better than an error in the middle of typing.
  }
}

/** Only the chosen mentions whose `@label` is still somewhere in the text. */
function mentionsStillInText(text: string, mentions: readonly ConfirmedMention[]): ConfirmedMention[] {
  return mentions
    .filter((mention) => text.includes(`@${mention.label}`))
    .slice(0, MAX_STORED_MENTIONS)
    .map((mention) => ({ kind: mention.kind, userId: mention.userId, label: mention.label }));
}

/* -------------------------------------------------------------------------------------------- */
/* Public operations                                                                              */
/* -------------------------------------------------------------------------------------------- */

/** The stored draft for one conversation, or null. */
export function loadDraft(
  userId: string,
  conversationId: string,
  store: DraftStore | null = defaultDraftStore(),
): ConversationDraft | null {
  const entry = readAll(userId, store).get(conversationId);
  return entry ? { text: entry.text, mentions: entry.mentions } : null;
}

/**
 * Saves one conversation's draft. Blank text DELETES it — an emptied composer has no draft — and
 * so does text too long to persist, rather than leaving an older, shorter version to come back.
 *
 * Whatever is saved here is the conversation's draft from now on, so it is no longer "the text
 * being sent" (see `holdDraftForSend`) even if the words happen to be the same.
 */
export function saveDraft(
  userId: string,
  conversationId: string,
  draft: ConversationDraft,
  store: DraftStore | null = defaultDraftStore(),
  now: number = Date.now(),
): void {
  sending.delete(sendingKey(userId, conversationId));
  if (!store) return;
  const drafts = readAll(userId, store);

  if (isBlank(draft.text) || draft.text.length > MAX_DRAFT_LENGTH) {
    if (!drafts.delete(conversationId)) return;
  } else {
    drafts.set(conversationId, {
      text: draft.text,
      mentions: mentionsStillInText(draft.text, draft.mentions),
      updatedAt: now,
    });
  }

  writeAll(userId, drafts, store);
}

export function clearDraft(
  userId: string,
  conversationId: string,
  store: DraftStore | null = defaultDraftStore(),
): void {
  saveDraft(userId, conversationId, { text: '', mentions: [] }, store);
}

/**
 * Removes drafts for every conversation not in `accessibleConversationIds`.
 *
 * Called only with the FULL list the server just returned — never with a partial or empty list
 * from before it loaded, which would wipe everything.
 */
export function pruneDrafts(
  userId: string,
  accessibleConversationIds: Iterable<string>,
  store: DraftStore | null = defaultDraftStore(),
): void {
  if (!store) return;
  const keep = new Set(accessibleConversationIds);
  const drafts = readAll(userId, store);

  let changed = false;
  for (const conversationId of [...drafts.keys()]) {
    if (keep.has(conversationId)) continue;
    drafts.delete(conversationId);
    changed = true;
  }

  if (changed) writeAll(userId, drafts, store);
}

/* -------------------------------------------------------------------------------------------- */
/* Send safety                                                                                    */
/* -------------------------------------------------------------------------------------------- */

/**
 * The composer is sending this text. Stores it as the draft — so a crash or a failed send loses
 * nothing — and remembers it is in flight. Blank text (a file with no caption) simply clears.
 */
export function holdDraftForSend(
  userId: string,
  conversationId: string,
  draft: ConversationDraft,
  store: DraftStore | null = defaultDraftStore(),
  now: number = Date.now(),
): void {
  if (isBlank(draft.text)) {
    clearDraft(userId, conversationId, store);
    return;
  }

  saveDraft(userId, conversationId, draft, store, now);
  sending.set(sendingKey(userId, conversationId), draft.text);
}

/**
 * The server accepted `text`. Its held draft goes — unless the employee has typed something else
 * since, in which case the newer draft is theirs and is left alone.
 */
export function releaseDeliveredDraft(
  userId: string,
  conversationId: string,
  text: string,
  store: DraftStore | null = defaultDraftStore(),
): void {
  const key = sendingKey(userId, conversationId);
  if (sending.get(key) === text) sending.delete(key);

  if (loadDraft(userId, conversationId, store)?.text === text) {
    clearDraft(userId, conversationId, store);
  }
}

/**
 * A send failed and nothing on screen offers to retry it — a failed or cancelled upload. The held
 * text is no longer "in flight", so the next time this conversation's composer opens it comes
 * back as the draft.
 */
export function returnUndeliveredDraft(userId: string, conversationId: string, text: string): void {
  const key = sendingKey(userId, conversationId);
  if (sending.get(key) === text) sending.delete(key);
}

/** Forgets every in-flight marker. Tests only — a page reload does this in real use. */
export function resetSendingDrafts(): void {
  sending.clear();
}

/* -------------------------------------------------------------------------------------------- */
/* Opening a composer                                                                             */
/* -------------------------------------------------------------------------------------------- */

/**
 * Keeps only the restored mentions the server would still accept.
 *
 * A USER mention survives only when that person is still an active member AND the chosen label is
 * still exactly their name — the server refuses a whole message otherwise. Dropping one leaves
 * the text alone: "@Rahul" stays on screen as plain text and can be chosen again from the picker.
 * `@everyone` survives in any group with somebody to address. No members (a direct conversation)
 * means no mentions at all, as the picker already enforces.
 */
export function restorableMentions(
  mentions: readonly ConfirmedMention[],
  members: readonly { userId: string; displayName: string }[],
): ConfirmedMention[] {
  if (members.length === 0) return [];
  const nameById = new Map(members.map((member) => [member.userId, member.displayName]));

  return mentions.filter((mention) =>
    mention.kind === 'EVERYONE'
      ? true
      : mention.userId !== null && nameById.get(mention.userId) === mention.label,
  );
}

/**
 * What a composer opening on `conversationId` should show, or null for an empty composer.
 *
 * Null too when the stored text is the very text this page is still sending (or failed to send
 * and is offering to retry) — see `sending` above.
 */
export function openDraft(
  userId: string,
  conversationId: string,
  members: readonly { userId: string; displayName: string }[],
  store: DraftStore | null = defaultDraftStore(),
): ConversationDraft | null {
  const draft = loadDraft(userId, conversationId, store);
  if (!draft) return null;
  if (sending.get(sendingKey(userId, conversationId)) === draft.text) return null;

  return { text: draft.text, mentions: restorableMentions(draft.mentions, members) };
}

/* -------------------------------------------------------------------------------------------- */
/* Debounced saving                                                                               */
/* -------------------------------------------------------------------------------------------- */

export interface DraftAutosave {
  /** The employee changed the draft. Written after `delayMs` without another change. */
  input(draft: ConversationDraft): void;
  /** Writes a pending change now. On leaving the conversation, hiding the page, or editing. */
  flush(): void;
  /** Drops a pending change unwritten. On send, where the held copy replaces it. */
  cancel(): void;
}

/**
 * One per composer. Holds at most one pending draft and one timer; `flush` with nothing pending
 * writes nothing, which is what keeps a composer that was emptied by SENDING (not by the employee)
 * from deleting the held copy on its way out.
 */
export function createDraftAutosave(
  write: (draft: ConversationDraft) => void,
  delayMs: number = DRAFT_SAVE_DELAY_MS,
): DraftAutosave {
  let pending: ConversationDraft | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const flush = () => {
    clearTimer();
    if (pending === null) return;
    const draft = pending;
    pending = null;
    write(draft);
  };

  return {
    input(draft) {
      pending = draft;
      clearTimer();
      timer = setTimeout(flush, delayMs);
    },
    flush,
    cancel() {
      clearTimer();
      pending = null;
    },
  };
}
