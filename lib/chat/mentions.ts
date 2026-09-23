/**
 * The composer's half of mentions: when to offer them, what to offer, and what gets sent
 * (Batch 1.7).
 *
 * Pure. No React, no DOM, no request. The picker renders what this decides, which is what makes
 * the interesting parts testable in a project whose suite runs under `environment: 'node'` and
 * deliberately has no DOM test infrastructure.
 *
 * TWO IDEAS DO ALL THE WORK HERE, and they are worth stating before the code.
 *
 * 1. A mention is CONFIRMED, never guessed. Choosing somebody from the picker adds them to a set
 *    of confirmed targets held alongside the draft. Typing "@Nilesh" by hand does not: the text
 *    is just text until a person has been picked. That is what keeps "email me at
 *    user@example.com" and "the @ sign" from becoming mentions, and it is the rule the brief
 *    asks for — a mention counts only when it came from the intended interaction.
 *
 * 2. Offsets are RESOLVED AT SEND TIME, not tracked while typing. The alternative — storing spans
 *    when a mention is inserted and shifting them on every keystroke — needs a correct answer for
 *    every edit anywhere in the draft, including pastes, deletions across a mention, and undo.
 *    Instead the draft stays a plain string, and just before sending, the confirmed labels are
 *    located in it. Editing text before a mention, after it, or through it all come out right
 *    because nothing was remembered that could go stale. Delete the "@Nilesh" text and the
 *    mention is simply not found.
 *
 * Everything below follows from those two.
 */

import type { MentionWire } from '@/lib/chat/wire';

/** The only special token. There is deliberately no @all, @channel or @here. */
export const MENTION_EVERYONE_TOKEN = 'everyone';

/** Its accessible description, used by the picker and by screen readers. */
export const MENTION_EVERYONE_DESCRIPTION = 'Mention all members in this group';

/**
 * Longest partial name the composer will keep searching through after an `@`.
 *
 * Past this, whatever is being typed is not a name being looked up — it is prose that happens to
 * follow an `@`, and the picker should have stopped offering to help several words ago.
 */
export const MENTION_QUERY_MAX_LENGTH = 32;

/** What the server will accept. Kept in step with `lib/messages/mentions.ts` by a test. */
export const MAX_MENTIONS_PER_MESSAGE = 20;

/** A person who can be mentioned: an active member of the open group, excluding the sender. */
export interface MentionCandidate {
  /** `null` for the `@everyone` row, which names no single user. */
  userId: string | null;
  /** The text inserted after the `@`. A display name, or "everyone". */
  label: string;
  kind: 'USER' | 'EVERYONE';
  /** Read out instead of a name for `@everyone`. */
  description?: string;
}

/** A confirmed mention target, held alongside the draft until it is sent. */
export interface ConfirmedMention {
  userId: string | null;
  label: string;
  kind: 'USER' | 'EVERYONE';
}

/** An open `@…` the caret is currently inside. */
export interface MentionTrigger {
  /** Index of the `@` itself. */
  start: number;
  /** Text between the `@` and the caret. Empty right after typing `@`. */
  query: string;
}

/**
 * Finds the mention being typed at the caret, or null.
 *
 * THE RULE THAT KEEPS EMAIL ADDRESSES OUT: the `@` must begin a word — it is either the first
 * character of the draft or is preceded by whitespace. In "user@example.com" the `@` follows "r",
 * so nothing opens, which is the behaviour asked for and also the one that stops the picker
 * flickering over an address as it is typed.
 *
 * Scanning stops at whitespace, a newline or `@`, so only the current word is considered. A name
 * with a space in it is still reachable: the query is matched against the WHOLE display name
 * below, so "@sumit" offers "Sumit Vishwakarma", and choosing it inserts the entire name at once.
 * What is not supported is continuing to narrow after the space — "@sumit v" closes the picker —
 * because at that point the text cannot be told apart from an ordinary sentence.
 */
export function findMentionTrigger(value: string, caret: number): MentionTrigger | null {
  if (caret < 0 || caret > value.length) return null;

  for (let index = caret - 1; index >= 0; index -= 1) {
    const character = value[index] as string;

    if (character === '@') {
      const before = index === 0 ? '' : (value[index - 1] as string);
      // Must begin a word. This is the email-address guard.
      if (index !== 0 && !/\s/.test(before)) return null;

      const query = value.slice(index + 1, caret);
      if (query.length > MENTION_QUERY_MAX_LENGTH) return null;

      return { start: index, query };
    }

    // A word boundary before any `@`: there is no mention being typed here.
    if (/\s/.test(character)) return null;

    if (caret - index > MENTION_QUERY_MAX_LENGTH + 1) return null;
  }

  return null;
}

