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

  /** True when the session has gone: the interface must return to the name screen. */
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

/** Who am I? `null` when this browser has no identity yet — a normal state, not an error. */
export async function fetchSession(): Promise<SessionIdentityWire | null> {
  const identity = await request<SessionIdentityWire | undefined>('/api/session');
  return identity ?? null;
}

/**
 * Enter with a display name.
 *
 * Always produces a NEW user. Entering a name that already exists does not sign you in as that
 * person — names are not unique and are not identifiers (D-02).
 */
export function createSession(displayName: string): Promise<SessionIdentityWire> {
  return request<SessionIdentityWire>('/api/session', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ displayName }),
  });
}

/** Switch User / Clear Device Identity — revokes the session and the device server-side. */
export function endSession(): Promise<void> {
  return request<void>('/api/session', { method: 'DELETE' });
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
