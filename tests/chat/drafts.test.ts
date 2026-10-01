/**
 * Per-conversation drafts (Batch 1.9): the store, the debounce, send safety, and the composer's
 * lifecycle — open, type, switch, send, edit, reload — modelled on fake timers with an in-memory
 * store. No DOM, no database, no socket: drafts touch none of them.
 *
 * `openComposer` below does what MessageComposer does, in the same order, with the same module
 * functions; tests/chat/drafts-wiring.test.ts checks the component really is wired that way.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DRAFTS_KEY,
  DRAFT_SAVE_DELAY_MS,
  MAX_DRAFTS,
  MAX_DRAFT_LENGTH,
  clearDraft,
  createDraftAutosave,
  holdDraftForSend,
  loadDraft,
  openDraft,
  pruneDrafts,
  releaseDeliveredDraft,
  resetSendingDrafts,
  restorableMentions,
  returnUndeliveredDraft,
  saveDraft,
  type ConversationDraft,
  type DraftStore,
} from '@/lib/chat/drafts';
import { resolveMentions, type ConfirmedMention } from '@/lib/chat/mentions';
import { createTypingSignal } from '@/lib/chat/typing';

const ME = 'user-me';
const OTHER_USER = 'user-other';
/** Conversation ids. Two of them deliberately share a title in the tests that care. */
const RAHUL_DM = '11111111-1111-4111-8111-111111111111';
const PRIYA_DM = '22222222-2222-4222-8222-222222222222';
const TEAM_GROUP = '33333333-3333-4333-8333-333333333333';

const GROUP_MEMBERS = [
  { userId: 'u-rahul', displayName: 'Rahul' },
  { userId: 'u-priya', displayName: 'Priya' },
];

/** `localStorage`, minus the browser. `data` survives a "reload": build a new store over it. */
function memoryStore(data: Map<string, string> = new Map()) {
  const store = {
    data,
    writes: 0,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.writes += 1;
      data.set(key, value);
    },
    removeItem: (key: string) => {
      store.writes += 1;
      data.delete(key);
    },
  };
  return store;
}

/** Storage that refuses every call, like a private window with site data blocked. */
const throwingStore: DraftStore = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
  removeItem: () => {
    throw new Error('SecurityError');
  },
};

/**
 * The composer's draft lifecycle, as MessageComposer runs it:
 *   open    → `openDraft` once, as initial state; nothing is signalled
 *   type    → typing signal + debounced save (never while editing)
 *   send    → stop typing, cancel the pending save, hold the text
 *   edit    → stop typing, flush the pending save, then show the message's own text
 *   close   → stop typing, flush the pending save (switching conversation)
 */
