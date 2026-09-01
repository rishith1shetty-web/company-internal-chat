'use client';

import { IconButton } from '@/components/ui/Button';
import { CloseIcon } from '@/components/ui/icons';
import type { ConnectionState } from '@/lib/chat/socket';

interface ConnectionNoticeProps {
  connection: ConnectionState;
  /** A specific failure worth showing, e.g. a message that could not be sent. */
  notice: string | null;
  onDismissNotice: () => void;
}

/**
 * A thin status strip under the header.
 *
 * A chat application that has quietly lost its connection is worse than one that says so: the
 * user keeps typing into what looks like a working window. This says so, in one line, and takes
 * no space at all while everything is working (CLAUDE.md §12, "clear success/error feedback").
 *
 * `connecting` is deliberately silent. The socket connects in a fraction of a second on a LAN,
 * and a banner that flashes on every page load is noise rather than information.
 */
export function ConnectionNotice({ connection, notice, onDismissNotice }: ConnectionNoticeProps) {
  if (notice) {
    return (
      <div
        role="status"
        className="flex shrink-0 items-center gap-2 border-b border-danger/20 bg-danger-tint px-3 py-2 sm:px-4"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" aria-hidden="true" />
        <p className="min-w-0 flex-1 truncate text-xs font-medium text-danger">{notice}</p>
        <IconButton label="Dismiss this message" onClick={onDismissNotice}>
          <CloseIcon className="h-4 w-4" />
        </IconButton>
      </div>
    );
  }

  if (connection === 'online' || connection === 'connecting') return null;

  return (
    <p
      role="status"
      className="flex shrink-0 items-center gap-2 border-b border-notice/20 bg-notice-tint px-3 py-2 text-xs font-medium text-notice sm:px-4"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-notice" aria-hidden="true" />
      {connection === 'reconnecting'
        ? 'Reconnecting… messages you send now may not go through until the connection returns.'
        : 'Disconnected. Reload the page to reconnect.'}
    </p>
  );
}
