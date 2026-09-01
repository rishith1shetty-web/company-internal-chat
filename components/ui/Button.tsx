import type { ButtonHTMLAttributes } from 'react';

import { cn } from '@/lib/ui/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
}

/**
 * Shared by every variant and by `IconButton`, so a control cannot drift by being styled in a
 * component instead of here.
 *
 * `active:translate-y-px` is the whole press animation: one pixel, on the button itself, ending
 * the moment the pointer lifts. It reads as the control being pushed rather than as something
 * moving on the page, and because it is a transform it costs no layout.
 */
const BASE_STYLES =
  'inline-flex cursor-pointer items-center justify-center gap-2 rounded-control font-medium ' +
  'whitespace-nowrap transition-[background-color,border-color,color,box-shadow,transform] ' +
  'duration-(--duration-quick) ease-(--ease-out-soft) ' +
  'active:translate-y-px ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ' +
  'disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none disabled:active:translate-y-0';

const VARIANT_STYLES: Record<ButtonVariant, string> = {
  /*
   * The one filled control on any given screen. The gold underlay is a 1px inset highlight along
   * the top edge — the detail that separates a button that looks printed on from one that looks
   * made of something. It is `inset-shadow`, so it costs no extra element.
   */
  primary:
    'bg-accent text-white shadow-subtle inset-shadow-[0_1px_0_0_rgb(255_255_255/0.18)] ' +
    'hover:bg-accent-hover hover:shadow-card active:shadow-subtle',
  secondary:
    'bg-surface text-ink-muted ring-1 ring-inset ring-line-strong shadow-subtle ' +
    'hover:bg-surface-muted hover:text-ink hover:ring-accent/35 active:bg-canvas',
  ghost: 'bg-transparent text-ink-muted hover:bg-canvas-deep hover:text-ink',
  danger:
    'bg-surface text-danger ring-1 ring-inset ring-danger/35 shadow-subtle ' +
    'hover:bg-danger-tint hover:ring-danger/55 focus-visible:outline-danger',
};

const SIZE_STYLES: Record<ButtonSize, string> = {
  sm: 'h-9 px-3.5 text-sm',
  md: 'h-10 px-4 text-sm',
};

/** The single button style for the application, so no two controls drift apart (CLAUDE.md §12). */
export function Button({
  variant = 'secondary',
  size = 'md',
  fullWidth = false,
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        BASE_STYLES,
        VARIANT_STYLES[variant],
        SIZE_STYLES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...props}
    />
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon-only control still needs an accessible name (A-04). */
  label: string;
}

/**
 * Icon-only control.
 *
 * 40x40 rather than the 24px glyph it contains, so the target clears the 44px guidance on touch
 * and the 24px minimum everywhere — the icon is small, the thing you press is not.
 */
export function IconButton({ label, className, type = 'button', ...props }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-control text-ink-muted',
        'transition-[background-color,color,transform] duration-(--duration-quick) ease-(--ease-out-soft)',
        'hover:bg-canvas-deep hover:text-ink active:translate-y-px',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0',
        className,
      )}
      {...props}
    />
  );
}
