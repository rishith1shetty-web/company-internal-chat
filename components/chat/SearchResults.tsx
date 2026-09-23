'use client';

import { Avatar, GroupAvatar } from '@/components/ui/Avatar';
import { FileIcon, GroupIcon, SearchIcon } from '@/components/ui/icons';
import { formatListTimestamp } from '@/lib/chat/format';
import { countResults, isEmptyResults, type SearchState } from '@/lib/chat/search';
import type { SearchFileWire, SearchMessageWire } from '@/lib/chat/wire';
import { cn } from '@/lib/ui/cn';

interface SearchResultsProps {
  state: SearchState;
  /** Opens (or reuses) the direct conversation with this person. */
  onOpenPerson: (userId: string) => void;
  /** Opens a conversation, optionally trying to jump to one message inside it. */
  onOpenConversation: (conversationId: string, messageId?: string) => void;
}

/**
 * Server-side search results, under the conversation list (Batch 1.6).
 *
 * WHAT THIS DOES AND DOES NOT SHOW. The sections above it — GROUPS and CHATS from Batch 1.4 —
 * already answer "which of my conversations match?" instantly and locally, with no request. This
 * region answers the things that only the server can: PEOPLE who are not yet in a conversation
 * with you, MESSAGE text, and FILENAMES. Rendering groups and chats a second time here would put
 * the same row on the screen twice, which is the confusion the brief asked to avoid.
 *
 * Every row is a real `<button>`, so the whole list is reachable by Tab and activated by Enter or
 * Space without a keyboard handler of our own. Nothing here is a link, because nothing here
 * navigates — it selects a conversation in the page that is already open.
 *
 * NOTHING IN THIS COMPONENT FETCHES. It renders the state the controller hands it and reports
 * clicks upwards. Searching changes no unread count and raises no notification; there is no code
 * path here by which it could.
 */
