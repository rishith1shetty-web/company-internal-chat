'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';

import { ComposerContextMenu } from '@/components/chat/ComposerContextMenu';

import { Button, IconButton } from '@/components/ui/Button';
import {
  AttachmentIcon,
  CheckIcon,
  CloseIcon,
  EditIcon,
  FileIcon,
  ReplyIcon,
  SendIcon,
} from '@/components/ui/icons';
import { canReadClipboard, pasteIntoComposer } from '@/lib/chat/clipboard';
import { formatFileSize } from '@/lib/chat/format';
import type { ChatMessage, UserSummary } from '@/lib/chat/types';
import { MAX_MESSAGE_LENGTH } from '@/lib/chat/types';

interface MessageComposerProps {
  conversationTitle: string;
  onSend: (body: string) => void;
  /** Uploads a file, with whatever was typed alongside it as a caption. */
  onSendFile: (file: File, caption?: string) => void;
  /** True while an upload from this browser is in flight, which disables sending another. */
  uploading: boolean;
  /** Bytes. Checked here so an oversized file is refused before it is sent, and again by the server. */
  maxFileSize: number;
  /** The message being replied to, or null. Purely local until the reply is actually sent. */
  replyTarget: ChatMessage | null;
  usersById: Map<string, UserSummary>;
  currentUserId: string;
  onCancelReply(): void;
  /**
   * The message being edited, or null (Batch 1.1).
   *
   * Never set at the same time as `replyTarget` — the session keeps the two mutually exclusive, so
   * this component never has to decide which banner wins.
   */
  editTarget: ChatMessage | null;
  onCancelEdit(): void;
  /** Saves the edited text. Resolves true when the server accepted it. */
  onSaveEdit(body: string): Promise<boolean>;
}

/** Show the character counter only when the limit is close enough to matter. */
const COUNTER_VISIBLE_FROM = MAX_MESSAGE_LENGTH - 200;

