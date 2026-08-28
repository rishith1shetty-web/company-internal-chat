/**
 * Presence tracking.
 *
 * Presence is **derived, not declared** (docs/01-architecture.md §6): a user is online when the
 * server is holding at least one socket for them. A client saying "I am online" changes nothing,
 * because nothing here reads client input — the only inputs are real connection and disconnection
 * events observed by the server.
 *
 * Two behaviours that matter more than they look:
 *
 * 1. **Multiple connections per user.** Employees keep several tabs open. The tracker counts
 *    sockets, so closing one tab while another is open changes nothing. A user goes offline only
 *    when their last socket is gone.
 *
 * 2. **A grace period before going offline.** A page reload disconnects and reconnects within a
 *    second or so. Without a delay the presence dot would flicker off and on for every refresh
 *    and every brief network blip, which is worse than useless — it teaches people to distrust
 *    the indicator.
 *
 * SCOPE: in-memory, correct for the single application process this project runs (D-09). If the
 * application is ever run as multiple processes, presence must move to a shared adapter — a
 * known constraint recorded as Q-09, not a bug.
 */

/** How long a user stays "online" after their last socket disconnects. */
const OFFLINE_GRACE_MS = 10_000;

export interface PresenceChange {
  userId: string;
  online: boolean;
}

export class PresenceTracker {
  private readonly socketsByUser = new Map<string, Set<string>>();
  private readonly pendingOffline = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly graceMs: number;

  constructor(options: { graceMs?: number } = {}) {
    this.graceMs = options.graceMs ?? OFFLINE_GRACE_MS;
  }

  /**
   * Records a connection.
   *
   * @returns true when this made the user newly online — the caller should announce it. False
   *          when they already had a socket open, so nothing needs announcing.
   */
  add(userId: string, socketId: string): boolean {
    // A reconnect inside the grace window cancels the pending offline, so a page reload never
    // produces an offline/online pair for anyone watching.
    const pending = this.pendingOffline.get(userId);
    if (pending) {
      clearTimeout(pending);
      this.pendingOffline.delete(userId);
    }

    const existing = this.socketsByUser.get(userId);
    if (existing) {
      existing.add(socketId);
      return false;
    }

    this.socketsByUser.set(userId, new Set([socketId]));
    return true;
  }

  /**
   * Records a disconnection.
   *
   * @param onOffline called after the grace period if the user is still without sockets. Not
   *                  called at all while another connection remains.
   */
  remove(userId: string, socketId: string, onOffline: (userId: string) => void): void {
    const sockets = this.socketsByUser.get(userId);
    if (!sockets) return;

    sockets.delete(socketId);
    if (sockets.size > 0) return;

    this.socketsByUser.delete(userId);

    const timer = setTimeout(() => {
      this.pendingOffline.delete(userId);
      // Re-checked rather than assumed: the user may have reconnected while this was pending.
      if (!this.isOnline(userId)) onOffline(userId);
    }, this.graceMs);

    // Never hold the process open for a presence timer — shutdown must not wait on it.
    timer.unref?.();
    this.pendingOffline.set(userId, timer);
  }

  isOnline(userId: string): boolean {
    return (this.socketsByUser.get(userId)?.size ?? 0) > 0;
  }

  /** Number of live sockets for a user. Used by tests and diagnostics, not by authorization. */
  connectionCount(userId: string): number {
    return this.socketsByUser.get(userId)?.size ?? 0;
  }

  onlineUserIds(): string[] {
    return [...this.socketsByUser.keys()];
  }

  /** Filters a list of user ids down to those currently online. */
  filterOnline(userIds: readonly string[]): string[] {
    return userIds.filter((userId) => this.isOnline(userId));
  }

  /** Clears every timer and all state. Called on shutdown and between tests. */
  dispose(): void {
    for (const timer of this.pendingOffline.values()) clearTimeout(timer);
    this.pendingOffline.clear();
    this.socketsByUser.clear();
  }
}
