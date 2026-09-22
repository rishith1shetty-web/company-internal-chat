'use client';

import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { CloseIcon, FileIcon } from '@/components/ui/icons';
import type { ChatMessage } from '@/lib/chat/types';
import type { MessageReadStatusWire } from '@/lib/chat/wire';
import { cn } from '@/lib/ui/cn';

interface MessageInfoDialogProps {
  /** The message being described, or null when the panel is closed. */
  message: ChatMessage | null;
  /** Fetches read status. Rejects for anybody but the sender — the server decides that. */
  load: (messageId: string) => Promise<MessageReadStatusWire>;
  /**
   * Subscribes to "somebody read something here" nudges, returning an unsubscribe.
   *
   * The nudge carries no read state of its own; this panel answers it by re-reading through the
   * authorized endpoint, which is the only place group read status is ever assembled.
   */
  subscribe: (handler: (conversationId: string, userId: string) => void) => () => void;
  onClose(): void;
}

/**
 * Who has read a group message you sent (Batch 1.3).
 *
 * WHY A PANEL AND NOT A LIST UNDER THE BUBBLE. A group of ten turns a read list into ten lines
 * under every message, which buries the conversation in bookkeeping. The information is worth
 * having and worth asking for, so it lives one right-click away instead.
 *
 * THERE ARE NO READ TIMES HERE, and their absence is deliberate rather than unfinished. The
 * application's read marker stores the timestamp of the furthest MESSAGE a member has read, not
 * the moment they read it — so a "read at" column would show a specific, plausible, wrong time,
 * often days earlier than the reading. Names are the honest answer until a per-message receipt is
 * stored (lib/messages/read-status.ts).
 *
 * NOTHING TECHNICAL IS SHOWN: display names only. No device id, no session, no address, no
 * timestamps that are not what they appear to be.
 */
export function MessageInfoDialog({
  message,
  load,
  subscribe,
  onClose,
}: MessageInfoDialogProps) {
  const [status, setStatus] = useState<MessageReadStatusWire | null>(null);
  const [error, setError] = useState<string | null>(null);

  const messageId = message?.id ?? null;

  /*
   * Loading is DERIVED, not stored.
   *
   * There is nothing a `loading` flag would know that "no answer and no error yet" does not, and
   * a stored one would have to be set synchronously inside the effect below — which is both a
   * cascading render and, in this component, unnecessary.
   *
   * The panel is keyed by message id where it is rendered, so opening a different message mounts
   * a fresh one and this starts at `true` again without anything having to reset it.
   */
  const loading = status === null && error === null;

  /** Re-reads without blanking the screen. Used for live updates, where an answer is already up. */
  const refreshSilently = useCallback(async () => {
    if (!messageId) return;
    try {
      setStatus(await load(messageId));
    } catch {
      // Keep what is on screen. A failed background refresh is not worth replacing a correct
      // -a-moment-ago answer with an error.
    }
  }, [load, messageId]);

  // The first read. Every `setState` happens in an async callback after an await, so nothing here
  // sets state synchronously during the effect.
  useEffect(() => {
    if (!messageId) return;
    let cancelled = false;

    void (async () => {
      try {
        const next = await load(messageId);
        if (!cancelled) setStatus(next);
      } catch {
        // Deliberately not the server's words: this panel is only ever opened on your own
        // message, so a failure here is a fault rather than a refusal to explain.
        if (!cancelled) setError('Could not load who has read this message.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [load, messageId]);

  /*
   * Live updates while the panel is open.
   *
   * A nudge means somebody's marker moved in some conversation; the panel re-reads only when it
   * was THIS conversation, so a busy chat elsewhere does not make this one fetch in a loop. The
   * re-read is silent for the reason given on `refreshSilently`.
   */
  useEffect(() => {
    if (!message) return;

    return subscribe((conversationId) => {
      if (conversationId === message.conversationId) void refreshSilently();
    });
  }, [message, refreshSilently, subscribe]);

  useEffect(() => {
    if (!message) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [message, onClose]);

  if (!message) return null;

  const nameOf = (userId: string) =>
    status?.users.find((user) => user.id === userId)?.displayName ?? 'Unknown user';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
      // Outside click closes. The panel itself stops the event, so a click inside does not.
      onClick={onClose}
    >
      <div className="absolute inset-0 animate-backdrop-in bg-ink/45 backdrop-blur-[2px]" />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="message-info-title"
        onClick={(event) => event.stopPropagation()}
        className={cn(
          'relative flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-panel',
          'border border-line bg-surface shadow-overlay',
        )}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-4">
          <h2 id="message-info-title" className="text-base font-semibold text-ink">
            Message info
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close message info">
            <CloseIcon className="h-4 w-4" />
          </Button>
        </div>

        {/*
          The message itself, so it is obvious which one this is about. Clamped to three lines:
          a long message would otherwise push the lists that matter off the screen.
        */}
        <div className="shrink-0 border-b border-line bg-surface-muted px-5 py-3">
          {message.attachment ? (
            <p className="flex items-center gap-2 text-sm text-ink-muted">
              <FileIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{message.attachment.filename}</span>
            </p>
          ) : null}
          {message.body ? (
            <p className={cn('line-clamp-3 text-sm text-ink', message.attachment && 'mt-1.5')}>
              {message.body}
            </p>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <p className="text-sm text-ink-muted" role="status">
              Loading…
            </p>
          ) : error ? (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          ) : status ? (
            <>
              <ReaderList
                title="Read by"
                entries={status.readBy}
                nameOf={nameOf}
                emptyLabel="Nobody has read this yet."
              />
              <ReaderList
                title="Not read by"
                entries={status.notReadBy}
                nameOf={nameOf}
                emptyLabel="Everybody has read this."
                className="mt-6"
              />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ReaderList({
  title,
  entries,
  nameOf,
  emptyLabel,
  className,
}: {
  title: string;
  entries: { userId: string; stillMember: boolean }[];
  nameOf: (userId: string) => string;
  emptyLabel: string;
  className?: string;
}) {
  return (
    <section className={className}>
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
        {title}
      </h3>

      {entries.length === 0 ? (
        <p className="mt-2 text-sm text-ink-muted">{emptyLabel}</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {entries.map((entry) => (
            <li key={entry.userId} className="flex items-baseline justify-between gap-3">
              {/* `break-words` rather than truncation: a colleague's name is not a detail to hide. */}
              <span className="min-w-0 break-words text-sm text-ink">{nameOf(entry.userId)}</span>
              {/*
                Somebody who read this and has since left the group. Said quietly, because the
                fact that they read it is still true and still worth reporting.
              */}
              {entry.stillMember ? null : (
                <span className="shrink-0 text-[11px] text-ink-subtle">left the group</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
