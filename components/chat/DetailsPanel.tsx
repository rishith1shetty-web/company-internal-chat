'use client';

import { Avatar } from '@/components/ui/Avatar';
import { IconButton } from '@/components/ui/Button';
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
}

/**
 * Conversation details: what this conversation is, and who is in it.
 *
 * Deliberately read-only in Phase 2. Group management — renaming, adding and removing members —
 * is Phase 6 and needs server-side authorization behind it, so no control for it is offered here
 * (CLAUDE.md §5, Phase 6).
 */
export function DetailsPanel({
  conversation,
  title,
  currentUserId,
  usersById,
  onClose,
}: DetailsPanelProps) {
  const allUsers = [...usersById.values()];
  const isGroup = conversation.type === 'GROUP';

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
          <h3 className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
            {isGroup ? `Members (${conversation.members.length})` : 'Participants'}
          </h3>

          <ul className="mt-2 space-y-1">
            {conversation.members.map((member) => {
              const user = usersById.get(member.userId);
              if (!user) return null;

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
                </li>
              );
            })}
          </ul>

          {isGroup ? (
            <p className="mt-3 border-t border-line pt-3 text-xs text-ink-subtle">
              Members see messages sent from the moment they joined the group onwards.
            </p>
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
