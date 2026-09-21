'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AttachmentCard, UploadCard } from '@/components/chat/AttachmentCard';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import {
  MessageContextMenu,
  type MessageMenuAction,
} from '@/components/chat/MessageContextMenu';
import { ChatIcon, ForwardIcon, PinIcon } from '@/components/ui/icons';
import { copyTextFor, writeClipboardText } from '@/lib/chat/clipboard';
import { formatDayLabel, formatFullTimestamp, formatTime } from '@/lib/chat/format';
import type { ChatMessage, PendingUpload, UserSummary } from '@/lib/chat/types';
import { cn } from '@/lib/ui/cn';

/**
 * What the message list can do to a message.
 *
 * Grouped into one object rather than six props: they are always supplied together by the
 * workspace, and a list of individually optional callbacks is how half of a feature ends up
 * silently wired.
 *
 * Copy is absent on purpose — it is pure clipboard work with no server involvement, so the list
 * does it itself rather than asking the workspace to.
 */
export interface MessageActions {
  onReply(message: ChatMessage): void;
  /** Loads the message's text back into the composer for the sender to rewrite (Batch 1.1). */
  onEdit(message: ChatMessage): void;
  onReact(message: ChatMessage, emoji: string): void;
  onForward(message: ChatMessage): void;
  onTogglePin(message: ChatMessage): void;
  /** Opens the delete dialog. The list never deletes anything directly. */
  onRequestDelete(message: ChatMessage): void;
  /** Scrolls to a quoted message, when it is loaded. */
  onJumpToMessage(messageId: string): void;
}

interface MessageListProps {
  messages: ChatMessage[];
  currentUserId: string;
  actions: MessageActions;
  /** The message to flash after a jump, so the eye can find it. */
  highlightedMessageId: string | null;
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
  actions,
  highlightedMessageId,
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

  /** Which message was right-clicked, and where. Null when no menu is open. */
  const [menu, setMenu] = useState<{ message: ChatMessage; x: number; y: number } | null>(null);
  /**
   * The outcome of the last copy, shown briefly. Local, transient, never a server round trip.
   *
   * Three states rather than a boolean, because "it failed" must be distinguishable from "nothing
   * has happened yet" — a copy that did not happen may not be reported as one that did.
   */
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const closeMenu = useCallback(() => setMenu(null), []);

  /*
   * Copy is entirely client-side: no request, no socket event, no unread change, no notification.
   *
   * WHAT IT COPIES is decided by `copyTextFor` — the text, or a file's caption, or otherwise its
   * filename. Never the bytes.
   *
   * WHETHER IT WORKED is decided by `writeClipboardText`, which tries the modern API and falls
   * back to the legacy one when it is missing or refused. That fallback is the fix: inside the
   * desktop client the async clipboard API is denied outright by the session's own permission
   * handler, and the previous implementation swallowed the rejection — so Copy silently did
   * nothing for every employee (lib/chat/clipboard.ts).
   *
   * The result is reported honestly. A failed copy says so instead of claiming "Copied".
   */
  const copyMessage = useCallback(async (message: ChatMessage) => {
    const text = copyTextFor(message);
    if (!text) return;

    const written = await writeClipboardText(text);
    setCopyState(written ? 'copied' : 'failed');
    window.setTimeout(() => setCopyState('idle'), written ? 1600 : 2600);
  }, []);

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
                currentUserId={currentUserId}
                usersById={usersById}
                senderName={usersById.get(message.senderId ?? '')?.displayName ?? 'Unknown user'}
                senderId={message.senderId}
                showSenderName={showSenderNames}
                grouped={grouped}
                highlighted={message.id === highlightedMessageId}
                onRetry={() => onRetry(message)}
                onReact={(emoji) => actions.onReact(message, emoji)}
                onJumpToReplyTarget={actions.onJumpToMessage}
                onOpenMenu={(x, y) => setMenu({ message, x, y })}
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