function openComposer(
  store: DraftStore,
  conversationId: string,
  options: { members?: typeof GROUP_MEMBERS; typing?: boolean[] } = {},
) {
  const typing = options.typing ?? [];
  const restored = openDraft(ME, conversationId, options.members ?? [], store);
  const signal = createTypingSignal((on) => typing.push(on));
  const autosave = createDraftAutosave((draft) => saveDraft(ME, conversationId, draft, store));

  let text = restored?.text ?? '';
  let mentions: ConfirmedMention[] = restored?.mentions ?? [];
  let editing: { stash: ConversationDraft } | null = null;

  return {
    restored,
    typing,
    get text() {
      return text;
    },
    get mentions() {
      return mentions;
    },
    type(next: string, chosen: ConfirmedMention[] = mentions) {
      text = next;
      mentions = chosen;
      if (editing) return;
      signal.input(next);
      autosave.input({ text: next, mentions: chosen });
    },
    send() {
      const trimmed = text.trim();
      signal.stop();
      autosave.cancel();
      holdDraftForSend(ME, conversationId, { text: trimmed, mentions }, store);
      text = '';
      mentions = [];
      return trimmed;
    },
    beginEdit(messageText: string) {
      editing = { stash: { text, mentions } };
      signal.stop();
      autosave.flush();
      text = messageText;
    },
    endEdit() {
      if (!editing) return;
      ({ text, mentions } = editing.stash);
      editing = null;
    },
    close() {
      signal.stop();
      autosave.flush();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetSendingDrafts();
});

afterEach(() => {
  vi.useRealTimers();
  resetSendingDrafts();
});

/* -------------------------------------------------------------------------------------------- */

describe('drafts per conversation', () => {
  it('1. typing in a conversation saves its draft after a short pause', () => {
    const store = memoryStore();
    const rahul = openComposer(store, RAHUL_DM);

    rahul.type('Please send me the updated');
    expect(loadDraft(ME, RAHUL_DM, store)).toBeNull();

    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    expect(loadDraft(ME, RAHUL_DM, store)?.text).toBe('Please send me the updated');
  });

  it('2-3. each conversation keeps its own draft across switching back and forth', () => {
    const store = memoryStore();

    const rahul = openComposer(store, RAHUL_DM);
    rahul.type('Please send me the updated');
    rahul.close(); // switched away before the debounce — flushed on the way out

    const priya = openComposer(store, PRIYA_DM);
    expect(priya.text).toBe('');
    priya.type('I checked the report');
    priya.close();

    expect(openComposer(store, RAHUL_DM).text).toBe('Please send me the updated');
    expect(openComposer(store, PRIYA_DM).text).toBe('I checked the report');
  });

  it('switching, collapsing or searching never clears a draft — only closing the composer runs', () => {
    const store = memoryStore();
    const rahul = openComposer(store, RAHUL_DM);
    rahul.type('half a thought');
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);

    // Leaving with nothing new typed writes nothing at all.
    const before = store.writes;
    rahul.close();
    expect(store.writes).toBe(before);
    expect(openComposer(store, RAHUL_DM).text).toBe('half a thought');
  });

  it('4. a delivered message clears only its own conversation’s draft', () => {
    const store = memoryStore();
    saveDraft(ME, PRIYA_DM, { text: 'I checked the report', mentions: [] }, store);

    const rahul = openComposer(store, RAHUL_DM);
    rahul.type('Please send me the updated file');
    const sent = rahul.send();

    // Held until the server answers: still stored, but not offered back while in flight.
    expect(loadDraft(ME, RAHUL_DM, store)?.text).toBe(sent);
    expect(openComposer(store, RAHUL_DM).text).toBe('');

    releaseDeliveredDraft(ME, RAHUL_DM, sent, store);
    expect(loadDraft(ME, RAHUL_DM, store)).toBeNull();
    expect(loadDraft(ME, PRIYA_DM, store)?.text).toBe('I checked the report');
  });

  it('a late acknowledgement does not wipe text typed after the send', () => {
    const store = memoryStore();
    const rahul = openComposer(store, RAHUL_DM);
    rahul.type('first');
    const sent = rahul.send();

    rahul.type('second thought');
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    releaseDeliveredDraft(ME, RAHUL_DM, sent, store);

    expect(loadDraft(ME, RAHUL_DM, store)?.text).toBe('second thought');
  });

  it('a pending save is dropped on send, so it cannot resurrect the sent text', () => {
    const store = memoryStore();
    const rahul = openComposer(store, RAHUL_DM);
    rahul.type('quick'); // Enter pressed inside the debounce window
    const sent = rahul.send();
    releaseDeliveredDraft(ME, RAHUL_DM, sent, store);

    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS * 2);
    rahul.close();
    expect(loadDraft(ME, RAHUL_DM, store)).toBeNull();
  });

  it('5. a failed send keeps the text: Retry on screen now, restored as the draft after a reload', () => {
    const data = new Map<string, string>();
    const store = memoryStore(data);
    const rahul = openComposer(store, RAHUL_DM);
    rahul.type('This must not be lost');
    rahul.send();
    // No acknowledgement: the send failed. The failed bubble (with Retry) holds the text on screen.
    rahul.close();

    expect(openComposer(store, RAHUL_DM).text).toBe('');
    expect(loadDraft(ME, RAHUL_DM, store)?.text).toBe('This must not be lost');

    resetSendingDrafts(); // the page reloads; the failed bubble is gone
    expect(openComposer(memoryStore(data), RAHUL_DM).text).toBe('This must not be lost');
  });

  it('a successful Retry clears the held draft', () => {
    const store = memoryStore();
    const rahul = openComposer(store, RAHUL_DM);
    rahul.type('retry me');
    const sent = rahul.send();
    // First attempt failed; nothing released. Retry succeeds:
    releaseDeliveredDraft(ME, RAHUL_DM, sent, store);
    expect(loadDraft(ME, RAHUL_DM, store)).toBeNull();
  });

  it('typing the failed text again by hand makes it an ordinary draft once more', () => {
    const store = memoryStore();
    const rahul = openComposer(store, RAHUL_DM);
    rahul.type('ok');
    rahul.send(); // fails
    rahul.type('ok');
    rahul.close();
    expect(openComposer(store, RAHUL_DM).text).toBe('ok');
  });

  it('6. emptying the composer removes the saved draft', () => {
    const store = memoryStore();
    const rahul = openComposer(store, RAHUL_DM);
    rahul.type('something');
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);

    rahul.type('');
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    expect(loadDraft(ME, RAHUL_DM, store)).toBeNull();
    expect(store.data.has(DRAFTS_KEY)).toBe(false); // no empty shell left behind

    rahul.type('   \n  ');
    rahul.close();
    expect(loadDraft(ME, RAHUL_DM, store)).toBeNull();
  });

  it('7. drafts survive a reload or closing and reopening the application', () => {
    const data = new Map<string, string>();
    const before = openComposer(memoryStore(data), RAHUL_DM);
    before.type('Please send me the updated');
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);

    resetSendingDrafts();
    const after = openComposer(memoryStore(data), RAHUL_DM);
    expect(after.restored).toEqual({ text: 'Please send me the updated', mentions: [] });
    expect(after.text).toBe('Please send me the updated');
  });

  it('8. drafts are keyed by conversation id, never by a display name', () => {
    const store = memoryStore();
    // Two different conversations that would both be titled "Rahul".
    saveDraft(ME, RAHUL_DM, { text: 'to the first Rahul', mentions: [] }, store);
    saveDraft(ME, PRIYA_DM, { text: 'to the second Rahul', mentions: [] }, store);

    const stored = JSON.parse(store.data.get(DRAFTS_KEY) ?? '{}') as {
      drafts: Record<string, unknown>;
    };
    expect(Object.keys(stored.drafts).sort()).toEqual([RAHUL_DM, PRIYA_DM].sort());
    expect(loadDraft(ME, RAHUL_DM, store)?.text).toBe('to the first Rahul');
    expect(loadDraft(ME, PRIYA_DM, store)?.text).toBe('to the second Rahul');
  });

  it('9. one-to-one drafts work, and carry no mentions', () => {
    const store = memoryStore();
    const dm = openComposer(store, RAHUL_DM, { members: [] });
    dm.type('hi @Rahul', [{ kind: 'USER', userId: 'u-rahul', label: 'Rahul' }]);
    dm.close();

    const reopened = openComposer(store, RAHUL_DM, { members: [] });
    expect(reopened.text).toBe('hi @Rahul');
    expect(reopened.mentions).toEqual([]);
  });

  it('10. group drafts work', () => {
    const store = memoryStore();
    const group = openComposer(store, TEAM_GROUP, { members: GROUP_MEMBERS });
    group.type('Team, the deadline moved');
    group.close();

    expect(openComposer(store, TEAM_GROUP, { members: GROUP_MEMBERS }).text).toBe(
      'Team, the deadline moved',
    );
  });

  it('drafts belong to one employee: another user on the same browser sees none', () => {
    const store = memoryStore();
    saveDraft(ME, TEAM_GROUP, { text: 'my private wording', mentions: [] }, store);

    expect(loadDraft(OTHER_USER, TEAM_GROUP, store)).toBeNull();
    saveDraft(OTHER_USER, TEAM_GROUP, { text: 'theirs', mentions: [] }, store);
    expect(store.data.get(DRAFTS_KEY)).not.toContain('my private wording');
    expect(loadDraft(ME, TEAM_GROUP, store)).toBeNull();
  });
});

