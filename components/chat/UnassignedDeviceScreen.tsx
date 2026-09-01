'use client';

import { BrandLockup } from '@/components/brand/Logo';
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
    <main className="chat-canvas flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        {/* The logo carries the identification here: this screen has no header above it. */}
        <div className="mb-7 flex justify-center">
          <BrandLockup width={216} className="h-auto w-[216px]" priority />
        </div>

        <div className="overflow-hidden rounded-panel border border-line bg-surface shadow-card">
          <div className="brand-rule h-1 w-full" aria-hidden="true" />

          <div className="p-6 sm:p-7">
            <span
              className="flex h-11 w-11 items-center justify-center rounded-full bg-gold-soft text-brand ring-1 ring-brand/12 ring-inset"
              aria-hidden="true"
            >
              <LockIcon className="h-5 w-5" />
            </span>

            <h1 className="mt-4 text-lg font-semibold tracking-tight text-ink">
              This computer is not set up yet
            </h1>

            <p className="mt-2 text-sm text-ink-muted">
              Chat accounts are set up by IT and are tied to the computer, not to a password. Ask
              your IT administrator to set this computer up for you, and it will open straight
              into your conversations from then on.
            </p>

            {/* A server failure is shown separately: it is about the request, not about setup. */}
            {error ? (
              <p
                className="mt-4 rounded-card bg-notice-tint px-3 py-2.5 text-sm text-notice ring-1 ring-notice/25 ring-inset"
                role="status"
              >
                {error}
              </p>
            ) : null}

            <p className="mt-6 flex items-start gap-2.5 border-t border-line pt-4 text-xs text-ink-subtle">
              <ChatIcon className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                If you already had chat on this computer and it has stopped recognising you, it
                may have been reassigned or reset. Contact IT — your previous conversations are
                not deleted.
              </span>
            </p>
          </div>
        </div>

        <p className="mt-5 text-center text-xs text-ink-subtle">
          Conversations and messages are stored on the company server.
        </p>
      </div>
    </main>
  );
}
