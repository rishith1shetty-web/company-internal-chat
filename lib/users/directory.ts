/**
 * User directory — the minimum needed to start a one-to-one conversation.
 *
 * PHASE 5 SCOPE, deliberately small. What "the company directory" should eventually be — whether
 * it is seeded from HR data, whether everyone should be visible to everyone, how it behaves once
 * real authentication exists — is an open question (Q-06 in docs/05-open-questions.md) and is not
 * being answered here by accident. This lists the users the application itself has created, so
 * that a person can be picked and chatted with. Nothing more.
 *
 * THE RULE THIS MODULE MUST NOT BREAK (D-02): a display name is a label, not an identifier.
 * `search` matches against `normalizedName` to *filter* the list, and every row is returned with
 * its `id`. Nothing here resolves a user from a name, and no caller may: two people called
 * "Sarah Chen" are two people, and the interface tells them apart by the id-derived
 * discriminator, not by the name it just matched.
 */

import type { PrismaClient } from '../../prisma/generated/client';

/** Default page size for the picker. Small enough to render, large enough to be useful. */
export const DIRECTORY_DEFAULT_LIMIT = 50;
export const DIRECTORY_MAX_LIMIT = 200;

/** Longest search term accepted. A longer one is a mistake or an attempt, not a name. */
export const DIRECTORY_MAX_SEARCH_LENGTH = 64;

export interface DirectoryEntry {
  /** The identity. The only thing a conversation is ever started against. */
  id: string;
  displayName: string;
  /**
   * Persisted "last seen" (UTC). NOT live presence: presence is derived from open sockets and is
   * scoped to people who share a conversation with the caller (Phase 4), so it is delivered over
   * the socket and never through this endpoint.
   */
  lastSeenAt: Date;
}

export interface DirectoryQuery {
  /** Substring match against the normalised display name. Filters; never identifies. */
  search?: string | undefined;
  limit?: number | undefined;
}

/**
 * Lists other users, most recently seen first.
 *
 * The caller is excluded — a person cannot start a conversation with themselves, so offering
 * themselves in the picker would only produce an error later.
 */
export async function listDirectory(
  db: PrismaClient,
  currentUserId: string,
  query: DirectoryQuery = {},
): Promise<DirectoryEntry[]> {
  const search = (query.search ?? '').trim().slice(0, DIRECTORY_MAX_SEARCH_LENGTH).toLowerCase();
  const limit = clampLimit(query.limit);

  return db.user.findMany({
    where: {
      id: { not: currentUserId },
      // Retired names stay out of the picker but keep their message history (`isActive`).
      isActive: true,
      // Prisma parameterises this; the term is never concatenated into SQL.
      ...(search.length > 0 ? { normalizedName: { contains: search } } : {}),
    },
    select: { id: true, displayName: true, lastSeenAt: true },
    // Recently active people first, then a stable alphabetical tail so the list does not shuffle
    // between requests.
    orderBy: [{ lastSeenAt: 'desc' }, { normalizedName: 'asc' }, { id: 'asc' }],
    take: limit,
  });
}

/** The users named by these ids, for rendering conversations whose members are not in the list. */
export async function listUsersByIds(
  db: PrismaClient,
  userIds: readonly string[],
): Promise<DirectoryEntry[]> {
  if (userIds.length === 0) return [];

  return db.user.findMany({
    where: { id: { in: [...new Set(userIds)] } },
    select: { id: true, displayName: true, lastSeenAt: true },
  });
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DIRECTORY_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), DIRECTORY_MAX_LIMIT);
}
