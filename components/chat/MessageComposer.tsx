'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';

import { Button, IconButton } from '@/components/ui/Button';
import { AttachmentIcon, SendIcon } from '@/components/ui/icons';
import { MAX_MESSAGE_LENGTH } from '@/lib/chat/types';

interface MessageComposerProps {
  conversationTitle: string;
  onSend: (body: string) => void;
  onAttachFile: () => void;
}

/** Show the character counter only when the limit is close enough to matter. */
const COUNTER_VISIBLE_FROM = MAX_MESSAGE_LENGTH - 200;

export function MessageComposer({
  conversationTitle,
  onSend,
  onAttachFile,
}: MessageComposerProps) {
  const [body, setBody] = useState('');
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  // Grow with the text, up to a ceiling, then scroll inside the field.
  useEffect(() => {
    const field = textAreaRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  }, [body]);

  const trimmed = body.trim();
  const tooLong = body.length > MAX_MESSAGE_LENGTH;
  const canSend = trimmed.length > 0 && !tooLong;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
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
        <div className="flex items-end gap-2 rounded-lg border border-line-strong bg-surface px-2 py-1.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
          <IconButton label="Attach a file" onClick={onAttachFile} className="shrink-0">
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
            placeholder={`Message ${conversationTitle}`}
            /* The parent keys this component by conversation, so opening one focuses a fresh field. */
            autoFocus
            aria-describedby="composer-hint"
            aria-invalid={tooLong || undefined}
            className="max-h-40 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-[0.9375rem] leading-6 text-ink placeholder:text-ink-subtle focus:outline-none"
          />

          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!canSend}
            className="mb-0.5 shrink-0"
          >
            <SendIcon className="h-4 w-4" />
            Send
          </Button>
        </div>

        <div className="mt-1.5 flex items-center justify-between gap-3">
          <p id="composer-hint" className="text-xs text-ink-subtle">
            Enter sends · Shift + Enter adds a line
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
