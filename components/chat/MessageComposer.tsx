'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  ClipboardEvent as ReactClipboardEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';

import { ComposerContextMenu } from '@/components/chat/ComposerContextMenu';
import { MentionPicker } from '@/components/chat/MentionPicker';

import { Button, IconButton } from '@/components/ui/Button';
import {
  AttachmentIcon,
  CheckIcon,
  CloseIcon,
  EditIcon,
  FileIcon,
  ReplyIcon,
  SendIcon,
} from '@/components/ui/icons';
import { canReadClipboard, pasteIntoComposer } from '@/lib/chat/clipboard';
import { COMPOSER_SPELLCHECK, shouldUseCustomComposerMenu } from '@/lib/chat/composer-menu';
import {
  createDraftAutosave,
  holdDraftForSend,
  openDraft,
  saveDraft,
  type DraftAutosave,
} from '@/lib/chat/drafts';
import {
  applyMention,
  filterMentionCandidates,
  findMentionTrigger,
  resolveMentions,
  type ConfirmedMention,
  type MentionCandidate,
  type MentionPayload,
  type MentionTrigger,
} from '@/lib/chat/mentions';
import { formatFileSize } from '@/lib/chat/format';
import { imageFromClipboard, pastedImageFile } from '@/lib/chat/paste-image';
import { createTypingSignal, type TypingSignal } from '@/lib/chat/typing';
import type { ChatMessage, UserSummary } from '@/lib/chat/types';
import { MAX_MESSAGE_LENGTH } from '@/lib/chat/types';

interface MessageComposerProps {
  /**
   * The conversation this composer writes to. Keys its saved draft (Batch 1.9) — the stable id,
   * never the title, which changes when a group is renamed.
   */
  conversationId: string;
  conversationTitle: string;
  onSend: (body: string, mentions: MentionPayload[]) => void;
  /** Uploads a file, with whatever was typed alongside it as a caption. */
  onSendFile: (file: File, caption?: string) => void;
  /** True while an upload from this browser is in flight, which disables sending another. */
  uploading: boolean;
  /** Bytes. Checked here so an oversized file is refused before it is sent, and again by the server. */
  maxFileSize: number;
  /** The message being replied to, or null. Purely local until the reply is actually sent. */
  replyTarget: ChatMessage | null;
  usersById: Map<string, UserSummary>;
  currentUserId: string;
  onCancelReply(): void;
  /**
   * The message being edited, or null (Batch 1.1).
   *
   * Never set at the same time as `replyTarget` — the session keeps the two mutually exclusive, so
   * this component never has to decide which banner wins.
   */
  editTarget: ChatMessage | null;
  onCancelEdit(): void;
  /** Saves the edited text. Resolves true when the server accepted it. */
  onSaveEdit(body: string, mentions: MentionPayload[]): Promise<boolean>;
  /**
   * Who can be mentioned here (Batch 1.7): the ACTIVE members of this group, minus the sender.
   *
   * Empty in a direct conversation, which is how the picker stays a group feature — there is
   * nothing to suggest, so typing "@" opens nothing. Passed in already filtered because the
   * workspace holds the conversation and the user directory; this component resolves nothing and
   * fetches nothing, so no keystroke can become a request.
   */
  mentionMembers: readonly { userId: string; displayName: string }[];
  /**
   * This user started or stopped typing here (Batch 1.8).
   *
   * Already throttled when it is called — a start, a heartbeat every few seconds, a stop — so the
   * caller can send it straight to the socket. Never called while editing: correcting an old
   * message is not "typing" anything new.
   */
  onTypingChange(typing: boolean): void;
}

/** Show the character counter only when the limit is close enough to matter. */
const COUNTER_VISIBLE_FROM = MAX_MESSAGE_LENGTH - 200;

