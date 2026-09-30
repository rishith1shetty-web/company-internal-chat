/**
 * Typing indicators (Batch 1.8) — who is typing where, in memory only.
 *
 * EPHEMERAL BY DESIGN. Nothing here is written to PostgreSQL and nothing survives a restart: a
 * restart disconnects every socket, and "nobody is typing" is then simply true. There is no model,
 * no migration and no persistence to keep in step.
 *
 * The inputs are server-observed facts only — a socket that the gateway has already authorized
 * asked to start or stop, a socket disconnected, a member was removed, a message was sent. The
 * tracker is never handed a user id that did not come from the socket's own handshake.
 *
 * MULTIPLE SOCKETS PER USER. Employees keep a desktop window and a browser tab open at once, so a
 * user is "typing in a conversation" while ANY of their sockets says so. Stopping in one window
 * does not clear another, and closing a window clears only what that window had started.
 *
 * STALE STATE CANNOT OUTLIVE THE TTL. Every start (re)arms one expiry timer per user and
 * conversation. The composer re-sends start as a heartbeat while typing continues, so a live typer
 * never expires — but a crashed tab, a dropped stop or a sleeping laptop is cleared on its own.
 *
 * SCOPE: in-memory, correct for the single application process this project runs (D-09), exactly
 * like presence (lib/realtime/presence.ts).
 */

/** How long a typing state lives without a fresh `typing:start`. Longer than the client heartbeat. */
export const TYPING_TTL_MS = 6_000;

interface TypingEntry {
  sockets: Set<string>;
  timer: ReturnType<typeof setTimeout>;
}

export interface TypingKey {
  conversationId: string;
  userId: string;
}

export class TypingTracker {
  /** conversationId → userId → entry. Small: an office's worth of people typing at most. */
  private readonly entries = new Map<string, Map<string, TypingEntry>>();
  private readonly ttlMs: number;
  private readonly onExpire: (key: TypingKey) => void;

  constructor(options: { ttlMs?: number; onExpire: (key: TypingKey) => void }) {
    this.ttlMs = options.ttlMs ?? TYPING_TTL_MS;
    this.onExpire = options.onExpire;
  }

  /**
   * A socket says its user is typing in a conversation. Also the heartbeat.
   *
   * @returns true only when the user has just BECOME typing there — the one moment worth
   *          broadcasting. A heartbeat, or a second window of someone already typing, returns false
   *          and costs the network nothing.
   */
  start(conversationId: string, userId: string, socketId: string): boolean {
    let byUser = this.entries.get(conversationId);
    if (!byUser) {
      byUser = new Map();
      this.entries.set(conversationId, byUser);
    }

    const existing = byUser.get(userId);
    if (existing) {
      existing.sockets.add(socketId);
      clearTimeout(existing.timer);
      existing.timer = this.arm(conversationId, userId);
      return false;
    }

    byUser.set(userId, {
      sockets: new Set([socketId]),
      timer: this.arm(conversationId, userId),
    });
    return true;
  }

  /**
   * A socket says its user stopped typing.
   *
   * @returns true when that left the user typing on no socket at all — they have stopped.
   */
  stop(conversationId: string, userId: string, socketId: string): boolean {
    const entry = this.entries.get(conversationId)?.get(userId);
    if (!entry) return false;

    entry.sockets.delete(socketId);
    if (entry.sockets.size > 0) return false;

    this.remove(conversationId, userId);
    return true;
  }

  /**
   * Clears a user in a conversation outright, whichever sockets had them typing.
   *
   * Used when the typing is over by definition: they sent the message, or they are no longer a
   * member of the conversation.
   *
   * @returns true when they had been typing.
   */
  stopUser(conversationId: string, userId: string): boolean {
    if (!this.entries.get(conversationId)?.has(userId)) return false;
    this.remove(conversationId, userId);
    return true;
  }

  /**
   * A socket disconnected. Removes it everywhere it was typing.
   *
   * @returns every user/conversation that stopped because of it. A user still typing in another
   *          window is not in the list.
   */
  removeSocket(socketId: string): TypingKey[] {
    const stopped: TypingKey[] = [];

    for (const [conversationId, byUser] of [...this.entries]) {
      for (const [userId, entry] of [...byUser]) {
        if (!entry.sockets.delete(socketId)) continue;
        if (entry.sockets.size > 0) continue;
        this.remove(conversationId, userId);
        stopped.push({ conversationId, userId });
      }
    }

    return stopped;
  }

  isTyping(conversationId: string, userId: string): boolean {
    return this.entries.get(conversationId)?.has(userId) ?? false;
  }

  /** How many of a user's sockets have them typing there. Tests and diagnostics only. */
  typingSocketCount(conversationId: string, userId: string): number {
    return this.entries.get(conversationId)?.get(userId)?.sockets.size ?? 0;
  }

  /** Users typing in a conversation. Used by tests and diagnostics, never sent as a set. */
  typingUserIds(conversationId: string): string[] {
    return [...(this.entries.get(conversationId)?.keys() ?? [])];
  }

  /** Clears every timer and all state. Called on shutdown and between tests. */
  dispose(): void {
    for (const byUser of this.entries.values()) {
      for (const entry of byUser.values()) clearTimeout(entry.timer);
    }
    this.entries.clear();
  }

  private arm(conversationId: string, userId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      if (!this.entries.get(conversationId)?.has(userId)) return;
      this.remove(conversationId, userId);
      this.onExpire({ conversationId, userId });
    }, this.ttlMs);

    // Never hold the process open for a typing timer — shutdown must not wait on it.
    timer.unref?.();
    return timer;
  }

  private remove(conversationId: string, userId: string): void {
    const byUser = this.entries.get(conversationId);
    const entry = byUser?.get(userId);
    if (!byUser || !entry) return;

    clearTimeout(entry.timer);
    byUser.delete(userId);
    if (byUser.size === 0) this.entries.delete(conversationId);
  }
}
