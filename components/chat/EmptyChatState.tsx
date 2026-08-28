'use client';

import { Button } from '@/components/ui/Button';
import { ChatIcon, GroupIcon, NewChatIcon } from '@/components/ui/icons';

interface EmptyChatStateProps {
  /** True when the user has no conversations at all, rather than simply none selected. */
  hasNoConversations: boolean;
  onNewChat: () => void;
  onNewGroup: () => void;
}

/** Shown in the message area when no conversation is open. */
export function EmptyChatState({
  hasNoConversations,
  onNewChat,
  onNewGroup,
}: EmptyChatStateProps) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-12">
      <div className="max-w-sm text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-accent">
          <ChatIcon className="h-6 w-6" />
        </span>

        <h2 className="mt-4 text-base font-semibold text-ink">
          {hasNoConversations ? 'No conversations yet' : 'No conversation selected'}
        </h2>

        <p className="mt-1.5 text-sm text-ink-muted">
          {hasNoConversations
            ? 'Start a private chat with a colleague, or create a group for a team or project.'
            : 'Choose a conversation from the list to read it and reply.'}
        </p>

        <div className="mt-5 flex flex-col justify-center gap-2 sm:flex-row">
          <Button variant="primary" onClick={onNewChat}>
            <NewChatIcon className="h-4 w-4" />
            New chat
          </Button>
          <Button onClick={onNewGroup}>
            <GroupIcon className="h-4 w-4" />
            New group
          </Button>
        </div>
      </div>
    </div>
  );
}
