'use client';

import { useEffect, useRef } from 'react';

import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { formatDayLabel, formatFullTimestamp, formatTime } from '@/lib/chat/format';
import type { ChatMessage, UserSummary } from '@/lib/chat/types';
import { cn } from '@/lib/ui/cn';

interface MessageListProps {
  messages: ChatMessage[];
  currentUserId: string;
  usersById: Map<string, UserSummary>;
  /** Group conversations name the sender above the bubble; direct ones do not need to. */
  showSenderNames: boolean;
  /** Scrolls to the newest message when this changes. */
  conversationId: string;
  /** A page of history is in flight. */
  loading: boolean;
  /** History has been read at least once, so "no messages" is a fact rather than a guess. */
  loaded: boolean;
  /** Older messages exist before the oldest one on screen. */
  hasOlderMessages: boolean;
  onLoadOlder: () => void;
  /** Re-sends a message whose delivery failed, reusing its idempotency key. */
  onRetry: (message: ChatMessage) => void;
}

/** Messages sent within this window by the same person are visually grouped. */
const GROUPING_WINDOW_MS = 5 * 60_000;

export function MessageList({
  messages,
  currentUserId,
  usersById,
  showSenderNames,
  conversationId,
  loading,
  loaded,
  hasOlderMessages,
  onLoadOlder,
  onRetry,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Follow the conversation: jump to the newest message when the conversation changes, and keep
  // up as messages arrive. Paging backwards only adds rows above, so it does not fight this.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [conversationId, messages.length]);

  if (messages.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10">
        <p className="max-w-sm text-center text-sm text-ink-subtle" role="status">
          {loading || !loaded
            ? 'Loading messages…'
            : 'No messages in this conversation yet. Write the first one below.'}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-4 sm:px-6">
      {/* `mt-auto` keeps a short conversation resting on the composer rather than floating. */}
      <ol className="mx-auto mt-auto flex w-full max-w-3xl flex-col gap-1" aria-label="Messages">
        {hasOlderMessages ? (
          <li className="mb-2 flex justify-center">
            <Button size="sm" onClick={onLoadOlder} disabled={loading}>
              {loading ? 'Loading…' : 'Load earlier messages'}
            </Button>
          </li>
        ) : null}

        {buildRows(messages).map(({ message, dayLabel, grouped }) => (
          <li key={message.id}>
            {dayLabel ? <DayDivider label={dayLabel} /> : null}
            {message.kind === 'SYSTEM' ? (
              <SystemMessage message={message} />
            ) : (
              <MessageBubble
                message={message}
                isOwn={message.senderId === currentUserId}
                senderName={usersById.get(message.senderId ?? '')?.displayName ?? 'Unknown user'}
                senderId={message.senderId}
                showSenderName={showSenderNames}
                grouped={grouped}
                onRetry={() => onRetry(message)}
              />
            )}
          </li>
        ))}
      </ol>
      <div ref={bottomRef} />
    </div>
  );
}

interface MessageRow {
  message: ChatMessage;
  /** Set on the first message of each calendar day, which renders the date separator. */
  dayLabel: string | null;
  /** True when this message continues the previous one from the same sender. */
  grouped: boolean;
}

/**
 * Works out where date separators go and which messages are visually grouped, once, before
 * rendering. Kept a plain function so the decision for each row does not depend on a variable
 * carried across the render.
 */
function buildRows(messages: readonly ChatMessage[]): MessageRow[] {
  let previousDay = '';

  return messages.map((message, index) => {
    const dayLabel = formatDayLabel(message.createdAt);
    const startsNewDay = dayLabel !== previousDay;
    previousDay = dayLabel;

    const previous = index > 0 ? messages[index - 1] : undefined;
    const grouped =
      !startsNewDay &&
      previous !== undefined &&
      previous.kind === message.kind &&
      previous.senderId === message.senderId &&
      new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() <
        GROUPING_WINDOW_MS;

    return { message, dayLabel: startsNewDay ? dayLabel : null, grouped };
  });
}

function DayDivider({ label }: { label: string }) {
  return (
    <div className="my-4 flex items-center gap-3">
      <span className="h-px flex-1 bg-line" />
      <span className="text-xs font-medium text-ink-subtle" suppressHydrationWarning>
        {label}
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

/**
 * Membership and group events. Rendered as plain text, centred, and never attributed to a
 * sender — the server writes these, not a user.
 */
function SystemMessage({ message }: { message: ChatMessage }) {
  return (
    <p className="my-3 text-center text-xs text-ink-subtle">
      <span className="rounded-full bg-canvas px-3 py-1">{message.body}</span>
    </p>
  );
}

interface MessageBubbleProps {
  message: ChatMessage;
  isOwn: boolean;
  senderId: string | null;
  senderName: string;
  showSenderName: boolean;
  grouped: boolean;
  onRetry: () => void;
}

/**
 * A single message.
 *
 * The body is rendered as text through React, which escapes it. `dangerouslySetInnerHTML` is
 * prohibited in this codebase (docs/04-security.md §3, "Injection") — message bodies are plain
 * text (A-06) and must never be interpreted as markup.
 */
function MessageBubble({
  message,
  isOwn,
  senderId,
  senderName,
  showSenderName,
  grouped,
  onRetry,
}: MessageBubbleProps) {
  const sending = message.deliveryState === 'SENDING';
  const failed = message.deliveryState === 'FAILED';

  return (
    <div
      className={cn(
        'flex items-end gap-2',
        grouped ? 'mt-0.5' : 'mt-3',
        isOwn ? 'justify-end' : 'justify-start',
      )}
    >
      {!isOwn ? (
        <span className="w-8 shrink-0">
          {!grouped && senderId ? (
            <Avatar userId={senderId} displayName={senderName} size="sm" />
          ) : null}
        </span>
      ) : null}

      <div className={cn('max-w-[min(42rem,80%)]', isOwn && 'items-end')}>
        {!isOwn && showSenderName && !grouped ? (
          <p className="mb-1 text-xs font-medium text-ink-muted">{senderName}</p>
        ) : null}

        <div
          className={cn(
            'rounded-2xl px-3.5 py-2 text-[0.9375rem] leading-6 break-words whitespace-pre-wrap',
            isOwn
              ? 'rounded-br-sm bg-accent text-white'
              : 'rounded-bl-sm border border-line bg-surface text-ink',
            // Not yet acknowledged by the server, and shown as such rather than as delivered.
            sending && 'opacity-70',
            failed && 'ring-2 ring-danger/60',
          )}
        >
          {message.body}
        </div>

        <p className={cn('mt-1 text-[11px] text-ink-subtle', isOwn && 'text-right')}>
          <time
            dateTime={message.createdAt}
            title={formatFullTimestamp(message.createdAt)}
            suppressHydrationWarning
          >
            {formatTime(message.createdAt)}
          </time>
          {sending ? <span className="ml-1.5">Sending…</span> : null}
        </p>

        {/*
          A failed message is never dressed up as sent. Retrying reuses the same idempotency key,
          so if the original write did commit and only the acknowledgement was lost, the server
          returns that row instead of storing the message a second time.
        */}
        {failed ? (
          <p className={cn('mt-0.5 text-[11px] text-danger', isOwn && 'text-right')} role="alert">
            Not sent.{' '}
            <button
              type="button"
              onClick={onRetry}
              className="cursor-pointer font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
            >
              Try again
            </button>
          </p>
        ) : null}
      </div>
    </div>
  );
}
