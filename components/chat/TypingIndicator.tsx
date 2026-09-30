import { formatTypingText } from '@/lib/chat/typing';

interface TypingIndicatorProps {
  /** Display names of the colleagues typing here, current user already excluded. */
  names: readonly string[];
}

/**
 * "Rahul is typing…" above the composer (Batch 1.8).
 *
 * ALWAYS RENDERED, at a fixed height, whether or not anybody is typing. A row that appeared and
 * disappeared would push the message list up and down every time a colleague paused — exactly the
 * layout jump this must not cause. It sits between the list and the composer rather than over the
 * list, so it can never cover the newest message.
 *
 * Announced politely to screen readers, and deliberately without animation (CLAUDE.md §12).
 */
export function TypingIndicator({ names }: TypingIndicatorProps) {
  const text = formatTypingText(names);

  return (
    <div className="shrink-0 bg-canvas px-3 sm:px-6">
      <p
        role="status"
        aria-live="polite"
        className="mx-auto h-6 max-w-3xl truncate text-xs leading-6 text-ink-subtle"
      >
        {text ?? ''}
      </p>
    </div>
  );
}
