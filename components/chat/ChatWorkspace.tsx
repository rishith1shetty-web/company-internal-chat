'use client';

import { useCallback, useMemo, useState } from 'react';

import { ChatHeader } from '@/components/chat/ChatHeader';
import { ConnectionNotice } from '@/components/chat/ConnectionNotice';
import { DetailsPanel } from '@/components/chat/DetailsPanel';
import { EmptyChatState } from '@/components/chat/EmptyChatState';
import { MessageComposer } from '@/components/chat/MessageComposer';
import { MessageList } from '@/components/chat/MessageList';
import { NameEntryScreen } from '@/components/chat/NameEntryScreen';
import { NewChatDialog } from '@/components/chat/NewConversationDialogs';
import { Sidebar } from '@/components/chat/Sidebar';
import {
  AttachmentDialog,
  GroupsUnavailableDialog,
  SettingsDialog,
  SwitchUserDialog,
} from '@/components/chat/SystemDialogs';
import { AppHeader } from '@/components/layout/AppHeader';
import { hasNameCollision } from '@/lib/chat/format';
import {
  conversationTitle,
  selectConversationListEntries,
  selectDirectCounterpart,
  selectDirectoryUsers,
  selectHistoryState,
  selectMessages,
  selectSelectedConversation,
  selectUsersById,
} from '@/lib/chat/state';
import { useChatSession } from '@/lib/chat/useChatSession';
import { cn } from '@/lib/ui/cn';
import { useMediaQuery } from '@/lib/ui/useMediaQuery';

type DialogName = 'new-chat' | 'new-group' | 'attachment' | 'switch-user' | 'settings';

/**
 * The application shell: header, conversation sidebar, chat panel and details panel, plus the
 * dialogs that act on them.
 *
 * This is the single client boundary for the chat interface. It holds no chat state of its own —
 * `useChatSession` owns that, and everything below this component is presentational and receives
 * data and callbacks (docs/01-architecture.md §4, "Layer rules").
 *
 * PHASE 5: conversations, messages, presence and identity are real and come from the server.
 * Group creation is Phase 6 and file transfer is Phase 7; both controls are present and say so
 * rather than doing something that only looks like it worked.
 */
