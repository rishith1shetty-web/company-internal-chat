/**
 * The browser's view of the HTTP API.
 *
 * Every network call the interface makes goes through this module, so there is one place where
 * a failure is turned into something the UI can show and one place that knows the endpoint
 * shapes. Components call these functions; they never call `fetch` themselves.
 *
 * Two things this module does NOT do:
 *
 *   - It never sends an identity. The session and device cookies are `HttpOnly`, so script
 *     cannot read them and does not need to: the browser attaches them, and the server derives
 *     the user from them. There is no `userId` parameter anywhere below by design (CLAUDE.md §10).
 *
 *   - It never treats its own state as authoritative. These calls are how the browser recovers
 *     the truth from PostgreSQL after a reload, a reconnect or a failed send.
 */

import type {
  ApiErrorWire,
  ConversationCreatedWire,
  ConversationListWire,
  ConversationMembersWire,
  DirectoryWire,
  MessagePageWire,
  ReadReceiptWire,
  SessionIdentityWire,
} from '@/lib/chat/wire';

/** A failed request, carrying a message that is already safe to show a user. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /** True when this computer no longer resolves to an employee: the workspace must close. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(input, {
      // Cookies are same-origin here, but stating it means a future change of origin fails
      // loudly rather than silently dropping the session.
      credentials: 'same-origin',
      ...init,
    });
  } catch {
    // A dropped network or a stopped server. Deliberately not the browser's error text, which
    // varies per engine and says nothing useful to an employee.
    throw new ApiError(0, 'NETWORK', 'Cannot reach the chat server. Check your connection.');
  }

  if (response.status === 204) return undefined as T;

  const body: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const error = (body as ApiErrorWire | undefined)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.message ?? 'Something went wrong. Please try again.',
    );
  }

  return body as T;
}

/* ------------------------------------------------------------------------------------------- */
/* Session                                                                                       */
/* ------------------------------------------------------------------------------------------- */

/**
 * Who am I? `null` when this computer has no assigned identity — a normal state, not an error.
 *
 * The only identity call the employee interface makes, and it is read-only. There is no
 * counterpart that creates, changes or clears an identity, because no such endpoint exists any
 * more: a computer is assigned to an employee by an administrator
 * (docs/12-admin-device-identity.md).
 */
export async function fetchSession(): Promise<SessionIdentityWire | null> {
  const identity = await request<SessionIdentityWire | undefined>('/api/session');
  return identity ?? null;
}

/* ------------------------------------------------------------------------------------------- */
/* Directory, conversations, messages                                                            */
/* ------------------------------------------------------------------------------------------- */

export function fetchDirectory(search?: string): Promise<DirectoryWire> {
  const query = search && search.trim().length > 0 ? `?q=${encodeURIComponent(search.trim())}` : '';
  return request<DirectoryWire>(`/api/users${query}`);
}

export function fetchConversations(): Promise<ConversationListWire> {
  return request<ConversationListWire>('/api/conversations');
}

/**
 * Open the direct conversation with a colleague.
 *
 * "Create or return" rather than "create": the server resolves the pair to a single conversation
 * (`Conversation.directKey`), so clicking twice cannot produce two.
 */
export function startDirectConversation(userId: string): Promise<ConversationCreatedWire> {
  return request<ConversationCreatedWire>('/api/conversations', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ type: 'DIRECT', userId }),
  });
}

/**
 * Create a group: a name and the colleagues to add, by id.
 *
 * The creator is not in the payload. They are taken from the session, are always a member, and
 * are always the group's owner — none of which a browser is allowed to state (CLAUDE.md §10).
 */
export function createGroupConversation(
  name: string,
  memberIds: string[],
): Promise<ConversationCreatedWire> {
  return request<ConversationCreatedWire>('/api/conversations', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ type: 'GROUP', name, memberIds }),
  });
}

/**
 * Add colleagues to a group.
 *
 * The server decides whether this caller may, and stamps everybody added with `joinedAt = now`,
 * which is what keeps the group's earlier history invisible to them (D-03).
 */
export function addGroupMembers(
  conversationId: string,
  userIds: string[],
): Promise<ConversationMembersWire> {
  return request<ConversationMembersWire>(
    `/api/conversations/${encodeURIComponent(conversationId)}/members`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ userIds }),
    },
  );
}

/**
 * Remove somebody from a group, or leave it by naming yourself.
 *
 * One call for both: the server compares this id with the session's own and applies the rule that
 * fits, so a browser cannot choose which rule it is judged by. `conversation` comes back null
 * when the caller is the one who left.
 */
export function removeGroupMember(
  conversationId: string,
  userId: string,
): Promise<ConversationMembersWire> {
  return request<ConversationMembersWire>(
    `/api/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );
}

export interface HistoryQuery {
  /** Older than this message. */
  before?: string;
  /** Newer than this message — the reconnect backfill. */
  after?: string;
  limit?: number;
}

export function fetchMessages(
  conversationId: string,
  query: HistoryQuery = {},
): Promise<MessagePageWire> {
  const params = new URLSearchParams();
  if (query.before) params.set('before', query.before);
  if (query.after) params.set('after', query.after);
  if (query.limit !== undefined) params.set('limit', String(query.limit));

  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return request<MessagePageWire>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages${suffix}`,
  );
}

/** Move the read marker to a message the user has actually seen. */
export function markRead(conversationId: string, messageId: string): Promise<ReadReceiptWire> {
  return request<ReadReceiptWire>(
    `/api/conversations/${encodeURIComponent(conversationId)}/read`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ messageId }),
    },
  );
}
