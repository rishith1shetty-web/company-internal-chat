/**
 * Clipboard access for the chat interface (Batch 1.2).
 *
 * ENTIRELY CLIENT-SIDE. Nothing here makes a request, opens a socket, touches unread state or
 * raises a notification. Copying and pasting are things that happen inside one browser, and this
 * module imports nothing that could make them anything else.
 *
 * WHY THIS EXISTS AT ALL, rather than `navigator.clipboard.writeText` at the call site.
 *
 * `navigator.clipboard` is a PERMISSIONED API. In Chromium, `writeText` performs a
 * `clipboard-sanitized-write` permission check and `readText` a `clipboard-read` check. In an
 * ordinary browser on an HTTPS origin the write check is granted automatically when the call
 * happens during a user gesture, so it simply works.
 *
 * **Inside the desktop client it does not.** `hardenSession` in desktop/main.ts installs
 *
 *     target.setPermissionCheckHandler(() => false);
 *
 * which refuses EVERY permission — deliberately, so a compromised page cannot prompt an employee
 * for a camera or a microphone inside a window that looks like a company application. Electron's
 * permission list includes `clipboard-read` and `clipboard-sanitized-write`, so that one line
 * also denies the async clipboard API. `navigator.clipboard.writeText()` therefore rejects with
 * `NotAllowedError` in the client every employee actually uses, and the old call site swallowed
 * the rejection — which is exactly why Copy appeared to do nothing at all.
 *
 * THE FALLBACK, and why it is the right one. `document.execCommand('copy')` is legacy and
 * deprecated, but it is gated on USER ACTIVATION rather than on the permissions system, so
 * Electron's blanket denial does not reach it. It works in the desktop client, in Chrome, in Edge
 * and in Safari, and it needs no change to the desktop application — which means fixing Copy costs
 * no new installer and no employee re-enrolment.
 *
 * READING IS DIFFERENT, and cannot be fixed the same way: `document.execCommand('paste')` is
 * disabled outright for web content in Chromium, for the obvious reason that a page that could
 * read the clipboard without asking would be reading whatever you last copied. So
 * `readClipboardText` reports honestly whether it could read, and the interface offers Paste only
 * when it can. Native Ctrl+V is unaffected by any of this — it is a trusted user action, carries
 * its own data, and needs no permission.
 *
 * The browser surface is INJECTED rather than reached for directly, following the pattern the
 * notification layer already uses (lib/notifications/electron.ts): the real one is read from the
 * globals by `browserClipboard()`, and tests hand in a fake. That is what makes the failure paths
 * — a missing API, a rejected promise, a refused `execCommand` — testable at all, in a Node test
 * environment with no DOM.
 */

import type { ChatMessage } from '@/lib/chat/types';

/**
 * The parts of the browser this module uses.
 *
 * Every member is optional because every one of them can genuinely be absent: an insecure origin
 * has no `navigator.clipboard`, a locked-down Electron session has it but refuses it, and a
 * document-less environment has no `execCommand`.
 */
export interface ClipboardSurface {
  writeText?: ((text: string) => Promise<void>) | undefined;
  readText?: (() => Promise<string>) | undefined;
  /** The legacy `document.execCommand('copy')` path. True when the copy took. */
  execCopy?: ((text: string) => boolean) | undefined;
}

/**
 * The real browser surface.
 *
 * Resolved on every call rather than captured once: `navigator.clipboard` is absent on an
 * insecure origin, and a module-level snapshot taken during server rendering would be wrong for
 * the lifetime of the page.
 */
export function browserClipboard(): ClipboardSurface {
  const api = typeof navigator === 'undefined' ? undefined : navigator.clipboard;

  return {
    writeText: api?.writeText ? (text: string) => api.writeText(text) : undefined,
    readText: api?.readText ? () => api.readText() : undefined,
    execCopy: typeof document === 'undefined' ? undefined : execCommandCopy,
  };
}