export function ChatWorkspace() {
  const session = useChatSession();
  const { state } = session;

  const [openDialog, setOpenDialog] = useState<DialogName | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  /*
   * The details panel is open by default where there is room for it beside the conversation,
   * and closed on narrower screens where it would cover the conversation instead. Once the user
   * decides for themselves, their choice wins and the screen width stops deciding.
   */
  const wideScreen = useMediaQuery('(min-width: 1280px)');
  const [detailsOverride, setDetailsOverride] = useState<boolean | null>(null);
  const detailsOpen = detailsOverride ?? wideScreen;

  const usersById = useMemo(() => selectUsersById(state), [state]);
  const listEntries = useMemo(() => selectConversationListEntries(state), [state]);
  const directoryUsers = useMemo(() => selectDirectoryUsers(state), [state]);
  const selectedConversation = selectSelectedConversation(state);
  const currentUser = state.currentUser;

  const closeDialog = useCallback(() => setOpenDialog(null), []);

  /**
   * Opening the picker re-reads the directory.
   *
   * The colleague list is loaded when the workspace opens; somebody who entered their name five
   * minutes later would be missing from it, which looks identical to them not existing.
   */
  const openNewChat = () => {
    session.refreshDirectory();
    setOpenDialog('new-chat');
  };

  const confirmSwitchUser = async () => {
    const switched = await session.switchUser();
    if (!switched) return;

    closeDialog();
    setDetailsOverride(null);
    setSidebarOpen(false);
  };

  if (state.screen === 'loading') {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-canvas px-4">
        <p className="text-sm text-ink-muted" role="status">
          Loading your conversations…
        </p>
      </main>
    );
  }

  if (state.screen === 'name-entry' || !currentUser) {
    return (
      <NameEntryScreen
        onEnter={session.enter}
        pending={session.entering}
        error={state.notice}
        afterSwitchUser={state.afterSwitchUser}
      />
    );
  }

  const selectConversation = (conversationId: string) => {
    session.selectConversation(conversationId);
    setSidebarOpen(false);
  };

  const startDirectConversation = (otherUserId: string) => {
    void session.startDirectConversation(otherUserId);
  };

  const selectedTitle = selectedConversation
    ? conversationTitle(selectedConversation, currentUser.id, usersById)
    : '';
  const counterpart = selectedConversation
    ? selectDirectCounterpart(selectedConversation, currentUser.id, usersById)
    : null;
  const currentUserSummary = usersById.get(currentUser.id) ?? {
    id: currentUser.id,
    displayName: currentUser.displayName,
    presence: 'ONLINE' as const,
    lastSeenAt: null,
  };
  const history = selectedConversation
    ? selectHistoryState(state, selectedConversation.id)
    : null;

  return (
    <div className="flex h-dvh flex-col bg-canvas text-ink">
      <a
        href="#conversation"
        className="sr-only rounded-md bg-accent px-3 py-2 text-sm text-white focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50"
      >
        Skip to conversation
      </a>

      <AppHeader
        currentUser={currentUserSummary}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        onSwitchUser={() => setOpenDialog('switch-user')}
        onOpenSettings={() => setOpenDialog('settings')}
      />

      {/* Honest about the connection: a chat that is quietly offline is worse than one that says so. */}
      <ConnectionNotice
        connection={state.connection}
        notice={state.notice}
        onDismissNotice={session.dismissNotice}
      />

      <div className="relative flex min-h-0 flex-1">
        {/* Conversation sidebar: a column on desktop, an overlay on small screens. */}
        {sidebarOpen ? (
          <div
            className="absolute inset-0 z-20 bg-ink/40 md:hidden"
            onClick={() => setSidebarOpen(false)}
            role="presentation"
          />
        ) : null}

        <aside
          className={cn(
            'absolute inset-y-0 left-0 z-30 w-80 max-w-[85vw] shrink-0 border-r border-line shadow-lg',
            'md:static md:z-auto md:w-72 md:max-w-none md:shadow-none lg:w-80',
            sidebarOpen ? 'block' : 'hidden md:block',
          )}
          aria-label="Conversations"
        >
          <Sidebar
            entries={listEntries}
            selectedConversationId={state.selectedConversationId}
            searchTerm={state.searchTerm}
            onSearchChange={session.setSearchTerm}
            onSelectConversation={selectConversation}
            onNewChat={openNewChat}
            onNewGroup={() => setOpenDialog('new-group')}
            onClose={() => setSidebarOpen(false)}
          />
        </aside>

        <main id="conversation" className="flex min-w-0 flex-1 flex-col bg-canvas">
          {selectedConversation ? (
            <>
              <ChatHeader
                conversation={selectedConversation}
                title={selectedTitle}
                counterpart={counterpart}
                showDiscriminator={
                  counterpart ? hasNameCollision([...usersById.values()], counterpart) : false
                }
                detailsOpen={detailsOpen}
                onToggleDetails={() => setDetailsOverride(!detailsOpen)}
              />

              <MessageList
                messages={selectMessages(state, selectedConversation.id)}
                currentUserId={currentUser.id}
                usersById={usersById}
                showSenderNames={selectedConversation.type === 'GROUP'}
                conversationId={selectedConversation.id}
                loading={history?.loading ?? false}
                loaded={history?.loaded ?? false}
                hasOlderMessages={history?.hasMore ?? false}
                onLoadOlder={session.loadOlderMessages}
                onRetry={session.retryMessage}
              />

              <MessageComposer
                /* Remounting per conversation gives each one a fresh, empty composer. */
                key={selectedConversation.id}
                conversationTitle={selectedTitle}
                onSend={session.sendMessage}
                onAttachFile={() => setOpenDialog('attachment')}
              />
            </>
          ) : (
            <EmptyChatState
              hasNoConversations={state.conversations.length === 0}
              onNewChat={openNewChat}
              onNewGroup={() => setOpenDialog('new-group')}
            />
          )}
        </main>

        {/* Details panel: a column on wide screens, an overlay below them. */}
        {selectedConversation && detailsOpen ? (
          <>
            <div
              className="absolute inset-0 z-20 bg-ink/40 xl:hidden"
              onClick={() => setDetailsOverride(false)}
              role="presentation"
            />
            <aside
              className="absolute inset-y-0 right-0 z-30 w-80 max-w-[85vw] border-l border-line shadow-lg xl:static xl:z-auto xl:max-w-none xl:shadow-none"
              aria-label="Conversation details"
            >
              <DetailsPanel
                conversation={selectedConversation}
                title={selectedTitle}
                currentUserId={currentUser.id}
                usersById={usersById}
                onClose={() => setDetailsOverride(false)}
              />
            </aside>
          </>
        ) : null}
      </div>

      {/* Each dialog is mounted only while it is open, so it always starts from a clean slate. */}
      {openDialog === 'new-chat' ? (
        <NewChatDialog
          users={directoryUsers}
          onClose={closeDialog}
          onStart={startDirectConversation}
          onSearch={session.searchDirectory}
        />
      ) : null}
      <GroupsUnavailableDialog open={openDialog === 'new-group'} onClose={closeDialog} />
      <AttachmentDialog open={openDialog === 'attachment'} onClose={closeDialog} />
      <SwitchUserDialog
        open={openDialog === 'switch-user'}
        currentUser={currentUserSummary}
        onClose={closeDialog}
        onConfirm={() => void confirmSwitchUser()}
      />
      <SettingsDialog
        open={openDialog === 'settings'}
        currentUser={currentUserSummary}
        onClose={closeDialog}
        onSwitchUser={() => setOpenDialog('switch-user')}
      />
    </div>
  );
}
