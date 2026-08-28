'use client';

import { Avatar } from '@/components/ui/Avatar';
import { IconButton } from '@/components/ui/Button';
import { GroupIcon, InfoIcon } from '@/components/ui/icons';
import { UserPresenceLine } from '@/components/chat/ConversationList';
import { formatPresence, memberCountLabel, userDiscriminator } from '@/lib/chat/format';
import type { Conversation, UserSummary } from '@/lib/chat/types';

interface ChatHeaderProps {
  conversation: Conversation;
  title: string;
  /** Direct conversations only; groups show a member count instead of a presence dot. */
  counterpart: UserSummary | null;
  showDiscriminator: boolean;
  detailsOpen: boolean;
  onToggleDetails: () => void;
}

/** Conversation header: who or what this is, and the controls that act on it. */
export function ChatHeader({
  conversation,
  title,
  counterpart,
  showDiscriminator,
  detailsOpen,
  onToggleDetails,
}: ChatHeaderProps) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 sm:px-4">
      {counterpart ? (
        <Avatar
          userId={counterpart.id}
          displayName={counterpart.displayName}
          presence={counterpart.presence}
        />
      ) : (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-canvas text-ink-muted">
          <GroupIcon className="h-5 w-5" />
        </span>
      )}

      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-semibold text-ink">
          {title}
          {counterpart && showDiscriminator ? (
            <span className="ml-1.5 text-xs font-normal text-ink-subtle">
              ID {userDiscriminator(counterpart.id)}
            </span>
          ) : null}
        </h2>
        {counterpart ? (
          <UserPresenceLine presence={counterpart.presence} text={formatPresence(counterpart)} />
        ) : (
          <p className="text-xs text-ink-subtle">{memberCountLabel(conversation)}</p>
        )}
      </div>

      <IconButton
        label={detailsOpen ? 'Hide conversation details' : 'Show conversation details'}
        onClick={onToggleDetails}
        aria-pressed={detailsOpen}
      >
        <InfoIcon />
      </IconButton>
    </div>
  );
}