/* -------------------------------------------------------------------------------------------- */

describe('storage robustness', () => {
  it('11. malformed stored data reads as "no drafts" and is replaced cleanly', () => {
    const junk = [
      'not json',
      '{"v":1',
      'null',
      '42',
      '"a string"',
      '[]',
      '{}',
      '{"v":2,"userId":"user-me","drafts":{}}',
      '{"v":1,"userId":"user-me","drafts":[]}',
      '{"v":1,"userId":"user-me","drafts":null}',
      '{"v":1,"userId":"user-me","drafts":{"x":{"text":5}}}',
    ];

    for (const raw of junk) {
      const store = memoryStore(new Map([[DRAFTS_KEY, raw]]));
      expect(() => openDraft(ME, RAHUL_DM, GROUP_MEMBERS, store), raw).not.toThrow();
      expect(loadDraft(ME, RAHUL_DM, store), raw).toBeNull();

      saveDraft(ME, RAHUL_DM, { text: 'fresh', mentions: [] }, store);
      expect(loadDraft(ME, RAHUL_DM, store)?.text, raw).toBe('fresh');
    }
  });

  it('keeps good entries and drops bad ones, field by field', () => {
    const raw = JSON.stringify({
      v: 1,
      userId: ME,
      drafts: {
        [RAHUL_DM]: {
          text: 'hi @Rahul and @everyone',
          updatedAt: 1,
          mentions: [
            { kind: 'USER', userId: 'u-rahul', label: 'Rahul' },
            { kind: 'USER', userId: null, label: 'Ghost' },
            { kind: 'EVERYONE', userId: null, label: 'everyone' },
            { kind: 'ADMIN', userId: 'x', label: 'x' },
            'nonsense',
          ],
        },
        [PRIYA_DM]: { text: '   ' },
        [TEAM_GROUP]: { text: 'ok', mentions: 'not-an-array', updatedAt: 'yesterday' },
      },
    });
    const store = memoryStore(new Map([[DRAFTS_KEY, raw]]));

    expect(loadDraft(ME, RAHUL_DM, store)?.mentions).toEqual([
      { kind: 'USER', userId: 'u-rahul', label: 'Rahul' },
      { kind: 'EVERYONE', userId: null, label: 'everyone' },
    ]);
    expect(loadDraft(ME, PRIYA_DM, store)).toBeNull();
    expect(loadDraft(ME, TEAM_GROUP, store)).toEqual({ text: 'ok', mentions: [] });
  });

  it('12. unavailable or throwing storage never stops the composer', () => {
    for (const store of [null, throwingStore]) {
      expect(() => openDraft(ME, RAHUL_DM, [], store)).not.toThrow();
      expect(openDraft(ME, RAHUL_DM, [], store)).toBeNull();
      expect(() => saveDraft(ME, RAHUL_DM, { text: 'x', mentions: [] }, store)).not.toThrow();
      expect(() => clearDraft(ME, RAHUL_DM, store)).not.toThrow();
      expect(() => holdDraftForSend(ME, RAHUL_DM, { text: 'x', mentions: [] }, store)).not.toThrow();
      expect(() => releaseDeliveredDraft(ME, RAHUL_DM, 'x', store)).not.toThrow();
      expect(() => pruneDrafts(ME, [], store)).not.toThrow();
    }

    // The full lifecycle on a store that throws: typing, switching and sending all still work.
    const composer = openComposer(throwingStore, RAHUL_DM);
    composer.type('still typing');
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    expect(composer.text).toBe('still typing');
    expect(() => composer.close()).not.toThrow();
    expect(composer.send()).toBe('still typing');
  });

  it('tolerates a stale or unknown conversation id', () => {
    const store = memoryStore();
    expect(openDraft(ME, 'no-such-conversation', [], store)).toBeNull();
    expect(() => releaseDeliveredDraft(ME, 'no-such-conversation', 'x', store)).not.toThrow();
  });

  it('prunes drafts for conversations that are no longer accessible', () => {
    const store = memoryStore();
    saveDraft(ME, RAHUL_DM, { text: 'keep', mentions: [] }, store);
    saveDraft(ME, TEAM_GROUP, { text: 'removed from this group', mentions: [] }, store);

    pruneDrafts(ME, [RAHUL_DM, PRIYA_DM], store);
    expect(loadDraft(ME, RAHUL_DM, store)?.text).toBe('keep');
    expect(loadDraft(ME, TEAM_GROUP, store)).toBeNull();

    const writes = store.writes;
    pruneDrafts(ME, [RAHUL_DM], store);
    expect(store.writes).toBe(writes); // nothing to remove, nothing written
  });

  it('is bounded: newest MAX_DRAFTS conversations, and no oversized text', () => {
    const store = memoryStore();
    for (let index = 0; index < MAX_DRAFTS + 10; index += 1) {
      saveDraft(ME, `conversation-${index}`, { text: `draft ${index}`, mentions: [] }, store, index);
    }

    const stored = JSON.parse(store.data.get(DRAFTS_KEY) ?? '{}') as {
      drafts: Record<string, unknown>;
    };
    expect(Object.keys(stored.drafts)).toHaveLength(MAX_DRAFTS);
    expect(loadDraft(ME, 'conversation-0', store)).toBeNull();
    expect(loadDraft(ME, `conversation-${MAX_DRAFTS + 9}`, store)?.text).toBe(
      `draft ${MAX_DRAFTS + 9}`,
    );

    saveDraft(ME, RAHUL_DM, { text: 'short', mentions: [] }, store);
    saveDraft(ME, RAHUL_DM, { text: 'x'.repeat(MAX_DRAFT_LENGTH + 1), mentions: [] }, store);
    // Not persisted — and the older, shorter version does not come back in its place.
    expect(loadDraft(ME, RAHUL_DM, store)).toBeNull();
  });
});

