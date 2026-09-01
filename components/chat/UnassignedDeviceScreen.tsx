'use client';

import { ChatIcon, LockIcon } from '@/components/ui/icons';

interface UnassignedDeviceScreenProps {
  /** A server failure, when the reason is something other than "not assigned yet". */
  error: string | null;
}

/**
 * Shown when this computer has no assigned identity.
 *
 * This replaced the display-name entry screen, and the important thing about it is what it does
 * NOT have: no field, no button, no way for the person sitting here to give themselves an
 * identity, take somebody else's, or clear the one the machine has
 * (docs/12-admin-device-identity.md).
 *
 * It is reached in three situations — a computer that has never been set up, one whose
 * assignment was retired, and one an administrator has just reassigned — and none of them is
 * something the employee can act on. So the screen explains the state and says who to ask,
 * rather than offering a control that would not work (CLAUDE.md §12).
 *
 * The setup code is deliberately not mentioned. Enrollment is an IT operation, and putting the
 * word in front of every employee would turn a setup mechanism into something people ask each
 * other for.
 */
export function UnassignedDeviceScreen({ error }: UnassignedDeviceScreenProps) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10">
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
          <h2 className="text-base font-semibold text-ink">This computer is not set up yet</h2>

          <p className="mt-2 text-sm text-ink-muted">
            Chat accounts are set up by IT and are tied to the computer, not to a password. Ask
            your IT administrator to set this computer up for you, and it will open straight into
            your conversations from then on.
          </p>

          {/* A server failure is shown separately: it is about the request, not about setup. */}
          {error ? (
            <p className="mt-4 rounded-md bg-notice-tint px-3 py-2 text-sm text-notice ring-1 ring-notice/30 ring-inset" role="status">
              {error}
            </p>
          ) : null}

          <p className="mt-5 flex items-start gap-2 border-t border-line pt-4 text-xs text-ink-subtle">
            <LockIcon className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle" />
            <span>
              If you already had chat on this computer and it has stopped recognising you, it may
              have been reassigned or reset. Contact IT — your previous conversations are not
              deleted.
            </span>
          </p>
        </div>

        <p className="mt-4 text-center text-xs text-ink-subtle">
          Conversations and messages are stored on the company server.
        </p>
      </div>
    </main>
  );
}
