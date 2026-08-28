'use client';

import { useCallback, useMemo, useReducer, useState } from 'react';

import { ChatHeader } from '@/components/chat/ChatHeader';
import { DetailsPanel } from '@/components/chat/DetailsPanel';
import { EmptyChatState } from '@/components/chat/EmptyChatState';
import { MessageComposer } from '@/components/chat/MessageComposer';
import { MessageList } from '@/components/chat/MessageList';
import { NameEntryScreen } from '@/components/chat/NameEntryScreen';
import { NewChatDialog, NewGroupDialog } from '@/components/chat/NewConversationDialogs';
import { Sidebar } from '@/components/chat/Sidebar';
import { AttachmentDialog, SettingsDialog, SwitchUserDialog } from '@/components/chat/SystemDialogs';
import { AppHeader } from '@/components/layout/AppHeader';
import { hasNameCollision } from '@/lib/chat/format';
import {
  chatReducer,
  conversationTitle,
  initialChatState,
  selectConversationListEntries,
  selectDirectCounterpart,
  selectMessages,
  selectSelectedConversation,
  selectUsersById,
} from '@/lib/chat/state';
import { cn } from '@/lib/ui/cn';
import { useMediaQuery } from '@/lib/ui/useMediaQuery';

type DialogName = 'new-chat' | 'new-group' | 'attachment' | 'switch-user' | 'settings';

/**
 * The application shell: header, conversation sidebar, chat panel and details panel, plus the
 * dialogs that act on them.
 *
 * This is the single client boundary for the chat interface and the only component that holds
 * state. Everything below it is presentational and receives data and callbacks, which is what
 * keeps Phase 4/5 from becoming a redesign: the reducer's actions become API calls and socket
 * emits, and the components stay as they are (docs/01-architecture.md §4, "Layer rules").
 *
 * PHASE 2: no network, no session, no persistence. See lib/mock/chat-seed.ts.
 */
export function ChatWorkspace() {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [openDialog, setOpenDialog] = useState<DialogName | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [hasSwitchedUser, setHasSwitchedUser] = useState(false);

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
  const selectedConversation = selectSelectedConversation(state);
  const currentUser = state.currentUser;

  const closeDialog = useCallback(() => setOpenDialog(null), []);

  const enter = (displayName: string) => {
    dispatch({ type: 'enter', userId: createId('usr'), displayName, now: new Date().toISOString() });
  };

  const confirmSwitchUser = () => {
    closeDialog();
    setDetailsOverride(null);
    setSidebarOpen(false);
    setHasSwitchedUser(true);
    dispatch({ type: 'switch-user' });
  };

  if (state.screen === 'name-entry' || !currentUser) {
    return <NameEntryScreen onEnter={enter} afterSwitchUser={hasSwitchedUser} />;
  }

  const selectConversation = (conversationId: string) => {
    dispatch({ type: 'select-conversation', conversationId });
    setSidebarOpen(false);
  };

  const sendMessage = (body: string) => {
    if (!selectedConversation) return;
    dispatch({
      type: 'send-message',
      conversationId: selectedConversation.id,
      body,
      messageId: createId('msg'),
      // The idempotency key Phase 4 uses to reconcile an optimistic bubble with the stored row.
      clientMessageId: createId('cmi'),
      now: new Date().toISOString(),
    });
  };

  const startDirectConversation = (otherUserId: string) => {
    dispatch({
      type: 'start-direct-conversation',
      otherUserId,
      conversationId: createId('cnv'),
      now: new Date().toISOString(),
    });
  };

  const createGroup = (name: string, memberIds: string[]) => {
    dispatch({
      type: 'create-group',
      conversationId: createId('cnv'),
      name,
      memberIds,
      systemMessageId: createId('msg'),
      now: new Date().toISOString(),
    });
  };

  const selectedTitle = selectedConversation
    ? conversationTitle(selectedConversation, currentUser.id, usersById)
    : '';
  const counterpart = selectedConversation
    ? selectDirectCounterpart(selectedConversation, currentUser.id, usersById)
    : null;
  const otherUsers = state.directory.filter((user) => user.id !== currentUser.id);

  return (
    <div className="flex h-dvh flex-col bg-canvas text-ink">
      <a
        href="#conversation"
        className="sr-only rounded-md bg-accent px-3 py-2 text-sm text-white focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50"
      >
        Skip to conversation
      </a>

      <AppHeader
        currentUser={currentUser}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        onSwitchUser={() => setOpenDialog('switch-user')}
        onOpenSettings={() => setOpenDialog('settings')}
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
            onSearchChange={(term) => dispatch({ type: 'set-search', term })}
            onSelectConversation={selectConversation}
            onNewChat={() => setOpenDialog('new-chat')}
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
              />

              <MessageComposer
                /* Remounting per conversation gives each one a fresh, empty composer. */
                key={selectedConversation.id}
                conversationTitle={selectedTitle}
                onSend={sendMessage}
                onAttachFile={() => setOpenDialog('attachment')}
              />
            </>
          ) : (
            <EmptyChatState
              hasNoConversations={state.conversations.length === 0}
              onNewChat={() => setOpenDialog('new-chat')}
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
          users={otherUsers}
          onClose={closeDialog}
          onStart={startDirectConversation}
        />
      ) : null}
      {openDialog === 'new-group' ? (
        <NewGroupDialog users={otherUsers} onClose={closeDialog} onCreate={createGroup} />
      ) : null}
      <AttachmentDialog open={openDialog === 'attachment'} onClose={closeDialog} />
      <SwitchUserDialog
        open={openDialog === 'switch-user'}
        currentUser={currentUser}
        onClose={closeDialog}
        onConfirm={confirmSwitchUser}
      />
      <SettingsDialog
        open={openDialog === 'settings'}
        currentUser={currentUser}
        onClose={closeDialog}
        onSwitchUser={() => setOpenDialog('switch-user')}
      />
    </div>
  );
}

/**
 * Local identifier for a locally created object.
 *
 * Phase 2 only. Every real id is issued by the server, which never trusts an id supplied by a
 * browser (CLAUDE.md §9); the one exception by design is `clientMessageId`, the browser-minted
 * idempotency key described in docs/01-architecture.md §6.
 */
function createId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(16).slice(2);
  return `${prefix}-${random.replace(/-/g, '').slice(0, 12)}`;
}