export function SearchResults({ state, onOpenPerson, onOpenConversation }: SearchResultsProps) {
  if (state.status === 'idle') return null;

  return (
    <section aria-labelledby="search-results-heading" className="mt-2 border-t border-line pt-2">
      <h3
        id="search-results-heading"
        className="px-2 pb-1 text-xs font-semibold tracking-wider text-ink-subtle uppercase"
      >
        Search results
      </h3>

      {/*
        One live region for the whole outcome. A screen reader is told "8 results" once, rather
        than having every row announced as it appears.
      */}
      <p aria-live="polite" className="sr-only">
        {state.status === 'loading'
          ? `Searching for ${state.query}`
          : state.status === 'error'
            ? 'Search is unavailable'
            : `${countResults(state.results)} results for ${state.query}`}
      </p>

      {state.status === 'loading' ? <SearchNotice>Searching…</SearchNotice> : null}

      {/*
        An error here is deliberately quiet and deliberately local. The conversation list above
        is untouched, the open conversation keeps working, the composer keeps working and the
        socket is not involved — a failed search must never take the chat down with it.
      */}
      {state.status === 'error' ? (
        <SearchNotice tone="error" role="status">
          {state.error ?? 'Search is unavailable right now.'}
        </SearchNotice>
      ) : null}

      {state.status === 'ready' && isEmptyResults(state.results) ? (
        <SearchNotice>
          <SearchIcon className="mr-1.5 inline h-3.5 w-3.5 opacity-60" />
          No messages, files or people match “{state.query}”.
        </SearchNotice>
      ) : null}

      {state.status === 'ready' && state.results ? (
        <>
          {/* Empty categories are omitted entirely rather than shown as empty headings. */}
          {state.results.people.length > 0 ? (
            <ResultGroup label="People">
              {state.results.people.map((person) => (
                <ResultRow
                  key={person.id}
                  onClick={() => onOpenPerson(person.id)}
                  icon={<Avatar userId={person.id} displayName={person.displayName} size="sm" />}
                  title={person.displayName}
                  detail="Start or open a direct chat"
                />
              ))}
            </ResultGroup>
          ) : null}

          {state.results.messages.length > 0 ? (
            <ResultGroup label="Messages">
              {state.results.messages.map((message) => (
                <ResultRow
                  key={message.id}
                  onClick={() => onOpenConversation(message.conversationId, message.id)}
                  icon={
                    message.conversationType === 'GROUP' ? (
                      <GroupAvatar size="sm">
                        <GroupIcon className="h-4 w-4" />
                      </GroupAvatar>
                    ) : (
                      <Avatar
                        userId={message.senderId ?? message.conversationId}
                        displayName={message.senderName ?? 'Unknown user'}
                        size="sm"
                      />
                    )
                  }
                  title={message.body}
                  detail={messageDetail(message)}
                  timestamp={message.createdAt}
                />
              ))}
            </ResultGroup>
          ) : null}

          {state.results.files.length > 0 ? (
            <ResultGroup label="Files">
              {state.results.files.map((file) => (
                <ResultRow
                  key={file.attachmentId}
                  /*
                   * Opens the conversation at the message that carries the file. It does NOT
                   * download it: a search result is a place to look, and downloading company
                   * files as a side effect of clicking a search row is not something an employee
                   * asked for. The file's own card in the conversation is where downloading lives.
                   */
                  onClick={() => onOpenConversation(file.conversationId, file.messageId)}
                  icon={
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-card bg-surface-muted">
                      <FileIcon className="h-4 w-4 text-ink-subtle" />
                    </span>
                  }
                  title={file.filename}
                  detail={fileDetail(file)}
                  timestamp={file.createdAt}
                />
              ))}
            </ResultGroup>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** Where a message was said, in the words the sidebar already uses. */
function messageDetail(message: SearchMessageWire): string {
  const who = message.senderName ?? 'Unknown user';
  return message.conversationType === 'GROUP'
    ? `${who} in ${message.conversationName ?? 'a group'}`
    : who;
}

function fileDetail(file: SearchFileWire): string {
  const who = file.senderName ?? 'Unknown user';
  return file.conversationType === 'GROUP'
    ? `${who} in ${file.conversationName ?? 'a group'}`
    : who;
}

function ResultGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-1.5 last:mb-0">
      <h4 className="px-2 py-1 text-[11px] font-semibold tracking-wider text-ink-subtle uppercase">
        {label}
      </h4>
      <ul className="space-y-0.5">{children}</ul>
    </div>
  );
}

interface ResultRowProps {
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  detail: string;
  timestamp?: string;
}

/**
 * One result.
 *
 * A real button inside a list item: focusable, in the tab order, activated by Enter and Space,
 * and announced as a button. `truncate` on both lines keeps a long message or a long filename
 * from widening the sidebar — the same treatment the conversation rows use.
 */
function ResultRow({ onClick, icon, title, detail, timestamp }: ResultRowProps) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-card px-2 py-1.5 text-left',
          'transition-colors duration-(--duration-quick) ease-(--ease-out-soft)',
          'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
          'hover:bg-surface-muted active:bg-canvas-deep',
        )}
      >
        <span className="shrink-0">{icon}</span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-ink">{title}</span>
          <span className="block truncate text-xs text-ink-subtle">{detail}</span>
        </span>

        {timestamp ? (
          <span className="shrink-0 text-[11px] text-ink-subtle tabular-nums">
            {formatListTimestamp(timestamp)}
          </span>
        ) : null}
      </button>
    </li>
  );
}

function SearchNotice({
  children,
  tone = 'muted',
  role,
}: {
  children: React.ReactNode;
  tone?: 'muted' | 'error';
  role?: string;
}) {
  return (
    <p
      {...(role ? { role } : {})}
      className={cn(
        'px-2 py-2 text-xs',
        tone === 'error' ? 'text-danger' : 'text-ink-subtle',
      )}
    >
      {children}
    </p>
  );
}
