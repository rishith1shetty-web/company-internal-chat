'use client';

import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { AttachmentIcon, FileIcon, LockIcon } from '@/components/ui/icons';
import { userDiscriminator } from '@/lib/chat/format';
import type { UserSummary } from '@/lib/chat/types';

/**
 * File attachment placeholder.
 *
 * The control exists in the composer from Phase 2 so the layout is settled, but no file is
 * selected, read, uploaded or stored — file transfer is Phase 7. The dialog states the rules
 * the feature will be built to (size ceiling, type allowlist, download-only) rather than
 * pretending to do something.
 */
export function AttachmentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      title="File transfer arrives in a later phase"
      description="The attachment control is in place, but uploads are not implemented yet."
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <p className="text-sm text-ink-muted">
        When file transfer is implemented, sending a file from this conversation will work like
        this:
      </p>

      <ul className="mt-3 space-y-2.5 text-sm text-ink-muted">
        <PlannedItem icon={<AttachmentIcon className="h-4 w-4" />}>
          Common business formats are accepted — PDF, Word, Excel, PowerPoint, images, text and
          ZIP — checked against both the file extension and the actual file contents.
        </PlannedItem>
        <PlannedItem icon={<FileIcon className="h-4 w-4" />}>
          Files up to the configured size limit, with upload progress shown and a clear message if
          an upload fails.
        </PlannedItem>
        <PlannedItem icon={<LockIcon className="h-4 w-4" />}>
          Files are stored on company storage and downloaded through the application, which checks
          that you are a member of the conversation first. Files are download-only — nothing
          uploaded is ever opened inside this page.
        </PlannedItem>
      </ul>
    </Modal>
  );
}

function PlannedItem({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-0.5 shrink-0 text-ink-subtle">{icon}</span>
      <span>{children}</span>
    </li>
  );
}

/**
 * "Switch User / Clear Device Identity" confirmation (F-19).
 *
 * The wording is deliberate about what this control is for — a shared or hot-desk computer —
 * and about the consequence: the next person becomes a separate user and does not inherit this
 * one's conversations.
 */
export function SwitchUserDialog({
  open,
  currentUser,
  onClose,
  onConfirm,
}: {
  open: boolean;
  currentUser: UserSummary;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={open}
      title="Switch user on this computer?"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm}>
            Switch user
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink-muted">
        You are currently signed in as{' '}
        <span className="font-medium text-ink">{currentUser.displayName}</span> (ID{' '}
        {userDiscriminator(currentUser.id)}). Switching returns this browser to the name screen so
        the next person can enter their own name.
      </p>

      <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-ink-muted">
        <li>The next person becomes a separate user with their own conversations.</li>
        <li>Your conversation history is not deleted — it stays with your identity.</li>
        <li>Use this whenever someone else takes over a shared computer.</li>
      </ul>

      <p className="mt-4 rounded-md bg-surface-muted px-3 py-2 text-xs text-ink-subtle">
        In this preview nothing is stored, so switching simply clears the screen. In the finished
        system this also revokes the session and the device identity on the server, not only in
        this browser.
      </p>
    </Modal>
  );
}

/**
 * Settings.
 *
 * There are no preferences to change yet, and inventing switches that do nothing would be worse
 * than an honest empty state (CLAUDE.md §12). What it does provide is the account information a
 * user may actually need — which identity they are using — and the switch-user route.
 */
export function SettingsDialog({
  open,
  currentUser,
  onClose,
  onSwitchUser,
}: {
  open: boolean;
  currentUser: UserSummary;
  onClose: () => void;
  onSwitchUser: () => void;
}) {
  return (
    <Modal
      open={open}
      title="Settings"
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <dl className="divide-y divide-line text-sm">
        <SettingRow label="Display name">{currentUser.displayName}</SettingRow>
        <SettingRow label="Your ID">{userDiscriminator(currentUser.id)}</SettingRow>
        <SettingRow label="Sign-in">No password — display name only</SettingRow>
        <SettingRow label="Availability">
          Everyone on the company network who can reach this application
        </SettingRow>
      </dl>

      <div className="mt-5 rounded-md border border-line bg-surface-muted p-3">
        <p className="text-sm font-medium text-ink">Shared computer?</p>
        <p className="mt-1 text-sm text-ink-muted">
          Switch user before someone else takes over, so their messages are not sent under your
          name.
        </p>
        <Button
          size="sm"
          className="mt-3"
          onClick={() => {
            onClose();
            onSwitchUser();
          }}
        >
          Switch user / clear device identity
        </Button>
      </div>

      <p className="mt-4 text-xs text-ink-subtle">
        Notification, appearance and message preferences are not part of this phase and are not
        shown here rather than being shown as controls that do nothing.
      </p>
    </Modal>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-2.5">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right font-medium text-ink">{children}</dd>
    </div>
  );
}
