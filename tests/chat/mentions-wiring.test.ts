/**
 * Structural guarantees about mentions (Batch 1.7).
 *
 * SOURCE ASSERTIONS, labelled as such, as in `clipboard-wiring.test.ts`, `sidebar-wiring`,
 * `spellcheck-wiring` and `search-wiring`. The project has no DOM test environment by design, so
 * the picker's arrow keys, Enter, Escape and mouse selection cannot be driven through a rendered
 * tree. The rules behind them are pure and tested properly in `mentions-composer.test.ts`; the
 * authorization is tested against the real database in `mentions-service.test.ts`.
 *
 * What is left for here is mostly what mentions must NOT do — and for this batch that list is the
 * whole risk: no second notification, no second sound, no second unread increment, no second
 * realtime path, no Electron dependency, and no damage to the four batches shipped before it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MAX_MENTIONS_PER_MESSAGE as CLIENT_MAX } from '@/lib/chat/mentions';
import { MAX_MENTIONS_PER_MESSAGE as SERVER_MAX } from '@/lib/messages/mentions';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function source(path: string): string {
  return readFileSync(new URL(path, `file://${ROOT.replace(/\\/g, '/')}`), 'utf8');
}

/** The file with its comments removed, so "never does X" is a claim about the code. */
function code(path: string): string {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const RULES = 'lib/chat/mentions.ts';
const SERVICE = 'lib/messages/mentions.ts';
const PICKER = 'components/chat/MentionPicker.tsx';
const COMPOSER = 'components/chat/MessageComposer.tsx';
const LIST = 'components/chat/MessageList.tsx';
const DESCRIBE = 'lib/notifications/describe.ts';
const POLICY = 'lib/notifications/policy.ts';
const SCHEMA = 'prisma/schema.prisma';
const MIGRATION = 'prisma/migrations/20260923090000_message_mentions/migration.sql';

/* -------------------------------------------------------------------------------------------- */
/* 49-55 — one message, one notification                                                          */
/* -------------------------------------------------------------------------------------------- */

describe('a mention changes the wording of a notification and nothing else', () => {
  it('the notification POLICY knows nothing about mentions', () => {
    /*
     * The single most important assertion in this file. `planNotification` decides sound, toast
     * and desktop; if a mention could reach it, a mentioned message could acquire a second sound
     * or a second surface. It cannot, because the word does not appear there.
     */
    const policy = code(POLICY);
    expect(policy).not.toContain('mention');
    expect(policy).not.toContain('Mention');
  });

  it('only the second LINE changes, inside the existing describe step', () => {
    const describeSource = code(DESCRIBE);
    expect(describeSource).toContain('mentionsMe');
    expect(describeSource).toContain('mentioned you');
    expect(describeSource).toContain('mentioned everyone');
  });

  it('adds no second notification call anywhere', () => {
    // One arrived message is one notification event. Nothing here raises an extra one.
    for (const path of [SERVICE, RULES, COMPOSER, PICKER]) {
      const text = code(path);
      for (const forbidden of ['new Notification', 'notify(', 'playSound', 'showToast']) {
        expect(text, `${path}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('distinguishes being named from being swept up by @everyone', () => {
    // "mentioned everyone" is a much less urgent fact than "mentioned you", and says so.
    expect(code(DESCRIBE)).toContain('everyone ?');
  });

  it('never treats your own message as mentioning you', () => {
    expect(code(RULES)).toContain('if (senderId !== null && senderId === userId) return false;');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 24, 52 — unread and read receipts are untouched                                                */
/* -------------------------------------------------------------------------------------------- */

describe('unread and Seen are untouched', () => {
  it('the mention service never writes or reads a watermark', () => {
    const service = code(SERVICE);
    for (const forbidden of ['lastReadAt', 'lastReadMessageId', 'unread', 'markConversationRead']) {
      expect(service, forbidden).not.toContain(forbidden);
    }
  });

  it('introduces no second unread counter anywhere', () => {
    for (const path of [RULES, SERVICE]) {
      expect(code(path), path).not.toContain('mentionCount');
    }
  });

  it('the mention service writes only mention rows', () => {
    /*
     * `messageMention` is the only model it touches. A mention cannot move a conversation, stamp
     * a read marker or alter a message — there is no statement here that could.
     */
    const service = code(SERVICE);
    const writes = service.match(/tx\.(\w+)\./g) ?? [];
    expect([...new Set(writes)]).toEqual(['tx.messageMention.']);
    expect(service).not.toContain('lastMessageAt');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 56, 57 — realtime                                                                              */
/* -------------------------------------------------------------------------------------------- */

describe('mentions ride the existing message payload', () => {
  it('adds no new socket event', () => {
    const events = code('lib/realtime/events.ts');
    for (const forbidden of ["'mention:", 'mentionEvent', 'message:mentioned']) {
      expect(events, forbidden).not.toContain(forbidden);
    }
  });

  it('is selected with the message, in the same query', () => {
    // One read, one broadcast. No second fetch and no separate mention payload.
    expect(code('lib/messages/service.ts')).toContain('mentions: {');
    expect(code('lib/realtime/events.ts')).toContain('mentions: deleted');
  });

  it('adds no second delivery path in the gateway', () => {
    const gateway = code('lib/realtime/gateway.ts');
    // The only mention-aware line is passing the proposed list into the existing send.
    expect(gateway).toContain('mentions: parsed.data.mentions');
    expect(gateway.match(/emit\('message:new'/g)?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it('the notifier module gains nothing', () => {
    expect(code('lib/realtime/notify.ts')).not.toContain('mention');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 10, 11 — the server decides, not the client                                                    */
/* -------------------------------------------------------------------------------------------- */

describe('the server is the authority', () => {
  const service = code(SERVICE);

  it('re-checks every mentioned id against live membership', () => {
    expect(service).toContain('conversationMember.findMany');
    expect(service).toContain('leftAt: null');
  });

  it('refuses mentions outside a group', () => {
    expect(service).toContain("input.conversationType !== 'GROUP'");
  });

  it('checks the written text against the mentioned person’s name', () => {
    // What stops a message reading "@Harsh" while quietly notifying somebody else.
    expect(service).toContain('nameById.get');
  });

  it('resolves @everyone from the membership table, never from the payload', () => {
    expect(service).toContain('kind === \'EVERYONE\'');
    expect(service).toContain('conversationId: input.conversationId, leftAt: null');
  });

  it('removes the sender from the recipients LAST, whatever produced them', () => {
    expect(service).toContain('recipients.delete(input.senderId)');
  });

  it('returns a SET, so @everyone and @name cannot double up', () => {
    expect(service).toContain('new Set<string>()');
  });

  it('the client and server agree on the cap', () => {
    expect(CLIENT_MAX).toBe(SERVER_MAX);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 18, 19 — reply and forward                                                                     */
/* -------------------------------------------------------------------------------------------- */

describe('quoting and forwarding create no mentions', () => {
  it('forwarding copies no mention rows', () => {
    /*
     * A forwarded copy may still READ "@Nilesh" as plain text, but it must not mention the
     * original Nilesh or resolve into a member of the destination. `forwardMessage` never names
     * the mention model, so there is nothing to copy — asserted here and proven against the
     * database in mentions-service.test.ts.
     */
    const actions = code('lib/messages/actions.ts');
    const forward = actions.slice(actions.indexOf('export async function forwardMessage'));
    expect(forward).not.toContain('messageMention');
    expect(forward).not.toContain('validateMentions');
  });

  it('a reply carries no mentions of its own from the quoted text', () => {
    // The composer sends only what IT confirmed; a quoted preview is not part of the new body.
    expect(code(RULES)).not.toContain('replyTo');
    expect(code(SERVICE)).not.toContain('replyTo');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 12 — deletion                                                                                  */
/* -------------------------------------------------------------------------------------------- */

describe('deleting a message removes its mentions', () => {
  it('delete-for-everyone deletes the rows in the same transaction as the tombstone', () => {
    const actions = code('lib/messages/actions.ts');
    expect(actions).toContain('tx.messageMention.deleteMany({ where: { messageId: input.messageId } })');
  });

  it('a tombstone also serializes an empty mention list', () => {
    // Belt and braces, exactly as `body` already is: an older row cannot render either.
    expect(code('lib/realtime/events.ts')).toContain('mentions: deleted');
  });

  it('the schema cascades mentions from the message', () => {
    expect(source(SCHEMA)).toContain(
      'message       Message @relation(fields: [messageId], references: [id], onDelete: Cascade)',
    );
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Schema and migration                                                                           */
/* -------------------------------------------------------------------------------------------- */

describe('the migration is additive', () => {
  /*
   * The STATEMENTS, with the `--` prose stripped out first.
   *
   * The migration's header explains what it does not do — it names `DROP TABLE` while describing
   * how a rollback would work — and an assertion that the file "never says DROP TABLE" would be
   * a claim about the documentation rather than about the SQL. Same distinction the `code()`
   * helper draws for TypeScript.
   */
  const sql = source(MIGRATION)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

  it('creates a table and an enum and alters nothing existing', () => {
    expect(sql).toContain('CREATE TABLE "MessageMention"');
    expect(sql).toContain('CREATE TYPE "MentionKind"');

    for (const forbidden of ['DROP TABLE', 'DROP COLUMN', 'ALTER COLUMN', 'TRUNCATE', 'DELETE FROM']) {
      expect(sql, forbidden).not.toContain(forbidden);
    }
  });

  it('back-fills nothing, so historical messages are untouched', () => {
    expect(sql).not.toContain('INSERT INTO');
    expect(sql).not.toContain('UPDATE "Message"');
  });

  it('only alters the tables it must, to add the two foreign keys', () => {
    const alters = sql.match(/ALTER TABLE "(\w+)"/g) ?? [];
    expect([...new Set(alters)]).toEqual(['ALTER TABLE "MessageMention"']);
  });

  it('adds exactly ONE index, and it is the uniqueness constraint', () => {
    const indexes = sql.match(/CREATE (UNIQUE )?INDEX/g) ?? [];
    expect(indexes).toHaveLength(1);
    expect(sql).toContain('CREATE UNIQUE INDEX "MessageMention_messageId_startOffset_key"');
  });

  it('leaves mentionedUserId unindexed, deliberately', () => {
    // Nothing queries "messages that mention me"; the index would arrive with that query.
    expect(sql).not.toContain('INDEX "MessageMention_mentionedUserId');
  });

  it('the schema declares the new model and nothing else new', () => {
    const models = [...source(SCHEMA).matchAll(/^model (\w+)/gm)].map((match) => match[1]);
    expect(models).toEqual([
      'User',
      'Session',
      'Device',
      'Conversation',
      'ConversationMember',
      'Message',
      'Attachment',
      'MessageReaction',
      'MessageMention',
      'MessageHide',
    ]);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 27, 28 — earlier batches still work                                                            */
/* -------------------------------------------------------------------------------------------- */

describe('Batches 1.1 to 1.6 are not regressed', () => {
  const composer = source(COMPOSER);

  it('spellcheck is still on, and still inherits its dictionary (Batch 1.5)', () => {
    expect(composer).toContain('spellCheck={COMPOSER_SPELLCHECK}');
    expect(code(COMPOSER)).not.toContain('spellCheck={false}');
  });

  it('the right-click menu still stands aside in a browser (Batch 1.5)', () => {
    const handler = code(COMPOSER).slice(
      code(COMPOSER).indexOf('const openComposerMenu'),
      code(COMPOSER).indexOf('const closeComposerMenu'),
    );
    expect(handler).toMatch(/if \(!shouldUseCustomComposerMenu\(\)\) return;/);
    expect(handler.indexOf('shouldUseCustomComposerMenu')).toBeLessThan(
      handler.indexOf('preventDefault'),
    );
  });

  it('Ctrl+V is still untouched (Batch 1.2)', () => {
    expect(code(COMPOSER)).not.toContain('onPaste={');
    expect(composer).toContain('pasteIntoComposer');
  });

  it('Enter still sends and Shift+Enter still adds a line', () => {
    expect(composer).toContain("if (event.key === 'Enter' && !event.shiftKey)");
  });

  it('THE PICKER TAKES ENTER FIRST, so choosing a name cannot send the message', () => {
    /*
     * The ordering IS the guarantee. If the send branch came first, pressing Enter to pick a
     * colleague would fire off a half-written sentence.
     */
    const keydown = composer.slice(composer.indexOf('const onKeyDown'));
    expect(keydown.indexOf('if (mentionOpen)')).toBeLessThan(
      keydown.indexOf("if (event.key === 'Enter' && !event.shiftKey)"),
    );
  });

  it('Escape closes the picker before it reaches reply or edit', () => {
    const keydown = composer.slice(composer.indexOf('const onKeyDown'));
    expect(keydown.indexOf('closeMentionPicker()')).toBeLessThan(
      keydown.indexOf('onCancelReply()'),
    );
  });

  it('reply, edit and attachments are still wired', () => {
    for (const piece of ['replyTarget', 'editTarget', 'onSaveEdit', 'onSendFile', 'fileInputRef']) {
      expect(composer, piece).toContain(piece);
    }
  });

  it('global search still reads the plain body, unaffected by mentions (Batch 1.6)', () => {
    // Search matches `Message.body`, which still contains "@Nilesh" as ordinary text.
    const search = code('lib/search/service.ts');
    expect(search).toContain('body: { contains: query');
    expect(search).not.toContain('mention');
  });

  it('the message list still renders text as text', () => {
    // Mentions are a wrapping span chosen by offsets — never markup found in the characters.
    const list = code(LIST);
    expect(list).toContain('segmentMessageBody');
    expect(list).not.toContain('dangerouslySetInnerHTML');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 29-32 — clients                                                                                */
/* -------------------------------------------------------------------------------------------- */

describe('standard web, no desktop dependency', () => {
  it('uses no Electron API anywhere in the mention code', () => {
    for (const path of [RULES, PICKER, COMPOSER, LIST]) {
      const text = code(path);
      for (const forbidden of ['ipcRenderer', 'risingPathDesktop', 'electron', 'require(']) {
        expect(text, `${path}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('the picker fetches nothing — the member list is already in state', () => {
    /*
     * The performance rule: typing "@" must not become a request per keystroke. The picker
     * receives candidates as a prop and the rules module has no way to ask for more.
     */
    for (const path of [RULES, PICKER]) {
      const text = code(path);
      expect(text, path).not.toContain('fetch(');
      expect(text, path).not.toContain('/api/');
    }
  });

  it('the rules module imports only a type', () => {
    const imports = code(RULES)
      .split('\n')
      .filter((line) => line.trimStart().startsWith('import '));

    expect(imports).toEqual(["import type { MentionWire } from '@/lib/chat/wire';"]);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Accessibility                                                                                  */
/* -------------------------------------------------------------------------------------------- */

describe('the picker is reachable from the keyboard', () => {
  const picker = source(PICKER);
  const composer = source(COMPOSER);

  it('is a listbox owned by the textarea, which keeps focus', () => {
    /*
     * A combobox, not a menu of buttons: focus must stay in the message being written, so the
     * current option is NAMED by `aria-activedescendant` rather than focused.
     */
    expect(picker).toContain('role="listbox"');
    expect(picker).toContain('role="option"');
    expect(composer).toContain('role="combobox"');
    expect(composer).toContain('aria-activedescendant');
  });

  it('binds aria-expanded to the real state', () => {
    expect(composer).toContain('aria-expanded={mentionOpen}');
    expect(composer).not.toMatch(/aria-expanded="(true|false)"/);
  });

  it('associates the field with the list it controls', () => {
    expect(composer).toContain('aria-controls={MENTION_LIST_ID}');
    expect(picker).toContain('id={listId}');
  });

  it('marks the active option as selected', () => {
    expect(picker).toContain('aria-selected={active}');
  });

  it('labels the list and explains @everyone in words', () => {
    expect(picker).toContain('aria-label="Mention someone in this group"');
    expect(picker).toContain('MENTION_EVERYONE_DESCRIPTION');
  });

  it('supports arrow keys, Enter, Tab and Escape', () => {
    const keydown = composer.slice(composer.indexOf('const onKeyDown'));
    for (const key of ["'ArrowDown'", "'ArrowUp'", "'Enter'", "'Tab'", "'Escape'"]) {
      expect(keydown, key).toContain(key);
    }
  });

  it('mouse hover drives the SAME active index as the keyboard', () => {
    // So there is never a hover highlight and a keyboard highlight disagreeing about Enter.
    expect(picker).toContain('onHoverIndex(index)');
    expect(composer).toContain('onHoverIndex={setMentionIndex}');
  });

  it('selects on mousedown, so the caret is not lost to a blur first', () => {
    expect(picker).toContain('onMouseDown');
    expect(picker).toContain('event.preventDefault()');
  });
});
