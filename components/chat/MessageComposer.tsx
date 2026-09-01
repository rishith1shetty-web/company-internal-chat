'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';

import { Button, IconButton } from '@/components/ui/Button';
import { AttachmentIcon, CloseIcon, FileIcon, SendIcon } from '@/components/ui/icons';
import { formatFileSize } from '@/lib/chat/format';
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
}

/** Show the character counter only when the limit is close enough to matter. */
const COUNTER_VISIBLE_FROM = MAX_MESSAGE_LENGTH - 200;

export function MessageComposer({
  conversationTitle,
  onSend,
  onSendFile,
  uploading,
  maxFileSize,
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
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Grow with the text, up to a ceiling, then scroll inside the field.
  useEffect(() => {
    const field = textAreaRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  }, [body]);

  const trimmed = body.trim();
  const tooLong = body.length > MAX_MESSAGE_LENGTH;
  // A file on its own is a message; so is text on its own; so is both together.
  const canSend = !uploading && !tooLong && (trimmed.length > 0 || file !== null);

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
    }
  };

  return (
    <form
      onSubmit={submit}
      className="shrink-0 border-t border-line bg-surface px-3 py-3 sm:px-6"
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

        {file ? (
          <div className="mb-2 flex items-center gap-3 rounded-lg border border-line bg-surface-muted px-3 py-2">
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface text-ink-muted"
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

        <div className="flex items-end gap-2 rounded-lg border border-line-strong bg-surface px-2 py-1.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
          <IconButton
            label="Attach a file"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
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
            placeholder={
              file ? 'Add a message with the file (optional)' : `Message ${conversationTitle}`
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
            <SendIcon className="h-4 w-4" />
            {uploading ? 'Sending…' : 'Send'}
          </Button>
        </div>

        <div className="mt-1.5 flex items-center justify-between gap-3">
          <p id="composer-hint" className="text-xs text-ink-subtle">
            Enter sends · Shift + Enter adds a line · any file up to{' '}
            {formatFileSize(maxFileSize)}
          </p>
          {body.length >= COUNTER_VISIBLE_FROM ? (
            <p className={tooLong ? 'text-xs font-medium text-danger' : 'text-xs text-ink-subtle'}>
              {body.length} / {MAX_MESSAGE_LENGTH}
              {tooLong ? ' — too long to send' : ''}
            </p>
          ) : null}
        </div>
      </div>
    </form>
  );
}
