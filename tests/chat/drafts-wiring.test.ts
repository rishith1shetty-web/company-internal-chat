/**
 * Draft wiring (Batch 1.9): the composer, the workspace and the session use lib/chat/drafts.ts the
 * way tests/chat/drafts.test.ts models it — and nothing about drafts reaches the server.
 *
 * Source assertions, like the other wiring tests: the suite runs under `environment: 'node'` with
 * no DOM, so the component is checked for the calls that make the behaviour true.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

/** The file with its comments removed, so "never does X" is a claim about the code. */
function code(...parts: string[]): string {
  return source(...parts)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const composer = code('components', 'chat', 'MessageComposer.tsx');
const workspace = code('components', 'chat', 'ChatWorkspace.tsx');
const session = code('lib', 'chat', 'useChatSession.ts');
const drafts = code('lib', 'chat', 'drafts.ts');

/** The body of the first arrow/function starting at `marker`, up to the matching close. */
function block(text: string, marker: string): string {
  const start = text.indexOf(marker);
  expect(start, marker).toBeGreaterThan(-1);
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    if (text[index] === '}') depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }
  return text.slice(start);
}

describe('the drafts module is local-only', () => {
  it('talks to no server, socket, database or log', () => {
    for (const forbidden of [
      'fetch(',
      '/api/',
      'socket',
      'emit(',
      'prisma',
      'console.',
      'sessionStorage',
      'indexedDB',
    ]) {
      expect(drafts, forbidden).not.toContain(forbidden);
    }
  });

  it('imports only a type', () => {
    const imports = drafts.split('\n').filter((line) => line.trimStart().startsWith('import '));
    expect(imports).toEqual(["import type { ConfirmedMention } from '@/lib/chat/mentions';"]);
  });

  it('uses one project-prefixed key', () => {
    expect(drafts).toContain("DRAFTS_KEY = 'cic.chat.drafts'");
  });

  it('no socket event, route or schema was added for drafts', () => {
    expect(code('lib', 'realtime', 'events.ts')).not.toMatch(/draft/i);
    expect(code('lib', 'realtime', 'gateway.ts')).not.toMatch(/draft/i);
    expect(code('lib', 'chat', 'socket.ts')).not.toMatch(/draft/i);
    expect(code('lib', 'chat', 'api.ts')).not.toMatch(/draft/i);
    expect(source('prisma', 'schema.prisma')).not.toMatch(/draft/i);
  });
});

