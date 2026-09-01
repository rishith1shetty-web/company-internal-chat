'use client';

import { useState } from 'react';

import { UserPicker } from '@/components/chat/UserPicker';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import type { UserSummary } from '@/lib/chat/types';
import { MAX_GROUP_NAME_LENGTH } from '@/lib/chat/types';

interface NewChatDialogProps {
  users: UserSummary[];
  onClose: () => void;
  onStart: (userId: string) => void;
  /** Widens the search beyond the colleagues already loaded, by asking the server. */
  onSearch?: (term: string) => void;
}

/**
 * Start a one-to-one conversation with a colleague.
 *
 * The list is keyed on user ids. Two colleagues may share a display name (D-02), and the picker
 * shows an id-derived discriminator so they can be told apart — choosing "Sarah Chen" is never
 * ambiguous, because what is submitted is an id, not the name that was matched.
 */
export function NewChatDialog({ users, onClose, onStart, onSearch }: NewChatDialogProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const confirm = () => {
    if (!selectedId) return;
    onStart(selectedId);
    onClose();
  };

  return (
    <Modal
      open
      title="New chat"
      description="Choose a colleague to start a private conversation with."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={confirm} disabled={!selectedId}>
            Start chat
          </Button>
        </>
      }
    >
      <UserPicker
        users={users}
        searchTerm={search}
        onSearchChange={(term) => {
          setSearch(term);
          onSearch?.(term);
        }}
        selectedIds={selectedId ? [selectedId] : []}
        onToggle={(userId) => setSelectedId((current) => (current === userId ? null : userId))}
        mode="single"
      />
    </Modal>
  );
}

interface NewGroupDialogProps {
  users: UserSummary[];
  onClose: () => void;
  onCreate: (name: string, memberIds: string[]) => void;
}

/**
 * Create a group conversation: a name and at least one other member.
 *
 * What is submitted is a name and a list of user IDS. The creator is not in that list and could
 * not be: the server takes them from the session, makes them a member, and makes them the owner
 * (D-02 — a display name identifies nobody, and this form never sends one).
 */
export function NewGroupDialog({ users, onClose, onCreate }: NewGroupDialogProps) {
  const [name, setName] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  const toggleMember = (userId: string) => {
    setMemberIds((current) =>
      current.includes(userId)
        ? current.filter((item) => item !== userId)
        : [...current, userId],
    );
  };

  const confirm = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError('Give the group a name so members can recognise it.');
      return;
    }
    if (memberIds.length === 0) {
      setError('Add at least one other member.');
      return;
    }

    onCreate(trimmed, memberIds);
    onClose();
  };

  return (
    <Modal
      open
      title="New group"
      description="Name the group and choose who to add. You become its owner."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={confirm}>
            Create group
          </Button>
        </>
      }
    >
      <TextField
        label="Group name"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          setError(null);
        }}
        maxLength={MAX_GROUP_NAME_LENGTH}
        placeholder="e.g. Operations Team"
        autoComplete="off"
        error={error && name.trim().length === 0 ? error : undefined}
      />

      <p className="mt-5 mb-2 text-sm font-medium text-ink-muted">
        Members
        {memberIds.length > 0 ? (
          <span className="ml-1.5 font-normal text-ink-subtle">
            · {memberIds.length} selected
          </span>
        ) : null}
      </p>

      <UserPicker
        users={users}
        searchTerm={search}
        onSearchChange={setSearch}
        selectedIds={memberIds}
        onToggle={toggleMember}
        mode="multiple"
      />

      {error && name.trim().length > 0 ? (
        <p className="mt-3 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      {/*
        D-03: a member added to a group sees only what is sent after they join. Saying so at the
        point of creation is cheaper than explaining missing history afterwards.
      */}
      <p className="mt-4 border-t border-line pt-3 text-xs text-ink-subtle">
        Members you add later will see messages from the moment they join, not the conversation
        that came before.
      </p>
    </Modal>
  );
}