/**
 * The suggestions for a query, in the order they are shown.
 *
 * `@everyone` first — it is the one entry that is always the same, so a fixed position makes it
 * predictable rather than something to hunt for — then people, alphabetically by display name.
 * Alphabetical rather than "recently active": a picker that reorders itself between openings
 * teaches nobody where anything is, and the list is one group, not a company directory.
 *
 * MATCHING IS A CASE-INSENSITIVE SUBSTRING over the whole display name, so "@vish" finds
 * "Sumit Vishwakarma" and "@ni" finds "Nilesh". The caller passes only ACTIVE members of the open
 * group; nothing here can widen that, and there is no path from this function to the directory.
 */
export function filterMentionCandidates(
  members: readonly { userId: string; displayName: string }[],
  query: string,
): MentionCandidate[] {
  const needle = query.trim().toLowerCase();

  /*
   * NO MEMBERS, NO SUGGESTIONS — not even `@everyone`.
   *
   * This is the group-only rule, and it lives here as data rather than as a condition in the
   * composer. A direct conversation is passed an empty member list, so there is nobody to mention
   * and "everyone" would mean the one other person, who is already reading the thread. Returning
   * an empty list is what keeps the picker from ever opening there.
   */
  if (members.length === 0) return [];

  const everyone: MentionCandidate[] =
    MENTION_EVERYONE_TOKEN.startsWith(needle) || needle.length === 0
      ? [
          {
            userId: null,
            label: MENTION_EVERYONE_TOKEN,
            kind: 'EVERYONE',
            description: MENTION_EVERYONE_DESCRIPTION,
          },
        ]
      : [];

  const people = members
    .filter((member) => member.displayName.toLowerCase().includes(needle))
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map<MentionCandidate>((member) => ({
      userId: member.userId,
      label: member.displayName,
      kind: 'USER',
    }));

  return [...everyone, ...people];
}

export interface MentionInsertion {
  value: string;
  /** Where the caret belongs afterwards: just past the space that follows the name. */
  cursor: number;
  confirmed: ConfirmedMention;
}

/**
 * Replaces the `@…` being typed with the chosen name.
 *
 * INSERTED AT THE TRIGGER, not appended — the text before and after is preserved exactly, so
 * "Hi @ni can you look" becomes "Hi @Nilesh can you look" and the caret lands in the middle of
 * the sentence where it belongs. Newlines are ordinary characters to this: a multiline draft is
 * untouched apart from the span being replaced.
 *
 * A single trailing space is added, because the next thing anybody types is another word. It is
 * added only when the mention is not already followed by one, so choosing a name in the middle of
 * a finished sentence does not leave a double space.
 */
export function applyMention(
  value: string,
  trigger: MentionTrigger,
  caret: number,
  candidate: MentionCandidate,
): MentionInsertion {
  const inserted = `@${candidate.label}`;
  const after = value.slice(caret);
  const needsSpace = !after.startsWith(' ');
  const suffix = needsSpace ? ' ' : '';

  return {
    value: `${value.slice(0, trigger.start)}${inserted}${suffix}${after}`,
    cursor: trigger.start + inserted.length + suffix.length,
    confirmed: { userId: candidate.userId, label: candidate.label, kind: candidate.kind },
  };
}

/** A mention as the send payload carries it. Matches `MentionInput` on the server. */
export interface MentionPayload {
  kind: 'USER' | 'EVERYONE';
  userId: string | null;
  startOffset: number;
  endOffset: number;
}

/**
 * Locates every confirmed mention in the final text, and returns the spans to send.
 *
 * This is where the two ideas at the top meet. The draft is scanned for `@<label>` — but only for
 * labels somebody actually chose, so text that merely looks like a mention is left alone.
 *
 * THREE DETAILS THAT MATTER:
 *
 *   LONGEST LABEL FIRST. If both "Nilesh" and "Nilesh Kumar" are confirmed, "@Nilesh Kumar" must
 *   match the longer one. Sorting by length descending and refusing to reuse consumed characters
 *   makes that fall out rather than needing a special case.
 *
 *   THE MATCH MUST BEGIN A WORD, exactly as the trigger did, so "email@Nilesh" is not a mention
 *   even when Nilesh is confirmed elsewhere in the draft.
 *
 *   EVERY OCCURRENCE IS RETURNED. "@Nilesh please ask @Nilesh" produces two spans, so both are
 *   highlighted where they were written. Reducing that to one recipient is the notification
 *   layer's job and happens on the server, from the stored rows.
 *
 * The body passed here must be the EXACT string being sent — trimmed, as the composer trims it —
 * or the offsets will be a character out and the server will refuse them.
 */