export function MessageComposer({
  conversationTitle,
  onSend,
  onSendFile,
  uploading,
  maxFileSize,
  replyTarget,
  usersById,
  currentUserId,
  onCancelReply,
  editTarget,
  onCancelEdit,
  onSaveEdit,
}: MessageComposerProps) {
  const [body, setBody] = useState('');
  /*
   * The chosen file, held here until the user presses Send.
   *
   * Choosing a file does not send it. Somebody who picks the wrong one — easy, from a list of
   * similar names — gets to see what they picked and change their mind, rather than discovering
   * it after their colleague already has it.
   */
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  /** True while a save is in flight, so Save cannot be pressed twice. */
  const [saving, setSaving] = useState(false);
  /**
   * The right-click menu inside the text field, and what the caret was doing when it opened.
   *
   * The selection is captured HERE, at right-click time, rather than read when Paste is chosen.
   * Opening the menu moves focus to its first item, so by the time Paste is pressed the field is
   * no longer focused — and capturing at the moment of the gesture is both accurate and immune to
   * anything that happens in between.
   */
  const [composerMenu, setComposerMenu] = useState<{
    x: number;
    y: number;
    selectionStart: number;
    selectionEnd: number;
  } | null>(null);
  /** Said out loud only when a paste could not happen. Cleared on the next attempt. */
  const [pasteError, setPasteError] = useState<string | null>(null);
  /** Where the caret belongs once a pasted value has been rendered. */
  const pendingCursor = useRef<number | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const editing = editTarget !== null;
  const editingId = editTarget?.id ?? null;

  /*
   * Mirrors of the current body and the current target, so the prefill effect below can READ them
   * without DEPENDING on them.
   *
   * That distinction is the whole reason these exist. An effect that listed `body` in its
   * dependencies would re-run on every keystroke; one that listed `editTarget` would re-run every
   * time a `message:updated` arrived for that message — and either would overwrite what the user
   * is in the middle of typing with the text the message used to have.
   *
   * They are written in an effect rather than during render, and this effect is declared FIRST on
   * purpose: effects run in declaration order, so by the time the prefill effect below runs, these
   * already hold the values from the render that triggered it.
   */
  const bodyRef = useRef(body);
  const editTargetRef = useRef(editTarget);
  const draftBeforeEdit = useRef('');
  const previousEditingId = useRef<string | null>(null);

  useEffect(() => {
    bodyRef.current = body;
    editTargetRef.current = editTarget;
  });

  /*
   * Entering and leaving edit mode.
   *
   * Keyed on the message id alone, so it fires exactly twice per edit — once on entry, once on
   * exit — and never in between.
   *
   *   Entering: whatever was half-typed is stashed, and the message's current text takes its place.
   *   Leaving:  the stash comes back, whether the edit was saved or cancelled. Somebody who was
   *             part-way through a sentence, edited an older message, then came back finds their
   *             sentence still there.
   *
   * Switching straight from editing one message to editing another does not re-stash: the draft
   * being held is the ordinary composer text, not the previous edit.
   */
  useEffect(() => {
    const previous = previousEditingId.current;
    previousEditingId.current = editingId;

    if (editingId === null) {
      if (previous !== null) {
        setBody(draftBeforeEdit.current);
        draftBeforeEdit.current = '';
      }
      return;
    }

    if (previous === null) draftBeforeEdit.current = bodyRef.current;
    setBody(editTargetRef.current?.body ?? '');
    textAreaRef.current?.focus();
  }, [editingId]);

  // Grow with the text, up to a ceiling, then scroll inside the field.
  useEffect(() => {
    const field = textAreaRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  }, [body]);

  /*
   * Puts the caret back after a paste has been rendered.
   *
   * A LAYOUT effect, so it runs before the browser paints: setting the selection after paint
   * makes the caret visibly jump to the end and back. The field is focused explicitly rather than
   * relying on the closing menu to restore it, so the caret lands whether the paste came from the
   * menu or from anywhere else.
   */
  useLayoutEffect(() => {
    const cursor = pendingCursor.current;
    if (cursor === null) return;
    pendingCursor.current = null;

    const field = textAreaRef.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(cursor, cursor);
  }, [body]);

  /**
   * Reads the clipboard and inserts it at the caret.
   *
   * Only ever reached from the menu. Native Ctrl+V does not come through here at all — it is a
   * trusted user action that carries its own data, needs no permission, and is handled by the
   * browser writing into the field and React seeing an ordinary change event. Nothing in this
   * component intercepts `paste`, so the keyboard keeps working exactly as it did.
   *
   * THE THREE OUTCOMES are kept apart on purpose:
   *   text     → inserted
   *   empty    → nothing happens, silently; there was nothing to paste
   *   refused  → said out loud, with the way that does work
   *
   * The refusal is the desktop client's case. Its session denies every permission, so the page
   * may not read the clipboard (lib/chat/clipboard.ts) — telling the employee to press Ctrl+V is
   * both true and immediately useful, and is far better than a menu item that appears to do
   * nothing.
   *
   * Reply and edit mode are untouched: this writes to the same `body` the field already shows, so
   * pasting while replying composes a reply and pasting while editing edits. Neither mode is
   * cancelled, because nothing here cancels anything.
   */
  const pasteFromClipboard = useCallback(
    async (selection: { selectionStart: number; selectionEnd: number }) => {
      setPasteError(null);

      const field = textAreaRef.current;
      const outcome = await pasteIntoComposer({ value: field?.value ?? '', ...selection });

      if (outcome.kind === 'refused') {
        setPasteError('This application cannot read the clipboard. Press Ctrl+V to paste.');
        return;
      }
      // 'empty': the clipboard held nothing. Nothing to say and nothing to do.
      if (outcome.kind !== 'inserted') return;

      setBody(outcome.value);
      pendingCursor.current = outcome.cursor;
    },
    [],
  );

  /** Right-click inside the field: our menu instead of nothing (Electron) or the native one. */
  const openComposerMenu = useCallback((event: ReactMouseEvent<HTMLTextAreaElement>) => {
    const field = event.currentTarget;
    event.preventDefault();
    setComposerMenu({
      x: event.clientX,
      y: event.clientY,
      selectionStart: field.selectionStart,
      selectionEnd: field.selectionEnd,
    });
  }, []);

  const closeComposerMenu = useCallback(() => setComposerMenu(null), []);

  const trimmed = body.trim();
  const tooLong = body.length > MAX_MESSAGE_LENGTH;

  /*
   * What "Save" is allowed to do, which is not the same as what "Send" is allowed to do.
   *
   * Emptying the text is legitimate for a file message — it clears the caption and leaves the
   * file, which is exactly what sending a file without typing anything produces. Emptying a text
   * message is not: there would be nothing left, and deleting is the action for that. The server
   * applies the same rule and is the one that decides.
   */
  const canSaveEdit =
    !saving && !tooLong && (trimmed.length > 0 || editTarget?.attachment != null);
  // A file on its own is a message; so is text on its own; so is both together.
  const canSend = editing
    ? canSaveEdit
    : !uploading && !tooLong && (trimmed.length > 0 || file !== null);

  const chooseFile = (chosen: File | null) => {
    setFileError(null);
    if (!chosen) {
      setFile(null);
      return;
    }

    /*
     * Refused here as well as on the server, and the client check is the courtesy rather than the
     * control: without it somebody would spend several minutes uploading a file that was always
     * going to be rejected at the end. The server enforces the same limit while the bytes arrive,
     * because a browser check is a suggestion (CLAUDE.md §9).
     */
    if (chosen.size > maxFileSize) {
      setFile(null);
      setFileError(
        `That file is ${formatFileSize(chosen.size)}. The limit is ${formatFileSize(maxFileSize)}.`,
      );
      return;
    }

    setFile(chosen);
  };

  const clearFile = () => {
    setFile(null);
    setFileError(null);
    // The input keeps its value, so re-choosing the same file would fire no change event.
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;

    /*
     * Editing takes over the composer entirely: no file is sent, and no new message is created.
     *
     * The body is NOT cleared here. Edit mode is left only when the save succeeds — the session
     * clears `editTarget`, which is what restores the composer — so a failure leaves the banner,
     * the text and the cursor exactly where they were, ready to try again.
     */
    if (editing) {
      setSaving(true);
      void onSaveEdit(trimmed).finally(() => setSaving(false));
      return;
    }

    if (file) {
      onSendFile(file, trimmed.length > 0 ? trimmed : undefined);
      clearFile();
      setBody('');
      return;
    }

    onSend(trimmed);
    setBody('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter starts a new line — the convention staff will expect.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }

    // Escape abandons the reply without clearing what has been typed. Only when there is one to
    // abandon, so Escape keeps its usual meaning the rest of the time.
    if (event.key === 'Escape' && replyTarget) {
      event.preventDefault();
      onCancelReply();
      return;
    }

    // The same for an edit. Leaving edit mode puts back whatever was being typed before it began,
    // so Escape here costs nothing that was not already the message's own text.
    if (event.key === 'Escape' && editing) {
      event.preventDefault();
      onCancelEdit();
    }
  };

  return (
    <form
      onSubmit={submit}
      className="shrink-0 border-t border-line bg-surface px-3 py-3 shadow-[0_-1px_2px_0_rgb(64_43_20/0.03)] sm:px-6"
    >
      <div className="mx-auto max-w-3xl">
        {/*
          Any file type. The input carries no `accept` filter on purpose: the company transfers
          arbitrary business files, and a filter here would hide ordinary work from the picker
          while stopping nothing (docs/14-phase-7-file-transfer.md §7).
        */}
        <input
          ref={fileInputRef}
          type="file"
          className="sr-only"
          onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
          aria-hidden="true"
          tabIndex={-1}
        />

        {/*
          The editing banner.

          Deliberately the same shape and weight as the reply banner below: they occupy the same
          place, do the same job — telling you the Send button does not mean what it usually does —
          and are never both on screen, because the session keeps the two modes exclusive.

          The current text is shown underneath rather than the new one: it is what the message says
          now, and the composer already shows what it would say instead.
        */}
        {editTarget ? (
          <div className="mb-2 flex animate-rise-in items-center gap-2 rounded-card border border-accent/20 bg-accent-tint px-3 py-2">
            <EditIcon className="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-semibold text-brand">Editing message</span>
              <span className="block truncate text-xs text-ink-muted">
                {editTarget.body?.trim() || editTarget.attachment?.filename || 'Attachment'}
              </span>
            </span>
            <IconButton label="Cancel edit" onClick={onCancelEdit}>
              <CloseIcon className="h-4 w-4" />
            </IconButton>
          </div>
        ) : null}

        {/*
          The reply banner.
          
          Above the file card and the text area, where the eye reaches it before typing — a reply
          that is only apparent after sending is a reply somebody did not mean to make. Cancelling
          is always one press away, and Escape in the text area does the same thing.
        */}
        {replyTarget ? (
          <div className="mb-2 flex animate-rise-in items-center gap-2 rounded-card border border-accent/20 bg-accent-tint px-3 py-2">
            <ReplyIcon className="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-semibold text-brand">
                Replying to{' '}
                {replyTarget.senderId === currentUserId
                  ? 'yourself'
                  : (usersById.get(replyTarget.senderId ?? '')?.displayName ?? 'Unknown user')}
              </span>
              <span className="block truncate text-xs text-ink-muted">
                {replyTarget.body?.trim() || replyTarget.attachment?.filename || 'Attachment'}
              </span>
            </span>
            <IconButton label="Cancel reply" onClick={onCancelReply}>
              <CloseIcon className="h-4 w-4" />
            </IconButton>
          </div>
        ) : null}

        {file && !editing ? (
          <div className="mb-2 flex animate-rise-in items-center gap-3 rounded-card border border-accent/20 bg-accent-tint px-3 py-2.5 shadow-subtle">
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-surface text-brand ring-1 ring-line"
              aria-hidden="true"
            >
              <FileIcon className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-ink" title={file.name}>
                {file.name}
              </span>
              <span className="block text-xs text-ink-subtle">
                {formatFileSize(file.size)} · ready to send
              </span>
            </span>
            <IconButton label="Remove the selected file" onClick={clearFile} className="shrink-0">
              <CloseIcon />
            </IconButton>
          </div>
        ) : null}

        {fileError ? (
          <p className="mb-2 text-sm text-danger" role="alert">
            {fileError}
          </p>
        ) : null}

        {/*
          A paste that could not happen. `role="status"` rather than `alert`: it answers something
          the employee just did and tells them the way that works, which is information rather
          than an interruption.
        */}
        {pasteError ? (
          <p className="mb-2 text-sm text-ink-muted" role="status">
            {pasteError}
          </p>
        ) : null}

        {/*
          The whole row is the field, not just the textarea inside it: focus lights up the
          container so the paperclip and Send read as part of one control rather than three
          controls that happen to be adjacent.
        */}
        <div
          className={
            'flex items-end gap-2 rounded-panel border border-line-strong bg-surface-muted px-2 py-1.5 ' +
            'shadow-subtle transition-[border-color,box-shadow,background-color] ' +
            'duration-(--duration-quick) ease-(--ease-out-soft) ' +
            'focus-within:border-accent focus-within:bg-surface focus-within:ring-4 focus-within:ring-accent/12'
          }
        >
          {/*
            No attaching while editing. An edit changes text; replacing a file is a different
            thing entirely, and the server has no route for it (`editMessage` writes `body` and
            `editedAt`, nothing else).
          */}
          <IconButton
            label="Attach a file"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || editing}
            className="shrink-0"
          >
            <AttachmentIcon />
          </IconButton>

          <label htmlFor="message-composer" className="sr-only">
            {`Message ${conversationTitle}`}
          </label>
          <textarea
            id="message-composer"
            ref={textAreaRef}
            rows={1}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={onKeyDown}
            onContextMenu={openComposerMenu}
            placeholder={
              editing
                ? 'Edit your message'
                : file
                  ? 'Add a message with the file (optional)'
                  : `Message ${conversationTitle}`
            }
            /* The parent keys this component by conversation, so opening one focuses a fresh field. */
            autoFocus
            aria-describedby="composer-hint"
            aria-invalid={tooLong || undefined}
            className="max-h-40 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-[0.9375rem] leading-6 text-ink placeholder:text-ink-subtle focus:outline-none"
          />

          {/*
            Disabled while an upload is in flight: pressing Send twice on a 500 MB video should
            not start a second one. The idempotency key would stop it becoming two messages, but
            it would not stop the second upload being sent up the wire.
          */}
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!canSend}
            className="mb-0.5 shrink-0"
          >
            {editing ? <CheckIcon className="h-4 w-4" /> : <SendIcon className="h-4 w-4" />}
            {editing ? (saving ? 'Saving…' : 'Save') : uploading ? 'Sending…' : 'Send'}
          </Button>
        </div>

        <div className="mt-2 flex items-center justify-between gap-3">
          <p id="composer-hint" className="text-xs text-ink-subtle">
            {editing ? (
              <>
                <kbd className="font-sans font-medium text-ink-muted">Enter</kbd> saves ·{' '}
                <kbd className="font-sans font-medium text-ink-muted">Shift + Enter</kbd> adds a
                line · <kbd className="font-sans font-medium text-ink-muted">Esc</kbd> cancels
              </>
            ) : (
              <>
                <kbd className="font-sans font-medium text-ink-muted">Enter</kbd> sends ·{' '}
                <kbd className="font-sans font-medium text-ink-muted">Shift + Enter</kbd> adds a
                line · any file up to {formatFileSize(maxFileSize)}
              </>
            )}
          </p>
          {body.length >= COUNTER_VISIBLE_FROM ? (
            <p className={tooLong ? 'text-xs font-medium text-danger' : 'text-xs text-ink-subtle'}>
              {body.length} / {MAX_MESSAGE_LENGTH}
              {tooLong ? ' — too long to send' : ''}
            </p>
          ) : null}
        </div>
      </div>

      {/*
        Fixed to the viewport and rendered last, so it is never clipped by the composer's own
        box. `useAnchoredMenu` closes it on Escape, on a click elsewhere, on a right-click
        elsewhere, on a scroll and on a resize — the right-click rule being what guarantees this
        and the message menu are never open at the same time.
      */}
      {composerMenu ? (
        <ComposerContextMenu
          anchor={{ x: composerMenu.x, y: composerMenu.y }}
          onPasteSelected={
            // Null only when the browser has no clipboard read API at all — an insecure origin,
            // or a browser too old for it. A PRESENT-BUT-REFUSED API (the desktop client) stays
            // enabled and explains itself when pressed, which is the more useful of the two.
            canReadClipboard()
              ? () =>
                  void pasteFromClipboard({
                    selectionStart: composerMenu.selectionStart,
                    selectionEnd: composerMenu.selectionEnd,
                  })
              : null
          }
          onClose={closeComposerMenu}
        />
      ) : null}
    </form>
  );
}
