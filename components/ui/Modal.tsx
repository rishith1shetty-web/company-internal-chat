'use client';

import { useEffect, useId, useRef } from 'react';

import { IconButton } from '@/components/ui/Button';
import { CloseIcon } from '@/components/ui/icons';

interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Action buttons, right-aligned in the footer. */
  footer?: React.ReactNode;
}

/**
 * Accessible dialog: Escape to dismiss, backdrop click to dismiss, focus moved into the dialog
 * on open and returned to the trigger on close, and Tab kept inside while it is open (A-04).
 *
 * Written rather than pulled from a component library because the interface needs one dialog
 * pattern; a headless UI dependency would be added for a single use (CLAUDE.md §3).
 */
export function Modal({ open, title, description, onClose, children, footer }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    // Land on the first field the user has to fill in; fall back to whatever is focusable when
    // the dialog has no form of its own.
    const focusTarget =
      dialog?.querySelector<HTMLElement>('input:not([type="search"]), textarea, select') ??
      focusableElements(dialog)[0];
    focusTarget?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusable = focusableElements(dialogRef.current);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/*
        The backdrop is blurred as well as darkened. That is the convention for "the thing behind
        this is not available right now" (Apple HIG), and it stops a busy conversation competing
        for attention with the dialog sitting on top of it.
      */}
      <div
        className="absolute inset-0 animate-backdrop-in bg-ink/45 backdrop-blur-[2px]"
        onClick={onClose}
        role="presentation"
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={
          'relative flex max-h-[90vh] w-full max-w-lg animate-dialog-in flex-col ' +
          'rounded-panel border border-line bg-surface shadow-overlay'
        }
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold tracking-tight text-ink">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-1 text-sm break-words text-ink-muted">
                {description}
              </p>
            ) : null}
          </div>
          <IconButton label="Close dialog" onClick={onClose} className="-mt-1 -mr-1 shrink-0">
            <CloseIcon />
          </IconButton>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer ? (
          <div className="flex justify-end gap-2 rounded-b-panel border-t border-line bg-surface-muted px-5 py-3.5">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return [
    ...container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ];
}