export function resolveMentions(
  body: string,
  confirmed: readonly ConfirmedMention[],
): MentionPayload[] {
  if (confirmed.length === 0 || body.length === 0) return [];

  /** Characters already claimed by a longer label, so nothing is matched twice. */
  const consumed = new Array<boolean>(body.length).fill(false);
  const found: MentionPayload[] = [];

  const byLongestLabel = [...confirmed].sort((a, b) => b.label.length - a.label.length);

  for (const target of byLongestLabel) {
    const needle = `@${target.label}`;
    let from = 0;

    for (;;) {
      const at = body.indexOf(needle, from);
      if (at === -1) break;

      from = at + 1;

      const before = at === 0 ? '' : (body[at - 1] as string);
      if (at !== 0 && !/\s/.test(before)) continue;

      const end = at + needle.length;
      if (consumed.slice(at, end).some(Boolean)) continue;

      for (let index = at; index < end; index += 1) consumed[index] = true;

      found.push({
        kind: target.kind,
        userId: target.userId,
        startOffset: at,
        endOffset: end,
      });

      from = end;
    }
  }

  /*
   * Sorted by position, and capped. The server enforces the same cap and would refuse a longer
   * list; sending the first twenty rather than failing means a draft that somehow accumulated
   * more still sends, with the later mentions rendered as the plain text they already are.
   */
  return found.sort((a, b) => a.startOffset - b.startOffset).slice(0, MAX_MENTIONS_PER_MESSAGE);
}

/**
 * Whether a message mentions the reader — the one question the notification layer asks.
 *
 * `EVERYONE` is true for anybody who is not the sender, because only members receive a group
 * message at all: if it reached you, you were in the audience. That is why the server never has
 * to send a resolved recipient list, and why one frozen at send time would be worse than useless.
 */
export function mentionsUser(
  mentions: readonly MentionWire[] | undefined,
  userId: string,
  senderId: string | null,
): boolean {
  if (!mentions || mentions.length === 0) return false;
  // Never your own message, however it got here.
  if (senderId !== null && senderId === userId) return false;

  return mentions.some(
    (mention) =>
      mention.kind === 'EVERYONE' || (mention.kind === 'USER' && mention.userId === userId),
  );
}

/** True when the reader was reached by `@everyone` rather than named individually. */
export function mentionsEveryone(mentions: readonly MentionWire[] | undefined): boolean {
  return (mentions ?? []).some((mention) => mention.kind === 'EVERYONE');
}

/** One run of message text: either plain, or a mention to be highlighted. */
export interface MessageSegment {
  text: string;
  mention: MentionWire | null;
}

/**
 * Splits a body into plain and mentioned runs, for rendering.
 *
 * Defensive about the spans even though the server validated them, because this also renders
 * messages that arrived over a socket from an older or newer build: anything out of order,
 * overlapping, reversed or past the end of the body is skipped, and the text is still shown in
 * full. A mention that cannot be highlighted must degrade to plain text, never to missing text.
 */
export function segmentMessageBody(
  body: string,
  mentions: readonly MentionWire[] | undefined,
): MessageSegment[] {
  if (!mentions || mentions.length === 0) return [{ text: body, mention: null }];

  const ordered = [...mentions].sort((a, b) => a.start - b.start);
  const segments: MessageSegment[] = [];
  let cursor = 0;

  for (const mention of ordered) {
    if (
      !Number.isInteger(mention.start) ||
      !Number.isInteger(mention.end) ||
      mention.start < cursor ||
      mention.end <= mention.start ||
      mention.end > body.length
    ) {
      continue;
    }

    if (mention.start > cursor) {
      segments.push({ text: body.slice(cursor, mention.start), mention: null });
    }

    segments.push({ text: body.slice(mention.start, mention.end), mention });
    cursor = mention.end;
  }

  if (cursor < body.length) segments.push({ text: body.slice(cursor), mention: null });

  return segments;
}
