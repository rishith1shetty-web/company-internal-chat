'use client';

import { useId } from 'react';
import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

import { SearchIcon } from '@/components/ui/icons';
import { cn } from '@/lib/ui/cn';

/**
 * One control surface for every input in the application.
 *
 * The focus treatment is a colour change plus a soft accent halo rather than the browser's
 * default outline: it reads as the field waking up, and because the ring is drawn outside the
 * border it never moves the text inside by a pixel.
 */
const CONTROL_STYLES =
  'block w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-sm text-ink ' +
  'shadow-subtle transition-[border-color,box-shadow] duration-(--duration-quick) ease-(--ease-out-soft) ' +
  'placeholder:text-ink-subtle hover:border-line-strong/80 ' +
  'focus:border-accent focus:ring-4 focus:ring-accent/12 focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-subtle';

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  hint?: string;
  error?: string;
}

/** Labelled text input. Every control in the application is labelled, not placeholder-only (A-04). */
export function TextField({ label, hint, error, className, ...props }: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <div className={className}>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={id}
        aria-describedby={cn(hint && hintId, error && errorId) || undefined}
        aria-invalid={error ? true : undefined}
        className={cn(
          'mt-1.5',
          CONTROL_STYLES,
          error && 'border-danger focus:border-danger focus:ring-danger/12',
        )}
        {...props}
      />
      {hint && !error ? (
        <p id={hintId} className="mt-1.5 text-xs text-ink-subtle">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="mt-1.5 text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'> {
  label: string;
}

/** Search input with a visually hidden label — the icon alone is not an accessible name. */
export function SearchField({ label, className, ...props }: SearchFieldProps) {
  const id = useId();
  return (
    <div className={cn('group relative', className)}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <SearchIcon
        className={cn(
          'pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-subtle',
          'transition-colors duration-(--duration-quick) group-focus-within:text-accent',
        )}
      />
      <input
        id={id}
        type="search"
        className={cn(CONTROL_STYLES, 'h-10 bg-surface-muted pl-9 focus:bg-surface')}
        {...props}
      />
    </div>
  );
}

interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  label: string;
}

export function TextArea({ label, className, ...props }: TextAreaProps) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <textarea id={id} className={cn(CONTROL_STYLES, className)} {...props} />
    </div>
  );
}