      {menu ? (
        <MessageContextMenu
          anchor={{ x: menu.x, y: menu.y }}
          myReaction={myReactionTo(menu.message, currentUserId)}
          onReact={
            // A tombstone and a system message have nothing to react to.
            menu.message.deletedAt === null && menu.message.kind !== 'SYSTEM'
              ? (emoji) => actions.onReact(menu.message, emoji)
              : null
          }
          actions={buildMenuActions(menu.message, {
            isOwn: menu.message.senderId === currentUserId,
            onReply: () => actions.onReply(menu.message),
            onCopy: () => void copyMessage(menu.message),
            onEdit: () => actions.onEdit(menu.message),
            onForward: () => actions.onForward(menu.message),
            onTogglePin: () => actions.onTogglePin(menu.message),
            onDelete: () => actions.onRequestDelete(menu.message),
          })}
          onClose={closeMenu}
        />
      ) : null}

      {/*
        The copy result.

        `role="status"` rather than an alert even for the failure: it is the answer to something
        the employee just did, not an interruption, and a screen reader should finish its sentence
        first. The failure lingers a little longer than the success, because it asks the reader to
        do something about it rather than just confirming what they expected.
      */}
      {copyState !== 'idle' ? (
        <div
          role="status"
          className={cn(
            'pointer-events-none fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-full',
            'px-3 py-1.5 text-xs font-medium shadow-lg',
            copyState === 'copied' ? 'bg-ink text-white' : 'bg-danger text-white',
          )}
        >
          {copyState === 'copied' ? 'Copied' : 'Could not copy — try Ctrl+C'}
        </div>
      ) : null}
    </div>
  );
}

/** This reader's own reaction to a message, or null. Derived from ids, never from a flag. */
function myReactionTo(message: ChatMessage, currentUserId: string): string | null {
  return (
    message.reactions.find((reaction) => reaction.userIds.includes(currentUserId))?.emoji ?? null
  );
}

/**
 * Which menu entries a message offers.
 *
 * `available` is computed from the message rather than the entries being hidden at the call
 * site, so the rules are in one place and readable together:
 *
 *   - A tombstone offers only "Delete for me" — there is nothing left to reply to, copy, forward
 *     or pin.
 *   - A SYSTEM message ("X joined the group") is the server talking: it can be copied and hidden,
 *     nothing else.
 *   - "Delete for everyone" is offered only on your own messages. The server enforces that
 *     independently; hiding the row is a courtesy, never the control.
 *   - A message still sending has no server id yet, so nothing that needs one is offered.
 */
