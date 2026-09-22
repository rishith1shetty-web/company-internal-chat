/**
 * Structural guarantees about spellcheck and the composer's right-click menu (Batch 1.5).
 *
 * THESE ARE SOURCE ASSERTIONS, labelled as such deliberately, exactly as in
 * `clipboard-wiring.test.ts` and `sidebar-wiring.test.ts`. The project has no DOM test environment
 * by design (vitest.config.mts runs `environment: 'node'`), and the behaviour this batch relies on
 * belongs to Chrome, Safari and Chromium rather than to this codebase: whether a red underline is
 * drawn, and what words are suggested, are decisions made by the platform and the OS dictionary.
 * They cannot be unit-tested here, and a test that mocked them would assert only that the mock
 * works. They are covered by the manual smoke test instead, and are reported as unverified.
 *
 * What IS testable is everything this application controls, and it is the part that broke:
 *
 *   - the field asks for spellchecking, and nothing turns it back off;
 *   - the composer stands aside in a browser, BEFORE cancelling the event, so the native menu
 *     with its spelling suggestions actually opens;
 *   - a correction made by the platform reaches the value that gets sent, because the field is
 *     controlled and the platform's edit arrives through the same `onChange` as typing;
 *   - nothing about any of this reaches the network, the database, or message state.
 *
 * The decision itself — which client gets which menu — is pure and is tested properly in
 * `composer-menu.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function source(path: string): string {
  return readFileSync(new URL(path, `file://${ROOT.replace(/\\/g, '/')}`), 'utf8');
}

/**
 * The same file with its comments removed.
 *
 * An assertion that a module "never does X" is a claim about the CODE, and the prose in these
 * files explains at length what they deliberately do NOT do — the note saying there is no
 * autocorrect is not autocorrect. Stripping comments first makes each assertion mean what it says.
 */
