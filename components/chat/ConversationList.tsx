'use client';

import { Avatar, PresenceDot, UnreadBadge } from '@/components/ui/Avatar';
import { GroupIcon } from '@/components/ui/icons';
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
      <p className="px-4 py-6 text-sm text-ink-subtle">
        {searchTerm.trim().length > 0
          ? `No conversations match "${searchTerm.trim()}".`
          : 'No conversations yet. Use "New chat" or "New group" to start one.'}
      </p>
    );
  }

  return (
    <ul className="py-1" aria-label="Conversations">
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
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full cursor-pointer items-center gap-3 border-l-2 px-3 py-2.5 text-left transition-colors duration-150',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
        selected
          ? 'border-accent bg-accent-tint'
          : 'border-transparent hover:bg-surface-muted',
      )}
    >
      {entry.counterpart ? (
        <Avatar
          userId={entry.counterpart.id}
          displayName={entry.counterpart.displayName}
          presence={entry.counterpart.presence}
        />
      ) : (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-canvas text-ink-muted">
          <GroupIcon className="h-5 w-5" />
        </span>
      )}

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              'truncate text-sm text-ink',
              unread ? 'font-semibold' : 'font-medium',
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
            <span className="shrink-0 text-xs text-ink-subtle" suppressHydrationWarning>
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
