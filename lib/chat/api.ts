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
  ConversationAttachmentsWire,
  ConversationCreatedWire,
  ConversationListWire,
  ConversationMembersWire,
  DirectoryWire,
  MessageWire,
  MessagePageWire,
  ReadReceiptWire,
  SessionIdentityWire,
  ForwardResultWire,
  MessageMutationWire,
  MessageReadStatusWire,
  PinnedMessagesWire,
  SearchResultsWire,
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

/**
 * Whether a thrown value is a cancelled request rather than a failed one.
 *
 * Checked by `name` rather than with `instanceof DOMException`: Safari, Chrome and the Node
 * runtime the tests use do not all reject with the same constructor, and every one of them sets
 * `name` to `'AbortError'`.
 */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(input, {
      // Cookies are same-origin here, but stating it means a future change of origin fails
      // loudly rather than silently dropping the session.
      credentials: 'same-origin',
      ...init,
    });
  } catch (error) {
    /*
     * A deliberate cancellation is not a failure (Batch 1.6).
     *
     * Search aborts the previous request on every keystroke, and each abort rejects here. Turning
     * those into a network error would make an employee typing normally see "Cannot reach the
     * chat server" — so the abort is re-thrown as itself and the caller decides, which is the
     * only place that knows whether it did the cancelling.
     */
    if (isAbortError(error)) throw error;

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

/* ------------------------------------------------------------------------------------------- */
/* Files                                                                                         */
/* ------------------------------------------------------------------------------------------- */

/** Where a file lives once it is uploaded. Built from an id; the server re-authorizes each hit. */
export function attachmentDownloadUrl(attachmentId: string): string {
  return `/api/attachments/${encodeURIComponent(attachmentId)}/download`;
}

export interface UploadHandle {
  /** Resolves with the stored message once the server has committed it. */
  done: Promise<MessageWire>;
  /** Aborts the transfer. The server writes nothing and no message appears. */
  cancel(): void;
}

export interface UploadOptions {
  conversationId: string;
  file: File;
  /** The same idempotency key on a retry, so a repeat cannot post the file twice. */
  clientMessageId: string;
  /** Optional caption typed alongside the file. */
  caption?: string | undefined;
  /** Fraction 0–1 of the bytes the browser has handed to the network. */
  onProgress?: (fraction: number) => void;
}

/**
 * Uploads a file, reporting real progress.
 *
 * `XMLHttpRequest` rather than `fetch`, and for exactly one reason: `fetch` cannot report upload
 * progress. There is no event for it and no supported way to observe the request body being
 * consumed, so a `fetch` implementation would have to either show nothing or animate a bar that
 * is not measuring anything. A 500 MB video over a company LAN takes long enough that a made-up
 * bar would be a lie the user could catch.
 *
 * The file is sent as the raw request body, not as multipart form data. The server streams it
 * straight to disk, so neither side has to hold it in memory (see the route for the whole
 * reasoning). The two values a form would have carried are percent-encoded headers, because a
 * header cannot hold arbitrary Unicode and filenames very often are.
 *
 * `xhr.send(file)` streams from the browser's file handle — the page never reads the file into
 * memory either, which is what makes a large upload possible from a modest workstation.
 */
export function uploadAttachment(options: UploadOptions): UploadHandle {
  const request = new XMLHttpRequest();

  const done = new Promise<MessageWire>((resolve, reject) => {
    request.open(
      'POST',
      `/api/conversations/${encodeURIComponent(options.conversationId)}/attachments`,
      true,
    );
    request.withCredentials = true;

    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.setRequestHeader('X-Client-Message-Id', options.clientMessageId);
    request.setRequestHeader('X-Filename', encodeURIComponent(options.file.name));
    if (options.caption && options.caption.length > 0) {
      request.setRequestHeader('X-Caption', encodeURIComponent(options.caption));
    }

    if (options.onProgress) {
      const report = options.onProgress;
      request.upload.addEventListener('progress', (event) => {
        // `lengthComputable` is false for a stream of unknown size; reporting nothing is better
        // than reporting a fraction of an unknown total.
        if (event.lengthComputable && event.total > 0) report(event.loaded / event.total);
      });
    }

    request.addEventListener('load', () => {
      let body: unknown;
      try {
        body = JSON.parse(request.responseText) as unknown;
      } catch {
        body = undefined;
      }

      if (request.status >= 200 && request.status < 300) {
        resolve(body as MessageWire);
        return;
      }

      const error = (body as ApiErrorWire | undefined)?.error;
      reject(
        new ApiError(
          request.status,
          error?.code ?? 'UNKNOWN',
          error?.message ?? 'The file could not be sent.',
        ),
      );
    });

    request.addEventListener('error', () => {
      reject(new ApiError(0, 'NETWORK', 'Cannot reach the chat server. The file was not sent.'));
    });

    // A cancelled upload is not a failure to report to the user: they asked for it.
    request.addEventListener('abort', () => {
      reject(new ApiError(0, 'ABORTED', 'The upload was cancelled.'));
    });

    request.send(options.file);
  });

  return {
    done,
    cancel: () => request.abort(),
  };
}

/** The files in a conversation the caller may see. Bounded by `joinedAt` server-side. */
export function fetchConversationAttachments(
  conversationId: string,
): Promise<ConversationAttachmentsWire> {
  return request<ConversationAttachmentsWire>(
    `/api/conversations/${encodeURIComponent(conversationId)}/attachments`,
  );
}

/* ------------------------------------------------------------------------------------------- */
/* Message actions (Batch 1)                                                                     */
/* ------------------------------------------------------------------------------------------- */

/**
 * Sets, or changes, this user's reaction to a message.
 *
 * PUT because one person has at most one reaction to one message: it replaces a value at a known
 * address, so sending it twice leaves the same state. There is no user id in the request — the
 * reaction belongs to whoever the cookie resolves to.
 */
export function setReaction(messageId: string, emoji: string): Promise<MessageMutationWire> {
  return request<MessageMutationWire>(
    `/api/messages/${encodeURIComponent(messageId)}/reactions`,
    { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ emoji }) },
  );
}

