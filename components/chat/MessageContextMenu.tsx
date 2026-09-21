'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  CopyIcon,
  EmojiIcon,
  ForwardIcon,
  PinIcon,
  ReplyIcon,
  TrashIcon,
} from '@/components/ui/icons';
import { REACTION_EMOJI } from '@/lib/chat/wire';
import { cn } from '@/lib/ui/cn';

/** How far from the window edge the menu refuses to sit. */
const EDGE_MARGIN = 8;

export interface MessageMenuAction {
  key: 'reply' | 'copy' | 'react' | 'forward' | 'pin' | 'delete';
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
 * Fixed-positioned against the pointer, then nudged back inside the viewport once its real size
 * is known — measured in a layout effect rather than guessed from a constant, because the row
 * count changes with what the message allows (a received message has no "delete for everyone",
 * a pinned one says "Unpin").
 *
 * Dismissal is deliberately generous: Escape, a click anywhere else, a right-click anywhere else,
 * scrolling, and the window resizing all close it. A context menu that outlives its context is
 * worse than no context menu.
 *
 * Keyboard: focus moves to the first item on open, the arrow keys move through the list, Home and
 * End jump to the ends, Escape closes and returns focus to where it was. That is the WAI-ARIA
 * menu pattern, minus submenus, which this does not have.
 */
export function MessageContextMenu({
  anchor,
  actions,
  onReact,
  myReaction,
  onClose,
}: MessageContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState(anchor);

  const available = actions.filter((action) => action.available);

  // Measure, then keep the whole menu on screen. `useLayoutEffect` so the correction happens
  // before the browser paints — measuring in a normal effect makes the menu visibly jump.
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;

    const { width, height } = element.getBoundingClientRect();
    const maxX = window.innerWidth - width - EDGE_MARGIN;
    const maxY = window.innerHeight - height - EDGE_MARGIN;

    setPosition({
      x: Math.max(EDGE_MARGIN, Math.min(anchor.x, maxX)),
      y: Math.max(EDGE_MARGIN, Math.min(anchor.y, maxY)),
    });
  }, [anchor.x, anchor.y, available.length]);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    menuRef.current?.querySelector<HTMLElement>('[data-menu-item]')?.focus();

    return () => {
      // Returning focus matters for keyboard and screen-reader users: without it focus falls back
      // to the document and the next Tab starts from the top of the page.
      previouslyFocused.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    const closeOnOutside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };

    // `capture` on pointerdown so the menu closes before the click lands on whatever is beneath.
    document.addEventListener('pointerdown', closeOnOutside, true);
    document.addEventListener('contextmenu', closeOnOutside, true);
    document.addEventListener('keydown', closeOnKey);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);

    return () => {
      document.removeEventListener('pointerdown', closeOnOutside, true);
      document.removeEventListener('contextmenu', closeOnOutside, true);
      document.removeEventListener('keydown', closeOnKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[data-menu-item]') ?? [])];
    if (items.length === 0) return;

    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (next: number) => {
      event.preventDefault();
      items[(next + items.length) % items.length]?.focus();
    };

    if (event.key === 'ArrowDown') focusAt(index + 1);
    else if (event.key === 'ArrowUp') focusAt(index - 1);
    else if (event.key === 'Home') focusAt(0);
    else if (event.key === 'End') focusAt(items.length - 1);
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Message actions"
      onKeyDown={onMenuKeyDown}
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
  if (action === 'react') return <EmojiIcon className={className} />;
  if (action === 'forward') return <ForwardIcon className={className} />;
  if (action === 'pin') return <PinIcon className={className} />;
  return <TrashIcon className={className} />;
}
