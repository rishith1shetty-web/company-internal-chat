/**
 * The composer's mention rules: when the picker opens, what it offers, and what gets sent
 * (Batch 1.7).
 *
 * All of it is pure, so all of it is tested properly rather than structurally. The two ideas the
 * module is built on are the two most worth attacking here:
 *
 *   - A mention is CONFIRMED, never guessed. Typing "@Nilesh" by hand is text; choosing Nilesh
 *     from the picker is a mention. That is what keeps "user@example.com" and "meet @ the desk"
 *     out of the notification system.
 *   - Offsets are RESOLVED AT SEND TIME, so editing text before, after or through a mention all
 *     come out right — there is no remembered span to go stale.
 *
 * What is NOT tested here: the rendered popup, arrow keys and mouse clicks, which live in a React
 * component. The project has no DOM test environment by design; those are asserted structurally
 * in `mentions-wiring.test.ts` and listed in the manual smoke test.
 */

import { describe, expect, it } from 'vitest';

import {
  applyMention,
  filterMentionCandidates,
  findMentionTrigger,
  mentionsEveryone,
  mentionsUser,
  resolveMentions,
  segmentMessageBody,
  MENTION_EVERYONE_TOKEN,
  MENTION_QUERY_MAX_LENGTH,
  type ConfirmedMention,
} from '@/lib/chat/mentions';
import type { MentionWire } from '@/lib/chat/wire';

const NILESH = { userId: 'u-nilesh', displayName: 'Nilesh' };
const HARSH = { userId: 'u-harsh', displayName: 'Harsh' };
const SUMIT = { userId: 'u-sumit', displayName: 'Sumit Vishwakarma' };
const PARWINDER = { userId: 'u-parw', displayName: 'Parwinder' };

const MEMBERS = [PARWINDER, NILESH, SUMIT, HARSH];

const everyone: ConfirmedMention = {
  userId: null,
  label: MENTION_EVERYONE_TOKEN,
  kind: 'EVERYONE',
};
const nilesh: ConfirmedMention = { userId: NILESH.userId, label: 'Nilesh', kind: 'USER' };
const harsh: ConfirmedMention = { userId: HARSH.userId, label: 'Harsh', kind: 'USER' };
const sumit: ConfirmedMention = { userId: SUMIT.userId, label: 'Sumit Vishwakarma', kind: 'USER' };

/* -------------------------------------------------------------------------------------------- */
/* 25, 42 — when the picker opens                                                                 */
/* -------------------------------------------------------------------------------------------- */

