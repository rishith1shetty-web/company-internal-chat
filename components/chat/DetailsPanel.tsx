'use client';

import { Avatar } from '@/components/ui/Avatar';
import { Button, IconButton } from '@/components/ui/Button';
import { CloseIcon, FileIcon } from '@/components/ui/icons';
import {
  formatFullTimestamp,
  formatPresence,
  hasNameCollision,
  userDiscriminator,
} from '@/lib/chat/format';
import type { Conversation, UserSummary } from '@/lib/chat/types';

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
}: DetailsPanelProps) {
  const allUsers = [...usersById.values()];
  const isGroup = conversation.type === 'GROUP';

  // Read from the membership the server sent, not from anything decided in the browser.
  const isOwner =
    conversation.members.find((member) => member.userId === currentUserId)?.role === 'OWNER';

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line px-4">
        <h2 className="text-sm font-semibold text-ink">Details</h2>
        <IconButton label="Hide conversation details" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <section>
          <h3 className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
            {isGroup ? 'Group' : 'Conversation'}
          </h3>
          <p className="mt-1.5 text-sm font-medium break-words text-ink">{title}</p>
          <p className="mt-1 text-xs text-ink-subtle" suppressHydrationWarning>
            Created {formatFullTimestamp(conversation.createdAt)}
          </p>
        </section>

        <section className="mt-6">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
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
                <li key={member.userId} className="flex items-center gap-2.5 py-1.5">
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
                      {member.role === 'OWNER' ? 'Owner · ' : ''}
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
            <div className="mt-3 border-t border-line pt-3">
              <p className="text-xs text-ink-subtle">
                Members see messages sent from the moment they joined the group onwards. Earlier
                messages stay with the members who were here for them.
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
          <h3 className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
            Shared files
          </h3>
          <div className="mt-2 rounded-md border border-dashed border-line-strong px-3 py-4 text-center">
            <FileIcon className="mx-auto h-5 w-5 text-ink-subtle" />
            <p className="mt-1.5 text-xs text-ink-subtle">
              Files shared in this conversation will be listed here once file transfer is
              implemented.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