/**
 * Copies text using the legacy path, which no permission check can refuse.
 *
 * The textarea is real and in the document, because a selection can only be made inside a node
 * that is laid out — but it is fixed at the top-left corner with zero opacity and is removed again
 * in the same tick, so nothing is ever visible and the page does not scroll to it.
 *
 * Focus is captured and restored around the call. Without that, copying from the message list
 * would silently take focus away from wherever the employee had it.
 */
function execCommandCopy(text: string): boolean {
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const field = document.createElement('textarea');

  field.value = text;
  // `readOnly` keeps a mobile keyboard from appearing; `select()` still works on a read-only field.
  field.readOnly = true;
  field.setAttribute('aria-hidden', 'true');
  field.tabIndex = -1;
  field.style.position = 'fixed';
  field.style.top = '0';
  field.style.left = '0';
  field.style.width = '1px';
  field.style.height = '1px';
  field.style.padding = '0';
  field.style.border = 'none';
  field.style.opacity = '0';
  // Belt and braces against a browser scrolling the document to the selection.
  field.style.pointerEvents = 'none';

  document.body.appendChild(field);

  try {
    field.select();
    field.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
    previouslyFocused?.focus?.();
  }
}

/**
 * Puts text on the clipboard. Resolves true only when it actually got there.
 *
 * The modern API first, the legacy path when it is missing or refused. The return value is the
 * whole point: the interface must not claim "Copied" for a copy that did not happen, which is
 * precisely what the previous implementation did by swallowing the rejection.
 *
 * Empty text is refused rather than written — clearing somebody's clipboard is not what choosing
 * Copy on a message means.
 */
export async function writeClipboardText(
  text: string,
  surface: ClipboardSurface = browserClipboard(),
): Promise<boolean> {
  if (text.length === 0) return false;

  if (surface.writeText) {
    try {
      await surface.writeText(text);
      return true;
    } catch {
      // Refused (the desktop client) or unavailable. Fall through to the legacy path rather than
      // reporting failure — this is the case that made Copy look broken.
    }
  }

  try {
    return surface.execCopy?.(text) ?? false;
  } catch {
    return false;
  }
}

/**
 * Reads plain text from the clipboard.
 *
 * Three outcomes, deliberately distinguished:
 *
 *   a string  — the clipboard was read; it may be empty, which is a real answer
 *   null      — it could NOT be read: no API, or permission refused
 *
 * The interface needs the difference. "The clipboard is empty" and "this application is not
 * allowed to look" call for different words, and collapsing them into `''` would make the desktop
 * client claim the employee's clipboard was empty when it had never been consulted.
 */