/** Removes this user's own reaction. Removing one that is not there is a success. */
export function clearReaction(messageId: string): Promise<MessageMutationWire> {
  return request<MessageMutationWire>(
    `/api/messages/${encodeURIComponent(messageId)}/reactions`,
    { method: 'DELETE' },
  );
}

/** Pins or unpins a message for the whole conversation. */
export function setMessagePinned(
  messageId: string,
  pinned: boolean,
): Promise<MessageMutationWire> {
  return request<MessageMutationWire>(`/api/messages/${encodeURIComponent(messageId)}/pin`, {
    method: pinned ? 'POST' : 'DELETE',
  });
}

/**
 * Rewrites the text of a message this user sent (Batch 1.1).
 *
 * PATCH on the message itself rather than another `/:id/<verb>` route: editing changes the
 * message's own representation, which is what PATCH is for. The request carries the new text and
 * nothing else — there is no field in it that could name a sender, a conversation or a timestamp,
 * and the server refuses the request outright if one appears.
 *
 * An empty string is a legitimate value: it clears the caption of a file message. The server
 * decides whether that is allowed for the message in question, and refuses it for a text message.
 */
export function editMessage(
  messageId: string,
  body: string,
  /**
   * The edited text's mentions — the WHOLE set, not a change to it (Batch 1.7).
   *
   * Always sent, including as an empty array, because omitting it is how a mention would be
   * silently kept after the text that carried it was deleted.
   */
  mentions: {
    kind: 'USER' | 'EVERYONE';
    userId: string | null;
    startOffset: number;
    endOffset: number;
  }[] = [],
): Promise<MessageMutationWire> {
  return request<MessageMutationWire>(`/api/messages/${encodeURIComponent(messageId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body, mentions }),
  });
}

/**
 * Who has read a message this user sent in a group (Batch 1.3).
 *
 * The server refuses this for anybody but the sender, and derives the conversation from the
 * message rather than taking one from here — so there is no conversation id in this call and
 * nothing to point at the wrong one.
 */
export function fetchMessageReadStatus(messageId: string): Promise<MessageReadStatusWire> {
  return request<MessageReadStatusWire>(
    `/api/messages/${encodeURIComponent(messageId)}/info`,
  );
}

/** The pinned messages of a conversation, newest pin first. */
export function fetchPinnedMessages(conversationId: string): Promise<PinnedMessagesWire> {
  return request<PinnedMessagesWire>(
    `/api/conversations/${encodeURIComponent(conversationId)}/pins`,
  );
}

/**
 * Hides a message from this user only. Nobody else is affected.
 *
 * Answers 204 with no body, so there is nothing to parse — the caller updates its own state from
 * the message id it already had.
 */
export async function deleteMessageForMe(messageId: string): Promise<void> {
  await request<undefined>(`/api/messages/${encodeURIComponent(messageId)}/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'ME' }),
  });
}

/**
 * Replaces a message with a tombstone for everyone in the conversation.
 *
 * The server refuses this for anybody but the original sender; the interface only offering it on
 * your own messages is a convenience, never the control.
 */
export function deleteMessageForEveryone(messageId: string): Promise<MessageMutationWire> {
  return request<MessageMutationWire>(`/api/messages/${encodeURIComponent(messageId)}/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'EVERYONE' }),
  });
}

/**
 * Forwards a message into one or more conversations.
 *
 * Each destination carries its own `clientMessageId` — the same idempotency key a send uses, so a
 * retry after a dropped response collides with the stored row instead of forwarding a file twice.
 * Destinations are authorized one at a time, so the answer can be a partial success.
 */
export function forwardMessage(
  messageId: string,
  destinations: { conversationId: string; clientMessageId: string }[],
): Promise<ForwardResultWire> {
  return request<ForwardResultWire>(`/api/messages/${encodeURIComponent(messageId)}/forward`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ destinations }),
  });
}

/* ------------------------------------------------------------------------------------------- */
/* Global search (Batch 1.6)                                                                     */
/* ------------------------------------------------------------------------------------------- */

/**
 * Searches people, groups, messages and filenames.
 *
 * The `signal` is what makes typing cheap: when the next keystroke supersedes this request, the
 * caller aborts it and the browser stops waiting for a response nobody will use. An abort is NOT
 * a failure and must not be shown as one — `AbortError` is re-thrown unchanged so the caller can
 * tell it apart from a real one, which `request` could not do because it turns every thrown
 * fetch into a network `ApiError`.
 *
 * The term travels as a query parameter and is encoded here; the server binds it as a parameter
 * and never concatenates it into SQL.
 */
export function searchEverything(
  query: string,
  signal?: AbortSignal,
): Promise<SearchResultsWire> {
  return request<SearchResultsWire>(`/api/search?q=${encodeURIComponent(query)}`, {
    ...(signal ? { signal } : {}),
  });
}