/* -------------------------------------------------------------------------------------------- */

describe('debounce', () => {
  it('writes once for a burst of typing, not once per key', () => {
    const writes: string[] = [];
    const autosave = createDraftAutosave((draft) => writes.push(draft.text));

    for (const text of ['H', 'He', 'Hel', 'Hell', 'Hello']) {
      autosave.input({ text, mentions: [] });
      vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS - 50);
    }
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(writes).toEqual(['Hello']);
  });

  it('flush writes the pending draft at once; flush or cancel with nothing pending writes nothing', () => {
    const writes: string[] = [];
    const autosave = createDraftAutosave((draft) => writes.push(draft.text));

    autosave.flush();
    autosave.input({ text: 'pending', mentions: [] });
    autosave.flush();
    autosave.flush();
    expect(writes).toEqual(['pending']);

    autosave.input({ text: 'dropped', mentions: [] });
    autosave.cancel();
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS * 2);
    expect(writes).toEqual(['pending']);
  });

  it('stays in the 200–500 ms range', () => {
    expect(DRAFT_SAVE_DELAY_MS).toBeGreaterThanOrEqual(200);
    expect(DRAFT_SAVE_DELAY_MS).toBeLessThanOrEqual(500);
  });
});

/* -------------------------------------------------------------------------------------------- */

