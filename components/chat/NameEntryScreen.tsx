'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';

import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/Field';
import { ChatIcon, LockIcon } from '@/components/ui/icons';
import { MAX_DISPLAY_NAME_LENGTH } from '@/lib/chat/types';

interface NameEntryScreenProps {
  onEnter: (displayName: string) => void;
  /** Shown after "Switch user", so it is obvious the previous identity was left behind. */
  afterSwitchUser: boolean;
}

/**
 * Entry screen: the user states the name colleagues will see.
 *
 * v1 has no password by design (D-11). What the user types here is a label; the identity is a
 * server-issued id, and entering the same name twice produces two different users (D-02).
 *
 * PHASE 2: no session or device identity is created — there is no server call at all. Phase 5
 * replaces this submit handler with POST /api/session, which issues the session and device
 * cookies described in docs/01-architecture.md §5.
 */
export function NameEntryScreen({ onEnter, afterSwitchUser }: NameEntryScreenProps) {
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmed = displayName.trim();
    if (trimmed.length < 2) {
      setError('Enter at least 2 characters so colleagues can recognise you.');
      return;
    }
    if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
      setError(`Use at most ${MAX_DISPLAY_NAME_LENGTH} characters.`);
      return;
    }

    setError(null);
    onEnter(trimmed);
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent text-white">
            <ChatIcon />
          </span>
          <div>
            <h1 className="text-lg font-semibold text-ink">Company Internal Chat</h1>
            <p className="text-sm text-ink-muted">Internal communication and file transfer</p>
          </div>
        </div>

        <div className="rounded-lg border border-line bg-surface p-6 shadow-sm">
          {afterSwitchUser ? (
            <p className="mb-4 rounded-md bg-notice-tint px-3 py-2 text-sm text-notice ring-1 ring-notice/30 ring-inset">
              The previous user was signed out on this computer. Entering a name below starts a
              separate identity — it does not reopen the previous person&apos;s conversations.
            </p>
          ) : null}

          <form onSubmit={submit} noValidate>
            <TextField
              label="Your display name"
              hint="This is how colleagues will see you. Names are not unique, so you may see more than one person with the same name."
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={MAX_DISPLAY_NAME_LENGTH}
              error={error ?? undefined}
              autoComplete="off"
              autoFocus
              required
            />

            <Button type="submit" variant="primary" fullWidth className="mt-5">
              Continue
            </Button>
          </form>

          <p className="mt-5 flex items-start gap-2 border-t border-line pt-4 text-xs text-ink-subtle">
            <LockIcon className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle" />
            <span>
              This system has no password in its first version. A display name identifies you to
              colleagues only — it is not proof of who you are, so treat conversations accordingly.
            </span>
          </p>
        </div>

        <p className="mt-4 text-center text-xs text-ink-subtle">
          Phase 2 preview — interface only. Nothing you type is sent to a server or stored.
        </p>
      </div>
    </main>
  );
}
