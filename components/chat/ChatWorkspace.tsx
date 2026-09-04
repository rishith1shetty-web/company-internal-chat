'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ChatHeader } from '@/components/chat/ChatHeader';
import { ConnectionNotice } from '@/components/chat/ConnectionNotice';
import { DetailsPanel } from '@/components/chat/DetailsPanel';
import { EmptyChatState } from '@/components/chat/EmptyChatState';
import { MessageComposer } from '@/components/chat/MessageComposer';
import { MessageList } from '@/components/chat/MessageList';
import {
  AddMembersDialog,
  NewChatDialog,
  NewGroupDialog,
  RemoveMemberDialog,
  type PendingMemberRemoval,
} from '@/components/chat/NewConversationDialogs';
import { NotificationToasts } from '@/components/chat/NotificationToasts';
import { Sidebar } from '@/components/chat/Sidebar';
import { SettingsDialog } from '@/components/chat/SystemDialogs';
import { UnassignedDeviceScreen } from '@/components/chat/UnassignedDeviceScreen';
import { AppHeader } from '@/components/layout/AppHeader';
import { BrandLockup } from '@/components/brand/Logo';
import { hasNameCollision } from '@/lib/chat/format';
import {
  conversationTitle,
  selectConversationListEntries,
  selectDirectCounterpart,
  selectDirectoryUsers,
  selectHistoryState,
  selectMessages,
  selectSelectedConversation,
  selectSharedFiles,
  selectUploads,
  selectUsersById,
} from '@/lib/chat/state';
import { useChatSession } from '@/lib/chat/useChatSession';
import { desktopClientScope } from '@/lib/notifications/electron';
import type { NotificationPreferences } from '@/lib/notifications/preferences';
import { useNotifications } from '@/lib/notifications/useNotifications';
import { cn } from '@/lib/ui/cn';
import { useMediaQuery } from '@/lib/ui/useMediaQuery';

type DialogName = 'new-chat' | 'new-group' | 'add-members' | 'settings';

/**
 * Starting preferences inside the Windows desktop client.
 *
 * The only difference from the browser's is `desktop`. It is off by default in a browser because
 * turning it on means an operating-system permission prompt, and an unexplained prompt is one
 * people refuse permanently. The desktop client has no prompt — the popup is drawn by the
 * application's own process — so the caution has nothing left to protect against, and a chat
 * client that sits silently in the tray is not doing the job it was installed for.
 *
 * It remains a default, not a setting: the employee's own choice is stored and wins over this.
 */
const DESKTOP_CLIENT_PREFERENCES: NotificationPreferences = {
  sound: true,
  inApp: true,
  desktop: true,
};

/**
 * The application shell: header, conversation sidebar, chat panel and details panel, plus the
 * dialogs that act on them.
 *
 * This is the single client boundary for the chat interface. It holds no chat state of its own —
 * `useChatSession` owns that, and everything below this component is presentational and receives
 * data and callbacks (docs/01-architecture.md §4, "Layer rules").
 *
 * Conversations, messages, presence, group membership, file transfer and identity are all real
 * and come from the server.
 *
 * IDENTITY IS NOT A CONTROL HERE. There is no name entry, no sign-out, no switch-user and no
 * clear-identity anywhere below this component: the computer is assigned to an employee by an
 * administrator, and this interface only ever reports who that is
 * (docs/12-admin-device-identity.md).
 */
