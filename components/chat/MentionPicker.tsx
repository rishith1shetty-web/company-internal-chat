'use client';

import { Avatar, GroupAvatar } from '@/components/ui/Avatar';
import { GroupIcon } from '@/components/ui/icons';
import {
  MENTION_EVERYONE_DESCRIPTION,
  type MentionCandidate,
} from '@/lib/chat/mentions';
import { cn } from '@/lib/ui/cn';

interface MentionPickerProps {
  candidates: MentionCandidate[];
  /** Index into `candidates`. The composer owns it, because the arrow keys arrive there. */
  activeIndex: number;
  onSelect: (candidate: MentionCandidate) => void;
  onHoverIndex: (index: number) => void;
  /** Ties the textarea's `aria-controls` and `aria-activedescendant` to this list. */
  listId: string;
  optionId: (index: number) => string;
}

/**
 * The @-mention suggestions, above the composer (Batch 1.7).
 *
 * A LISTBOX, NOT A MENU, and the distinction is doing real work. The employee's focus never
 * leaves the textarea — they are still typing a message — so this cannot be a set of buttons that
 * take focus. It is a `listbox` the textarea OWNS: the textarea is the `combobox`, it keeps
 * focus, and `aria-activedescendant` names whichever option is current. That is the pattern a
 * screen reader already understands for "typing in a field with suggestions attached", and it is
 * why the arrow keys are handled by the composer rather than here.
 *
 * So the rows below are `<div role="option">` rather than `<button>` — deliberately, and against
 * the instinct this codebase otherwise follows. A button would be focusable, and focusing it
 * would take the caret out of the message being written.
 *
 * Mouse and keyboard drive the SAME `activeIndex`: hovering moves it, so there is never a hover
 * highlight and a keyboard highlight arguing about which row Enter will choose.
 */
export function MentionPicker({
  candidates,
  activeIndex,
  onSelect,
  onHoverIndex,
  listId,
  optionId,
}: MentionPickerProps) {
  if (candidates.length === 0) return null;

  return (
    <ul
      id={listId}
      role="listbox"
      aria-label="Mention someone in this group"
      className={cn(
        'absolute bottom-full left-0 z-40 mb-2 max-h-60 w-72 overflow-y-auto',
        'rounded-xl border border-line bg-surface py-1 shadow-lg ring-1 ring-black/5',
      )}
    >
      {candidates.map((candidate, index) => {
        const active = index === activeIndex;
        const everyone = candidate.kind === 'EVERYONE';

        return (
          <li
            key={candidate.userId ?? `everyone:${candidate.label}`}
            id={optionId(index)}
            role="option"
            aria-selected={active}
            /*
             * `onMouseDown` with `preventDefault`, not `onClick`. A click would first blur the
             * textarea, and the insertion needs the caret position that blur discards — this also
             * keeps the field focused so typing continues straight afterwards.
             */
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(candidate);
            }}
            onMouseEnter={() => onHoverIndex(index)}
            className={cn(
              'flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm',
              'transition-colors duration-(--duration-quick)',
              active ? 'bg-accent/12 text-ink' : 'text-ink',
            )}
          >
            {everyone ? (
              <GroupAvatar size="sm">
                <GroupIcon className="h-4 w-4" />
              </GroupAvatar>
            ) : (
              <Avatar
                userId={candidate.userId ?? ''}
                displayName={candidate.label}
                size="sm"
              />
            )}

            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">
                {everyone ? 'Everyone' : candidate.label}
              </span>
              {/*
                The one row that needs explaining gets explained, on screen and to a screen
                reader alike — "@everyone" beside a group icon is not self-evidently "notify all
                twelve people in here".
              */}
              {everyone ? (
                <span className="block truncate text-xs text-ink-subtle">
                  {candidate.description ?? MENTION_EVERYONE_DESCRIPTION}
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
