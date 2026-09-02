'use client';

import { useEffect, useRef, useState } from 'react';

import { Avatar } from '@/components/ui/Avatar';
import { SettingsIcon } from '@/components/ui/icons';
import { userDiscriminator } from '@/lib/chat/format';
import type { UserSummary } from '@/lib/chat/types';
import { cn } from '@/lib/ui/cn';

interface UserMenuProps {
  currentUser: UserSummary;
  /** The administrator's name for this computer, shown as information only. */
  deviceLabel: string;
  onOpenSettings: () => void;
}

/**
 * Current-user area in the application header.
 *
 * The identity shown is a display name plus a short discriminator derived from the user id.
 * The discriminator is not decoration: display names are not unique (D-02), so the name alone
 * never establishes which user this is.
 *
 * IDENTITY IS DISPLAY-ONLY. There is no sign-out, no switch-user and no clear-identity item here:
 * an employee cannot change who this computer is (docs/12-admin-device-identity.md). What is left
 * is Settings, which reports the assignment read-only and — since the notification feature — also
 * holds the preferences an employee does own, all of which live in this browser alone.
 */
export function UserMenu({ currentUser, deviceLabel, onOpenSettings }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const select = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          'flex cursor-pointer items-center gap-2.5 rounded-control py-1.5 pr-2.5 pl-1.5 text-left',
          'transition-[background-color,box-shadow] duration-(--duration-quick) ease-(--ease-out-soft)',
          'hover:bg-canvas-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          open && 'bg-canvas-deep ring-1 ring-line ring-inset',
        )}
      >
        <Avatar
          userId={currentUser.id}
          displayName={currentUser.displayName}
          size="sm"
          presence={currentUser.presence}
        />
        <span className="hidden min-w-0 sm:block">
          <span className="block truncate text-sm font-medium text-ink">
            {currentUser.displayName}
          </span>
          <span className="block text-xs text-ink-subtle">
            You · ID {userDiscriminator(currentUser.id)}
          </span>
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Account"
          className="absolute right-0 z-40 mt-1.5 w-72 animate-rise-in rounded-card border border-line bg-surface py-1 shadow-raised"
        >
          <div className="border-b border-line px-3 py-2.5">
            <p className="truncate text-sm font-semibold text-ink">{currentUser.displayName}</p>
            <p className="mt-0.5 text-xs text-ink-subtle">
              ID {userDiscriminator(currentUser.id)} ·{' '}
              <span data-wrap-anywhere>{deviceLabel}</span>
            </p>
          </div>

          <MenuItem icon={<SettingsIcon className="h-4 w-4" />} onClick={() => select(onOpenSettings)}>
            Settings
          </MenuItem>
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({
  icon,
  children,
  description,
  onClick,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  description?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full cursor-pointer items-start gap-2.5 px-3 py-2.5 text-left text-sm text-ink-muted transition-colors duration-(--duration-quick) hover:bg-accent-tint hover:text-ink focus-visible:bg-accent-tint focus-visible:outline-none"
    >
      <span className="mt-0.5 text-ink-subtle">{icon}</span>
      <span>
        <span className="block">{children}</span>
        {description ? <span className="mt-0.5 block text-xs text-ink-subtle">{description}</span> : null}
      </span>
    </button>
  );
}
