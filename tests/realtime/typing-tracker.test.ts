/**
 * The in-memory typing tracker (Batch 1.8), on fake timers — no socket, no database, no waiting.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TYPING_TTL_MS, TypingTracker, type TypingKey } from '@/lib/realtime/typing';

const C1 = 'conversation-1';
const C2 = 'conversation-2';

describe('TypingTracker', () => {
  let expired: TypingKey[];
  let tracker: TypingTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    expired = [];
    tracker = new TypingTracker({ onExpire: (key) => expired.push(key) });
  });

  afterEach(() => {
    tracker.dispose();
    vi.useRealTimers();
  });

  it('reports only the moment a user becomes typing', () => {
    expect(tracker.start(C1, 'alice', 's1')).toBe(true);
    // The heartbeat, and a second window, are not news.
    expect(tracker.start(C1, 'alice', 's1')).toBe(false);
    expect(tracker.start(C1, 'alice', 's2')).toBe(false);
    expect(tracker.isTyping(C1, 'alice')).toBe(true);
  });

  it('keeps a user typing until their last typing socket stops', () => {
    tracker.start(C1, 'alice', 's1');
    tracker.start(C1, 'alice', 's2');

    expect(tracker.stop(C1, 'alice', 's1')).toBe(false);
    expect(tracker.isTyping(C1, 'alice')).toBe(true);
    expect(tracker.stop(C1, 'alice', 's2')).toBe(true);
    expect(tracker.isTyping(C1, 'alice')).toBe(false);
  });

  it('treats a stop for somebody not typing as nothing', () => {
    expect(tracker.stop(C1, 'alice', 's1')).toBe(false);
    tracker.start(C1, 'alice', 's1');
    expect(tracker.stop(C1, 'alice', 'another-socket')).toBe(false);
    expect(tracker.isTyping(C1, 'alice')).toBe(true);
  });

  it('keeps conversations apart', () => {
    tracker.start(C1, 'alice', 's1');
    tracker.start(C2, 'bob', 's2');

    expect(tracker.typingUserIds(C1)).toEqual(['alice']);
    expect(tracker.typingUserIds(C2)).toEqual(['bob']);
    expect(tracker.isTyping(C2, 'alice')).toBe(false);
  });

  it('clears a user outright on send or removal, whatever windows were typing', () => {
    tracker.start(C1, 'alice', 's1');
    tracker.start(C1, 'alice', 's2');

    expect(tracker.stopUser(C1, 'alice')).toBe(true);
    expect(tracker.isTyping(C1, 'alice')).toBe(false);
    expect(tracker.stopUser(C1, 'alice')).toBe(false);
  });

  it('clears a disconnected socket everywhere, reporting only who actually stopped', () => {
    tracker.start(C1, 'alice', 's1');
    tracker.start(C2, 'alice', 's1');
    tracker.start(C2, 'alice', 's2'); // still typing in C2 from another window
    tracker.start(C1, 'bob', 's3');

    expect(tracker.removeSocket('s1')).toEqual([{ conversationId: C1, userId: 'alice' }]);
    expect(tracker.isTyping(C2, 'alice')).toBe(true);
    expect(tracker.isTyping(C1, 'bob')).toBe(true);
    expect(tracker.removeSocket('unknown')).toEqual([]);
  });

  it('expires a typing state that nobody refreshed', () => {
    tracker.start(C1, 'alice', 's1');

    vi.advanceTimersByTime(TYPING_TTL_MS - 1);
    expect(tracker.isTyping(C1, 'alice')).toBe(true);
    expect(expired).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(tracker.isTyping(C1, 'alice')).toBe(false);
    expect(expired).toEqual([{ conversationId: C1, userId: 'alice' }]);
  });

  it('lets the heartbeat keep a live typer alive', () => {
    tracker.start(C1, 'alice', 's1');
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(TYPING_TTL_MS - 1_000);
      tracker.start(C1, 'alice', 's1');
    }
    expect(tracker.isTyping(C1, 'alice')).toBe(true);
    expect(expired).toEqual([]);
  });

  it('does not expire what was already stopped, or anything after dispose', () => {
    tracker.start(C1, 'alice', 's1');
    tracker.stop(C1, 'alice', 's1');
    tracker.start(C1, 'bob', 's2');
    tracker.dispose();

    vi.advanceTimersByTime(TYPING_TTL_MS * 2);
    expect(expired).toEqual([]);
    expect(tracker.typingUserIds(C1)).toEqual([]);
  });

  it('honours a custom TTL', () => {
    const quick = new TypingTracker({ ttlMs: 100, onExpire: (key) => expired.push(key) });
    quick.start(C1, 'alice', 's1');
    vi.advanceTimersByTime(100);
    expect(expired).toEqual([{ conversationId: C1, userId: 'alice' }]);
    quick.dispose();
  });

  it('is pure in-memory state: the module imports nothing, database included', () => {
    const source = readFileSync(join(process.cwd(), 'lib', 'realtime', 'typing.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/prisma/i);
  });
});