export function ChatWorkspace() {
  /*
   * Notifications are wired before the session, because the session needs somewhere to hand each
   * arriving message — and the notifier needs a way back to select a conversation when a toast or
   * a desktop popup is clicked. That is a cycle, and the ref below is what breaks it: the notifier
   * is given a stable function today, and the effect underneath fills in what it does once the
   * session exists.
   */
  const openHandlerRef = useRef<(conversationId: string) => void>(() => {});
  const openFromNotification = useCallback(
    (conversationId: string) => openHandlerRef.current(conversationId),
    [],
  );

  /*
   * Inside the Windows desktop client, notifications are drawn by the application's own process.
   *
   * Resolved once and passed straight down: `useNotifications` already accepts an injectable
   * scope, so this is the entire integration — no branch in the policy, no flag through the
   * centre, and no second code path to keep in step (lib/notifications/electron.ts). In an
   * ordinary browser it is `undefined`, which means the browser's own `Notification` and leaves
   * every existing behaviour exactly as it was.
   *
   * `useState` with a lazy initialiser because creating the scope subscribes to the desktop
   * bridge, and doing that on every render would add a listener per render.
   */
  const [desktopScope] = useState(() => desktopClientScope());

  const notifications = useNotifications({
    openConversation: openFromNotification,
    ...(desktopScope ? { desktopScope, defaults: DESKTOP_CLIENT_PREFERENCES } : {}),
  });
  const session = useChatSession({ onIncomingMessage: notifications.notify });
  const { state } = session;

  const [openDialog, setOpenDialog] = useState<DialogName | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /*
   * Removing somebody from a group — or leaving one — is confirmed first.
   *
   * Not because the removal is hard to undo, but because what it does to the person's history is:
   * under D-03 a re-added member starts a fresh window, so the part of the conversation they can
   * read today is not the part they would read after coming back.
   */
  const [pendingRemoval, setPendingRemoval] = useState<PendingMemberRemoval | null>(null);
  const [removing, setRemoving] = useState(false);

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

  /*
   * Clicking a notification opens its conversation — through the same call the sidebar makes.
   *
   * Deliberately not a second navigation path: whatever selecting a conversation does today
   * (re-read its history, clear its unread badge, close the mobile sidebar) is what a notification
   * click does too, and it stays that way without anybody remembering to keep two routes in step.
   */
  const selectConversationFromSession = session.selectConversation;
  useEffect(() => {
    openHandlerRef.current = (conversationId: string) => {
      selectConversationFromSession(conversationId);
      setSidebarOpen(false);
    };
  }, [selectConversationFromSession]);

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

  /** Same reason as `openNewChat`: a picker must not open on a directory loaded minutes ago. */
  const openNewGroup = () => {
    session.refreshDirectory();
    setOpenDialog('new-group');
  };

  const openAddMembers = () => {
    session.refreshDirectory();
    setOpenDialog('add-members');
  };

  if (state.screen === 'loading') {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-canvas px-4">
        <BrandLockup width={168} className="h-auto w-[168px] opacity-90" priority />
        <p className="text-sm text-ink-muted" role="status">
          Loading your conversations…
        </p>
      </main>
    );
  }

  /*
   * No assigned identity: an explanation, not a form. Nothing on that screen is actionable for an
   * employee, because nothing an employee could do would change it.
   *
   * The one thing it does carry, and only inside the desktop client, is the route to `/setup` —
   * which has no address bar to be typed into. It leads to the same code-gated IT screen and
   * confers nothing without a code (docs/12-admin-device-identity.md).
   */
  if (state.screen === 'unassigned' || !currentUser) {
    return <UnassignedDeviceScreen error={state.notice} showSetupLink={Boolean(desktopScope)} />;
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
  const uploads = selectedConversation ? selectUploads(state, selectedConversation.id) : [];
  const sharedFiles = selectedConversation
    ? selectSharedFiles(state, selectedConversation.id)
    : { loading: false, files: [] };

  /*
   * Colleagues who could be added to the open group: the directory minus the people already in
   * it. Offering a current member would invite an accidental re-add, which resets their join time
   * and hides the history they can read today. The server refuses to do that anyway; this keeps
   * it from being asked.
   */
  const memberIds = new Set(selectedConversation?.members.map((member) => member.userId) ?? []);
  const addableColleagues = directoryUsers.filter((user) => !memberIds.has(user.id));

  const requestRemoval = (userId: string) => {
    if (!selectedConversation) return;
    setPendingRemoval({
      conversationId: selectedConversation.id,
      userId,
      displayName: usersById.get(userId)?.displayName ?? 'That person',
      groupName: selectedTitle,
      isSelf: userId === currentUser.id,
    });
  };

  const confirmRemoval = () => {
    if (!pendingRemoval || removing) return;
    const target = pendingRemoval;

    setRemoving(true);
    void session
      .removeMember(target.conversationId, target.userId)
      .finally(() => {
        setRemoving(false);
        setPendingRemoval(null);
      });
  };

  return (
    <div className="flex h-dvh flex-col bg-canvas text-ink">
      <a
        href="#conversation"
        className="sr-only rounded-control bg-accent px-3 py-2 text-sm font-medium text-white shadow-raised focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50"
      >
        Skip to conversation
      </a>

      <AppHeader
        currentUser={currentUserSummary}
        deviceLabel={currentUser.deviceLabel}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
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
            className="absolute inset-0 z-20 animate-backdrop-in bg-ink/45 backdrop-blur-[2px] md:hidden"
            onClick={() => setSidebarOpen(false)}
            role="presentation"
          />
        ) : null}

        <aside
          className={cn(
            'absolute inset-y-0 left-0 z-30 w-80 max-w-[85vw] shrink-0 border-r border-line shadow-overlay',
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
            onNewGroup={openNewGroup}
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
                uploads={uploads}
                onCancelUpload={session.cancelUpload}
                onDismissUpload={session.dismissUpload}
              />

              <MessageComposer
                /* Remounting per conversation gives each one a fresh, empty composer. */
                key={selectedConversation.id}
                conversationTitle={selectedTitle}
                onSend={session.sendMessage}
                onSendFile={session.sendFile}
                uploading={uploads.some((upload) => upload.state === 'UPLOADING')}
                maxFileSize={currentUser.maxFileSize}
              />
            </>
          ) : (
            <EmptyChatState
              hasNoConversations={state.conversations.length === 0}
              onNewChat={openNewChat}
              onNewGroup={openNewGroup}
            />
          )}
        </main>

        {/* Details panel: a column on wide screens, an overlay below them. */}
        {selectedConversation && detailsOpen ? (
          <>
            <div
              className="absolute inset-0 z-20 animate-backdrop-in bg-ink/45 backdrop-blur-[2px] xl:hidden"
              onClick={() => setDetailsOverride(false)}
              role="presentation"
            />
            <aside
              className="absolute inset-y-0 right-0 z-30 w-80 max-w-[85vw] border-l border-line shadow-overlay xl:static xl:z-auto xl:max-w-none xl:shadow-none"
              aria-label="Conversation details"
            >
              <DetailsPanel
                conversation={selectedConversation}
                title={selectedTitle}
                currentUserId={currentUser.id}
                usersById={usersById}
                onClose={() => setDetailsOverride(false)}
                onAddMembers={openAddMembers}
                onRequestRemove={requestRemoval}
                sharedFiles={sharedFiles.files}
                filesLoading={sharedFiles.loading}
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
      {openDialog === 'new-group' ? (
        <NewGroupDialog
          users={directoryUsers}
          onClose={closeDialog}
          onCreate={(name, memberIds) => void session.createGroup(name, memberIds)}
        />
      ) : null}
      {openDialog === 'add-members' && selectedConversation ? (
        <AddMembersDialog
          groupName={selectedTitle}
          candidates={addableColleagues}
          onClose={closeDialog}
          onAdd={(userIds) => void session.addMembers(selectedConversation.id, userIds)}
          onSearch={session.searchDirectory}
        />
      ) : null}
      <RemoveMemberDialog
        pending={pendingRemoval}
        busy={removing}
        onCancel={() => setPendingRemoval(null)}
        onConfirm={confirmRemoval}
      />
      {/*
        Fixed to the viewport, so it is rendered last and outside the layout rather than inside a
        column that could clip or scroll it.
      */}
      <NotificationToasts
        toasts={notifications.toasts}
        onOpen={(conversationId) => {
          selectConversation(conversationId);
          notifications.dismissToast(
            notifications.toasts.find((toast) => toast.conversationId === conversationId)?.key ??
              '',
          );
        }}
        onDismiss={notifications.dismissToast}
      />

      <SettingsDialog
        open={openDialog === 'settings'}
        currentUser={currentUserSummary}
        deviceLabel={currentUser.deviceLabel}
        preferences={notifications.preferences}
        onPreferenceChange={notifications.setPreference}
        desktopPermission={notifications.permission}
        onEnableDesktop={notifications.enableDesktop}
        soundBlocked={notifications.soundBlocked}
        onTestSound={notifications.testSound}
        surface={desktopScope ? 'desktop' : 'browser'}
        onClose={closeDialog}
      />
    </div>
  );
}