describe('typing indicators (Batch 1.8) stay separate from drafts', () => {
  it('13. reopening a saved draft does not announce typing', () => {
    const store = memoryStore();
    saveDraft(ME, RAHUL_DM, { text: 'Please send me the updated', mentions: [] }, store);

    const typing: boolean[] = [];
    const rahul = openComposer(store, RAHUL_DM, { typing });
    expect(rahul.text).toBe('Please send me the updated');
    vi.advanceTimersByTime(10_000);
    expect(typing).toEqual([]);
  });

  it('14. editing a restored draft starts typing as usual', () => {
    const store = memoryStore();
    saveDraft(ME, RAHUL_DM, { text: 'Please send me the updated', mentions: [] }, store);

    const typing: boolean[] = [];
    const rahul = openComposer(store, RAHUL_DM, { typing });
    rahul.type('Please send me the updated report');
    expect(typing).toEqual([true]);
  });

  it('15. switching conversations still stops typing — and keeps the draft', () => {
    const store = memoryStore();
    const typing: boolean[] = [];
    const rahul = openComposer(store, RAHUL_DM, { typing });
    rahul.type('mid sentence');
    rahul.close();

    expect(typing).toEqual([true, false]);
    expect(loadDraft(ME, RAHUL_DM, store)?.text).toBe('mid sentence');
  });

  it('the stop when typing pauses does not touch the draft', () => {
    const store = memoryStore();
    const typing: boolean[] = [];
    const rahul = openComposer(store, RAHUL_DM, { typing });
    rahul.type('pausing here');
    vi.advanceTimersByTime(10_000);

    expect(typing).toEqual([true, false]);
    expect(loadDraft(ME, RAHUL_DM, store)?.text).toBe('pausing here');
  });
});

/* -------------------------------------------------------------------------------------------- */

