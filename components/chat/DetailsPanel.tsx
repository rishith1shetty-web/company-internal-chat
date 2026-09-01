'use client';

import { Avatar, GroupAvatar } from '@/components/ui/Avatar';
import { Button, IconButton } from '@/components/ui/Button';
import {
  ChatIcon,
  CloseIcon,
  DownloadIcon,
  FileIcon,
  GroupIcon,
  ShieldIcon,
} from '@/components/ui/icons';
import { attachmentDownloadUrl } from '@/lib/chat/api';
import {
  formatFileSize,
  formatFullTimestamp,
  formatPresence,
  hasNameCollision,
  userDiscriminator,
} from '@/lib/chat/format';
import type { Conversation, SharedFile, UserSummary } from '@/lib/chat/types';

interface DetailsPanelProps {
  conversation: Conversation;
  title: string;
  currentUserId: string;
  usersById: Map<string, UserSummary>;
  onClose: () => void;
  /** Groups only: open the colleague picker. */
  onAddMembers: () => void;
  /** Groups only: ask to remove somebody. Confirmed before anything is sent. */
  onRequestRemove: (userId: string) => void;
  /** Files in this conversation the current user may see. Bounded by `joinedAt` server-side. */
  sharedFiles: SharedFile[];
  filesLoading: boolean;
}

/**
 * Conversation details: what this conversation is, and who is in it.
 *
 * From Phase 6 it is also where a group is managed. The controls shown here are a convenience,
 * never the authorization: the server re-derives who the caller is and what their role is on
 * every request, so hiding "Remove" from a member is a courtesy to them and not a defence
 * (CLAUDE.md §9). Showing a button somebody may not use would simply produce a refusal.
 *
 * What is NOT offered: renaming a group. It is listed for Phase 6 in the requirements
 * (docs/00-phase-0-overview.md, F-15) but is not part of this phase's brief, and a control that
 * writes `Conversation.name` needs the same role decision behind it that removal has.
 */