export async function readClipboardText(
  surface: ClipboardSurface = browserClipboard(),
): Promise<string | null> {
  if (!surface.readText) return null;

  try {
    const text = await surface.readText();
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/**
 * Whether this browser exposes a clipboard read API at all.
 *
 * Deliberately a CAPABILITY check and not a permission check: it looks for the function and never
 * calls it, so it costs nothing and — importantly — cannot make a browser show a permission prompt
 * merely because somebody right-clicked.
 *
 * It therefore answers false only for a browser that has no such API: an insecure origin, or one
 * too old for it. It answers TRUE inside the desktop client, where the API exists and is refused
 * when used. That is the right split for the interface: an absent API means the menu row can be
 * disabled honestly up front, while a refusal can only be discovered by trying, and is explained
 * at the moment it happens.
 */
export function canReadClipboard(surface: ClipboardSurface = browserClipboard()): boolean {
  return typeof surface.readText === 'function';
}

/**
 * What choosing Copy on a message puts on the clipboard.
 *
 * Pure, and separated from the act of copying so the rule can be read and tested on its own:
 *
 *   a text message              → its text
 *   a file with a caption       → the caption, which is the part made of words
 *   a file with no caption      → its filename, as plain text
 *   a tombstone, or nothing     → nothing, and Copy is not offered
 *
 * NEVER the bytes. An attachment-only message copies its NAME; there is no path here by which a
 * file's contents could reach the clipboard, which is why this returns a string and not a blob.
 */
export function copyTextFor(message: ChatMessage): string {
  if (message.deletedAt !== null) return '';
  return message.body?.trim() || message.attachment?.filename || '';
}

export interface PasteTarget {
  /** The composer's current text. */
  value: string;
  /** Selection start, as the textarea reports it. */
  selectionStart: number;
  /** Selection end. Equal to the start when nothing is selected. */
  selectionEnd: number;
}

export interface PasteResult {
  value: string;
  /** Where the caret belongs afterwards: immediately after what was inserted. */
  cursor: number;
}

/**
 * Inserts pasted text into the composer's value.
 *
 * Pure: it takes the text and a selection and returns the new text and where the caret goes. All
 * of the behaviour worth arguing about lives here rather than in an event handler, which is what
 * makes it testable without a DOM.
 *
 *   - Text already in the composer is PRESERVED, including newlines. Pasting is an insertion, not
 *     a replacement of everything.
 *   - Inserted AT THE CARET, not appended, so pasting into the middle of a sentence works.
 *   - A SELECTION IS REPLACED, which is what every text field does and what a user expects.
 *   - The caret ends up after the inserted text, ready to keep typing.
 *
 * The pasted text is treated as text and nothing else. Markup in it stays markup-as-characters:
 * it goes into a controlled `value`, React renders it as a text node, and nothing in this
 * application ever sets it as HTML.
 *
 * Carriage returns are normalised away because a textarea's own value never contains them — text
 * copied from a Windows application otherwise arrives with `\r\n` and the composer's length count
 * disagrees with what the server will store.
 *
 * NOT length-capped, on purpose: native Ctrl+V is not capped either, and a menu that silently
 * truncated where the keyboard did not would be the more surprising of the two. An over-long
 * message is already caught by the composer's own counter and by the server.
 */
/**
 * What a paste attempt did.
 *
 * Three outcomes rather than a nullable value, because the interface says something different
 * about each and must not confuse them:
 *
 *   inserted — text went in; the caller renders `value` and puts the caret at `cursor`
 *   empty    — the clipboard was read and held nothing; say nothing, do nothing
 *   refused  — the clipboard could not be read; tell the employee the way that does work
 */
export type PasteOutcome =
  | { kind: 'inserted'; value: string; cursor: number }
  | { kind: 'empty' }
  | { kind: 'refused' };

/**
 * Reads the clipboard and works out what the composer should now contain.
 *
 * The whole paste decision, deliberately out of the component: it takes a value and a selection
 * and returns a value and a caret, so it can be tested exhaustively in a Node environment with no
 * DOM — which is the only environment this project's test suite has (vitest.config.mts).
 *
 * IT TAKES NO MODE AND NO CONVERSATION, and that is a property rather than an omission. There is
 * no argument here by which replying, editing, a direct chat or a group could change the result,
 * so pasting behaves identically in all four and cannot cancel a reply or an edit — there is
 * nothing here that could.
 */
export async function pasteIntoComposer(
  target: PasteTarget,
  surface: ClipboardSurface = browserClipboard(),
): Promise<PasteOutcome> {
  const text = await readClipboardText(surface);

  if (text === null) return { kind: 'refused' };
  if (text.length === 0) return { kind: 'empty' };

  const { value, cursor } = applyPaste(target, text);
  return { kind: 'inserted', value, cursor };
}

export function applyPaste(target: PasteTarget, pasted: string): PasteResult {
  const text = pasted.replace(/\r\n?/g, '\n');

  // Defensive: a selection can arrive reversed, and a stale index can point past the end.
  const length = target.value.length;
  const start = Math.max(0, Math.min(target.selectionStart, target.selectionEnd, length));
  const end = Math.min(Math.max(target.selectionStart, target.selectionEnd), length);

  return {
    value: target.value.slice(0, start) + text + target.value.slice(end),
    cursor: start + text.length,
  };
}
