'use client';

import { ChevronRightIcon } from '@/components/ui/icons';
import { UnreadBadge } from '@/components/ui/Avatar';
import type { SidebarSection } from '@/lib/chat/sidebar-sections';
import { cn } from '@/lib/ui/cn';

interface ConversationSectionProps {
  section: SidebarSection;
  open: boolean;
  /** Null when the section is open for a reason the employee did not choose. See below. */
  overriddenReason: 'search' | 'selection' | null;
  onToggle: () => void;
  children: React.ReactNode;
}

/**
 * One collapsible sidebar section: GROUPS or CHATS (Batch 1.4).
 *
 * THE WHOLE HEADER IS THE BUTTON, not the chevron. A 16-pixel arrow is a target you have to aim
 * at, and the row beside it looks clickable anyway — so it is.
 *
 * WHAT A COLLAPSED HEADER STILL SAYS. The unread total moves onto the header when the section
 * closes, and only then: open, the rows carry their own badges and a second copy on the header
 * would be the same fact stated twice. Closed, it is the only thing left that can say something
 * happened in here. Collapsing is a presentation choice and must never be a way to miss a
 * message — notifications, sounds and unread counts are untouched by it.
 *
 * The count is also folded into the accessible name rather than left as a bare number, so the
 * control announces "Groups, 4 unread, collapsed" instead of "Groups 4".
 */
export function ConversationSection({
  section,
  open,
  overriddenReason,
  onToggle,
  children,
}: ConversationSectionProps) {
  const headingId = `sidebar-section-${section.key}`;
  const regionId = `sidebar-section-${section.key}-list`;
  const unread = section.unreadCount;

  return (
    <section aria-labelledby={headingId} className="mb-1 last:mb-0">
      <h3 className="px-0.5">
        <button
          type="button"
          id={headingId}
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={regionId}
          /*
           * `onClick` alone is enough for the keyboard: a real <button> is activated by both
           * Enter and Space, and reimplementing that with onKeyDown is how the two paths drift
           * apart. What IS added is the focus ring, which matches the conversation rows below.
           */
          className={cn(
            'flex w-full cursor-pointer items-center gap-1.5 rounded-card px-2 py-1.5 text-left',
            'transition-colors duration-(--duration-quick) ease-(--ease-out-soft)',
            'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
            'hover:bg-surface-muted active:bg-canvas-deep',
          )}
        >
          <ChevronRightIcon
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-ink-subtle',
              'transition-transform duration-(--duration-quick) ease-(--ease-out-soft)',
              // Right when closed, down when open. One glyph, two positions.
              open && 'rotate-90',
            )}
          />

          <span className="min-w-0 flex-1 truncate text-xs font-semibold tracking-wider text-ink-subtle uppercase">
            {section.label}
          </span>

          {/*
            Two things a sighted employee reads at a glance, and a screen reader is told in words.
            The count only appears while closed; `overriddenReason` explains an open section the
            employee did not open themselves, so a collapse that appears not to have worked is
            accounted for rather than looking broken.
          */}
          <span className="sr-only">
            {unread > 0 ? `, ${unread} unread` : ''}
            {open ? '' : ', collapsed'}
            {overriddenReason === 'search' ? ', expanded to show search results' : ''}
            {overriddenReason === 'selection' ? ', expanded to show the open conversation' : ''}
          </span>

          {!open && unread > 0 ? (
            <span aria-hidden="true" className="shrink-0">
              <UnreadBadge count={unread} />
            </span>
          ) : null}

          {/* The row count, once open, where it is a quiet orientation cue rather than an alert. */}
          {open && section.entries.length > 0 ? (
            <span aria-hidden="true" className="shrink-0 text-[11px] tabular-nums text-ink-subtle">
              {section.entries.length}
            </span>
          ) : null}
        </button>
      </h3>

      {/*
        The list is unmounted when closed rather than hidden with CSS. A hidden subtree is still
        in the accessibility tree's reading order in some combinations, and the empty-state text
        beneath must not be announced for a section nobody has opened.
      */}
      <div id={regionId} hidden={!open}>
        {open ? <div className="mt-0.5">{children}</div> : null}
      </div>
    </section>
  );
}