export function MessageComposer({
  conversationId,
  conversationTitle,
  onSend,
  onSendFile,
  uploading,
  maxFileSize,
  replyTarget,
  usersById,
  currentUserId,
  onCancelReply,
  editTarget,
  onCancelEdit,
  onSaveEdit,
  mentionMembers,
  onTypingChange,
}: MessageComposerProps) {
  /*
   * The saved draft for this conversation (Batch 1.9), read ONCE as the composer opens.
   *
   * The parent remounts this component per conversation, so "opened" is exactly "switched to this
   * conversation" — and a lazy initial state is the whole of restoring. Nothing is announced: the
   * typing signal is only ever fed from the employee's own input below, so reopening a draft does
   * not tell anybody that its author is typing.
   */
  const [restoredDraft] = useState(() => openDraft(currentUserId, conversationId, mentionMembers));
  const [body, setBody] = useState(restoredDraft?.text ?? '');
  /*
   * The chosen file, held here until the user presses Send.
   *
   * Choosing a file does not send it. Somebody who picks the wrong one — easy, from a list of
   * similar names — gets to see what they picked and change their mind, rather than discovering
   * it after their colleague already has it.
   */
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  /** True while a save is in flight, so Save cannot be pressed twice. */
  const [saving, setSaving] = useState(false);
  /**
   * The right-click menu inside the text field, and what the caret was doing when it opened.
   *
   * The selection is captured HERE, at right-click time, rather than read when Paste is chosen.
   * Opening the menu moves focus to its first item, so by the time Paste is pressed the field is
   * no longer focused — and capturing at the moment of the gesture is both accurate and immune to
   * anything that happens in between.
   */
  const [composerMenu, setComposerMenu] = useState<{
    x: number;
    y: number;
    selectionStart: number;
    selectionEnd: number;
  } | null>(null);
  /** Said out loud only when a paste could not happen. Cleared on the next attempt. */
  const [pasteError, setPasteError] = useState<string | null>(null);
  /**
   * Mentions the employee has actually CHOSEN, for this draft (Batch 1.7).
   *
   * Not the spans — those are located in the text at send time (lib/chat/mentions.ts). This is
   * only the list of who was picked, which is what separates a real mention from somebody typing
   * "@" in an email address. It is a draft-scoped fact, so it is cleared whenever the draft is.
   */
  const [confirmed, setConfirmed] = useState<ConfirmedMention[]>(restoredDraft?.mentions ?? []);
  /** The `@…` the caret is inside, or null. Recomputed from the field; never remembered. */
  const [mentionTrigger, setMentionTrigger] = useState<MentionTrigger | null>(null);
  /** Which suggestion Enter would choose. Shared by the arrow keys and the mouse. */
  const [mentionIndex, setMentionIndex] = useState(0);
  /** Where the caret belongs once a pasted value has been rendered — or a restored draft. */
  const pendingCursor = useRef<number | null>(restoredDraft ? restoredDraft.text.length : null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const editing = editTarget !== null;
  const editingId = editTarget?.id ?? null;

  /*
   * Mirrors of the current body and the current target, so the prefill effect below can READ them
   * without DEPENDING on them.
   *
   * That distinction is the whole reason these exist. An effect that listed `body` in its
   * dependencies would re-run on every keystroke; one that listed `editTarget` would re-run every
   * time a `message:updated` arrived for that message — and either would overwrite what the user
   * is in the middle of typing with the text the message used to have.
   *
   * They are written in an effect rather than during render, and this effect is declared FIRST on
   * purpose: effects run in declaration order, so by the time the prefill effect below runs, these
   * already hold the values from the render that triggered it.
   */
  const bodyRef = useRef(body);
  const editTargetRef = useRef(editTarget);
  const draftBeforeEdit = useRef('');
  /** The draft's confirmed mentions, stashed alongside its text while an edit is in progress. */
  const confirmedBeforeEdit = useRef<ConfirmedMention[]>([]);
  const confirmedRef = useRef(confirmed);
  const previousEditingId = useRef<string | null>(null);
  const onTypingChangeRef = useRef(onTypingChange);

  useEffect(() => {
    bodyRef.current = body;
    editTargetRef.current = editTarget;
    confirmedRef.current = confirmed;
    onTypingChangeRef.current = onTypingChange;
  });

  /*
   * The typing signal (Batch 1.8): one per composer, and the composer is remounted per
   * conversation — so unmounting it is exactly "left this conversation", and the stop below is
   * what clears the old conversation's indicator when the user switches to another one.
   */
  const typingSignalRef = useRef<TypingSignal | null>(null);
  useEffect(() => {
    const signal = createTypingSignal((typing) => onTypingChangeRef.current(typing));
    typingSignalRef.current = signal;
    return () => {
      signal.stop();
      typingSignalRef.current = null;
    };
  }, []);

  /** The user changed the draft. Editing an old message is not typing a new one. */
  const noteTyping = useCallback((text: string) => {
    if (editTargetRef.current !== null) return;
    typingSignalRef.current?.input(text);
  }, []);

  /*
   * Saving the draft (Batch 1.9): one debounced writer per composer, flushed when the composer
   * closes — switching conversation — and when the page is hidden or unloaded, which is the
   * desktop client going to the tray or being closed. Nothing is written while the text is only
   * being shown (restored, cleared by a send, swapped for an edit); only `noteDraft` schedules a
   * write, and only the employee's own input calls it.
   */
  const draftAutosaveRef = useRef<DraftAutosave | null>(null);
  useEffect(() => {
    const autosave = createDraftAutosave((draft) => saveDraft(currentUserId, conversationId, draft));
    draftAutosaveRef.current = autosave;

    const flush = () => autosave.flush();
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') autosave.flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flushWhenHidden);

    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flushWhenHidden);
      autosave.flush();
      draftAutosaveRef.current = null;
    };
  }, [currentUserId, conversationId]);

  /** The user changed the draft. An edit in progress is the old message's text, not a draft. */
  const noteDraft = useCallback((text: string, mentions: ConfirmedMention[]) => {
    if (editTargetRef.current !== null) return;
    draftAutosaveRef.current?.input({ text, mentions });
  }, []);

  /*
   * Entering and leaving edit mode.
   *
   * Keyed on the message id alone, so it fires exactly twice per edit — once on entry, once on
   * exit — and never in between.
   *
   *   Entering: whatever was half-typed is stashed, and the message's current text takes its place.
   *   Leaving:  the stash comes back, whether the edit was saved or cancelled. Somebody who was
   *             part-way through a sentence, edited an older message, then came back finds their
   *             sentence still there.
   *
   * Switching straight from editing one message to editing another does not re-stash: the draft
   * being held is the ordinary composer text, not the previous edit.
   */
  useEffect(() => {
    const previous = previousEditingId.current;
    previousEditingId.current = editingId;

    if (editingId === null) {
      if (previous !== null) {
        setBody(draftBeforeEdit.current);
        setConfirmed(confirmedBeforeEdit.current);
        draftBeforeEdit.current = '';
        confirmedBeforeEdit.current = [];
      }
      return;
    }

    if (previous === null) {
      draftBeforeEdit.current = bodyRef.current;
      confirmedBeforeEdit.current = confirmedRef.current;
      // The draft is set aside, and so is any "is typing…" it had started.
      typingSignalRef.current?.stop();
      // Saved as it stands, so the edit's text can never be mistaken for it (Batch 1.9).
      draftAutosaveRef.current?.flush();
    }

    const target = editTargetRef.current;
    const text = target?.body ?? '';
    setBody(text);

    /*
     * RE-CONFIRM THE MENTIONS THE MESSAGE ALREADY HAS (Batch 1.7).
     *
     * Without this, editing "@Nilesh please review" to fix a typo elsewhere would save a message
     * with no mentions at all: the confirmed set starts empty, so `resolveMentions` would find
     * nothing to match and the server would replace the rows with none. Editing must not quietly
     * un-mention somebody.
     *
     * The label is read back out of the text at the stored offsets, which is exactly the text
     * that was sent — so a person renamed since then keeps the name the message actually says,
     * and re-saving preserves it rather than rewriting history.
     */
    setConfirmed(
      (target?.mentions ?? []).map((mention) => ({
        userId: mention.userId,
        label: text.slice(mention.start + 1, mention.end),
        kind: mention.kind,
      })),
    );

    textAreaRef.current?.focus();
  }, [editingId]);

  // Grow with the text, up to a ceiling, then scroll inside the field.
  useEffect(() => {
    const field = textAreaRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  }, [body]);

  /*
   * Puts the caret back after a paste has been rendered.
   *
   * A LAYOUT effect, so it runs before the browser paints: setting the selection after paint
   * makes the caret visibly jump to the end and back. The field is focused explicitly rather than
   * relying on the closing menu to restore it, so the caret lands whether the paste came from the
   * menu or from anywhere else.
   */
  useLayoutEffect(() => {
    const cursor = pendingCursor.current;
    if (cursor === null) return;
    pendingCursor.current = null;

    const field = textAreaRef.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(cursor, cursor);
  }, [body]);

  /**
   * Reads the clipboard and inserts it at the caret.
   *
   * Only ever reached from the menu. Native Ctrl+V does not come through here at all — it is a
   * trusted user action that carries its own data, needs no permission, and is handled by the
   * browser writing into the field and React seeing an ordinary change event. Nothing in this
   * component intercepts `paste`, so the keyboard keeps working exactly as it did.
   *
   * THE THREE OUTCOMES are kept apart on purpose:
   *   text     → inserted
   *   empty    → nothing happens, silently; there was nothing to paste
   *   refused  → said out loud, with the way that does work
   *
   * The refusal is the desktop client's case. Its session denies every permission, so the page
   * may not read the clipboard (lib/chat/clipboard.ts) — telling the employee to press Ctrl+V is
   * both true and immediately useful, and is far better than a menu item that appears to do
   * nothing.
   *
   * Reply and edit mode are untouched: this writes to the same `body` the field already shows, so
   * pasting while replying composes a reply and pasting while editing edits. Neither mode is
   * cancelled, because nothing here cancels anything.
   */
  const pasteFromClipboard = useCallback(
    async (selection: { selectionStart: number; selectionEnd: number }) => {
      setPasteError(null);

      const field = textAreaRef.current;
      const outcome = await pasteIntoComposer({ value: field?.value ?? '', ...selection });

      if (outcome.kind === 'refused') {
        setPasteError('This application cannot read the clipboard. Press Ctrl+V to paste.');
        return;
      }
      // 'empty': the clipboard held nothing. Nothing to say and nothing to do.
      if (outcome.kind !== 'inserted') return;

      setBody(outcome.value);
      pendingCursor.current = outcome.cursor;
      noteTyping(outcome.value);
      noteDraft(outcome.value, confirmedRef.current);
    },
    [noteDraft, noteTyping],
  );

  /**
   * Right-click inside the field: our menu, but only where the platform offers none.
   *
   * WHY THE EARLY RETURN (Batch 1.5). This handler used to call `preventDefault` unconditionally,
   * which is right in the desktop client — Electron shows no context menu of its own, so without
   * ours there is nothing — and wrong in a browser, where it also cancelled Chrome's and Safari's
   * own menu and took the SPELLING SUGGESTIONS down with it. Standing aside in a browser gives
   * the employee suggestions from the OS dictionary plus a native Paste, neither of which this
   * application could offer as well itself.
   *
   * Returning BEFORE `preventDefault` is the whole of the fix: the event continues untouched and
   * the platform does what it would have done. See lib/chat/composer-menu.ts for the rule.
   */
  const openComposerMenu = useCallback((event: ReactMouseEvent<HTMLTextAreaElement>) => {
    if (!shouldUseCustomComposerMenu()) return;

    const field = event.currentTarget;
    event.preventDefault();
    setComposerMenu({
      x: event.clientX,
      y: event.clientY,
      selectionStart: field.selectionStart,
      selectionEnd: field.selectionEnd,
    });
  }, []);

  const closeComposerMenu = useCallback(() => setComposerMenu(null), []);

  /*
   * The suggestions, derived rather than stored.
   *
   * `mentionMembers` is empty in a direct conversation, so `candidates` is empty there too and
   * the picker never opens — the group-only rule needs no condition of its own.
   */
  const mentionCandidates =
    mentionTrigger === null ? [] : filterMentionCandidates(mentionMembers, mentionTrigger.query);
  const mentionOpen = mentionCandidates.length > 0;
  const activeMention = mentionCandidates[Math.min(mentionIndex, mentionCandidates.length - 1)];

  const MENTION_LIST_ID = 'composer-mention-list';
  const mentionOptionId = (index: number) => `${MENTION_LIST_ID}-option-${index}`;

  /** Re-reads the caret and decides whether an `@…` is being typed. */
  const syncMentionTrigger = useCallback((field: HTMLTextAreaElement) => {
    const next = findMentionTrigger(field.value, field.selectionStart ?? 0);
    setMentionTrigger(next);
    setMentionIndex(0);
  }, []);

  const closeMentionPicker = useCallback(() => setMentionTrigger(null), []);

  /** Puts the chosen name into the draft and remembers that it was chosen. */
  const chooseMention = useCallback(
    (candidate: MentionCandidate) => {
      const field = textAreaRef.current;
      if (!field || mentionTrigger === null) return;

      const result = applyMention(
        field.value,
        mentionTrigger,
        field.selectionStart ?? field.value.length,
        candidate,
      );

      const current = confirmedRef.current;
      const nextConfirmed = current.some(
        (item) => item.kind === result.confirmed.kind && item.userId === result.confirmed.userId,
      )
        ? current
        : [...current, result.confirmed];

      setBody(result.value);
      pendingCursor.current = result.cursor;
      noteTyping(result.value);
      noteDraft(result.value, nextConfirmed);
      setConfirmed(nextConfirmed);
      setMentionTrigger(null);
      setMentionIndex(0);
    },
    [mentionTrigger, noteDraft, noteTyping],
  );

  const trimmed = body.trim();
  const tooLong = body.length > MAX_MESSAGE_LENGTH;

  /*
   * What "Save" is allowed to do, which is not the same as what "Send" is allowed to do.
   *
   * Emptying the text is legitimate for a file message — it clears the caption and leaves the
   * file, which is exactly what sending a file without typing anything produces. Emptying a text
   * message is not: there would be nothing left, and deleting is the action for that. The server
   * applies the same rule and is the one that decides.
   */
  const canSaveEdit =
    !saving && !tooLong && (trimmed.length > 0 || editTarget?.attachment != null);
  // A file on its own is a message; so is text on its own; so is both together.
  const canSend = editing
    ? canSaveEdit
    : !uploading && !tooLong && (trimmed.length > 0 || file !== null);

  const chooseFile = (chosen: File | null) => {
    setFileError(null);
    if (!chosen) {
      setFile(null);
      return;
    }

    /*
     * Refused here as well as on the server, and the client check is the courtesy rather than the
     * control: without it somebody would spend several minutes uploading a file that was always
     * going to be rejected at the end. The server enforces the same limit while the bytes arrive,
     * because a browser check is a suggestion (CLAUDE.md §9).
     */
    if (chosen.size > maxFileSize) {
      setFile(null);
      setFileError(
        `That file is ${formatFileSize(chosen.size)}. The limit is ${formatFileSize(maxFileSize)}.`,
      );
      return;
    }

    setFile(chosen);
  };

  const clearFile = () => {
    setFile(null);
    setFileError(null);
    // The input keeps its value, so re-choosing the same file would fire no change event.
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  /**
   * Ctrl+V with a screenshot on the clipboard (Batch 1.10).
   *
   * TEXT PASTE IS NEVER TOUCHED. `imageFromClipboard` answers null for anything that is not an
   * image-only clipboard — text, text alongside a picture (Excel, Word), or nothing usable — and
   * this returns BEFORE `preventDefault`, so the browser pastes exactly as it did before (Batch
   * 1.2). Only an image paste is taken over, and only to do what the paperclip does: the image
   * becomes the selected file, shown in the same card, with whatever is typed as its caption. Nothing
   * is uploaded until Send.
   *
   * Not while editing: an edit changes a message's text and cannot add a file — the paperclip is
   * disabled for the same reason — so the employee is told rather than left wondering.
   */
  const pasteImage = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const image = imageFromClipboard(event.clipboardData);
    if (!image) return;

    event.preventDefault();
    if (editing) {
      setPasteError('A screenshot cannot be added while editing a message.');
      return;
    }

    setPasteError(null);
    chooseFile(pastedImageFile(image));
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;

    /*
     * Editing takes over the composer entirely: no file is sent, and no new message is created.
     *
     * The body is NOT cleared here. Edit mode is left only when the save succeeds — the session
     * clears `editTarget`, which is what restores the composer — so a failure leaves the banner,
     * the text and the cursor exactly where they were, ready to try again.
     */
    /*
     * Spans are located in the FINAL trimmed text — the exact string the server will store — so
     * the offsets it re-checks are the ones it can verify (Batch 1.7).
     */
    const mentions = resolveMentions(trimmed, confirmed);

    if (editing) {
      setSaving(true);
      void onSaveEdit(trimmed, mentions).finally(() => setSaving(false));
      return;
    }

    // Sending ends the typing, before the message leaves (Batch 1.8).
    typingSignalRef.current?.stop();

    /*
     * The draft is HELD, not deleted (Batch 1.9): stored as exactly what is being sent, and
     * removed by the session only once the server accepts it. A pending debounced write is
     * dropped first — the held copy supersedes it.
     */
    draftAutosaveRef.current?.cancel();
    holdDraftForSend(currentUserId, conversationId, { text: trimmed, mentions: confirmed });

    if (file) {
      // A caption can mention people too; it is the same body, sent the same way.
      onSendFile(file, trimmed.length > 0 ? trimmed : undefined);
      clearFile();
      setBody('');
      setConfirmed([]);
      return;
    }

    onSend(trimmed, mentions);
    setBody('');
    setConfirmed([]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    /*
     * THE MENTION PICKER GETS THE KEYS FIRST, and only while it is open (Batch 1.7).
     *
     * This block is deliberately ahead of everything below, because the key that matters is
     * Enter: with suggestions on screen it must CHOOSE one, and it must not send the message.
     * Sending a half-written sentence because somebody pressed Enter to pick a name is the exact
     * failure this ordering prevents.
     *
     * Every other composer key is untouched. When the picker is closed — which is nearly always —
     * this block does nothing at all and Enter, Shift+Enter, Escape, reply and edit behave
     * exactly as they did before.
     */
    if (mentionOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionIndex((index) => (index + 1) % mentionCandidates.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionIndex(
          (index) => (index - 1 + mentionCandidates.length) % mentionCandidates.length,
        );
        return;
      }
      // Tab selects as well as Enter, which is what a suggestion list conventionally does.
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        if (activeMention) chooseMention(activeMention);
        return;
      }
      /*
       * Escape closes the picker and STOPS THERE — it does not fall through to cancelling a
       * reply or an edit. One Escape, one thing dismissed; the next Escape reaches those.
       */
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMentionPicker();
        return;
      }
    }

    // Enter sends; Shift+Enter starts a new line — the convention staff will expect.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }

    // Escape abandons the reply without clearing what has been typed. Only when there is one to
    // abandon, so Escape keeps its usual meaning the rest of the time.
    if (event.key === 'Escape' && replyTarget) {
      event.preventDefault();
      onCancelReply();
      return;
    }

    // The same for an edit. Leaving edit mode puts back whatever was being typed before it began,
    // so Escape here costs nothing that was not already the message's own text.
    if (event.key === 'Escape' && editing) {
      event.preventDefault();
      onCancelEdit();
    }
  };

  return (
    <form
      onSubmit={submit}
      className="shrink-0 border-t border-line bg-surface px-3 py-3 shadow-[0_-1px_2px_0_rgb(64_43_20/0.03)] sm:px-6"
    >
      <div className="mx-auto max-w-3xl">
        {/*
          Any file type. The input carries no `accept` filter on purpose: the company transfers
          arbitrary business files, and a filter here would hide ordinary work from the picker
          while stopping nothing (docs/14-phase-7-file-transfer.md §7).
        */}
        <input
          ref={fileInputRef}
          type="file"
          className="sr-only"
          onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
          aria-hidden="true"
          tabIndex={-1}
        />

        {/*
          The editing banner.

          Deliberately the same shape and weight as the reply banner below: they occupy the same
          place, do the same job — telling you the Send button does not mean what it usually does —
          and are never both on screen, because the session keeps the two modes exclusive.

          The current text is shown underneath rather than the new one: it is what the message says
          now, and the composer already shows what it would say instead.
        */}
        {editTarget ? (
          <div className="mb-2 flex animate-rise-in items-center gap-2 rounded-card border border-accent/20 bg-accent-tint px-3 py-2">
            <EditIcon className="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-semibold text-brand">Editing message</span>
              <span className="block truncate text-xs text-ink-muted">
                {editTarget.body?.trim() || editTarget.attachment?.filename || 'Attachment'}
              </span>
            </span>
            <IconButton label="Cancel edit" onClick={onCancelEdit}>
              <CloseIcon className="h-4 w-4" />
            </IconButton>
          </div>
        ) : null}

        {/*
          The reply banner.
          
          Above the file card and the text area, where the eye reaches it before typing — a reply
          that is only apparent after sending is a reply somebody did not mean to make. Cancelling
          is always one press away, and Escape in the text area does the same thing.
        */}
        {replyTarget ? (
          <div className="mb-2 flex animate-rise-in items-center gap-2 rounded-card border border-accent/20 bg-accent-tint px-3 py-2">
            <ReplyIcon className="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-semibold text-brand">
                Replying to{' '}
                {replyTarget.senderId === currentUserId
                  ? 'yourself'
                  : (usersById.get(replyTarget.senderId ?? '')?.displayName ?? 'Unknown user')}
              </span>
              <span className="block truncate text-xs text-ink-muted">
                {replyTarget.body?.trim() || replyTarget.attachment?.filename || 'Attachment'}
              </span>
            </span>
            <IconButton label="Cancel reply" onClick={onCancelReply}>
              <CloseIcon className="h-4 w-4" />
            </IconButton>
          </div>
        ) : null}

        {file && !editing ? (
          <div className="mb-2 flex animate-rise-in items-center gap-3 rounded-card border border-accent/20 bg-accent-tint px-3 py-2.5 shadow-subtle">
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-surface text-brand ring-1 ring-line"
              aria-hidden="true"
            >
              <FileIcon className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-ink" title={file.name}>
                {file.name}
              </span>
              <span className="block text-xs text-ink-subtle">
                {formatFileSize(file.size)} · ready to send
              </span>
            </span>
            <IconButton label="Remove the selected file" onClick={clearFile} className="shrink-0">
              <CloseIcon />
            </IconButton>
          </div>
        ) : null}

        {fileError ? (
          <p className="mb-2 text-sm text-danger" role="alert">
            {fileError}
          </p>
        ) : null}

        {/*
          A paste that could not happen. `role="status"` rather than `alert`: it answers something
          the employee just did and tells them the way that works, which is information rather
          than an interruption.
        */}
        {pasteError ? (
          <p className="mb-2 text-sm text-ink-muted" role="status">
            {pasteError}
          </p>
        ) : null}

        {/*
          The whole row is the field, not just the textarea inside it: focus lights up the
          container so the paperclip and Send read as part of one control rather than three
          controls that happen to be adjacent.
        */}
        <div
          className={
            'relative flex items-end gap-2 rounded-panel border border-line-strong bg-surface-muted px-2 py-1.5 ' +
            'shadow-subtle transition-[border-color,box-shadow,background-color] ' +
            'duration-(--duration-quick) ease-(--ease-out-soft) ' +
            'focus-within:border-accent focus-within:bg-surface focus-within:ring-4 focus-within:ring-accent/12'
          }
        >
          {/*
            No attaching while editing. An edit changes text; replacing a file is a different
            thing entirely, and the server has no route for it (`editMessage` writes `body` and
            `editedAt`, nothing else).
          */}
          <IconButton
            label="Attach a file"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || editing}
            className="shrink-0"
          >
            <AttachmentIcon />
          </IconButton>

          {/*
            Anchored to the field row, so the list sits directly above the text being typed
            rather than somewhere near the window. `relative` lives on the row; the picker
            positions itself against it.
          */}
          {mentionOpen ? (
            <MentionPicker
              candidates={mentionCandidates}
              activeIndex={mentionCandidates.indexOf(activeMention as MentionCandidate)}
              onSelect={chooseMention}
              onHoverIndex={setMentionIndex}
              listId={MENTION_LIST_ID}
              optionId={mentionOptionId}
            />
          ) : null}

          <label htmlFor="message-composer" className="sr-only">
            {`Message ${conversationTitle}`}
          </label>
          <textarea
            id="message-composer"
            ref={textAreaRef}
            rows={1}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
              syncMentionTrigger(event.target);
              noteTyping(event.target.value);
              noteDraft(event.target.value, confirmedRef.current);
            }}
            /*
             * `onSelect` fires whenever the caret moves — arrow keys, a click, a drag — so moving
             * away from an `@…` closes the picker and moving back into one reopens it. Without
             * this the suggestions would only track typing, and would linger over text the caret
             * had already left.
             */
            onSelect={(event) => syncMentionTrigger(event.currentTarget)}
            onKeyDown={onKeyDown}
            /* Image pastes only; text pastes return untouched (see `pasteImage`). */
            onPaste={pasteImage}
            onContextMenu={openComposerMenu}
            /*
             * Spelling underlines, from the platform's own dictionary (Batch 1.5).
             *
             * Stated explicitly rather than left to the default: a textarea is spellchecked by
             * default in Chrome and Safari, but `spellcheck` INHERITS, so any ancestor that ever
             * turned it off would silently take it away here. This pins the one field where it
             * matters.
             *
             * No `lang` and no `autoCorrect`: the dictionary is inherited from `<html lang="en">`
             * so the employee's own English variant still applies, and nothing may rewrite a word
             * that a person did not choose to change. See lib/chat/composer-menu.ts.
             */
            spellCheck={COMPOSER_SPELLCHECK}
            placeholder={
              editing
                ? 'Edit your message'
                : file
                  ? 'Add a message with the file (optional)'
                  : `Message ${conversationTitle}`
            }
            /*
             * The parent keys this component by conversation, so opening one focuses a fresh field
             * — holding that conversation's saved draft, if it has one, with the caret at its end.
             */
            autoFocus
            aria-describedby="composer-hint"
            aria-invalid={tooLong || undefined}
            /*
             * The textarea IS the combobox (Batch 1.7). Focus never leaves it, so the suggestion
             * list is described from here and the current option is named by id rather than
             * focused — the pattern a screen reader already knows for "field with suggestions".
             */
            role="combobox"
            aria-expanded={mentionOpen}
            aria-controls={MENTION_LIST_ID}
            aria-autocomplete="list"
            {...(mentionOpen && activeMention
              ? { 'aria-activedescendant': mentionOptionId(mentionCandidates.indexOf(activeMention)) }
              : {})}
            className="max-h-40 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-[0.9375rem] leading-6 text-ink placeholder:text-ink-subtle focus:outline-none"
          />

          {/*
            Disabled while an upload is in flight: pressing Send twice on a 500 MB video should
            not start a second one. The idempotency key would stop it becoming two messages, but
            it would not stop the second upload being sent up the wire.
          */}
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!canSend}
            className="mb-0.5 shrink-0"
          >
            {editing ? <CheckIcon className="h-4 w-4" /> : <SendIcon className="h-4 w-4" />}
            {editing ? (saving ? 'Saving…' : 'Save') : uploading ? 'Sending…' : 'Send'}
          </Button>
        </div>

        <div className="mt-2 flex items-center justify-between gap-3">
          <p id="composer-hint" className="text-xs text-ink-subtle">
            {editing ? (
              <>
                <kbd className="font-sans font-medium text-ink-muted">Enter</kbd> saves ·{' '}
                <kbd className="font-sans font-medium text-ink-muted">Shift + Enter</kbd> adds a
                line · <kbd className="font-sans font-medium text-ink-muted">Esc</kbd> cancels
              </>
            ) : (
              <>
                <kbd className="font-sans font-medium text-ink-muted">Enter</kbd> sends ·{' '}
                <kbd className="font-sans font-medium text-ink-muted">Shift + Enter</kbd> adds a
                line · any file up to {formatFileSize(maxFileSize)}
              </>
            )}
          </p>
          {body.length >= COUNTER_VISIBLE_FROM ? (
            <p className={tooLong ? 'text-xs font-medium text-danger' : 'text-xs text-ink-subtle'}>
              {body.length} / {MAX_MESSAGE_LENGTH}
              {tooLong ? ' — too long to send' : ''}
            </p>
          ) : null}
        </div>
      </div>

      {/*
        Fixed to the viewport and rendered last, so it is never clipped by the composer's own
        box. `useAnchoredMenu` closes it on Escape, on a click elsewhere, on a right-click
        elsewhere, on a scroll and on a resize — the right-click rule being what guarantees this
        and the message menu are never open at the same time.
      */}
      {composerMenu ? (
        <ComposerContextMenu
          anchor={{ x: composerMenu.x, y: composerMenu.y }}
          onPasteSelected={
            // Null only when the browser has no clipboard read API at all — an insecure origin,
            // or a browser too old for it. A PRESENT-BUT-REFUSED API (the desktop client) stays
            // enabled and explains itself when pressed, which is the more useful of the two.
            canReadClipboard()
              ? () =>
                  void pasteFromClipboard({
                    selectionStart: composerMenu.selectionStart,
                    selectionEnd: composerMenu.selectionEnd,
                  })
              : null
          }
          onClose={closeComposerMenu}
        />
      ) : null}
    </form>
  );
}
