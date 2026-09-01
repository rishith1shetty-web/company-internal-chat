'use client';

import { UserMenu } from '@/components/layout/UserMenu';
import { IconButton } from '@/components/ui/Button';
import { ChatIcon, MenuIcon } from '@/components/ui/icons';
import type { UserSummary } from '@/lib/chat/types';

interface AppHeaderProps {
  currentUser: UserSummary;
  /** The administrator's name for this computer. Shown to the employee, never editable by them. */
  deviceLabel: string;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
}

/**
 * Application header: product identity on the left, current user and account controls on the
 * right. Neutral, company-internal branding — no third-party product's marks or design
 * language (CLAUDE.md §2 Phase 2).
 */
export function AppHeader({
  currentUser,
  deviceLabel,
  onToggleSidebar,
  onOpenSettings,
}: AppHeaderProps) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-3 sm:px-4">
      <div className="flex min-w-0 items-center gap-2">
        <IconButton label="Show conversations" onClick={onToggleSidebar} className="md:hidden">
          <MenuIcon />
        </IconButton>

        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent text-white">
          <ChatIcon className="h-5 w-5" />
        </span>

        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">Company Internal Chat</p>
          <p className="hidden text-xs text-ink-subtle sm:block">Internal use only</p>
        </div>
      </div>

      <UserMenu
        currentUser={currentUser}
        deviceLabel={deviceLabel}
        onOpenSettings={onOpenSettings}
      />
    </header>
  );
}
