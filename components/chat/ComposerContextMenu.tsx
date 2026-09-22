'use client';

import { PasteIcon } from '@/components/ui/icons';
import { cn } from '@/lib/ui/cn';
import { useAnchoredMenu } from '@/lib/ui/useAnchoredMenu';

interface ComposerContextMenuProps {
  /** Where the pointer was, in viewport coordinates. */
  anchor: { x: number; y: number };
  /**
   * What happens on Paste, or null when this browser will not let the page read the clipboard.
   *
   * Null is the desktop client's case: the session refuses every permission, so
   * `navigator.clipboard.readText` is denied (lib/chat/clipboard.ts). The row is then shown
   * DISABLED with the keyboard shortcut beside it rather than hidden, because the employee still
   * has a way to paste and the menu is the natural place to learn what it is.
   */
  onPasteSelected: (() => void) | null;
  onClose(): void;
}

/**
 * The right-click menu inside the message composer (Batch 1.2).
 *
 * WHY IT EXISTS. Chromium shows its own Cut/Copy/Paste menu on a text field, so in a browser
 * right-clicking the composer already works. Electron shows nothing at all — it implements no
 * default context menu for web content — so inside the desktop client, which is what employees
 * use, a right-click in the composer does nothing whatsoever. This is that missing menu.
 *
 * SO IT IS NOW RENDERED ONLY IN THE DESKTOP CLIENT (Batch 1.5). That was always the case it was
 * written for; until Batch 1.5 it was also shown in browsers, where it replaced a native menu
 * that was strictly better — one that carries spelling suggestions as well as Paste. The composer
 * decides, via `shouldUseCustomComposerMenu`; nothing in this file changed.
 *
 * Deliberately one item. Cut and Copy inside a textarea are already served by the keyboard and by
 * the browser's own menu where there is one, and a menu that lists three things to make itself
 * look complete is a menu with two rows nobody presses. Paste is the one that is genuinely
 * missing, and it is the one the employee asked for.
 *
 * Placement, dismissal, focus handling and keyboard navigation are the shared `useAnchoredMenu`
 * behaviour — the same code the message menu uses, so the two cannot drift apart and cannot both
 * be open at once.
 *
 * Styled from the same tokens as the message menu rather than copying any particular product's
 * chrome.
 */
export function ComposerContextMenu({
  anchor,
  onPasteSelected,
  onClose,
}: ComposerContextMenuProps) {
  const { menuRef, position, onKeyDown } = useAnchoredMenu(anchor, onClose, 1);
  const enabled = onPasteSelected !== null;

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Composer actions"
      onKeyDown={onKeyDown}
      className={cn(
        'fixed z-50 min-w-44 overflow-hidden rounded-xl border border-line bg-surface py-1',
        'shadow-lg ring-1 ring-black/5',
      )}
      style={{ left: position.x, top: position.y }}
    >
      <button
        type="button"
        data-menu-item
        role="menuitem"
        disabled={!enabled}
        aria-disabled={!enabled}
        title={
          enabled ? undefined : 'This application cannot read the clipboard. Use Ctrl+V to paste.'
        }
        onClick={() => {
          onPasteSelected?.();
          onClose();
        }}
        className={cn(
          'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm',
          'transition-colors duration-(--duration-quick)',
          'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
          enabled
            ? 'text-ink hover:bg-surface-muted'
            : 'cursor-not-allowed text-ink-subtle opacity-60',
        )}
      >
        <PasteIcon className="h-4 w-4 shrink-0 opacity-70" />
        <span className="flex-1">Paste</span>
        {/*
          The shortcut is shown always, not only when the row is disabled: it is the faster way
          even when the menu works, and it is the ONLY way in the desktop client.
        */}
        <kbd className="font-sans text-[11px] text-ink-subtle">Ctrl+V</kbd>
      </button>
    </div>
  );
}