describe('the composer', () => {
  it('opens on the saved draft for its conversation id, once, as initial state', () => {
    expect(composer).toContain(
      'useState(() => openDraft(currentUserId, conversationId, mentionMembers))',
    );
    expect(composer).toContain("useState(restoredDraft?.text ?? '')");
    expect(composer).toContain('useState<ConfirmedMention[]>(restoredDraft?.mentions ?? [])');
  });

  it('the workspace keys it by conversation and passes the same id', () => {
    expect(workspace).toContain('key={selectedConversation.id}');
    expect(workspace).toContain('conversationId={selectedConversation.id}');
  });

  it('restoring announces nothing: typing and saving are fed only from user input', () => {
    // Exactly the three input paths: typing, paste from the menu, choosing a mention.
    expect(composer.match(/noteTyping\(/g)?.length).toBe(3);
    expect(composer.match(/noteDraft\(/g)?.length).toBe(3);
    expect(composer).toMatch(/noteTyping\(event\.target\.value\);\s*noteDraft\(event\.target\.value/);
    expect(composer).toMatch(/noteTyping\(outcome\.value\);\s*noteDraft\(outcome\.value/);
    expect(composer).toMatch(/noteTyping\(result\.value\);\s*noteDraft\(result\.value, nextConfirmed\)/);

    // And the restore path is just state — no signal, no write.
    const restore = composer.slice(
      composer.indexOf('const [restoredDraft]'),
      composer.indexOf('const [file, setFile]'),
    );
    expect(restore).not.toContain('noteTyping');
    expect(restore).not.toContain('typingSignal');
    expect(restore).not.toContain('saveDraft');
  });

  it('saves with a debounce, flushing on close, on page hide and on entering edit mode', () => {
    const effect = block(composer, 'useEffect(() => {\n    const autosave = createDraftAutosave(');
    expect(effect).toContain('saveDraft(currentUserId, conversationId, draft)');
    expect(effect).toContain("addEventListener('pagehide', flush)");
    expect(effect).toContain("addEventListener('visibilitychange', flushWhenHidden)");
    expect(effect).toContain('autosave.flush();');

    const editEntry = composer.slice(
      composer.indexOf('if (previous === null) {'),
      composer.indexOf('const target = editTargetRef.current;'),
    );
    expect(editEntry).toContain('draftAutosaveRef.current?.flush()');
  });

  it('never saves while editing an existing message', () => {
    const noteDraft = block(composer, 'const noteDraft = useCallback(');
    expect(noteDraft).toContain('if (editTargetRef.current !== null) return;');

    // A save of an edit returns before the draft is held.
    const submit = block(composer, 'const submit = (event?: FormEvent) =>');
    expect(submit.indexOf('if (editing) {')).toBeGreaterThan(-1);
    expect(submit.indexOf('if (editing) {')).toBeLessThan(submit.indexOf('holdDraftForSend('));
  });

  it('holds the draft on send instead of deleting it, for files and text alike', () => {
    const submit = block(composer, 'const submit = (event?: FormEvent) =>');
    const hold = submit.indexOf('holdDraftForSend(currentUserId, conversationId,');
    expect(submit.indexOf('draftAutosaveRef.current?.cancel()')).toBeLessThan(hold);
    expect(hold).toBeLessThan(submit.indexOf('if (file) {'));
    expect(hold).toBeLessThan(submit.indexOf('onSend(trimmed, mentions)'));
    expect(submit).not.toContain('clearDraft');
  });

  it('still stops typing on send, edit and unmount (Batch 1.8)', () => {
    expect((composer.match(/typingSignalRef\.current\?\.stop\(\)/g) ?? []).length).toBe(2);
    expect(composer).toMatch(/signal\.stop\(\)/);
  });
});

describe('the session', () => {
  it('releases a draft only when the server accepted the message', () => {
    const send = block(session, 'const sendMessage = useCallback(');
    expect(send).toMatch(/\.then\(\(ok\) => \{\s*if \(ok\) releaseDraft\(conversationId, trimmed\);/);

    const retry = block(session, 'const retryMessage = useCallback(');
    expect(retry).toMatch(/\.then\(\(ok\) => \{\s*if \(ok\) releaseDraft\(conversationId, body\);/);

    const deliver = block(session, 'const deliver = useCallback(');
    expect(deliver).toContain('return true;');
    expect(deliver.match(/return false;/g)?.length).toBe(2);
  });

  it('a completed upload releases its caption; a failed or cancelled one gives it back', () => {
    const sendFile = block(session, 'const sendFile = useCallback(');
    const success = sendFile.slice(sendFile.indexOf('.then((message)'), sendFile.indexOf('.catch('));
    expect(success).toContain('if (caption) releaseDraft(conversationId, caption);');

    const failure = sendFile.slice(sendFile.indexOf('.catch('));
    // Before any early return, so every failure path — including a cancel — gives it back.
    expect(failure.indexOf('returnUndeliveredDraft(owner, conversationId, caption)')).toBeLessThan(
      failure.indexOf("error.code === 'ABORTED'"),
    );
  });

  it('prunes drafts only from the full conversation list the server returned', () => {
    const load = block(session, 'const loadConversations = useCallback(');
    const fetched = load.indexOf('await fetchConversations()');
    const prune = load.indexOf('pruneDrafts(owner, knownConversationsRef.current)');
    expect(fetched).toBeGreaterThan(-1);
    expect(prune).toBeGreaterThan(fetched);
    expect(load.indexOf('catch')).toBeGreaterThan(prune);
  });

  it('drafts are never part of a message payload or notification', () => {
    const deliver = block(session, 'const deliver = useCallback(');
    expect(deliver).not.toMatch(/draft/i);
    expect(code('lib', 'notifications', 'describe.ts')).not.toMatch(/draft/i);
  });
});
