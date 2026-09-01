'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { BrandLockup } from '@/components/brand/Logo';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/Field';
import { CheckIcon, LockIcon } from '@/components/ui/icons';
import { redeemEnrollmentCode } from '@/lib/admin/api';
import { ApiError } from '@/lib/chat/api';

/**
 * Setup: links this browser to the company computer it is running on.
 *
 * An IT operation performed once per machine, not a login. Redeeming a code does not let anybody
 * choose who they are — the employee was decided when the administrator made the assignment, and
 * the code carries no name and no choice. The wording says so plainly, because a screen that asks
 * for a code and then shows somebody's name would otherwise read like a sign-in.
 *
 * Nothing in the employee interface links here.
 */
export function EnrollmentScreen({ initialCode }: { initialCode: string }) {
  const router = useRouter();
  const [code, setCode] = useState(initialCode);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ deviceLabel: string; displayName: string } | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || code.trim().length === 0) return;

    setPending(true);
    setError(null);

    void (async () => {
      try {
        setDone(await redeemEnrollmentCode(code));
        setCode('');
      } catch (failure) {
        setError(
          failure instanceof ApiError ? failure.message : 'Could not complete setup.',
        );
      } finally {
        setPending(false);
      }
    })();
  };

  return (
    <main className="chat-canvas flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        {/*
          Setup runs on a machine nobody is signed in to, so the logo is doing real work here: it
          is the only thing telling whoever is at the keyboard that this is the company's own
          system and not a page that has asked them for a code.
        */}
        <div className="mb-6 flex flex-col items-center">
          <BrandLockup width={200} className="h-auto w-[200px]" priority />
          <p className="mt-3 text-xs font-semibold tracking-wider text-ink-subtle uppercase">
            Computer setup
          </p>
        </div>

        <div className="overflow-hidden rounded-panel border border-line bg-surface shadow-card">
          <div className="brand-rule h-1 w-full" aria-hidden="true" />
          <div className="p-6 sm:p-7">
          {done ? (
            <>
              <span
                className="flex h-11 w-11 items-center justify-center rounded-full bg-gold-soft text-brand ring-1 ring-brand/12 ring-inset"
                aria-hidden="true"
              >
                <CheckIcon className="h-5 w-5" />
              </span>
              <h1 className="mt-4 text-lg font-semibold tracking-tight text-ink">
                {done.deviceLabel} is ready
              </h1>
              <p className="mt-2 text-sm text-ink-muted">
                This computer is now recognised as{' '}
                <span className="font-medium text-ink">{done.displayName}</span>. Chat will open
                straight to their conversations, with nothing to sign in to.
              </p>
              <Button variant="primary" className="mt-5" onClick={() => router.push('/')}>
                Open chat
              </Button>
            </>
          ) : (
            <form onSubmit={submit} noValidate>
              <h1 className="text-lg font-semibold tracking-tight text-ink">
                Set up this computer
              </h1>
              <p className="mt-2 text-sm text-ink-muted">
                For IT. Enter the setup code from the administration page to link this computer to
                the employee it has been assigned to.
              </p>

              <TextField
                className="mt-5"
                label="Setup code"
                hint="Dashes and capitals do not matter."
                value={code}
                onChange={(event) => setCode(event.target.value)}
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                autoFocus
                required
              />

              {error ? (
                <p className="mt-3 text-sm text-danger" role="alert">
                  {error}
                </p>
              ) : null}

              <Button type="submit" variant="primary" fullWidth className="mt-5" disabled={pending}>
                {pending ? 'Setting up…' : 'Set up this computer'}
              </Button>

              <p className="mt-5 flex items-start gap-2 border-t border-line pt-4 text-xs text-ink-subtle">
                <LockIcon className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle" />
                <span>
                  A setup code works once and then expires. It links this browser to one computer;
                  it does not sign anybody in and cannot be used to change who a computer belongs
                  to.
                </span>
              </p>
            </form>
          )}
          </div>
        </div>

        <p className="mt-5 text-center text-xs text-ink-subtle">
          Rising Path Recruiters · internal system
        </p>
      </div>
    </main>
  );
}
