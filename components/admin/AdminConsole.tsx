'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import type { AdminDeviceWire } from '@/lib/admin/wire';
import {
  adminSignIn,
  adminSignOut,
  fetchAdminSession,
  fetchDevices,
  reactivateDevice,
  registerDevice,
  reassignDevice,
  reissueEnrollmentCode,
  renameDevice,
  revokeDevice,
} from '@/lib/admin/api';
import { BrandLockup, BrandLockupInline } from '@/components/brand/Logo';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { ApiError } from '@/lib/chat/api';
import { formatFullTimestamp, userDiscriminator } from '@/lib/chat/format';
import { cn } from '@/lib/ui/cn';

/**
 * The administrator's console: register a company computer, assign it to an employee, hand it to
 * a different employee later, and retire it.
 *
 * Deliberately plain. This is an IT tool used a handful of times a week, not the employee product,
 * and every minute spent styling it is a minute not spent on the chat system (CLAUDE.md §12).
 *
 * It reuses the employee interface's components rather than introducing a second design, and it
 * shows the one-time setup code exactly once, with an explanation of why it cannot be shown again.
 */
export function AdminConsole() {
  const [checking, setChecking] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [devices, setDevices] = useState<AdminDeviceWire[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** The most recently issued setup code. Held in memory only, and never re-fetchable. */
  const [issued, setIssued] = useState<{ label: string; code: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchDevices();
      setDevices(data.devices);
      setError(null);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) {
        setSignedIn(false);
        return;
      }
      setError(failure instanceof ApiError ? failure.message : 'Could not load the computers.');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const active = await fetchAdminSession();
        if (cancelled) return;
        setSignedIn(active);
        if (active) await load();
      } catch (failure) {
        if (cancelled) return;
        setError(
          failure instanceof ApiError ? failure.message : 'Could not reach the server.',
        );
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [load]);

  if (checking) {
    return (
      <Shell>
        <p className="text-sm text-ink-muted" role="status">
          Checking administrator access…
        </p>
      </Shell>
    );
  }

  if (!signedIn) {
    return (
      <Shell>
        <SignIn
          error={error}
          onSignedIn={async () => {
            setError(null);
            setSignedIn(true);
            await load();
          }}
          onError={setError}
        />
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Company computers</h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            Each computer is assigned to one employee. Whoever sits at it is recognised as that
            person — there is no sign-in and nothing for them to change.
          </p>
        </div>
        <Button
          onClick={() => {
            void (async () => {
              await adminSignOut();
              setSignedIn(false);
              setDevices([]);
              setIssued(null);
            })();
          }}
        >
          Sign out
        </Button>
      </div>

      {error ? (
        <p
          className="mt-4 rounded-card bg-danger-tint px-3 py-2.5 text-sm font-medium text-danger ring-1 ring-danger/20 ring-inset"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {issued ? <SetupCode label={issued.label} code={issued.code} onDismiss={() => setIssued(null)} /> : null}

      <RegisterForm
        onRegistered={async (result) => {
          setIssued({ label: result.label, code: result.code });
          setError(null);
          await load();
        }}
        onError={setError}
      />

      <DeviceTable
        devices={devices}
        onIssued={(label, code) => setIssued({ label, code })}
        onChanged={load}
        onError={setError}
      />
    </Shell>
  );
}

/**
 * Admin chrome.
 *
 * A real header bar with the company mark in it, over a warm page, then one card for the work —
 * the layout a person recognises as an internal console rather than a form on a blank page. The
 * mark here is the compact one, not the full lockup: the console is a place of work somebody
 * returns to daily, and a wordmark at the top of every visit is a banner rather than an aid.
 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="shrink-0">
        <div className="flex h-15 items-center justify-between gap-3 bg-surface px-4">
          <BrandLockupInline subtitle="Administration" />
          <span className="hidden rounded-full bg-accent-tint px-2.5 py-1 text-xs font-semibold text-accent ring-1 ring-accent/20 ring-inset sm:inline-block">
            Internal tool
          </span>
        </div>
        <div className="brand-rule h-0.5 w-full" aria-hidden="true" />
      </header>

      <main className="flex-1 px-4 py-8">
        <div className="mx-auto w-full max-w-4xl">
          <div className="rounded-panel border border-line bg-surface p-6 shadow-card sm:p-7">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}

function SignIn({
  error,
  onSignedIn,
  onError,
}: {
  error: string | null;
  onSignedIn: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [token, setToken] = useState('');
  const [pending, setPending] = useState(false);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || token.length === 0) return;

    setPending(true);
    void (async () => {
      try {
        await adminSignIn(token);
        setToken('');
        await onSignedIn();
      } catch (failure) {
        onError(
          failure instanceof ApiError ? failure.message : 'Could not sign in. Please try again.',
        );
      } finally {
        setPending(false);
      }
    })();
  };

  return (
    <form onSubmit={submit} noValidate className="mx-auto max-w-sm py-2 text-center">
      <BrandLockup width={190} className="mx-auto h-auto w-[190px]" priority />

      <h1 className="mt-6 text-lg font-semibold tracking-tight text-ink">
        Administrator sign-in
      </h1>
      <p className="mt-1.5 text-sm text-ink-muted">
        This page assigns company computers to employees. It gives no access to anybody&apos;s
        conversations, messages or files.
      </p>

      <TextField
        className="mt-6 text-left"
        label="Administrator token"
        hint="The ADMIN_TOKEN configured on this server."
        type="password"
        value={token}
        onChange={(event) => setToken(event.target.value)}
        autoComplete="off"
        autoFocus
        required
      />

      {error ? (
        <p className="mt-3 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-6 text-left">
        <Button type="submit" variant="primary" fullWidth disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </div>
    </form>
  );
}

/**
 * A newly issued setup code, shown once.
 *
 * The wording is deliberate about the two things an administrator has to know: this is the only
 * time the code is visible, and it is redeemed on the computer being set up, not here.
 */
function SetupCode({
  label,
  code,
  onDismiss,
}: {
  label: string;
  code: string;
  onDismiss: () => void;
}) {
  return (
    <div className="mt-6 animate-rise-in overflow-hidden rounded-panel border border-accent/25 bg-accent-tint shadow-card">
      <div className="brand-rule h-1 w-full" aria-hidden="true" />
      <div className="p-4 sm:p-5">
      <p className="text-sm font-semibold text-ink">Setup code for {label}</p>
      <p
        className="mt-2.5 rounded-control border border-accent/20 bg-surface px-3 py-2.5 font-mono text-lg tracking-wider text-ink select-all"
        data-wrap-anywhere
      >
        {code}
      </p>
      <p className="mt-2.5 text-sm text-ink-muted">
        Open <span className="font-medium text-ink">/setup</span> on that computer and enter this
        code. It works once and then expires. It is stored only as a hash, so this is the only
        time it can be shown — if it is lost, issue a new one.
      </p>
      <Button size="sm" className="mt-3" onClick={onDismiss}>
        Done
      </Button>
      </div>
    </div>
  );
}

function RegisterForm({
  onRegistered,
  onError,
}: {
  onRegistered: (result: { label: string; code: string }) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [label, setLabel] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [pending, setPending] = useState(false);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;

    setPending(true);
    void (async () => {
      try {
        const result = await registerDevice(label.trim(), displayName.trim());
        setLabel('');
        setDisplayName('');
        await onRegistered({ label: result.device.label, code: result.enrollmentCode });
      } catch (failure) {
        onError(
          failure instanceof ApiError ? failure.message : 'Could not register that computer.',
        );
      } finally {
        setPending(false);
      }
    })();
  };

  return (
    <form onSubmit={submit} noValidate className="mt-8 border-t border-line pt-6">
      <h2 className="text-base font-semibold tracking-tight text-ink">Register a computer</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Creates the employee&apos;s account and a setup code for the machine.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <TextField
          label="Computer name"
          hint="How you recognise the machine, e.g. PC-001 or Reception PC."
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={64}
          autoComplete="off"
          required
        />
        <TextField
          label="Employee name"
          hint="Shown to colleagues in chat. Names need not be unique."
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          maxLength={64}
          autoComplete="off"
          required
        />
      </div>

      <Button type="submit" variant="primary" className="mt-4" disabled={pending}>
        {pending ? 'Registering…' : 'Register and assign'}
      </Button>
    </form>
  );
}

const STATUS_LABELS: Record<AdminDeviceWire['status'], string> = {
  'awaiting-setup': 'Awaiting setup',
  enrolled: 'In use',
  expired: 'Lapsed',
  revoked: 'Out of service',
};

/*
 * Status is never colour alone: each badge carries its own word, and the ring gives it an edge
 * that survives a monochrome screen or a colour-blind reader.
 */
const STATUS_STYLES: Record<AdminDeviceWire['status'], string> = {
  'awaiting-setup': 'bg-notice-tint text-notice ring-notice/25',
  enrolled: 'bg-gold-soft text-ink ring-brand/25',
  expired: 'bg-surface-muted text-ink-muted ring-line-strong',
  revoked: 'bg-surface-muted text-ink-subtle ring-line-strong',
};

function DeviceTable({
  devices,
  onIssued,
  onChanged,
  onError,
}: {
  devices: AdminDeviceWire[];
  onIssued: (label: string, code: string) => void;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  /*
   * Which computer the confirmation is asking about, or null.
   *
   * Held here rather than in the row because `Modal` renders a `div`, and a `div` inside a `tr`
   * is invalid HTML — React says so in the console, and the browser regression check treats a
   * console error as a failure.
   */
  const [confirming, setConfirming] = useState<AdminDeviceWire | null>(null);
  const [retiring, setRetiring] = useState(false);

  const confirmRetire = () => {
    if (!confirming || retiring) return;
    const device = confirming;

    setRetiring(true);
    void (async () => {
      try {
        await revokeDevice(device.id);
        setConfirming(null);
        await onChanged();
      } catch (failure) {
        onError(
          failure instanceof ApiError
            ? failure.message
            : 'Could not take that computer out of service.',
        );
      } finally {
        setRetiring(false);
      }
    })();
  };

  if (devices.length === 0) {
    return (
      <p className="mt-8 border-t border-line pt-6 text-sm text-ink-muted">
        No computers are registered yet.
      </p>
    );
  }

  return (
    <div className="mt-8 border-t border-line pt-6">
      <h2 className="text-base font-semibold tracking-tight text-ink">Registered computers</h2>

      {/* Its own scroll container, so a wide table never makes the page scroll sideways. */}
      <div className="mt-4 -mx-2 overflow-x-auto px-2">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <thead className="border-b border-line text-xs font-semibold tracking-wider text-ink-subtle uppercase">
            <tr>
              <th className="py-2 pr-4 font-medium">Computer</th>
              <th className="py-2 pr-4 font-medium">Assigned to</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">Last seen</th>
              <th className="py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {devices.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                onIssued={onIssued}
                onChanged={onChanged}
                onError={onError}
                onRequestRetire={() => setConfirming(device)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <RetireDialog
        device={confirming}
        pending={retiring}
        onCancel={() => setConfirming(null)}
        onConfirm={confirmRetire}
      />
    </div>
  );
}

/**
 * Confirmation for the one action here that stops a working computer.
 *
 * It states the three consequences plainly — it stops now, its sessions go, and it needs setting
 * up again — because an administrator clicking through the register has no other way to know the
 * third one, and it is the one that costs somebody a walk to the desk. Cancel writes nothing.
 */
function RetireDialog({
  device,
  pending,
  onCancel,
  onConfirm,
}: {
  device: AdminDeviceWire | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={device !== null}
      title="Take this computer out of service?"
      description={device ? device.label : undefined}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={pending}>
            {pending ? 'Taking out of service…' : 'Take out of service'}
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink-muted">
        <span className="font-medium text-ink">{device?.assignedUser.displayName}</span> is
        currently assigned to this computer.
      </p>

      <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-ink-muted">
        <li>
          <span className="font-medium text-ink">It stops working immediately.</span> Chat on that
          machine returns to the &ldquo;not set up yet&rdquo; screen on its next request.
        </li>
        <li>
          Anyone signed in on it is signed out at once: every session for this computer is revoked,
          and its saved identity is destroyed so a copied cookie is useless.
        </li>
        <li>
          Putting it back into service later needs a <span className="font-medium text-ink">new
          setup code entered on that computer</span> — someone has to go to it.
        </li>
      </ul>

      <p className="mt-4 rounded-card border border-line bg-surface-muted px-3 py-2.5 text-xs text-ink-subtle">
        Nothing is deleted. The computer stays in this register, the employee keeps their account,
        and their conversations and messages are untouched. Use{' '}
        <span className="font-medium text-ink">Reassign</span> instead if the computer is simply
        changing hands — that needs no visit and no code.
      </p>
    </Modal>
  );
}

function DeviceRow({
  device,
  onIssued,
  onChanged,
  onError,
  onRequestRetire,
}: {
  device: AdminDeviceWire;
  onIssued: (label: string, code: string) => void;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
  onRequestRetire: () => void;
}) {
  const [reassigning, setReassigning] = useState(false);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [newLabel, setNewLabel] = useState(device.label);
  /*
   * The rename failure is held here, not raised to the page banner.
   *
   * "That name is already used" is a correction to the field the administrator is typing in, and
   * belongs beside it — a message at the top of the page reads as though the whole operation
   * failed for some other reason.
   */
  const [renameError, setRenameError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const run = (action: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    void (async () => {
      try {
        await action();
        await onChanged();
      } catch (failure) {
        onError(failure instanceof ApiError ? failure.message : 'That did not work.');
      } finally {
        setPending(false);
      }
    })();
  };

  const retired = device.status === 'revoked';

  const openRename = () => {
    setNewLabel(device.label);
    setRenameError(null);
    setRenaming((open) => !open);
  };

  const submitRename = () => {
    const label = newLabel.trim();
    if (pending || label.length < 2) return;

    setPending(true);
    setRenameError(null);
    void (async () => {
      try {
        await renameDevice(device.id, label);
        setRenaming(false);
        await onChanged();
      } catch (failure) {
        setRenameError(
          failure instanceof ApiError ? failure.message : 'Could not rename that computer.',
        );
      } finally {
        setPending(false);
      }
    })();
  };

  return (
    <>
      <tr>
        <td className="py-3.5 pr-4 align-top font-semibold text-ink">{device.label}</td>
        <td className="py-3 pr-4 align-top text-ink-muted">
          {device.assignedUser.displayName}
          <span className="block text-xs text-ink-subtle">
            ID {userDiscriminator(device.assignedUser.id)}
          </span>
        </td>
        <td className="py-3 pr-4 align-top">
          <span
            className={cn(
              'inline-block rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset',
              STATUS_STYLES[device.status],
            )}
          >
            {STATUS_LABELS[device.status]}
          </span>
        </td>
        <td className="py-3 pr-4 align-top text-xs text-ink-subtle">
          {formatFullTimestamp(device.lastSeenAt)}
        </td>
        <td className="py-3 align-top">
          <div className="flex flex-wrap justify-end gap-2">
            {/* Renaming works in or out of service: it writes a label and nothing else. */}
            <Button size="sm" disabled={pending} onClick={openRename}>
              Rename
            </Button>

            {retired ? (
              /*
               * Otherwise a computer out of service has exactly one action, and it is the way
               * back. Taking a computer out of service is easy to reach on purpose, so it will
               * occasionally be used on a machine that returns — leaving no route back would make
               * a mis-click repairable only with direct SQL.
               */
              <Button
                size="sm"
                variant="primary"
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    const result = await reactivateDevice(device.id);
                    onIssued(result.device.label, result.enrollmentCode);
                  })
                }
              >
                Return to service
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => setReassigning((open) => !open)}
                >
                  Reassign
                </Button>
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    run(async () => {
                      const result = await reissueEnrollmentCode(device.id);
                      onIssued(result.device.label, result.enrollmentCode);
                    })
                  }
                >
                  New setup code
                </Button>
                {/* Asks first: this is the one action that stops a working computer. */}
                <Button
                  size="sm"
                  variant="danger"
                  disabled={pending}
                  onClick={onRequestRetire}
                >
                  Take out of service
                </Button>
              </>
            )}
          </div>
        </td>
      </tr>

      {renaming ? (
        <tr>
          <td colSpan={5} className="pb-4">
            <div className="animate-rise-in rounded-card border border-line bg-surface-muted p-3.5">
              <p className="text-sm text-ink-muted">
                Changes only what this computer is called here. Its employee, its setup and every
                message stay exactly as they are.
              </p>

              <div className="mt-3 flex flex-wrap items-end gap-3">
                <TextField
                  className="min-w-[16rem] flex-1"
                  label="Computer name"
                  value={newLabel}
                  onChange={(event) => setNewLabel(event.target.value)}
                  error={renameError ?? undefined}
                  maxLength={64}
                  autoComplete="off"
                />
                <Button
                  variant="primary"
                  disabled={pending || newLabel.trim().length < 2}
                  onClick={submitRename}
                >
                  {pending ? 'Saving…' : 'Save name'}
                </Button>
                <Button onClick={() => setRenaming(false)} disabled={pending}>
                  Cancel
                </Button>
              </div>
            </div>
          </td>
        </tr>
      ) : null}

      {retired ? (
        <tr>
          <td colSpan={5} className="pb-4">
            <p className="rounded-card border border-line bg-surface-muted px-3 py-2.5 text-xs text-ink-muted">
              Out of service since {formatFullTimestamp(device.revokedAt ?? device.lastSeenAt)}.
              Returning it to service keeps this same computer, its name and{' '}
              <span className="font-medium text-ink">{device.assignedUser.displayName}</span> as
              its employee, and issues a new setup code — the old one and the computer&apos;s
              saved identity were destroyed when it was taken out of service, so it has to be set
              up once more.
            </p>
          </td>
        </tr>
      ) : null}

      {reassigning ? (
        <tr>
          <td colSpan={5} className="pb-4">
            <div className="animate-rise-in rounded-card border border-line bg-surface-muted p-3.5">
              <p className="text-sm text-ink-muted">
                The new employee gets their own account and their own message history.{' '}
                <span className="font-medium text-ink">
                  {device.assignedUser.displayName}
                </span>
                &apos;s conversations are kept and are not transferred. The computer stays set up —
                nobody needs to visit it.
              </p>

              <div className="mt-3 flex flex-wrap items-end gap-3">
                <TextField
                  className="min-w-[16rem] flex-1"
                  label="New employee name"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  maxLength={64}
                  autoComplete="off"
                />
                <Button
                  variant="primary"
                  disabled={pending || newName.trim().length < 2}
                  onClick={() =>
                    run(async () => {
                      await reassignDevice(device.id, newName.trim());
                      setNewName('');
                      setReassigning(false);
                    })
                  }
                >
                  {pending ? 'Reassigning…' : 'Reassign'}
                </Button>
                <Button onClick={() => setReassigning(false)}>Cancel</Button>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
