'use client';

import { useEffect, useRef } from 'react';

import { AttachmentCard, UploadCard } from '@/components/chat/AttachmentCard';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ChatIcon } from '@/components/ui/icons';
import { formatDayLabel, formatFullTimestamp, formatTime } from '@/lib/chat/format';
import type { ChatMessage, PendingUpload, UserSummary } from '@/lib/chat/types';
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
  /** Files this browser is uploading into this conversation. Local state, never a message. */
  uploads: PendingUpload[];
  onCancelUpload: (clientMessageId: string) => void;
  onDismissUpload: (clientMessageId: string) => void;
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
  uploads,
  onCancelUpload,
  onDismissUpload,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Follow the conversation: jump to the newest message when the conversation changes, and keep
  // up as messages arrive. Paging backwards only adds rows above, so it does not fight this.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [conversationId, messages.length]);

  // An upload in flight is something to show, so an otherwise empty conversation must not fall
  // into the empty state and hide it.
  if (messages.length === 0 && uploads.length === 0) {
    return (
      <div className="chat-canvas flex min-h-0 flex-1 items-center justify-center px-6 py-10">
        <div className="max-w-sm text-center" role="status">
          <span
            className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-line bg-surface text-brand shadow-subtle"
            aria-hidden="true"
          >
            <ChatIcon className="h-5 w-5" />
          </span>
          <p className="mt-3 text-sm text-ink-muted">
            {loading || !loaded
              ? 'Loading messages…'
              : 'No messages here yet. Write the first one below.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-canvas flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-4 sm:px-6">
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

      {/*
        Uploads sit after the messages rather than among them, because they are not messages yet:
        nobody else can see these files, and placing them in the timeline would suggest otherwise.
        Same column width as the messages, so a card lines up with the bubbles above it.
      */}
      {uploads.length > 0 ? (
        <div className="mx-auto w-full max-w-3xl">
          {uploads.map((upload) => (
            <UploadCard
              key={upload.clientMessageId}
              upload={upload}
              onCancel={() => onCancelUpload(upload.clientMessageId)}
              onDismiss={() => onDismissUpload(upload.clientMessageId)}
            />
          ))}
        </div>
      ) : null}

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

/**
 * Date separator.
 *
 * A floating pill rather than a rule across the column: the message area has a tinted background,
 * and a hairline drawn across it reads as a crack in the surface.
 */
function DayDivider({ label }: { label: string }) {
  return (
    <div className="my-4 flex justify-center">
      <span
        className="rounded-full border border-line bg-surface/80 px-3 py-1 text-[11px] font-semibold tracking-wide text-ink-muted uppercase shadow-subtle backdrop-blur-sm"
        suppressHydrationWarning
      >
        {label}
      </span>
    </div>
  );
}

/**
 * Membership and group events. Rendered as plain text, centred, and never attributed to a
 * sender — the server writes these, not a user.
 */
function SystemMessage({ message }: { message: ChatMessage }) {
  return (
    <p className="my-3 text-center">
      <span className="inline-block rounded-full border border-line bg-surface/70 px-3 py-1 text-xs text-ink-muted">
        {message.body}
      </span>
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
          <p className="mb-1 text-xs font-semibold text-brand">{senderName}</p>
        ) : null}

        {/*
          Own messages are the company bronze with white on it (6.4:1); everyone else's are white
          with a hairline. The "tail" is the one corner that stays square on the side the message
          came from — the cheapest way to say who sent it without a drawn pointer.
        */}
        <div
          className={cn(
            'rounded-bubble px-3.5 py-2 text-[0.9375rem] leading-6 break-words whitespace-pre-wrap',
            'shadow-bubble transition-shadow duration-(--duration-quick)',
            isOwn
              ? 'rounded-br-md bg-accent text-white'
              : 'rounded-bl-md border border-line bg-surface text-ink',
            // Not yet acknowledged by the server, and shown as such rather than as delivered.
            sending && 'opacity-70',
            failed && 'ring-2 ring-danger/60',
          )}
        >
          {/*
            A file and a caption, in that order. The schema allows a `FILE` message to carry a
            body, so somebody can send a spreadsheet and say what it is in one message; when there
            is no caption the bubble is just the file.
          */}
          {message.attachment ? (
            <AttachmentCard attachment={message.attachment} isOwn={isOwn} />
          ) : null}
          {message.body ? (
            <span className={cn('block', message.attachment && 'mt-2')}>{message.body}</span>
          ) : null}
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
