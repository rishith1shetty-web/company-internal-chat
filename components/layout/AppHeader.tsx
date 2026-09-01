'use client';

import { BrandMark } from '@/components/brand/Logo';
import { UserMenu } from '@/components/layout/UserMenu';
import { IconButton } from '@/components/ui/Button';
import { MenuIcon } from '@/components/ui/icons';
import type { UserSummary } from '@/lib/chat/types';

interface AppHeaderProps {
  currentUser: UserSummary;
  /** The administrator's name for this computer. Shown to the employee, never editable by them. */
  deviceLabel: string;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
}

/**
 * Application header: company identity on the left, current user and account controls on the
 * right.
 *
 * This is where the real logo lives — one mark, at the top left, on every screen of the product.
 * It is not repeated anywhere inside the chat interface: a logo that appears in the header, the
 * sidebar and the empty state stops reading as a brand and starts reading as wallpaper.
 *
 * The mark is `aria-hidden` because the company name sits beside it as text. The gold rule under
 * the header is the only flat band of the brand's brightest colour in the interface.
 */
export function AppHeader({
  currentUser,
  deviceLabel,
  onToggleSidebar,
  onOpenSettings,
}: AppHeaderProps) {
  return (
    <header className="shrink-0">
      <div className="flex h-15 items-center justify-between gap-3 bg-surface px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <IconButton label="Show conversations" onClick={onToggleSidebar} className="md:hidden">
            <MenuIcon />
          </IconButton>

          <span className="flex h-9 w-9 shrink-0 items-center justify-center">
            <BrandMark size={34} priority />
          </span>

          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold tracking-tight text-ink">
              Rising Path Recruiters
            </p>
            <p className="hidden truncate text-xs text-ink-subtle sm:block">
              Internal chat &amp; file transfer
            </p>
          </div>
        </div>

        <UserMenu
          currentUser={currentUser}
          deviceLabel={deviceLabel}
          onOpenSettings={onOpenSettings}
        />
      </div>

      {/* 2px of the logo's own gradient, in place of another grey border. */}
      <div className="brand-rule h-0.5 w-full" aria-hidden="true" />
    </header>
  );
}
