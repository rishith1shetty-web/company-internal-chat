/**
 * Typing indicators in the browser (Batch 1.8): the composer's signal, the wording, and the
 * reducer — all pure, all on fake timers.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chatReducer, initialChatState, type ChatState } from '@/lib/chat/state';
import {
  TYPING_HEARTBEAT_MS,
  TYPING_IDLE_MS,
  createTypingSignal,
  formatTypingText,
} from '@/lib/chat/typing';
import { TYPING_TTL_MS } from '@/lib/realtime/typing';

describe('createTypingSignal', () => {
  let sent: boolean[];

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function signal() {
    return createTypingSignal((typing) => sent.push(typing));
  }

  it('sends one start for a burst of keystrokes, not one per key', () => {
    const typing = signal();
    for (const text of ['H', 'He', 'Hel', 'Hell', 'Hello']) {
      typing.input(text);
      vi.advanceTimersByTime(100);
    }
    expect(sent).toEqual([true]);
  });

  it('repeats start as a heartbeat while typing continues', () => {
    const typing = signal();
    typing.input('a');
    // Keystrokes every second, never pausing long enough to stop.
    for (let elapsed = 0; elapsed < TYPING_HEARTBEAT_MS; elapsed += 1_000) {
      vi.advanceTimersByTime(1_000);
      typing.input('ab');
    }
    expect(sent).toEqual([true, true]);
  });

  it('keeps the heartbeat well inside the server expiry', () => {
    expect(TYPING_HEARTBEAT_MS).toBeLessThan(TYPING_TTL_MS);
    expect(TYPING_IDLE_MS).toBeGreaterThanOrEqual(2_000);
    expect(TYPING_IDLE_MS).toBeLessThanOrEqual(3_000);
  });

  it('stops after a pause', () => {
    const typing = signal();
    typing.input('hello');
    vi.advanceTimersByTime(TYPING_IDLE_MS - 1);
    expect(sent).toEqual([true]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([true, false]);
  });

  it('stops when the field is emptied, and never starts for whitespace', () => {
    const typing = signal();
    typing.input('   ');
    expect(sent).toEqual([]);

    typing.input('hi');
    typing.input('');
    expect(sent).toEqual([true, false]);
  });

  it('stops once on send or on leaving the conversation, and not again', () => {
    const typing = signal();
    typing.input('hello');
    typing.stop();
    typing.stop();
    vi.advanceTimersByTime(TYPING_IDLE_MS * 2);
    expect(sent).toEqual([true, false]);
  });

  it('starts again when typing resumes after a stop', () => {
    const typing = signal();
    typing.input('first');
    typing.stop();
    typing.input('second');
    expect(sent).toEqual([true, false, true]);
  });
});

describe('formatTypingText', () => {
  it('says nothing when nobody is typing', () => {
    expect(formatTypingText([])).toBeNull();
  });

  it('names one or two people', () => {
    expect(formatTypingText(['Rahul'])).toBe('Rahul is typing…');
    expect(formatTypingText(['Rahul', 'Priya'])).toBe('Rahul and Priya are typing…');
  });

  it('stays compact for three or more', () => {
    expect(formatTypingText(['Rahul', 'Priya', 'Amit'])).toBe(
      'Rahul, Priya and 1 other are typing…',
    );
    expect(formatTypingText(['Rahul', 'Priya', 'Amit', 'Neha'])).toBe(
      'Rahul, Priya and 2 others are typing…',
    );
    const many = Array.from({ length: 30 }, (_, index) => `Person ${index}`);
    expect(formatTypingText(many)).toBe('Person 0, Person 1 and 28 others are typing…');
  });
});

describe('typing state in the reducer', () => {
  function typing(state: ChatState, conversationId: string, userId: string, on: boolean) {
    return chatReducer(state, { type: 'typing-changed', conversationId, userId, typing: on });
  }

  it('adds and removes typers per conversation, in the order they started', () => {
    let state = typing(initialChatState, 'c1', 'rahul', true);
    state = typing(state, 'c1', 'priya', true);
    state = typing(state, 'c2', 'amit', true);
    expect(state.typingByConversation).toEqual({ c1: ['rahul', 'priya'], c2: ['amit'] });

    state = typing(state, 'c1', 'rahul', false);
    state = typing(state, 'c2', 'amit', false);
    expect(state.typingByConversation).toEqual({ c1: ['priya'] });
  });

  it('returns the same state for a redundant update, so nothing re-renders', () => {
    const once = typing(initialChatState, 'c1', 'rahul', true);
    expect(typing(once, 'c1', 'rahul', true)).toBe(once);
    expect(typing(once, 'c1', 'nobody', false)).toBe(once);
  });

  it('forgets everybody when the connection drops, and on losing the identity', () => {
    const state = typing(initialChatState, 'c1', 'rahul', true);

    const reconnecting = chatReducer(state, { type: 'connection-changed', connection: 'reconnecting' });
    expect(reconnecting.typingByConversation).toEqual({});

    const online = chatReducer(state, { type: 'connection-changed', connection: 'online' });
    expect(online.typingByConversation).toEqual({ c1: ['rahul'] });

    expect(chatReducer(state, { type: 'identity-missing' }).typingByConversation).toEqual({});
  });

  it('touches nothing else: no unread, no reordering, no messages', () => {
    const state = typing(initialChatState, 'c1', 'rahul', true);
    expect(state.conversations).toBe(initialChatState.conversations);
    expect(state.messagesByConversation).toBe(initialChatState.messagesByConversation);
  });
});

describe('typing wiring', () => {
  const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8');

  it('the client module is pure: no imports, no socket, no storage', () => {
    const source = read('lib', 'chat', 'typing.ts');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });

  it('the composer signals from user input and stops on send, edit and unmount', () => {
    const composer = read('components', 'chat', 'MessageComposer.tsx');
    expect(composer).toContain('createTypingSignal(');
    expect(composer).toMatch(/noteTyping\(event\.target\.value\)/);
    expect(composer).toMatch(/signal\.stop\(\)/);
    expect((composer.match(/typingSignalRef\.current\?\.stop\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('the workspace shows only the open conversation, between the list and the composer', () => {
    const workspace = read('components', 'chat', 'ChatWorkspace.tsx');
    const list = workspace.indexOf('<MessageList');
    const indicator = workspace.indexOf('<TypingIndicator');
    const composer = workspace.indexOf('<MessageComposer');
    expect(list).toBeGreaterThan(-1);
    expect(indicator).toBeGreaterThan(list);
    expect(composer).toBeGreaterThan(indicator);
    expect(workspace).toContain('state.typingByConversation[selectedConversationId]');
    expect(workspace).toContain('onTypingChange={onTypingChange}');
  });

  it('typing updates go to the reducer and never to the notification pipeline', () => {
    const session = read('lib', 'chat', 'useChatSession.ts');
    const start = session.indexOf('onTyping(');
    const handler = session.slice(start, session.indexOf('},', start));
    expect(handler).toContain("type: 'typing-changed'");
    expect(handler).not.toContain('announce(');
  });
});
