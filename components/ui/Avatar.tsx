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
 */
export function Avatar({ userId, displayName, size = 'md', presence, className }: AvatarProps) {
  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      <span
        className={cn(
          'inline-flex items-center justify-center rounded-full font-semibold select-none',
          SIZE_STYLES[size],
          avatarTint(userId),
        )}
        aria-hidden="true"
      >
        {initials(displayName)}
      </span>
      {presence ? (
        <PresenceDot presence={presence} className="absolute -right-0.5 -bottom-0.5 ring-2 ring-white" />
      ) : null}
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

/** Unread counter for the conversation list (F-09). */
export function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className="inline-flex min-w-5 items-center justify-center rounded-full bg-accent px-1.5 py-0.5 text-xs font-semibold text-white"
      aria-label={`${count} unread ${count === 1 ? 'message' : 'messages'}`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
