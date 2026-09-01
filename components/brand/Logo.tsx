import Image from 'next/image';

import lockup from '@/public/brand/rising-path-lockup.png';
import mark from '@/public/brand/rising-path-mark.png';
import { cn } from '@/lib/ui/cn';

/**
 * The company logo.
 *
 * THE ASSET IS THE REAL ONE. `public/brand/rising-path-recruiters.png` is the file supplied by
 * the company, byte for byte. The two files used here are crops of it and nothing else —
 * `-lockup` is that image with its surrounding whitespace removed, `-mark` is the sun-and-path
 * symbol on its own, squared with transparent padding. Nothing is redrawn, recoloured or
 * approximated, and no vector imitation of it exists in this codebase.
 *
 * Both are imported statically, so Next knows their intrinsic dimensions at build time and the
 * browser reserves the right box before the bytes arrive — a logo in the header is the one image
 * on the page guaranteed to be above the fold, and it must not shift the layout when it loads.
 *
 * Kept in one component so the logo appears in a handful of deliberate places rather than being
 * pasted around the interface. Where it goes is listed in docs/15-brand-refresh.md §3.
 */

interface BrandMarkProps {
  /** Rendered pixel size of the square. */
  size?: number;
  className?: string;
  /**
   * Set when the mark is the only thing identifying the company — otherwise it sits beside the
   * name in text and is decorative, and a screen reader should not read the brand twice.
   */
  title?: string;
  priority?: boolean;
}

/** The sun-and-path symbol alone. For headers and other places too small for the wordmark. */
export function BrandMark({ size = 32, className, title, priority = false }: BrandMarkProps) {
  return (
    <Image
      src={mark}
      alt={title ?? ''}
      aria-hidden={title ? undefined : 'true'}
      width={size}
      height={size}
      priority={priority}
      className={cn('shrink-0 select-none', className)}
    />
  );
}

interface BrandLockupProps {
  /** Rendered width in pixels; the height follows the asset's own proportions. */
  width?: number;
  className?: string;
  priority?: boolean;
}

/**
 * The full logo — symbol and wordmark. For sign-in, setup and the unassigned-computer screen,
 * where identifying the company is the point rather than an accompaniment.
 */
export function BrandLockup({ width = 220, className, priority = false }: BrandLockupProps) {
  return (
    <Image
      src={lockup}
      alt="Rising Path Recruiters"
      width={width}
      height={Math.round((width * lockup.height) / lockup.width)}
      priority={priority}
      className={cn('select-none', className)}
    />
  );
}

/**
 * Mark plus product name, as it appears in the application header and on the standalone screens.
 *
 * The mark is decorative here by design: the company name is beside it as real text, so marking
 * the image up as well would have a screen reader announce the brand twice.
 */
export function BrandLockupInline({
  subtitle,
  size = 'md',
  className,
}: {
  subtitle?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const markSize = size === 'lg' ? 44 : size === 'sm' ? 28 : 34;

  return (
    <div className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <span
        className={cn(
          'flex shrink-0 items-center justify-center rounded-card bg-white ring-1 ring-line',
          'shadow-subtle',
          size === 'lg' ? 'h-12 w-12' : size === 'sm' ? 'h-8 w-8' : 'h-10 w-10',
        )}
      >
        <BrandMark size={markSize} priority />
      </span>
      <div className="min-w-0">
        <p
          className={cn(
            'truncate font-semibold tracking-tight text-ink',
            size === 'lg' ? 'text-lg' : 'text-sm',
          )}
        >
          Rising Path Recruiters
        </p>
        {subtitle ? (
          <p
            className={cn(
              'truncate text-ink-subtle',
              size === 'lg' ? 'text-sm' : 'text-xs',
            )}
          >
            {subtitle}
          </p>
        ) : null}
      </div>
    </div>
  );
}
