/**
 * Which right-click menu the composer should show — the platform's own, or ours (Batch 1.5).
 *
 * THE PROBLEM THIS SOLVES. Batch 1.2 added a custom Paste menu to the composer because
 * **Electron has no default context menu for web content**: right-clicking the text field in the
 * desktop client did nothing at all. That menu was wired to `onContextMenu` with an unconditional
 * `event.preventDefault()`, which is correct in Electron and wrong everywhere else — in Chrome and
 * Safari it also suppresses the browser's OWN menu, and with it the spelling suggestions that
 * appear when you right-click a misspelled word. The desktop client's missing menu was being
 * fixed at the cost of the browser's working one.
 *
 * THE RULE, and it is the whole of this module: show our menu only where there is no native one.
 *
 *   browser (Mac Chrome, Mac Safari)  → let the native menu through. It already offers spelling
 *                                       suggestions AND Cut/Copy/Paste, both better than ours:
 *                                       the suggestions come from the OS dictionary, and native
 *                                       Paste is a trusted user action that no permission check
 *                                       can refuse.
 *   desktop client (Electron)         → show ours, exactly as before. There is nothing to let
 *                                       through.
 *
 * So the browser gains spelling suggestions, the desktop client keeps the menu it has, and
 * neither is rebuilt to imitate the other. Nothing here replaces a native menu that exists.
 *
 * ENTIRELY LOCAL. This module reads two properties of the current page and returns a boolean. It
 * makes no request, opens no socket, and has no import that could make it do either — the same
 * property `lib/chat/clipboard.ts` documents about itself, and for the same reason: a right-click
 * must never be a thing that talks to a server.
 */

/**
 * The parts of the page this module looks at.
 *
 * Injectable, following `ClipboardSurface` and `DesktopScope`, so every branch below can be tested
 * in a Node environment that has neither a `window` nor an Electron bridge.
 */
export interface ContextMenuScope {
  /** The preload bridge, when one loaded. See desktop/preload.ts. */
  risingPathDesktop?: unknown;
  navigator?: { userAgent?: unknown } | undefined;
}

/** The real page, or undefined during server rendering. */
export function browserScope(): ContextMenuScope | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as ContextMenuScope);
}

/**
 * Whether this page is running inside the Rising Path desktop client.
 *
 * TWO INDEPENDENT SIGNALS, EITHER OF WHICH IS ENOUGH — and the redundancy is deliberate rather
 * than defensive habit.
 *
 * The obvious check is the preload bridge, and on its own it is not trustworthy enough for this
 * decision. desktop/preload.ts documents a failure that has actually happened in this project: a
 * sandboxed preload that cannot resolve an import is dropped in its entirety, and "the page
 * silently comes up with no bridge on it". If that recurred, a bridge-only check would conclude
 * "browser", suppress nothing, and leave the desktop client with no context menu at all — a
 * silent regression of Batch 1.2 in the client every Windows employee uses.
 *
 * The user agent cannot be dropped that way: Electron appends `Electron/<version>` to it in the
 * renderer, and it is there before any of our code runs. It is normally a poor thing to branch on,
 * because it is a claim about identity rather than about capability — but what is being asked here
 * IS the identity of the shell, since "does this runtime have a built-in context menu" has no
 * feature test. No browser an employee could be using sends `Electron/` in its user agent, so a
 * false positive would take deliberate spoofing, and the worst it could do is show our one-item
 * Paste menu to somebody who also had a native one.
 *
 * Accepting either signal means both would have to fail together before the desktop client lost
 * its menu.
 */
export function isDesktopClient(scope: ContextMenuScope | undefined = browserScope()): boolean {
  if (!scope) return false;

  const agent = scope.navigator?.userAgent;
  if (typeof agent === 'string' && agent.includes('Electron/')) return true;

  const bridge = scope.risingPathDesktop;
  if (typeof bridge !== 'object' || bridge === null) return false;

  return (bridge as { isDesktop?: unknown }).isDesktop === true;
}

/**
 * Whether the composer should suppress the platform menu and show its own.
 *
 * Named for the decision rather than for the platform, because the platform is the evidence and
 * not the reason: what matters is whether anything would appear if we stood aside. Today that is
 * true exactly in the desktop client, and if Electron ever gains a default menu — or if the
 * desktop shell grows one of its own — this is the single line that changes.
 *
 * A false answer means the handler must ALSO leave `preventDefault` alone. Opening nothing while
 * still cancelling the event would be the worst of both: no suggestions and no Paste.
 */
export function shouldUseCustomComposerMenu(
  scope: ContextMenuScope | undefined = browserScope(),
): boolean {
  return isDesktopClient(scope);
}

/**
 * Whether the composer's text should be spellchecked.
 *
 * Constant, and stated here rather than written inline in the JSX so the promise has somewhere to
 * be documented and somewhere to be tested.
 *
 * ADVISORY ONLY, which is the point. The underline is a hint; nothing in this application reads
 * it, acts on it, blocks a send on it, or reports it anywhere. Employees type colleagues' names,
 * client names, role titles, abbreviations, URLs and Hinglish, and a great many of those will be
 * underlined — that is acceptable precisely because the underline has no consequences. There is
 * deliberately no autocorrect: a word changes only when a person chooses a suggestion.
 *
 * NO LANGUAGE IS PINNED HERE, and that is a decision. The document already declares `lang="en"`
 * (app/layout.tsx), which every engine uses to choose a dictionary, so English is inherited
 * without this module asserting anything. Writing `lang="en-US"` on the field would go further
 * than that and force ONE regional dictionary on everybody — which would underline "organisation",
 * "colour" and "realise" for a recruiting company that plainly may write British English, and
 * would override the variant the employee chose in their own OS settings. Inheriting lets Chrome
 * and Safari resolve `en` against the dictionaries the person actually has.
 */
export const COMPOSER_SPELLCHECK = true;
