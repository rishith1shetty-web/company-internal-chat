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
}

/** Start a one-to-one conversation with a colleague. */
export function NewChatDialog({ users, onClose, onStart }: NewChatDialogProps) {
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
        onSearchChange={setSearch}
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

/** Create a group conversation: a name and at least one other member. */
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
