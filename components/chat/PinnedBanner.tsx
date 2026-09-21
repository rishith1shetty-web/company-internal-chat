'use client';

import { useState } from 'react';

import { CloseIcon, PinIcon } from '@/components/ui/icons';
import type { ChatMessage, UserSummary } from '@/lib/chat/types';
import { cn } from '@/lib/ui/cn';

interface PinnedBannerProps {
  pinned: ChatMessage[];
  usersById: Map<string, UserSummary>;
  currentUserId: string;
  /** Scrolls the conversation to a pinned message. */
  onJump(messageId: string): void;
  onUnpin(message: ChatMessage): void;
}

/**
 * A slim bar above the conversation listing what has been pinned.
 *
 * Collapsed to one line by default — the newest pin — and expandable into the full list. That is
 * the whole design decision here: a conversation with six pinned messages must not lose a third
 * of its height to them, but a panel that hides everything behind a click is not "easily
 * discoverable" either. One line is always visible; the rest is one press away.
 *
 * Renders nothing at all when nothing is pinned, rather than an empty bar.
 */
export function PinnedBanner({
  pinned,
  usersById,
  currentUserId,
  onJump,
  onUnpin,
}: PinnedBannerProps) {
  const [expanded, setExpanded] = useState(false);

  if (pinned.length === 0) return null;

  const newest = pinned[0];
  if (!newest) return null;

  const shown = expanded ? pinned : [newest];

  return (
    <section
      aria-label="Pinned messages"
      className="border-b border-line bg-surface-muted/60 px-3 py-1.5 sm:px-6"
    >
      <div className="mx-auto w-full max-w-3xl">
        <ul className="space-y-1">
          {shown.map((message) => (
            <li key={message.id} className="flex items-center gap-2">
              <PinIcon className="h-3.5 w-3.5 shrink-0 text-brand" />

              <button
                type="button"
                onClick={() => onJump(message.id)}
                className={cn(
                  'min-w-0 flex-1 cursor-pointer truncate text-left text-xs',
                  'transition-colors duration-(--duration-quick) hover:text-ink',
                  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                )}
              >
                <span className="font-semibold text-brand">
                  {message.senderId === currentUserId
                    ? 'You'
                    : (usersById.get(message.senderId ?? '')?.displayName ?? 'Unknown user')}
                </span>
                <span className="text-ink-muted">
                  {' · '}
                  {message.body?.trim() || message.attachment?.filename || 'Attachment'}
                </span>
              </button>

              <button
                type="button"
                onClick={() => onUnpin(message)}
                aria-label="Unpin this message"
                title="Unpin"
                className={cn(
                  'shrink-0 cursor-pointer rounded p-0.5 text-ink-subtle',
                  'transition-colors duration-(--duration-quick) hover:text-ink',
                  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                )}
              >
                <CloseIcon className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>

        {pinned.length > 1 ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            className={cn(
              'mt-0.5 cursor-pointer text-[11px] font-medium text-brand',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
            )}
          >
            {expanded ? 'Show less' : `Show all ${pinned.length} pinned`}
          </button>
        ) : null}
      </div>
    </section>
  );
}