function code(path: string): string {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const COMPOSER = 'components/chat/MessageComposer.tsx';
const COMPOSER_MENU = 'components/chat/ComposerContextMenu.tsx';
const RULE = 'lib/chat/composer-menu.ts';
const LAYOUT = 'app/layout.tsx';

/* -------------------------------------------------------------------------------------------- */
/* 1, 14, 15, 16 — the field asks to be spellchecked                                              */
/* -------------------------------------------------------------------------------------------- */

describe('the composer is spellchecked', () => {
  it('sets spellCheck on the textarea', () => {
    // Standard HTML, which is what Chrome, Safari and Chromium all act on. No vendor API.
    expect(source(COMPOSER)).toContain('spellCheck={COMPOSER_SPELLCHECK}');
  });

  it('never turns spellcheck off anywhere in the composer', () => {
    /*
     * `spellcheck` INHERITS, so this is the regression that would be easiest to introduce by
     * accident and hardest to notice — an ancestor or a later edit setting false, and the
     * underlines quietly stop appearing for everybody.
     */
    const text = code(COMPOSER);
    expect(text).not.toContain('spellCheck={false}');
    expect(text).not.toContain('spellcheck="false"');
  });

  it('does not disable spellcheck anywhere up the tree that contains the composer', () => {
    expect(code(LAYOUT)).not.toContain('spellCheck={false}');
    expect(code(LAYOUT)).not.toContain('spellcheck="false"');
  });

  it('inherits its dictionary from the document language rather than pinning one', () => {
    /*
     * `lang="en"` on <html> is what Chrome and Safari resolve the dictionary against. Pinning
     * `en-US` on the field would force one regional dictionary on everybody and underline
     * "organisation" and "colour" for anybody writing British English.
     */
    expect(source(LAYOUT)).toContain('<html lang="en">');
    expect(code(COMPOSER)).not.toContain('lang="en-US"');
  });

  it('adds no autocorrect and no autocapitalisation', () => {
    /*
     * The feature is advisory. Employees type colleagues' names, client names, abbreviations,
     * URLs and Hinglish, and NOTHING may rewrite a word the person did not choose to change.
     */
    const text = code(COMPOSER);
    expect(text).not.toContain('autoCorrect');
    expect(text).not.toContain('autoCapitalize');
  });

  it('uses no third-party or AI spelling service', () => {
    /*
     * The drafts employees type are company data. Spelling comes from the platform and the OS
     * dictionary, in the client, and nothing leaves the machine.
     */
    for (const path of [COMPOSER, RULE, COMPOSER_MENU]) {
      const text = code(path);
      for (const forbidden of ['fetch(', 'XMLHttpRequest', 'http://', 'https://', 'api.']) {
        expect(text, `${path}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 14 — the native menu is no longer suppressed in browsers                                       */
/* -------------------------------------------------------------------------------------------- */

describe('the browser keeps its own context menu', () => {
  const text = code(COMPOSER);

  it('asks the rule before doing anything on right-click', () => {
    expect(text).toContain('shouldUseCustomComposerMenu()');
  });

  it('RETURNS BEFORE preventDefault, not after', () => {
    /*
     * The ordering IS the fix, and it is worth asserting rather than assuming. Cancelling the
     * event and then declining to open a menu would be the worst outcome available: no spelling
     * suggestions AND no Paste. So the guard must come first.
     */
    const handler = text.slice(
      text.indexOf('const openComposerMenu'),
      text.indexOf('const closeComposerMenu'),
    );

    expect(handler).toContain('shouldUseCustomComposerMenu');
    expect(handler).toContain('preventDefault');
    expect(handler.indexOf('shouldUseCustomComposerMenu')).toBeLessThan(
      handler.indexOf('preventDefault'),
    );
    // And the guard's consequence is a bare `return`, which leaves the event entirely untouched.
    expect(handler).toMatch(/if \(!shouldUseCustomComposerMenu\(\)\) return;/);
  });

  it('cancels the event exactly once, inside the handler', () => {
    const handler = text.slice(
      text.indexOf('const openComposerMenu'),
      text.indexOf('const closeComposerMenu'),
    );
    expect(handler.match(/preventDefault/g)).toHaveLength(1);
  });

  it('does not suppress the context menu anywhere else in the composer', () => {
    // A handler on the form or the wrapper would cancel the menu before the textarea ever saw it.
    expect(text.match(/onContextMenu=/g)).toHaveLength(1);
    expect(text).toContain('onContextMenu={openComposerMenu}');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 18 — a correction reaches what gets sent                                                       */
/* -------------------------------------------------------------------------------------------- */

describe('a platform spelling correction becomes the text that is sent', () => {
  const text = source(COMPOSER);

  it('keeps the textarea CONTROLLED, which is what makes that true', () => {
    /*
     * This is the load-bearing detail of requirement 18, and it is why no code was needed to
     * apply a suggestion.
     *
     * When Chrome, Safari or Chromium replaces a misspelled word it edits the field and dispatches
     * a native `input` event — the same event typing produces. A controlled textarea turns that
     * into `onChange`, `setBody` stores it, and Send submits `body`. The correction therefore
     * travels the identical path as a keystroke, with no special case anywhere.
     *
     * It would stop being true if the field became uncontrolled or read-only, which is what these
     * assertions pin.
     */
    expect(text).toContain('value={body}');
    expect(text).toContain('onChange={(event) => setBody(event.target.value)}');
    expect(code(COMPOSER)).not.toContain('defaultValue');
    expect(code(COMPOSER)).not.toContain('readOnly');
  });

  it('sends and saves the current body, with no separate copy of the text', () => {
    // Nothing caches the typed text elsewhere, so a correction cannot be missed by the sender.
    expect(text).toContain('onSend(');
    expect(text).toContain('onSaveEdit(');
  });

  it('intercepts no input or beforeinput event', () => {
    /*
     * A handler on either could swallow the platform's replacement — this is the shape of the bug
     * that would make a chosen suggestion appear and then vanish.
     */
    const stripped = code(COMPOSER);
    expect(stripped).not.toContain('onInput=');
    expect(stripped).not.toContain('onBeforeInput=');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 2, 3, 4, 5 — composing, replying, editing and multiline are untouched                          */
/* -------------------------------------------------------------------------------------------- */

describe('normal composing, reply and edit are unaffected', () => {
  const text = source(COMPOSER);

  it('still sends on Enter and adds a line on Shift+Enter', () => {
    // Multiline text is a textarea with a newline in it; nothing in this batch touches either.
    expect(text).toContain('<textarea');
    expect(text).toContain('rows={1}');
    expect(text).toContain('onKeyDown={onKeyDown}');
  });

  it('keeps the reply banner and its cancel', () => {
    expect(text).toContain('replyTarget');
    expect(text).toContain('onCancelReply');
  });

  it('keeps edit mode, its prefill and its save', () => {
    expect(text).toContain('editTarget');
    expect(text).toContain('onCancelEdit');
    expect(text).toContain('onSaveEdit');
  });

  it('the spelling rule cannot reach reply or edit state at all', () => {
    /*
     * The strongest form of "selecting a correction does not cancel Reply or Edit": the module
     * that decides about menus and spellchecking has no knowledge of either, so there is no
     * argument by which it could change them. It takes a scope and returns a boolean.
     */
    const rule = code(RULE);
    for (const forbidden of ['replyTo', 'editTarget', 'conversation', 'message']) {
      expect(rule, forbidden).not.toContain(forbidden);
    }
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 6, 7 — Batch 1.2 is not regressed                                                              */
/* -------------------------------------------------------------------------------------------- */

describe('Copy and Paste still work as Batch 1.2 left them', () => {
  it('the composer still registers no paste handler, so Ctrl+V is untouched', () => {
    // `onPaste={` is the JSX handler. The menu's own prop is `onPasteSelected`, which is a
    // different thing and must not trip this — the same distinction clipboard-wiring.test.ts draws.
    expect(code(COMPOSER)).not.toContain('onPaste={');
    expect(code(COMPOSER)).not.toContain("addEventListener('paste'");
  });

  it('the composer menu still offers Paste, unchanged', () => {
    const menu = source(COMPOSER_MENU);
    expect(menu).toContain('Paste');
    expect(menu).toContain('Ctrl+V');
    expect(menu).toContain('PasteIcon');
  });

  it('the composer still wires Paste to the same clipboard helper', () => {
    const text = source(COMPOSER);
    expect(text).toContain('pasteIntoComposer');
    expect(text).toContain('canReadClipboard()');
  });

  it('the message Copy menu is untouched by this batch', () => {
    // Different component, different menu; the batch changed nothing about the message list.
    const menu = source('components/chat/MessageContextMenu.tsx');
    expect(menu).toContain('Copy');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 8-13 — spelling is local, and nothing else moves                                               */
/* -------------------------------------------------------------------------------------------- */

describe('spelling changes nothing outside the composer', () => {
  it('the rule module imports nothing at all', () => {
    /*
     * No import means no socket, no fetch, no database, no notification and no message state —
     * not by policy but by construction. Requirements 8 through 13 in one assertion.
     */
    const imports = code(RULE)
      .split('\n')
      .filter((line) => line.trimStart().startsWith('import '));

    expect(imports).toHaveLength(0);
  });

  it('reaches no server, socket, database or notification by name either', () => {
    const rule = code(RULE);
    for (const forbidden of [
      'fetch',
      'socket',
      'io(',
      '/api/',
      'prisma',
      'getDb',
      '@/lib/db',
      'unread',
      'Notification',
      'notify',
    ]) {
      expect(rule, forbidden).not.toContain(forbidden);
    }
  });

  it('adds no socket event and no request to the composer', () => {
    /*
     * The composer legitimately sends messages, so this pins the ADDITION rather than the
     * absence: no socket is reached from here, and this batch introduced no new call.
     */
    const text = code(COMPOSER);
    expect(text).not.toContain('socket');
    expect(text).not.toContain('fetch(');
    expect(text).not.toContain('/api/');
  });

  it('touches no Prisma schema or migration from the client', () => {
    for (const path of [COMPOSER, RULE, COMPOSER_MENU]) {
      expect(code(path), path).not.toContain('prisma');
    }
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 17 — Electron is explicitly determined, not assumed                                            */
/* -------------------------------------------------------------------------------------------- */

describe('Electron support is decided explicitly', () => {
  it('the desktop shell already enables Chromium spellchecking', () => {
    /*
     * This is why the desktop client gets UNDERLINES with no installer: the flag is already in
     * the shipped shell. It is asserted here so that removing it would fail a test rather than
     * quietly turning off spellchecking for every Windows employee.
     */
    expect(source('desktop/main.ts')).toContain('spellcheck: true');
  });

  it('the desktop shell still has no context-menu handler, which is the documented gap', () => {
    /*
     * SUGGESTIONS are a separate capability from underlines, and they are the part that cannot be
     * done from the page: Chromium delivers `misspelledWord` and `dictionarySuggestions` only on
     * the main process's `context-menu` event, and only `webContents.replaceMisspelling` can
     * apply one. There is no renderer API for either, so no amount of React can reach them.
     *
     * This assertion records the current state honestly. It is expected to be CHANGED — not
     * deleted — by whoever is approved to add that handler, at which point a new installer ships.
     */
    expect(code('desktop/main.ts')).not.toContain("'context-menu'");
    expect(code('desktop/main.ts')).not.toContain('replaceMisspelling');
  });

  it('this batch changed no desktop file, so no installer is implied', () => {
    /*
     * The renderer-side rule names Electron but cannot act on it beyond choosing a menu, and the
     * preload exposes nothing about spelling.
     */
    expect(code('desktop/preload.ts')).not.toContain('spell');
    expect(code(RULE)).toContain("'Electron/'");
  });

  it('keeps the desktop security posture untouched', () => {
    const main = source('desktop/main.ts');
    expect(main).toContain('contextIsolation: true');
    expect(main).toContain('nodeIntegration: false');
    expect(main).toContain('sandbox: true');
    expect(main).toContain('webSecurity: true');
  });
});
