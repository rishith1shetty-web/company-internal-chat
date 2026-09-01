import { avatarTint, initials } from '@/lib/chat/format';
import type { PresenceState } from '@/lib/chat/types';
import { cn } from '@/lib/ui/cn';

interface AvatarProps {
  userId: string;
  displayName: string;
  size?: 'sm' | 'md' | 'lg';
  presence?: PresenceState;
  className?: string;
}

const SIZE_STYLES = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-11 w-11 text-sm',
} as const;

/**
 * Initials avatar. The tint is derived from the user id, not the name, so two people who share
 * a display name do not also share an avatar (D-02).
 *
 * The inset hairline is the polish: a 1px ring of the ink at 6% inside the circle's own edge,
 * which stops a pale tint dissolving into a pale surface without drawing a border around it.
 */
export function Avatar({ userId, displayName, size = 'md', presence, className }: AvatarProps) {
  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      <span
        className={cn(
          'inline-flex items-center justify-center rounded-full font-semibold tracking-wide select-none',
          'ring-1 ring-ink/6 ring-inset',
          SIZE_STYLES[size],
          avatarTint(userId),
        )}
        aria-hidden="true"
      >
        {initials(displayName)}
      </span>
      {presence ? (
        <PresenceDot
          presence={presence}
          className="absolute -right-0.5 -bottom-0.5 ring-2 ring-white"
        />
      ) : null}
    </span>
  );
}

/**
 * Avatar substitute for a group conversation.
 *
 * A group has no single face, so it gets the brand's own colours instead of a person's initials —
 * which also makes a group instantly distinguishable from a one-to-one in a mixed list, without
 * reading either name.
 */
export function GroupAvatar({
  size = 'md',
  className,
  children,
}: {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full',
        'bg-gold-soft text-brand ring-1 ring-brand/15 ring-inset',
        SIZE_STYLES[size],
        className,
      )}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

interface PresenceDotProps {
  presence: PresenceState;
  className?: string;
  /** Set when the dot is the only presence indicator, so it is not silent to a screen reader. */
  labelled?: boolean;
}

/**
 * Online/offline indicator (F-08). Presence is fixed mock state in Phase 2; Phase 4 derives it
 * from live socket connections (docs/01-architecture.md §6).
 */
export function PresenceDot({ presence, className, labelled = false }: PresenceDotProps) {
  const isOnline = presence === 'ONLINE';
  return (
    <span
      className={cn(
        'block h-2.5 w-2.5 rounded-full',
        isOnline ? 'bg-online' : 'bg-line-strong',
        className,
      )}
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? (isOnline ? 'Online' : 'Offline') : undefined}
      aria-hidden={labelled ? undefined : 'true'}
    />
  );
}

/**
 * Unread counter for the conversation list (F-09).
 *
 * Gold with dark ink on it, at 8.1:1 — the one place the logo's brightest colour is used as a
 * flat fill, because a badge is exactly what it is good at: small, meant to be found at a glance,
 * and carrying text that has to stay legible on it.
 */
export function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        'inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5',
        'bg-gold text-xs font-semibold text-ink tabular-nums shadow-subtle',
      )}
      aria-label={`${count} unread ${count === 1 ? 'message' : 'messages'}`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