describe('mentions (Batch 1.7) in a restored draft', () => {
  const rahul: ConfirmedMention = { kind: 'USER', userId: 'u-rahul', label: 'Rahul' };
  const everyone: ConfirmedMention = { kind: 'EVERYONE', userId: null, label: 'everyone' };

  it('16. @name and @everyone come back as real mentions with correct offsets', () => {
    const store = memoryStore();
    const group = openComposer(store, TEAM_GROUP, { members: GROUP_MEMBERS });
    group.type('@Rahul please check, @everyone FYI', [rahul, everyone]);
    group.close();

    const reopened = openComposer(store, TEAM_GROUP, { members: GROUP_MEMBERS });
    expect(reopened.text).toBe('@Rahul please check, @everyone FYI');
    expect(reopened.mentions).toEqual([rahul, everyone]);

    const payload = resolveMentions(reopened.text, reopened.mentions);
    expect(payload).toEqual([
      { kind: 'USER', userId: 'u-rahul', startOffset: 0, endOffset: 6 },
      { kind: 'EVERYONE', userId: null, startOffset: 21, endOffset: 30 },
    ]);
  });

  it('only stores chosen mentions still present in the text', () => {
    const store = memoryStore();
    saveDraft(ME, TEAM_GROUP, { text: 'nobody named any more', mentions: [rahul, everyone] }, store);
    expect(loadDraft(ME, TEAM_GROUP, store)?.mentions).toEqual([]);
  });

  it('drops a restored mention the server would refuse: left the group, or renamed', () => {
    const left = restorableMentions([rahul, everyone], [{ userId: 'u-priya', displayName: 'Priya' }]);
    expect(left).toEqual([everyone]);

    const renamed = restorableMentions([rahul], [{ userId: 'u-rahul', displayName: 'Rahul Shah' }]);
    expect(renamed).toEqual([]);

    // A direct conversation has nobody to mention at all.
    expect(restorableMentions([rahul, everyone], [])).toEqual([]);
  });

  it('a hand-typed "@Rahul" was never a mention, and does not become one on restore', () => {
    const store = memoryStore();
    const group = openComposer(store, TEAM_GROUP, { members: GROUP_MEMBERS });
    group.type('ask @Rahul', []);
    group.close();

    const reopened = openComposer(store, TEAM_GROUP, { members: GROUP_MEMBERS });
    expect(resolveMentions(reopened.text, reopened.mentions)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------- */

describe('reply, edit and attachments', () => {
  it('17. replying does not touch another conversation’s draft', () => {
    const store = memoryStore();
    saveDraft(ME, PRIYA_DM, { text: 'Priya draft', mentions: [] }, store);

    // Reply mode is session state: the composer's text is the reply's text, sent the normal way.
    const rahul = openComposer(store, RAHUL_DM);
    rahul.type('Replying to that');
    const sent = rahul.send();
    releaseDeliveredDraft(ME, RAHUL_DM, sent, store);

    expect(loadDraft(ME, RAHUL_DM, store)).toBeNull();
    expect(loadDraft(ME, PRIYA_DM, store)?.text).toBe('Priya draft');
  });

  it('18. editing a message never becomes the saved draft, and the draft comes back after', () => {
    const store = memoryStore();
    const typing: boolean[] = [];
    const rahul = openComposer(store, RAHUL_DM, { typing });
    rahul.type('my normal draft');
    // Edit mode begins inside the debounce window: the normal draft is saved first.
    rahul.beginEdit('the old message text');
    expect(loadDraft(ME, RAHUL_DM, store)?.text).toBe('my normal draft');

    rahul.type('the old message text, corrected');
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS * 2);
    expect(loadDraft(ME, RAHUL_DM, store)?.text).toBe('my normal draft');
    expect(typing).toEqual([true, false]); // editing is not typing

    // Leaving the conversation mid-edit keeps the normal draft, not the edit.
    rahul.close();
    expect(openComposer(store, RAHUL_DM).text).toBe('my normal draft');

    rahul.endEdit();
    expect(rahul.text).toBe('my normal draft');
  });

  it('19. a file with a caption holds the caption until the upload succeeds', () => {
    const store = memoryStore();
    const rahul = openComposer(store, RAHUL_DM);
    rahul.type('Here is the report');
    const caption = rahul.send();

    expect(openComposer(store, RAHUL_DM).text).toBe(''); // uploading
    releaseDeliveredDraft(ME, RAHUL_DM, caption, store);
    expect(loadDraft(ME, RAHUL_DM, store)).toBeNull();
  });

  it('a failed or cancelled upload gives its caption back to the composer', () => {
    const store = memoryStore();
    const rahul = openComposer(store, RAHUL_DM);
    rahul.type('Here is the report');
    const caption = rahul.send();

    returnUndeliveredDraft(ME, RAHUL_DM, caption);
    expect(openComposer(store, RAHUL_DM).text).toBe('Here is the report');
  });

  it('a file sent with no caption clears a stale draft rather than keeping it', () => {
    const store = memoryStore();
    const rahul = openComposer(store, RAHUL_DM);
    rahul.type('typed then deleted');
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    rahul.type(''); // emptied, and Send pressed with a file before the debounce ran
    expect(rahul.send()).toBe('');

    expect(loadDraft(ME, RAHUL_DM, store)).toBeNull();
  });
});