export function DetailsPanel({
  conversation,
  title,
  currentUserId,
  usersById,
  onClose,
  onAddMembers,
  onRequestRemove,
  sharedFiles,
  filesLoading,
}: DetailsPanelProps) {
  const allUsers = [...usersById.values()];
  const isGroup = conversation.type === 'GROUP';

  // Read from the membership the server sent, not from anything decided in the browser.
  const isOwner =
    conversation.members.find((member) => member.userId === currentUserId)?.role === 'OWNER';

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-15 shrink-0 items-center justify-between gap-2 border-b border-line px-4">
        <h2 className="text-sm font-semibold tracking-tight text-ink">Details</h2>
        <IconButton label="Hide conversation details" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {/* The conversation's own identity card, so the panel opens on what this thing is. */}
        <section className="rounded-card border border-line bg-surface-muted p-3.5">
          <div className="flex items-center gap-3">
            <GroupAvatar size="lg" className={isGroup ? undefined : 'bg-accent-soft'}>
              {isGroup ? <GroupIcon className="h-5 w-5" /> : <ChatIcon className="h-5 w-5" />}
            </GroupAvatar>
            <div className="min-w-0">
              <p className="text-sm font-semibold break-words text-ink">{title}</p>
              <p className="mt-0.5 text-xs text-ink-subtle">
                {isGroup ? 'Group conversation' : 'Private conversation'}
              </p>
            </div>
          </div>
          <p
            className="mt-3 border-t border-line pt-2.5 text-xs text-ink-subtle"
            suppressHydrationWarning
          >
            Created {formatFullTimestamp(conversation.createdAt)}
          </p>
        </section>

        <section className="mt-6">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold tracking-wider text-ink-subtle uppercase">
              {isGroup ? `Members (${conversation.members.length})` : 'Participants'}
            </h3>
            {/* Any member may add (Q-05b option (a)); the server checks that they are one. */}
            {isGroup ? (
              <Button size="sm" onClick={onAddMembers}>
                Add people
              </Button>
            ) : null}
          </div>

          <ul className="mt-2 space-y-1">
            {conversation.members.map((member) => {
              const user = usersById.get(member.userId);
              if (!user) return null;

              const removable = isGroup && isOwner && member.userId !== currentUserId;

              return (
                <li
                  key={member.userId}
                  className="flex items-center gap-2.5 rounded-control px-1.5 py-1.5 transition-colors duration-(--duration-quick) hover:bg-surface-muted"
                >
                  <Avatar
                    userId={user.id}
                    displayName={user.displayName}
                    size="sm"
                    presence={user.presence}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">
                      {user.displayName}
                      {member.userId === currentUserId ? (
                        <span className="ml-1.5 text-xs text-ink-subtle">(you)</span>
                      ) : null}
                      {hasNameCollision(allUsers, user) ? (
                        <span className="ml-1.5 text-xs text-ink-subtle">
                          ID {userDiscriminator(user.id)}
                        </span>
                      ) : null}
                    </span>
                    <span className="block text-xs text-ink-subtle" suppressHydrationWarning>
                      {member.role === 'OWNER' ? (
                        /*
                          Not `uppercase`: a CSS text-transform changes what the pixels say
                          without changing what the DOM says, so the label a sighted reader sees
                          and the one a screen reader announces stop matching.
                        */
                        <span className="mr-1.5 rounded-full bg-gold-soft px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-ink">
                          Owner
                        </span>
                      ) : null}
                      {formatPresence(user)}
                    </span>
                  </span>

                  {removable ? (
                    <Button
                      size="sm"
                      onClick={() => onRequestRemove(member.userId)}
                      aria-label={`Remove ${user.displayName} from the group`}
                    >
                      Remove
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {isGroup ? (
            <div className="mt-4 border-t border-line pt-4">
              {/*
                D-03, stated where a group is managed. It explains missing history before somebody
                has to ask about it.
              */}
              <p className="flex gap-2 rounded-card bg-notice-tint px-3 py-2.5 text-xs text-notice ring-1 ring-notice/15 ring-inset">
                <ShieldIcon className="mt-px h-4 w-4 shrink-0" />
                <span>
                  Members see messages sent from the moment they joined the group onwards. Earlier
                  messages stay with the members who were here for them.
                </span>
              </p>

              {/* Leaving needs no permission: it takes access away rather than granting it. */}
              <Button
                className="mt-3 w-full"
                variant="danger"
                onClick={() => onRequestRemove(currentUserId)}
              >
                Leave group
              </Button>
            </div>
          ) : null}
        </section>

        <section className="mt-6">
          <h3 className="text-xs font-semibold tracking-wider text-ink-subtle uppercase">
            Shared files
            {sharedFiles.length > 0 ? (
              <span className="ml-1.5 font-normal normal-case tabular-nums">
                ({sharedFiles.length})
              </span>
            ) : null}
          </h3>

          {filesLoading && sharedFiles.length === 0 ? (
            <p className="mt-2 text-xs text-ink-subtle" role="status">
              Loading files…
            </p>
          ) : sharedFiles.length === 0 ? (
            /* An intentional empty state: what goes here, and how to put something here. */
            <div className="mt-2.5 rounded-card border border-dashed border-line-strong bg-surface-muted px-3 py-5 text-center">
              <span
                className="mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-gold-soft text-brand"
                aria-hidden="true"
              >
                <FileIcon className="h-4 w-4" />
              </span>
              <p className="mt-2 text-xs font-medium text-ink-muted">No files shared yet</p>
              <p className="mt-1 text-xs text-ink-subtle">
                Use the paperclip in the message box to send one.
              </p>
            </div>
          ) : (
            <ul className="mt-2.5 space-y-0.5">
              {sharedFiles.map((file) => (
                <li key={file.id}>
                  <a
                    href={attachmentDownloadUrl(file.id)}
                    download={file.filename}
                    className="group flex items-center gap-2.5 rounded-control px-2 py-2 transition-colors duration-(--duration-quick) hover:bg-accent-tint focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                  >
                    <span
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-gold-soft text-brand ring-1 ring-brand/12 ring-inset"
                      aria-hidden="true"
                    >
                      <FileIcon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate text-sm font-medium text-ink"
                        title={file.filename}
                      >
                        {file.filename}
                      </span>
                      <span
                        className="block truncate text-xs text-ink-subtle"
                        suppressHydrationWarning
                      >
                        {formatFileSize(file.byteSize)}
                        {file.uploaderId
                          ? ` · ${usersById.get(file.uploaderId)?.displayName ?? 'Unknown user'}`
                          : ''}
                        {` · ${formatFullTimestamp(file.createdAt)}`}
                      </span>
                    </span>
                    <DownloadIcon className="h-4 w-4 shrink-0 text-ink-subtle opacity-0 transition-opacity duration-(--duration-quick) group-hover:opacity-100 group-focus-visible:opacity-100" />
                  </a>
                </li>
              ))}
            </ul>
          )}

          {isGroup ? (
            <p className="mt-3 text-xs text-ink-subtle">
              This list shows the files shared since you joined the group.
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
