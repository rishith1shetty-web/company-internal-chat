/**
 * Conditional class-name joiner.
 *
 * Deliberately three lines rather than a dependency (`clsx`/`classnames`): the project adds a
 * package only when it earns its place (CLAUDE.md §3, docs/05-open-questions.md Part A).
 */
export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}
