'use client';

import { BrandLockup } from '@/components/brand/Logo';
import { Button } from '@/components/ui/Button';
import { GroupIcon, NewChatIcon } from '@/components/ui/icons';

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
    /*
     * The one place inside the chat interface where the full logo appears.
     *
     * It earns its place here rather than being decoration: this panel is the largest empty area
     * in the product and the first thing a new employee sees, so it is the right surface to say
     * whose system this is. It is not repeated in the header, the sidebar or any dialog.
     */
    <div className="chat-canvas flex flex-1 items-center justify-center px-6 py-12">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto w-fit rounded-panel border border-line bg-surface/80 px-8 py-6 shadow-card backdrop-blur-sm">
          <BrandLockup width={188} className="mx-auto h-auto w-[188px]" />
        </div>

        <h2 className="mt-6 text-lg font-semibold tracking-tight text-ink">
          {hasNoConversations ? 'Welcome to your workspace' : 'No conversation selected'}
        </h2>

        <p className="mx-auto mt-2 max-w-sm text-sm text-ink-muted">
          {hasNoConversations
            ? 'Start a private chat with a colleague, or create a group for a team or project. Messages and files stay on the company server.'
            : 'Choose a conversation from the list to read it and reply.'}
        </p>

        <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
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
