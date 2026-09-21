'use client';

import {
  CopyIcon,
  EditIcon,
  EmojiIcon,
  ForwardIcon,
  PinIcon,
  ReplyIcon,
  TrashIcon,
} from '@/components/ui/icons';
import { REACTION_EMOJI } from '@/lib/chat/wire';
import { cn } from '@/lib/ui/cn';
import { useAnchoredMenu } from '@/lib/ui/useAnchoredMenu';

export interface MessageMenuAction {
  key: 'reply' | 'copy' | 'edit' | 'react' | 'forward' | 'pin' | 'delete';
  label: string;
  /** Hidden entirely rather than disabled: a greyed row invites a click that cannot work. */
  available: boolean;
  danger?: boolean;
  onSelect(): void;
}

interface MessageContextMenuProps {
  /** Where the pointer was, in viewport coordinates. */
  anchor: { x: number; y: number };
  actions: MessageMenuAction[];
  /** Shown as a row of emoji above the list; null hides the row entirely. */
  onReact: ((emoji: string) => void) | null;
  /** The reader's current reaction, so the picker can show it as chosen. */
  myReaction: string | null;
  onClose(): void;
}

/**
 * The right-click menu on a message.
 *
 * Placement, dismissal and keyboard navigation all come from `useAnchoredMenu`, which the
 * composer's menu uses too (Batch 1.2) — including the right-click-elsewhere rule that is what
 * stops the two menus ever being open at the same time.
 *
 * What is left here is the part that is about MESSAGES: which rows a message offers, the reaction
 * strip above them, and the fact that an unavailable action is hidden entirely rather than
 * disabled — a greyed row invites a click that cannot work.
 */
export function MessageContextMenu({
  anchor,
  actions,
  onReact,
  myReaction,
  onClose,
}: MessageContextMenuProps) {
  const available = actions.filter((action) => action.available);
  const { menuRef, position, onKeyDown } = useAnchoredMenu(anchor, onClose, available.length);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Message actions"
      onKeyDown={onKeyDown}
      className={cn(
        'fixed z-50 min-w-48 overflow-hidden rounded-xl border border-line bg-surface py-1',
        'shadow-lg ring-1 ring-black/5',
      )}
      style={{ left: position.x, top: position.y }}
    >
      {onReact ? (
        <div
          className="flex items-center gap-0.5 border-b border-line px-1.5 pb-1.5 pt-1"
          role="group"
          aria-label="React"
        >
          {REACTION_EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              data-menu-item
              role="menuitemradio"
              aria-checked={myReaction === emoji}
              aria-label={`React with ${emoji}`}
              onClick={() => {
                onReact(emoji);
                onClose();
              }}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-lg text-base',
                'transition-colors duration-(--duration-quick) hover:bg-surface-muted',
                'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                myReaction === emoji && 'bg-accent/15 ring-1 ring-accent/40',
              )}
            >
              <span aria-hidden="true">{emoji}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="py-0.5">
        {available.map((action) => (
          <button
            key={action.key}
            type="button"
            data-menu-item
            role="menuitem"
            onClick={() => {
              action.onSelect();
              onClose();
            }}
            className={cn(
              'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm',
              'transition-colors duration-(--duration-quick)',
              'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
              action.danger
                ? 'text-danger hover:bg-danger/10'
                : 'text-ink hover:bg-surface-muted',
            )}
          >
            <MenuIconFor action={action.key} />
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function MenuIconFor({ action }: { action: MessageMenuAction['key'] }) {
  const className = 'h-4 w-4 shrink-0 opacity-70';

  if (action === 'reply') return <ReplyIcon className={className} />;
  if (action === 'copy') return <CopyIcon className={className} />;
  if (action === 'edit') return <EditIcon className={className} />;
  if (action === 'react') return <EmojiIcon className={className} />;
  if (action === 'forward') return <ForwardIcon className={className} />;
  if (action === 'pin') return <PinIcon className={className} />;
  return <TrashIcon className={className} />;
}
