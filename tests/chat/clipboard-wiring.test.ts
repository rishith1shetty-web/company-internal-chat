/**
 * Structural guarantees about the clipboard work that a Node test cannot demonstrate behaviourally.
 *
 * THESE ARE SOURCE ASSERTIONS, and they are labelled as such deliberately. The project has no DOM
 * test environment (vitest.config.mts says so, and adding jsdom and a testing library for this
 * would be a large dependency for a small feature), so a few of the Batch 1.2 requirements cannot
 * be driven through a rendered component. They are not, however, unverifiable: each one below is a
 * property of the source that would have to be broken deliberately, and a regression in any of
 * them fails this file.
 *
 * What is checked here, and why each matters:
 *
 *   - The composer intercepts no `paste` event, so native Ctrl+V / Cmd+V keeps working. The custom
 *     menu was asked for as an ADDITION to the keyboard, never a replacement, and the way that
 *     promise gets broken is somebody adding an `onPaste` handler that calls `preventDefault`.
 *   - Neither menu is hand-rolled: both use the shared `useAnchoredMenu`, whose right-click
 *     listener closes the other one. That is what makes "the two menus never conflict" true, so
 *     it is worth asserting that neither component has drifted back to its own implementation.
 *   - No clipboard content is ever set as HTML, anywhere in the chat interface.
 *   - The clipboard module reaches nothing that could turn a local action into a remote one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function source(path: string): string {
  return readFileSync(new URL(path, `file://${ROOT.replace(/\\/g, '/')}`), 'utf8');
}

const COMPOSER = 'components/chat/MessageComposer.tsx';
const MESSAGE_MENU = 'components/chat/MessageContextMenu.tsx';
const COMPOSER_MENU = 'components/chat/ComposerContextMenu.tsx';
const MESSAGE_LIST = 'components/chat/MessageList.tsx';
const CLIPBOARD = 'lib/chat/clipboard.ts';

describe('native keyboard paste is left alone', () => {
  it('the composer registers no paste handler at all', () => {
    const text = source(COMPOSER);

    /*
     * Ctrl+V is a trusted user action: the browser writes into the field and React sees an
     * ordinary change event. Nothing has to be done to support it — but it is easy to BREAK, by
     * adding an `onPaste` that preventDefaults in order to "handle pasting properly".
     */
    // `onPaste={` is the JSX handler, not a mention in a comment. The composer's own menu prop
    // is deliberately called `onPasteSelected` so that this check stays unambiguous.
    expect(text).not.toContain('onPaste={');
    expect(text).not.toContain("addEventListener('paste'");
  });

  it('the composer intercepts only the context menu, and only to replace it', () => {
    const text = source(COMPOSER);

    // One preventDefault on `contextmenu` is the whole interception. It stops the browser's own
    // menu (or, in Electron, nothing at all) so ours can take its place.
    expect(text).toContain('onContextMenu={openComposerMenu}');
    expect(text).toContain('event.preventDefault()');
  });

  it('the composer does not intercept the copy or cut events either', () => {
    const text = source(COMPOSER);
    expect(text).not.toContain('onCopy={');
    expect(text).not.toContain('onCut={');
  });
});

describe('the two context menus cannot conflict', () => {
  it('both are built on the shared anchored-menu behaviour', () => {
    /*
     * The shared hook closes an open menu on any right-click outside it, so opening either menu
     * closes the other and both can never be open at once. A component that re-implemented its own
     * dismissal would quietly lose that.
     */
    for (const path of [MESSAGE_MENU, COMPOSER_MENU]) {
      expect(source(path), path).toContain('useAnchoredMenu');
    }
  });

  it('neither menu hand-rolls its own dismissal listeners', () => {
    for (const path of [MESSAGE_MENU, COMPOSER_MENU]) {
      const text = source(path);
      expect(text, path).not.toContain("addEventListener('contextmenu'");
      expect(text, path).not.toContain("addEventListener('pointerdown'");
    }
  });

  it('the shared hook closes on every route a menu should close by', () => {
    const hook = source('lib/ui/useAnchoredMenu.ts');

    for (const listener of [
      "addEventListener('pointerdown'", // a click elsewhere
      "addEventListener('contextmenu'", // a right-click elsewhere — the anti-conflict rule
      "addEventListener('keydown'", // Escape
      "addEventListener('resize'",
      "addEventListener('scroll'",
    ]) {
      expect(hook, listener).toContain(listener);
    }

    // And removes every one of them again: a menu that leaked listeners would close menus that
    // are no longer open.
    for (const listener of [
      "removeEventListener('pointerdown'",
      "removeEventListener('contextmenu'",
      "removeEventListener('keydown'",
      "removeEventListener('resize'",
      "removeEventListener('scroll'",
    ]) {
      expect(hook, listener).toContain(listener);
    }
  });

  it('Escape in a menu is stopped there, so it cannot also cancel a reply or an edit', () => {
    expect(source('lib/ui/useAnchoredMenu.ts')).toContain('event.stopPropagation()');
  });
});

describe('clipboard content is never treated as markup', () => {
  it('no chat component sets HTML directly', () => {
    for (const path of [COMPOSER, COMPOSER_MENU, MESSAGE_MENU, MESSAGE_LIST]) {
      // The USE, `dangerouslySetInnerHTML={`, not the name — MessageList mentions it in a
      // comment explaining that it is deliberately not used, and that comment should stay.
      expect(source(path), path).not.toContain('dangerouslySetInnerHTML={');
    }
  });

  it('the clipboard module renders nothing and parses nothing', () => {
    const text = source(CLIPBOARD);
    expect(text).not.toContain('innerHTML');
    expect(text).not.toContain('DOMParser');
    // `readText` only. Reading `text/html` off the clipboard is the shape of the mistake.
    expect(text).not.toContain("'text/html'");
  });
});

describe('the clipboard module is local-only by construction', () => {
  it('imports nothing that could make a request or emit an event', () => {
    const text = source(CLIPBOARD);

    /*
     * The cheapest possible proof that Copy and Paste cannot create a database record, send an
     * API request, emit a socket event, move an unread count or raise a notification: there is no
     * import through which any of it could happen.
     */
    for (const forbidden of [
      '@/lib/chat/api',
      '@/lib/chat/socket',
      '@/lib/notifications',
      'socket.io',
      'fetch(',
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('its only import is a type', () => {
    const imports = source(CLIPBOARD)
      .split('\n')
      .filter((line) => line.startsWith('import '));

    expect(imports).toEqual(["import type { ChatMessage } from '@/lib/chat/types';"]);
  });
});
