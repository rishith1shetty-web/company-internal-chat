'use client';

import { Avatar, GroupAvatar, PresenceDot, UnreadBadge } from '@/components/ui/Avatar';
import { ChatIcon, GroupIcon } from '@/components/ui/icons';
import { formatListTimestamp } from '@/lib/chat/format';
import type { ConversationListEntry } from '@/lib/chat/state';
import { cn } from '@/lib/ui/cn';

interface ConversationListProps {
  entries: ConversationListEntry[];
  selectedConversationId: string | null;
  onSelect: (conversationId: string) => void;
  /** Distinguishes "nothing yet" from "nothing matched the search". */
  searchTerm: string;
}

/** One-to-one and group conversations, most recent activity first. */
export function ConversationList({
  entries,
  selectedConversationId,
  onSelect,
  searchTerm,
}: ConversationListProps) {
  if (entries.length === 0) {
    return (
      <div className="px-3 py-8 text-center">
        <span
          className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-gold-soft text-brand"
          aria-hidden="true"
        >
          <ChatIcon className="h-5 w-5" />
        </span>
        <p className="mt-3 text-sm text-ink-muted">
          {searchTerm.trim().length > 0
            ? `No conversations match “${searchTerm.trim()}”.`
            : 'No conversations yet.'}
        </p>
        {searchTerm.trim().length === 0 ? (
          <p className="mt-1 text-xs text-ink-subtle">
            Use New chat or New group above to start one.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <ul className="space-y-0.5" aria-label="Conversations">
      {entries.map((entry) => (
        <li key={entry.id}>
          <ConversationListItem
            entry={entry}
            selected={entry.id === selectedConversationId}
            onSelect={() => onSelect(entry.id)}
          />
        </li>
      ))}
    </ul>
  );
}

function ConversationListItem({
  entry,
  selected,
  onSelect,
}: {
  entry: ConversationListEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  const unread = entry.unreadCount > 0;

  return (
    /*
     * The selected row is marked three ways, none of which is colour alone: a gold rail down its
     * left edge, a warm tinted fill, and a hairline ring. `aria-current` says the same thing to a
     * screen reader.
     */
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'relative flex w-full cursor-pointer items-center gap-3 overflow-hidden rounded-card px-2.5 py-2.5 text-left',
        'transition-[background-color,box-shadow] duration-(--duration-quick) ease-(--ease-out-soft)',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
        selected
          ? 'bg-accent-tint ring-1 ring-accent/15 ring-inset'
          : 'hover:bg-surface-muted active:bg-canvas-deep',
      )}
    >
      {selected ? (
        <span
          className="absolute inset-y-1.5 left-0 w-1 rounded-r-full bg-gold"
          aria-hidden="true"
        />
      ) : null}

      {entry.counterpart ? (
        <Avatar
          userId={entry.counterpart.id}
          displayName={entry.counterpart.displayName}
          presence={entry.counterpart.presence}
        />
      ) : (
        <GroupAvatar>
          <GroupIcon className="h-5 w-5" />
        </GroupAvatar>
      )}

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              'truncate text-sm',
              unread ? 'font-semibold text-ink' : 'font-medium text-ink',
            )}
          >
            {entry.title}
            {entry.discriminator ? (
              <span className="ml-1.5 text-xs font-normal text-ink-subtle">
                ID {entry.discriminator}
              </span>
            ) : null}
          </span>
          {entry.timestamp ? (
            <span
              className={cn(
                'shrink-0 text-[11px] tabular-nums',
                unread ? 'font-semibold text-brand' : 'text-ink-subtle',
              )}
              suppressHydrationWarning
            >
              {formatListTimestamp(entry.timestamp)}
            </span>
          ) : null}
        </span>

        <span className="mt-0.5 flex items-center justify-between gap-2">
          <span
            className={cn(
              'truncate text-xs',
              unread ? 'font-medium text-ink-muted' : 'text-ink-subtle',
            )}
          >
            {entry.preview}
          </span>
          <UnreadBadge count={entry.unreadCount} />
        </span>
      </span>
    </button>
  );
}

/** Compact presence line used where a row shows a single user rather than a conversation. */
export function UserPresenceLine({
  presence,
  text,
}: {
  presence: 'ONLINE' | 'OFFLINE';
  text: string;
}) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-ink-subtle">
      <PresenceDot presence={presence} />
      <span suppressHydrationWarning>{text}</span>
    </span>
  );
}