interface AddMembersDialogProps {
  groupName: string;
  /** Colleagues who are not already in the group. Computed by the caller from the member list. */
  candidates: UserSummary[];
  onClose: () => void;
  onAdd: (userIds: string[]) => void;
  onSearch?: (term: string) => void;
}

/**
 * Add colleagues to an existing group.
 *
 * Only people who are not already members are offered, so "add" cannot become an accidental
 * re-add — which would reset a working member's join time and hide history they can currently
 * read. The server skips a duplicate anyway; this stops it being asked for.
 *
 * The note at the bottom is not decoration. D-03 means the people chosen here will open the group
 * and find it empty of everything said before this moment, and the person adding them is the only
 * one in a position to know that beforehand.
 */
export function AddMembersDialog({
  groupName,
  candidates,
  onClose,
  onAdd,
  onSearch,
}: AddMembersDialogProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');

  const toggle = (userId: string) => {
    setSelectedIds((current) =>
      current.includes(userId) ? current.filter((item) => item !== userId) : [...current, userId],
    );
  };

  const confirm = () => {
    if (selectedIds.length === 0) return;
    onAdd(selectedIds);
    onClose();
  };

  return (
    <Modal
      open
      title="Add people to the group"
      description={groupName}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={confirm} disabled={selectedIds.length === 0}>
            {selectedIds.length > 1 ? `Add ${selectedIds.length} people` : 'Add to group'}
          </Button>
        </>
      }
    >
      {candidates.length === 0 ? (
        <p className="py-4 text-sm text-ink-muted">
          Everyone in your colleague list is already in this group.
        </p>
      ) : (
        <UserPicker
          users={candidates}
          searchTerm={search}
          onSearchChange={(term) => {
            setSearch(term);
            onSearch?.(term);
          }}
          selectedIds={selectedIds}
          onToggle={toggle}
          mode="multiple"
        />
      )}

      <p className="mt-4 border-t border-line pt-3 text-xs text-ink-subtle">
        People you add see messages from the moment they join. The conversation that came before
        stays private to the members who were already here — it is not shown to them, and it is
        not deleted.
      </p>
    </Modal>
  );
}

export interface PendingMemberRemoval {
  conversationId: string;
  userId: string;
  displayName: string;
  groupName: string;
  /** True when the user is removing themselves — leaving rather than removing. */
  isSelf: boolean;
}

/**
 * Confirmation for removing somebody from a group, and for leaving one.
 *
 * Both need asking about, and for the same reason: the consequence is not the removal, it is what
 * happens if the person comes back. Re-joining starts a fresh window under D-03, so the part of
 * the conversation they can read today is not the part they would be able to read afterwards.
 * That is invisible at the moment of clicking and impossible to undo after it.
 */
export function RemoveMemberDialog({
  pending,
  busy,
  onCancel,
  onConfirm,
}: {
  pending: PendingMemberRemoval | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const leaving = pending?.isSelf ?? false;

  return (
    <Modal
      open={pending !== null}
      title={leaving ? 'Leave this group?' : 'Remove this person from the group?'}
      description={pending?.groupName}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : leaving ? 'Leave group' : 'Remove'}
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink-muted">
        {leaving ? (
          <>
            You will stop receiving messages from this group, and it will disappear from your
            conversation list.
          </>
        ) : (
          <>
            <span className="font-medium text-ink">{pending?.displayName}</span> will stop
            receiving messages from this group, and it will disappear from their conversation
            list.
          </>
        )}
      </p>

      <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-ink-muted">
        <li>Nothing is deleted. Messages already sent stay in the group.</li>
        <li>
          {leaving ? 'Messages you have' : 'Messages they have'} sent remain in the conversation
          for everyone else.
        </li>
        <li>
          If {leaving ? 'you are' : 'they are'} added again later,{' '}
          {leaving ? 'you' : 'they'} will see the group from that moment onwards —{' '}
          <span className="font-medium text-ink">
            not the history {leaving ? 'you' : 'they'} can read now
          </span>
          .
        </li>
      </ul>
    </Modal>
  );
}