function buildMenuActions(
  message: ChatMessage,
  handlers: {
    isOwn: boolean;
    onReply(): void;
    onCopy(): void;
    onEdit(): void;
    onForward(): void;
    onTogglePin(): void;
    onDelete(): void;
  },
): MessageMenuAction[] {
  const deleted = message.deletedAt !== null;
  const system = message.kind === 'SYSTEM';
  const settled = message.deliveryState === 'SENT';
  const hasText = Boolean(message.body?.trim() || message.attachment?.filename);
  /** Text of its own, as opposed to a filename that can be copied but not rewritten. */
  const hasBody = Boolean(message.body?.trim());

  return [
    {
      key: 'reply',
      label: 'Reply',
      available: settled && !deleted && !system,
      onSelect: handlers.onReply,
    },
    { key: 'copy', label: 'Copy', available: !deleted && hasText, onSelect: handlers.onCopy },
    /*
     * Edit: yours, still there, and with text in it to change.
     *
     * `hasBody` rather than `hasText`, and the difference matters: a file sent with no caption has
     * a filename to copy but nothing to edit. Adding a caption afterwards is a feature this is
     * deliberately not, and the server refuses it identically — the row being hidden here is a
     * courtesy, never the control.
     */
    {
      key: 'edit',
      label: 'Edit',
      available: handlers.isOwn && settled && !deleted && !system && hasBody,
      onSelect: handlers.onEdit,
    },
    {
      key: 'forward',
      label: 'Forward',
      available: settled && !deleted && !system,
      onSelect: handlers.onForward,
    },
    {
      key: 'pin',
      label: message.pinnedAt === null ? 'Pin' : 'Unpin',
      available: settled && !deleted && !system,
      onSelect: handlers.onTogglePin,
    },
    {
      key: 'delete',
      label: 'Delete',
      available: settled,
      danger: true,
      onSelect: handlers.onDelete,
    },
  ];
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
  currentUserId: string;
  usersById: Map<string, UserSummary>;
  senderId: string | null;
  senderName: string;
  showSenderName: boolean;
  grouped: boolean;
  /** Briefly outlined after somebody jumped to it from a reply or the pinned banner. */
  highlighted: boolean;
  onRetry: () => void;
  onReact: (emoji: string) => void;
  onJumpToReplyTarget: (messageId: string) => void;
  /** Viewport coordinates of the right-click. */
  onOpenMenu: (x: number, y: number) => void;
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
  currentUserId,
  usersById,
  senderId,
  senderName,
  showSenderName,
  grouped,
  highlighted,
  onRetry,
  onReact,
  onJumpToReplyTarget,
  onOpenMenu,
}: MessageBubbleProps) {
  const sending = message.deliveryState === 'SENDING';
  const failed = message.deliveryState === 'FAILED';
  const deleted = message.deletedAt !== null;

  return (
    <div
      id={`message-${message.id}`}
      data-message-id={message.id}
      /*
       * The right-click target is the whole row, so the menu opens from the generous area around
       * a short message rather than only from the few characters in it. `preventDefault` replaces
       * the browser's own menu — a deliberate trade every chat application makes, and the reason
       * the menu below has to provide Copy itself.
       */
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu(event.clientX, event.clientY);
      }}
      className={cn(
        'flex items-end gap-2 rounded-lg transition-colors duration-500',
        grouped ? 'mt-0.5' : 'mt-3',
        isOwn ? 'justify-end' : 'justify-start',
        highlighted && 'bg-accent/10',
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
          {/*
            A message deleted for everyone. The body and the attachment are already null — the
            server cleared them — so this renders a tombstone rather than hiding content that is
            still present. Italic and muted, because it is a statement about the conversation
            rather than something somebody said.
          */}
          {deleted ? (
            <span className={cn('block italic', isOwn ? 'text-white/70' : 'text-ink-subtle')}>
              This message was deleted
            </span>
          ) : (
            <>
              {message.isForwarded ? (
                <span
                  className={cn(
                    'mb-1 flex items-center gap-1 text-[11px] italic',
                    isOwn ? 'text-white/70' : 'text-ink-subtle',
                  )}
                >
                  <ForwardIcon className="h-3 w-3" />
                  Forwarded
                </span>
              ) : null}

              {message.replyTo ? (
                <ReplyQuote
                  reply={message.replyTo}
                  isOwn={isOwn}
                  senderName={
                    message.replyTo.senderId === currentUserId
                      ? 'You'
                      : (usersById.get(message.replyTo.senderId ?? '')?.displayName ??
                        'Unknown user')
                  }
                  onJump={() => onJumpToReplyTarget(message.replyTo!.id)}
                />
              ) : null}

              {message.attachment ? (
                <AttachmentCard attachment={message.attachment} isOwn={isOwn} />
              ) : null}
              {message.body ? (
                <span className={cn('block', message.attachment && 'mt-2')}>{message.body}</span>
              ) : null}
            </>
          )}
        </div>

        {/*
          Reactions sit under the bubble rather than inside it: they are other people's, and
          putting them in the bubble would make them look like part of the message.
        */}
        {message.reactions.length > 0 && !deleted ? (
          <div className={cn('mt-1 flex flex-wrap gap-1', isOwn && 'justify-end')}>
            {message.reactions.map((reaction) => {
              const mine = reaction.userIds.includes(currentUserId);
              const who = reaction.userIds
                .map((id) =>
                  id === currentUserId
                    ? 'You'
                    : (usersById.get(id)?.displayName ?? 'Unknown user'),
                )
                .join(', ');

              return (
                <button
                  key={reaction.emoji}
                  type="button"
                  onClick={() => onReact(reaction.emoji)}
                  title={`${who} reacted with ${reaction.emoji}`}
                  aria-label={`${who} reacted with ${reaction.emoji}. Select to ${mine ? 'remove yours' : 'add yours'}.`}
                  aria-pressed={mine}
                  className={cn(
                    'flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] leading-4',
                    'cursor-pointer transition-colors duration-(--duration-quick)',
                    'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                    mine
                      ? 'border-accent/40 bg-accent/15 text-ink'
                      : 'border-line bg-surface text-ink-muted hover:bg-surface-muted',
                  )}
                >
                  <span aria-hidden="true">{reaction.emoji}</span>
                  <span className="font-medium tabular-nums">{reaction.count}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        <p className={cn('mt-1 text-[11px] text-ink-subtle', isOwn && 'text-right')}>
          <time
            dateTime={message.createdAt}
            title={formatFullTimestamp(message.createdAt)}
            suppressHydrationWarning
          >
            {formatTime(message.createdAt)}
          </time>
          {/*
            "edited", beside the time rather than inside the bubble.
            
            Shown to everybody — sender and recipients, direct chats and groups — because a message
            that has changed since it was read is exactly the kind of thing a reader is entitled to
            know. It carries no timestamp of its own: when it was edited is rarely the question,
            and a second time next to the first reads as clutter.
          */}
          {message.editedAt !== null && !deleted ? (
            <span className="ml-1.5" title={`Edited ${formatFullTimestamp(message.editedAt)}`}>
              · edited
            </span>
          ) : null}
          {sending ? <span className="ml-1.5">Sending…</span> : null}
          {message.pinnedAt !== null && !deleted ? (
            <span className="ml-1.5 inline-flex items-center gap-0.5" title="Pinned">
              <PinIcon className="inline h-3 w-3" />
              <span className="sr-only">Pinned</span>
            </span>
          ) : null}
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

/**
 * The quoted message above a reply.
 *
 * Renders only what the server sent. `unavailable` and `deleted` are different states and are
 * shown differently on purpose: "deleted" is a fact about the conversation that everyone shares,
 * while "unavailable" means this reader is not entitled to the original — so it says as little as
 * possible and is not clickable, because there is nothing to jump to.
 */
function ReplyQuote({
  reply,
  isOwn,
  senderName,
  onJump,
}: {
  reply: NonNullable<ChatMessage['replyTo']>;
  isOwn: boolean;
  senderName: string;
  onJump: () => void;
}) {
  const text = reply.deleted
    ? 'Message deleted'
    : reply.unavailable
      ? 'Original message'
      : (reply.body ?? reply.attachmentFilename ?? 'Attachment');

  const content = (
    <>
      <span className={cn('block text-[11px] font-semibold', isOwn ? 'text-white/85' : 'text-brand')}>
        {reply.unavailable ? 'Reply' : senderName}
      </span>
      <span
        className={cn(
          'block truncate text-xs',
          isOwn ? 'text-white/75' : 'text-ink-muted',
          (reply.deleted || reply.unavailable) && 'italic',
        )}
      >
        {text}
      </span>
    </>
  );

  const className = cn(
    'mb-1.5 block w-full rounded-md border-l-2 px-2 py-1 text-left',
    isOwn ? 'border-white/50 bg-white/10' : 'border-accent/60 bg-surface-muted',
  );

  // Nothing to jump to: the reader cannot see the original at all.
  if (reply.unavailable) {
    return <span className={className}>{content}</span>;
  }

  return (
    <button
      type="button"
      onClick={onJump}
      className={cn(
        className,
        'cursor-pointer transition-opacity duration-(--duration-quick) hover:opacity-80',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
      )}
    >
      {content}
    </button>
  );
}
