'use client';

import { useEffect, useRef, useState } from 'react';

import { Avatar } from '@/components/ui/Avatar';
import { SettingsIcon, SwitchUserIcon } from '@/components/ui/icons';
import { userDiscriminator } from '@/lib/chat/format';
import type { UserSummary } from '@/lib/chat/types';
import { cn } from '@/lib/ui/cn';

interface UserMenuProps {
  currentUser: UserSummary;
  onSwitchUser: () => void;
  onOpenSettings: () => void;
}

/**
 * Current-user area in the application header, with the account controls behind it.
 *
 * The identity shown is a display name plus a short discriminator derived from the user id.
 * The discriminator is not decoration: display names are not unique (D-02), so the name alone
 * never establishes which user this is.
 */
export function UserMenu({ currentUser, onSwitchUser, onOpenSettings }: UserMenuProps) {
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
          'flex cursor-pointer items-center gap-2.5 rounded-md py-1.5 pr-2 pl-1 text-left transition-colors duration-150',
          'hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          open && 'bg-canvas',
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
          className="absolute right-0 z-40 mt-1 w-72 rounded-md border border-line bg-surface py-1 shadow-lg"
        >
          <div className="border-b border-line px-3 py-2">
            <p className="truncate text-sm font-medium text-ink">{currentUser.displayName}</p>
            <p className="mt-0.5 text-xs text-ink-subtle">
              Signed in without a password · ID {userDiscriminator(currentUser.id)}
            </p>
          </div>

          <MenuItem icon={<SettingsIcon className="h-4 w-4" />} onClick={() => select(onOpenSettings)}>
            Settings
          </MenuItem>

          <MenuItem
            icon={<SwitchUserIcon className="h-4 w-4" />}
            onClick={() => select(onSwitchUser)}
            description="Use on a shared computer before someone else takes over."
          >
            Switch user / clear device identity
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
      className="flex w-full cursor-pointer items-start gap-2.5 px-3 py-2.5 text-left text-sm text-ink-muted transition-colors duration-150 hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:outline-none"
    >
      <span className="mt-0.5 text-ink-subtle">{icon}</span>
      <span>
        <span className="block">{children}</span>
        {description ? <span className="mt-0.5 block text-xs text-ink-subtle">{description}</span> : null}
      </span>
    </button>
  );
}
