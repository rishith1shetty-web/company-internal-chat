'use client';

import { Avatar } from '@/components/ui/Avatar';
import { SearchField } from '@/components/ui/Field';
import { CheckIcon } from '@/components/ui/icons';
import { formatPresence, hasNameCollision, userDiscriminator } from '@/lib/chat/format';
import type { UserSummary } from '@/lib/chat/types';
import { cn } from '@/lib/ui/cn';

interface UserPickerProps {
  users: UserSummary[];
  searchTerm: string;
  onSearchChange: (term: string) => void;
  selectedIds: string[];
  onToggle: (userId: string) => void;
  /** Single-select renders radio semantics; multi-select renders checkboxes. */
  mode: 'single' | 'multiple';
}

/**
 * Colleague picker used by both "New chat" and "New group".
 *
 * Every row shows a short id discriminator whenever another known user shares the same display
 * name. This is a requirement, not a nicety: names are not unique (D-02), so a name alone is
 * never enough to choose the right person.
 */
export function UserPicker({
  users,
  searchTerm,
  onSearchChange,
  selectedIds,
  onToggle,
  mode,
}: UserPickerProps) {
  const term = searchTerm.trim().toLowerCase();
  const visible =
    term.length === 0
      ? users
      : users.filter((user) => user.displayName.toLowerCase().includes(term));

  return (
    <div>
      <SearchField
        label="Search colleagues"
        placeholder="Search by name"
        value={searchTerm}
        onChange={(event) => onSearchChange(event.target.value)}
      />

      {visible.length === 0 ? (
        <p className="px-1 py-6 text-sm text-ink-subtle">
          No one matches &ldquo;{searchTerm.trim()}&rdquo;.
        </p>
      ) : (
        <ul
          className="mt-3 max-h-72 space-y-0.5 overflow-y-auto pr-1"
          role={mode === 'multiple' ? 'group' : 'radiogroup'}
          aria-label="Colleagues"
        >
          {visible.map((user) => {
            const selected = selectedIds.includes(user.id);
            const showDiscriminator = hasNameCollision(users, user);

            return (
              <li key={user.id}>
                <button
                  type="button"
                  onClick={() => onToggle(user.id)}
                  role={mode === 'multiple' ? 'checkbox' : 'radio'}
                  aria-checked={selected}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-3 rounded-control px-2 py-2 text-left',
                    'transition-[background-color,box-shadow] duration-(--duration-quick) ease-(--ease-out-soft)',
                    'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
                    selected
                      ? 'bg-accent-tint ring-1 ring-accent/20 ring-inset'
                      : 'hover:bg-surface-muted',
                  )}
                >
                  <Avatar
                    userId={user.id}
                    displayName={user.displayName}
                    size="sm"
                    presence={user.presence}
                  />

                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">
                      {user.displayName}
                      {showDiscriminator ? (
                        <span className="ml-1.5 text-xs font-normal text-ink-subtle">
                          ID {userDiscriminator(user.id)}
                        </span>
                      ) : null}
                    </span>
                    <span className="block text-xs text-ink-subtle" suppressHydrationWarning>
                      {formatPresence(user)}
                    </span>
                  </span>

                  <span
                    className={cn(
                      'flex h-5 w-5 shrink-0 items-center justify-center border',
                      'transition-colors duration-(--duration-quick)',
                      mode === 'multiple' ? 'rounded-[0.3rem]' : 'rounded-full',
                      selected
                        ? 'border-accent bg-accent text-white'
                        : 'border-line-strong bg-surface',
                    )}
                    aria-hidden="true"
                  >
                    {selected ? <CheckIcon className="h-3.5 w-3.5" /> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
