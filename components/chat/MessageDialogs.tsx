'use client';

import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { conversationTitle } from '@/lib/chat/state';
import type { ChatMessage, Conversation, UserSummary } from '@/lib/chat/types';
import { cn } from '@/lib/ui/cn';

/* --------------------------------------------------------------------------------------------- */
/* Forward                                                                                         */
/* --------------------------------------------------------------------------------------------- */

interface ForwardDialogProps {
  open: boolean;
  /** The message being forwarded. Null while the dialog is closed. */
  message: ChatMessage | null;
  /** Everywhere the user could send it. The server re-authorizes every one of them. */
  conversations: Conversation[];
  usersById: Map<string, UserSummary>;
  currentUserId: string;
  onClose(): void;
  onConfirm(conversationIds: string[]): void;
  /** True while the forward is in flight, so the button cannot be pressed twice. */
  sending: boolean;
}

/**
 * Choose where to forward a message.
 *
 * The list is the caller's own conversations — the same ones their sidebar shows — and the source
 * conversation is excluded, because forwarding a message into the conversation it is already in
 * is never what somebody meant.
 *
 * This list is a convenience, not a permission: the server authorizes each destination
 * independently when the request arrives, and a conversation the caller has since been removed
 * from is refused there regardless of what this dialog offered.
 */
export function ForwardDialog({
  open,
  message,
  conversations,
  usersById,
  currentUserId,
  onClose,
  onConfirm,
  sending,
}: ForwardDialogProps) {
  const [selected, setSelected] = useState<string[]>([]);

  const destinations = useMemo(
    () => conversations.filter((conversation) => conversation.id !== message?.conversationId),
    [conversations, message?.conversationId],
  );

  function toggle(conversationId: string) {
    setSelected((current) =>
      current.includes(conversationId)
        ? current.filter((id) => id !== conversationId)
        : [...current, conversationId],
    );
  }

  function close() {
    setSelected([]);
    onClose();
  }

  const preview = message?.body?.trim() || message?.attachment?.filename || '';

  return (
    <Modal
      open={open}
      title="Forward message"
      description={preview ? `“${truncate(preview, 90)}”` : undefined}
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onConfirm(selected);
              setSelected([]);
            }}
            disabled={selected.length === 0 || sending}
          >
            {sending
              ? 'Forwarding…'
              : `Forward${selected.length > 0 ? ` to ${selected.length}` : ''}`}
          </Button>
        </>
      }
    >
      {destinations.length === 0 ? (
        <p className="text-sm text-ink-muted">
          There is nowhere else to forward this to yet. Start another conversation first.
        </p>
      ) : (
        <ul className="max-h-72 space-y-0.5 overflow-y-auto" aria-label="Conversations">
          {destinations.map((conversation) => {
            const checked = selected.includes(conversation.id);
            const title = conversationTitle(conversation, currentUserId, usersById);

            return (
              <li key={conversation.id}>
                <label
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm',
                    'transition-colors duration-(--duration-quick) hover:bg-surface-muted',
                    checked && 'bg-accent/10',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(conversation.id)}
                    className="h-4 w-4 accent-[var(--color-accent)]"
                  />
                  <span className="min-w-0 flex-1 truncate text-ink">{title}</span>
                  <span className="text-[11px] text-ink-subtle uppercase">
                    {conversation.type === 'GROUP' ? 'Group' : 'Direct'}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

/* --------------------------------------------------------------------------------------------- */
/* Delete                                                                                          */
/* --------------------------------------------------------------------------------------------- */

interface DeleteDialogProps {
  open: boolean;
  message: ChatMessage | null;
  /** Whether the caller sent it. Decides whether "Delete for everyone" is offered at all. */
  isOwn: boolean;
  onClose(): void;
  onDeleteForMe(): void;
  onDeleteForEveryone(): void;
}

/**
 * Confirms a deletion, and makes the difference between the two kinds impossible to miss.
 *
 * "Delete for me" is reversible in the only sense that matters — the message is still in the
 * conversation for everybody else — while "delete for everyone" is not. They are therefore
 * described in full rather than labelled, and the irreversible one is styled as the dangerous
 * action it is.
 *
 * "Delete for everyone" is offered only on your own messages. That is a courtesy: the server
 * refuses it for anybody but the original sender whatever this dialog shows.
 */
export function DeleteDialog({
  open,
  message,
  isOwn,
  onClose,
  onDeleteForMe,
  onDeleteForEveryone,
}: DeleteDialogProps) {
  const preview = message?.body?.trim() || message?.attachment?.filename || '';

  return (
    <Modal
      open={open}
      title="Delete message"
      description={preview ? `“${truncate(preview, 90)}”` : undefined}
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <div className="space-y-2">
        <button
          type="button"
          onClick={onDeleteForMe}
          className={cn(
            'w-full cursor-pointer rounded-lg border border-line px-3 py-2.5 text-left',
            'transition-colors duration-(--duration-quick) hover:bg-surface-muted',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          )}
        >
          <span className="block text-sm font-medium text-ink">Delete for me</span>
          <span className="mt-0.5 block text-xs text-ink-muted">
            Removes it from your view on every computer you use. Everyone else still sees it.
          </span>
        </button>

        {isOwn ? (
          <button
            type="button"
            onClick={onDeleteForEveryone}
            className={cn(
              'w-full cursor-pointer rounded-lg border border-danger/40 px-3 py-2.5 text-left',
              'transition-colors duration-(--duration-quick) hover:bg-danger/10',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger',
            )}
          >
            <span className="block text-sm font-medium text-danger">Delete for everyone</span>
            <span className="mt-0.5 block text-xs text-ink-muted">
              Replaces it with “This message was deleted” for everyone in the conversation. Any
              attached file is removed. This cannot be undone.
            </span>
          </button>
        ) : null}
      </div>
    </Modal>
  );
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
