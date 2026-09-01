'use client';

import { ConversationList } from '@/components/chat/ConversationList';
import { Button, IconButton } from '@/components/ui/Button';
import { SearchField } from '@/components/ui/Field';
import { CloseIcon, GroupIcon, NewChatIcon } from '@/components/ui/icons';
import type { ConversationListEntry } from '@/lib/chat/state';

interface SidebarProps {
  entries: ConversationListEntry[];
  selectedConversationId: string | null;
  searchTerm: string;
  onSearchChange: (term: string) => void;
  onSelectConversation: (conversationId: string) => void;
  onNewChat: () => void;
  onNewGroup: () => void;
  /** Small screens only: the sidebar is an overlay there and needs a way back to the chat. */
  onClose: () => void;
}

/** Conversation navigation: search, the two creation actions, and the conversation list. */
export function Sidebar({
  entries,
  selectedConversationId,
  searchTerm,
  onSearchChange,
  onSelectConversation,
  onNewChat,
  onNewGroup,
  onClose,
}: SidebarProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="shrink-0 border-b border-line px-3 py-3">
        <div className="mb-2 flex items-center justify-between gap-2 md:hidden">
          <h2 className="text-sm font-semibold text-ink">Conversations</h2>
          <IconButton label="Close conversation list" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </div>

        {/* Section label on desktop, where the mobile heading above is hidden. */}
        <p className="mb-2 hidden text-xs font-semibold tracking-wider text-ink-subtle uppercase md:block">
          Conversations
        </p>

        <SearchField
          label="Search conversations and people"
          placeholder="Search conversations"
          value={searchTerm}
          onChange={(event) => onSearchChange(event.target.value)}
        />

        <div className="mt-2 flex gap-2">
          <Button variant="primary" size="sm" onClick={onNewChat} className="flex-1">
            <NewChatIcon className="h-4 w-4" />
            New chat
          </Button>
          <Button size="sm" onClick={onNewGroup} className="flex-1">
            <GroupIcon className="h-4 w-4" />
            New group
          </Button>
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2" aria-label="Conversation list">
        <ConversationList
          entries={entries}
          selectedConversationId={selectedConversationId}
          onSelect={onSelectConversation}
          searchTerm={searchTerm}
        />
      </nav>

      {/*
        What the application can do, stated plainly. Every one of these is real and persistent:
        there is no longer a control here that says it is waiting for a later phase.
      */}
      <p className="shrink-0 border-t border-line bg-surface-muted px-3 py-2.5 text-xs text-ink-subtle">
        One-to-one and group chat · file transfer
      </p>
    </div>
  );
}