describe('when an @ starts a mention', () => {
  it('opens on a bare @ at the start', () => {
    expect(findMentionTrigger('@', 1)).toEqual({ start: 0, query: '' });
  });

  it('opens on an @ after a space, mid-sentence', () => {
    const value = 'Hi @';
    expect(findMentionTrigger(value, value.length)).toEqual({ start: 3, query: '' });
  });

  it('opens after a newline, so a multiline draft still works', () => {
    const value = 'first line\n@ni';
    expect(findMentionTrigger(value, value.length)).toEqual({ start: 11, query: 'ni' });
  });

  it('collects what has been typed so far as the query', () => {
    const value = 'Hi @nil';
    expect(findMentionTrigger(value, value.length)).toEqual({ start: 3, query: 'nil' });
  });

  it('DOES NOT open inside an email address', () => {
    // The `@` does not begin a word, so it is an address and not a mention.
    for (const value of ['user@example.com', 'mail me at user@exa', 'a@b']) {
      expect(findMentionTrigger(value, value.length), value).toBeNull();
    }
  });

  it('does not open when the caret has moved past a completed word', () => {
    const value = '@Nilesh hello';
    // The caret is after "hello", which contains no `@`.
    expect(findMentionTrigger(value, value.length)).toBeNull();
  });

  it('REOPENS when the caret moves back into the mention being typed', () => {
    const value = '@nil hello';
    expect(findMentionTrigger(value, 4)).toEqual({ start: 0, query: 'nil' });
  });

  it('gives up once the query grows longer than a name', () => {
    const long = `@${'x'.repeat(MENTION_QUERY_MAX_LENGTH + 1)}`;
    expect(findMentionTrigger(long, long.length)).toBeNull();
  });

  it('gives up at a space, so a finished word is not a query', () => {
    const value = '@sumit v';
    expect(findMentionTrigger(value, value.length)).toBeNull();
  });

  it('returns null for an out-of-range caret rather than throwing', () => {
    expect(findMentionTrigger('hello', 99)).toBeNull();
    expect(findMentionTrigger('hello', -1)).toBeNull();
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 26-32 — what the picker offers                                                                 */
/* -------------------------------------------------------------------------------------------- */

describe('what the picker offers', () => {
  it('offers @everyone FIRST, then members alphabetically', () => {
    const candidates = filterMentionCandidates(MEMBERS, '');

    expect(candidates.map((candidate) => candidate.label)).toEqual([
      'everyone',
      'Harsh',
      'Nilesh',
      'Parwinder',
      'Sumit Vishwakarma',
    ]);
    expect(candidates[0]?.kind).toBe('EVERYONE');
  });

  it('offers NOTHING when there are no members — which is a direct conversation', () => {
    /*
     * The group-only rule, expressed as data rather than as a condition: the workspace passes an
     * empty member list for a direct conversation, so there is nothing to suggest and the picker
     * never opens. Not even @everyone, which would mean "the other person".
     */
    expect(filterMentionCandidates([], '')).toEqual([]);
    expect(filterMentionCandidates([], 'ni')).toEqual([]);
  });

  it('filters to the matching member', () => {
    expect(filterMentionCandidates(MEMBERS, 'ni').map((c) => c.label)).toEqual(['Nilesh']);
  });

  it('is case-insensitive', () => {
    for (const query of ['ni', 'NI', 'Ni', 'nI']) {
      expect(filterMentionCandidates(MEMBERS, query).map((c) => c.label), query).toEqual([
        'Nilesh',
      ]);
    }
  });

  it('matches anywhere in the name, including after a space', () => {
    expect(filterMentionCandidates(MEMBERS, 'vish').map((c) => c.label)).toEqual([
      'Sumit Vishwakarma',
    ]);
  });

  it('keeps @everyone while its own name still matches, and drops it after', () => {
    expect(filterMentionCandidates(MEMBERS, 'ever')[0]?.kind).toBe('EVERYONE');
    expect(filterMentionCandidates(MEMBERS, 'ni').some((c) => c.kind === 'EVERYONE')).toBe(false);
  });

  it('returns nothing when the query matches nobody', () => {
    expect(filterMentionCandidates(MEMBERS, 'zzz')).toEqual([]);
  });

  it('carries a description for @everyone and none for a person', () => {
    const [first, ...people] = filterMentionCandidates(MEMBERS, '');
    expect(first?.description).toContain('all members');
    expect(people.every((candidate) => candidate.description === undefined)).toBe(true);
  });

  it('offers only the members it is given — there is no directory here', () => {
    // The caller passes active members of the open group, minus the sender. Nothing widens that.
    const only = filterMentionCandidates([NILESH], '');
    expect(only.map((c) => c.label)).toEqual(['everyone', 'Nilesh']);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 37, 38, 39 — inserting                                                                         */
/* -------------------------------------------------------------------------------------------- */

describe('inserting a chosen mention', () => {
  const candidate = { userId: NILESH.userId, label: 'Nilesh', kind: 'USER' as const };

  it('replaces the partial query AT THE CARET, preserving both sides', () => {
    const value = 'Hi @ni can you review this?';
    const trigger = findMentionTrigger(value, 6);
    expect(trigger).not.toBeNull();

    const result = applyMention(value, trigger!, 6, candidate);

    expect(result.value).toBe('Hi @Nilesh can you review this?');
    // Caret just past the inserted name, ready to keep typing.
    expect(result.value.slice(0, result.cursor)).toBe('Hi @Nilesh');
  });

  it('adds a trailing space when the mention ends the draft', () => {
    const value = '@ni';
    const result = applyMention(value, findMentionTrigger(value, 3)!, 3, candidate);

    expect(result.value).toBe('@Nilesh ');
    expect(result.cursor).toBe('@Nilesh '.length);
  });

  it('does NOT add a second space when one already follows', () => {
    const value = '@ni hello';
    const result = applyMention(value, findMentionTrigger(value, 3)!, 3, candidate);
    expect(result.value).toBe('@Nilesh hello');
  });

  it('preserves a MULTILINE draft around the insertion', () => {
    const value = 'line one\n@ni\nline three';
    const trigger = findMentionTrigger(value, 12)!;
    const result = applyMention(value, trigger, 12, candidate);

    expect(result.value).toBe('line one\n@Nilesh \nline three');
  });

  it('inserts a name containing spaces whole', () => {
    const value = 'cc @sum please';
    const trigger = findMentionTrigger(value, 7)!;
    const result = applyMention(value, trigger, 7, {
      userId: SUMIT.userId,
      label: 'Sumit Vishwakarma',
      kind: 'USER',
    });

    expect(result.value).toBe('cc @Sumit Vishwakarma please');
  });

  it('reports what was confirmed, so the target is remembered and the text is not re-parsed', () => {
    const value = '@ni';
    const result = applyMention(value, findMentionTrigger(value, 3)!, 3, candidate);

    expect(result.confirmed).toEqual({ userId: NILESH.userId, label: 'Nilesh', kind: 'USER' });
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 40, 41, 42 — what actually gets sent                                                           */
/* -------------------------------------------------------------------------------------------- */

describe('resolving what is sent', () => {
  it('finds a confirmed mention and reports its exact span', () => {
    const body = 'Hi @Nilesh can you review this?';
    const [mention] = resolveMentions(body, [nilesh]);

    expect(mention).toEqual({
      kind: 'USER',
      userId: NILESH.userId,
      startOffset: 3,
      endOffset: 10,
    });
    expect(body.slice(mention!.startOffset, mention!.endOffset)).toBe('@Nilesh');
  });

  it('finds SEVERAL mentions, in order', () => {
    const body = '@Nilesh and @Harsh please check.';
    const found = resolveMentions(body, [nilesh, harsh]);

    expect(found.map((m) => body.slice(m.startOffset, m.endOffset))).toEqual([
      '@Nilesh',
      '@Harsh',
    ]);
  });

  it('finds @everyone in the middle of a sentence', () => {
    const body = 'quick note for @everyone about Friday';
    const [mention] = resolveMentions(body, [everyone]);

    expect(mention?.kind).toBe('EVERYONE');
    expect(mention?.userId).toBeNull();
    expect(body.slice(mention!.startOffset, mention!.endOffset)).toBe('@everyone');
  });

  it('returns EVERY occurrence when somebody is mentioned twice', () => {
    // Both are highlighted; the server reduces them to one recipient.
    const body = '@Nilesh please ask @Nilesh';
    expect(resolveMentions(body, [nilesh])).toHaveLength(2);
  });

  it('IGNORES text that was never confirmed', () => {
    /*
     * The rule the whole design rests on. Typing "@Nilesh" by hand — or pasting it, or quoting
     * somebody else's message — is text. Only a name chosen from the picker is a mention.
     */
    expect(resolveMentions('@Nilesh please review', [])).toEqual([]);
    expect(resolveMentions('@Nilesh please review', [harsh])).toEqual([]);
  });

  it('ignores an email address even when that person IS confirmed', () => {
    const body = 'write to nilesh@Nilesh.example for details';
    expect(resolveMentions(body, [nilesh])).toEqual([]);
  });

  it('returns nothing once the mention text has been deleted', () => {
    // Confirmed, then removed from the draft: there is nothing left to point at.
    expect(resolveMentions('please review this', [nilesh])).toEqual([]);
  });

  it('survives editing the text BEFORE a mention — the offsets are recomputed', () => {
    const before = resolveMentions('@Nilesh review', [nilesh])[0];
    const after = resolveMentions('Hi there @Nilesh review', [nilesh])[0];

    expect(before?.startOffset).toBe(0);
    expect(after?.startOffset).toBe(9);
    expect(after?.userId).toBe(NILESH.userId);
  });

  it('prefers the LONGEST label when one name contains another', () => {
    /*
     * "@Sumit Vishwakarma" must not be read as "@Sumit" followed by stray text. Longest-first
     * matching and consumed characters make that fall out rather than needing a special case.
     */
    const shortSumit: ConfirmedMention = { userId: 'u-sumit-2', label: 'Sumit', kind: 'USER' };
    const body = 'cc @Sumit Vishwakarma please';
    const found = resolveMentions(body, [shortSumit, sumit]);

    expect(found).toHaveLength(1);
    expect(body.slice(found[0]!.startOffset, found[0]!.endOffset)).toBe('@Sumit Vishwakarma');
    expect(found[0]?.userId).toBe(SUMIT.userId);
  });

  it('handles @everyone and a person together', () => {
    const body = '@everyone and especially @Nilesh';
    const found = resolveMentions(body, [everyone, nilesh]);

    expect(found.map((m) => m.kind)).toEqual(['EVERYONE', 'USER']);
  });

  it('returns nothing for an empty draft or an empty confirmed list', () => {
    expect(resolveMentions('', [nilesh])).toEqual([]);
    expect(resolveMentions('hello', [])).toEqual([]);
  });

  it('caps the list at what the server accepts', () => {
    const body = '@Nilesh '.repeat(30).trim();
    expect(resolveMentions(body, [nilesh]).length).toBeLessThanOrEqual(20);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Reading a mention back                                                                         */
/* -------------------------------------------------------------------------------------------- */

describe('whether a message mentions the reader', () => {
  const wire = (kind: 'USER' | 'EVERYONE', userId: string | null): MentionWire => ({
    kind,
    userId,
    start: 0,
    end: 5,
  });

  it('is true when the reader is named', () => {
    expect(mentionsUser([wire('USER', 'me')], 'me', 'someone-else')).toBe(true);
  });

  it('is false when somebody else is named', () => {
    expect(mentionsUser([wire('USER', 'them')], 'me', 'someone-else')).toBe(false);
  });

  it('is true for @everyone — if it reached you, you were in the audience', () => {
    expect(mentionsUser([wire('EVERYONE', null)], 'me', 'someone-else')).toBe(true);
  });

  it('is FALSE for your own message, however it was mentioned', () => {
    // A forged self-mention notifies nobody, on the client as well as the server.
    expect(mentionsUser([wire('USER', 'me')], 'me', 'me')).toBe(false);
    expect(mentionsUser([wire('EVERYONE', null)], 'me', 'me')).toBe(false);
  });

  it('is false when there are no mentions at all', () => {
    expect(mentionsUser([], 'me', 'them')).toBe(false);
    expect(mentionsUser(undefined, 'me', 'them')).toBe(false);
  });

  it('distinguishes being named from being included in @everyone', () => {
    expect(mentionsEveryone([wire('EVERYONE', null)])).toBe(true);
    expect(mentionsEveryone([wire('USER', 'me')])).toBe(false);
    expect(mentionsEveryone(undefined)).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Rendering                                                                                      */
/* -------------------------------------------------------------------------------------------- */

describe('splitting a body for rendering', () => {
  it('returns one plain segment when there are no mentions', () => {
    expect(segmentMessageBody('hello there', [])).toEqual([
      { text: 'hello there', mention: null },
    ]);
  });

  it('splits around a mention, keeping every character', () => {
    const body = 'Hi @Nilesh please look';
    const mention: MentionWire = { kind: 'USER', userId: NILESH.userId, start: 3, end: 10 };
    const segments = segmentMessageBody(body, [mention]);

    expect(segments.map((s) => s.text)).toEqual(['Hi ', '@Nilesh', ' please look']);
    expect(segments[1]?.mention).toBe(mention);
    expect(segments.map((s) => s.text).join('')).toBe(body);
  });

  it('handles a mention at the very start and at the very end', () => {
    expect(
      segmentMessageBody('@Nilesh', [{ kind: 'USER', userId: 'u', start: 0, end: 7 }]).map(
        (s) => s.text,
      ),
    ).toEqual(['@Nilesh']);
  });

  it('handles two mentions', () => {
    const body = '@Nilesh and @Harsh';
    const segments = segmentMessageBody(body, [
      { kind: 'USER', userId: 'a', start: 0, end: 7 },
      { kind: 'USER', userId: 'b', start: 12, end: 18 },
    ]);

    expect(segments.map((s) => s.text)).toEqual(['@Nilesh', ' and ', '@Harsh']);
    expect(segments.map((s) => s.text).join('')).toBe(body);
  });

  it('SKIPS malformed spans and still renders the whole text', () => {
    /*
     * The server validates spans, but this also renders messages from an older or newer build.
     * A mention that cannot be highlighted must degrade to plain text, never to missing text.
     */
    const body = 'hello there';
    for (const bad of [
      { kind: 'USER' as const, userId: 'u', start: 5, end: 3 },
      { kind: 'USER' as const, userId: 'u', start: 0, end: 900 },
      { kind: 'USER' as const, userId: 'u', start: -3, end: 2 },
      { kind: 'USER' as const, userId: 'u', start: 1.5, end: 4 },
    ]) {
      const segments = segmentMessageBody(body, [bad]);
      expect(segments.map((s) => s.text).join(''), JSON.stringify(bad)).toBe(body);
    }
  });

  it('skips a second span that overlaps the first, losing no characters', () => {
    const body = '@Nilesh hello';
    const segments = segmentMessageBody(body, [
      { kind: 'USER', userId: 'a', start: 0, end: 7 },
      { kind: 'USER', userId: 'b', start: 3, end: 9 },
    ]);

    expect(segments.map((s) => s.text).join('')).toBe(body);
  });
});
