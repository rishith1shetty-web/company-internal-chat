'use client';

import { Avatar } from '@/components/ui/Avatar';
import { CloseIcon, FileIcon, GroupIcon } from '@/components/ui/icons';
import { formatTime } from '@/lib/chat/format';
import type { ToastItem } from '@/lib/notifications/useNotifications';

/**
 * The in-app notification stack.
 *
 * WHERE IT SITS. Bottom-right, and lifted clear of the composer rather than resting on the
 * viewport edge. A toast that covers the message box is a toast that interrupts the reply it was
 * announcing — so the stack is offset by more than the composer's height, and the browser
 * regression asserts the two rectangles never intersect rather than trusting the arithmetic here.
 *
 * It also never blocks navigation: the sidebar and the header are on the other two edges, and on
 * a narrow screen the stack is inset from both sides so it cannot reach either.
 *
 * WHAT IT IS, STRUCTURALLY. A polite live region holding at most three items, newest at the
 * bottom, each one a button. Making the card itself the button — rather than putting a "Open"
 * link inside it — is what makes the whole surface clickable for a mouse and reachable in one tab
 * stop for a keyboard, with the dismiss control as the only thing inside it that is separately
 * focusable.
 */
export function NotificationToasts({
  toasts,
  onOpen,
  onDismiss,
}: {
  toasts: readonly ToastItem[];
  onOpen: (conversationId: string) => void;
  onDismiss: (key: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div
      /*
       * `polite`, not `assertive`: a message arriving is worth announcing at the next natural
       * pause, never worth cutting off what a screen reader is already saying.
       */
      role="status"
      aria-live="polite"
      aria-label="New message notifications"
      className={
        'pointer-events-none fixed right-3 bottom-28 z-50 flex w-[min(22rem,calc(100vw-1.5rem))] ' +
        'flex-col gap-2 sm:right-6 sm:bottom-32'
      }
    >
      {toasts.map((toast) => (
        <NotificationToast
          key={toast.key}
          toast={toast}
          onOpen={() => onOpen(toast.conversationId)}
          onDismiss={() => onDismiss(toast.key)}
        />
      ))}
    </div>
  );
}

function NotificationToast({
  toast,
  onOpen,
  onDismiss,
}: {
  toast: ToastItem;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      // The container is inert so the gap between cards never swallows a click aimed at the app
      // behind it; the card itself takes its events back.
      className="pointer-events-auto animate-toast-in"
      data-testid="notification-toast"
      data-conversation-id={toast.conversationId}
    >
      <div
        className={
          'group relative overflow-hidden rounded-panel border border-line bg-surface ' +
          'shadow-overlay ring-1 ring-ink/5'
        }
      >
        {/* The brand hairline, as on every other raised surface in the application. */}
        <div className="brand-rule h-0.5 w-full" aria-hidden="true" />

        <button
          type="button"
          onClick={onOpen}
          className={
            'flex w-full items-start gap-3 px-3.5 py-3 pr-10 text-left ' +
            'transition-colors duration-(--duration-quick) ease-(--ease-out-soft) ' +
            'hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:outline-none ' +
            'focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset'
          }
        >
          {toast.isGroup ? (
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gold-soft text-brand ring-1 ring-brand/12 ring-inset"
              aria-hidden="true"
            >
              <GroupIcon className="h-4.5 w-4.5" />
            </span>
          ) : toast.senderId ? (
            <Avatar userId={toast.senderId} displayName={toast.senderName ?? '?'} size="md" />
          ) : (
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-muted text-ink-subtle ring-1 ring-line ring-inset"
              aria-hidden="true"
            >
              <FileIcon className="h-4.5 w-4.5" />
            </span>
          )}

          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-semibold text-ink">{toast.title}</span>
              <span className="shrink-0 text-xs text-ink-subtle tabular-nums">
                {formatTime(toast.createdAt)}
              </span>
            </span>

            {/*
              Two lines, then an ellipsis. A long message must not grow the card until it reaches
              the composer it was positioned to avoid.
            */}
            <span className="mt-0.5 block line-clamp-2 text-sm text-ink-muted">{toast.body}</span>

            {toast.filename ? (
              <span className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-subtle">
                <FileIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate" title={toast.filename}>
                  {toast.filename}
                </span>
              </span>
            ) : null}
          </span>
        </button>

        {/*
          Dismiss is its own button, outside the card button — a button inside a button is invalid
          HTML and a click on it would open the conversation as well as closing the toast.
        */}
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Dismiss notification from ${toast.title}`}
          className={
            'absolute top-2.5 right-2 flex h-7 w-7 items-center justify-center rounded-control ' +
            'text-ink-subtle transition-colors duration-(--duration-quick) ' +
            'hover:bg-surface-muted hover:text-ink focus-visible:outline-none ' +
            'focus-visible:ring-2 focus-visible:ring-accent/40'
          }
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
