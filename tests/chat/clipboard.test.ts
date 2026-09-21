/**
 * Copy and paste in the chat interface (Batch 1.2).
 *
 * THE BUG THESE EXIST FOR. `navigator.clipboard.writeText` is permissioned, and the desktop
 * client's session refuses every permission (`setPermissionCheckHandler(() => false)` in
 * desktop/main.ts). So in the client every employee uses, the modern clipboard API rejects — and
 * the previous implementation caught the rejection and said nothing, which is why Copy appeared to
 * do nothing at all. Most of this file is about the fallback that fixes it and about never again
 * claiming a copy that did not happen.
 *
 * NO DOM. The test environment is Node (vitest.config.mts), so the browser surface is INJECTED and
 * faked — the same approach tests/notifications/electron.test.ts takes with the preload bridge.
 * The one place a document is genuinely needed, the legacy `execCommand` path, gets a small
 * hand-written fake rather than a jsdom dependency the project has deliberately never added.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyPaste,
  browserClipboard,
  canReadClipboard,
  copyTextFor,
  pasteIntoComposer,
  readClipboardText,
  writeClipboardText,
  type ClipboardSurface,
} from '@/lib/chat/clipboard';
import type { ChatMessage } from '@/lib/chat/types';

/* --------------------------------------------------------------------------------------------- */
/* Fakes                                                                                            */
/* --------------------------------------------------------------------------------------------- */

/** A clipboard that works, and records what was put on it. */
function workingClipboard() {
  const written: string[] = [];
  const surface: ClipboardSurface = {
    writeText: async (text) => {
      written.push(text);
    },
    readText: async () => written[written.length - 1] ?? '',
    execCopy: () => {
      throw new Error('the legacy path must not be reached when writeText works');
    },
  };
  return { surface, written };
}

/**
 * The desktop client: the API exists and is refused.
 *
 * This is the shape that broke Copy, so it is the shape most of these tests use.
 */
function deniedClipboard(execCopyWorks: boolean) {
  const copied: string[] = [];
  const surface: ClipboardSurface = {
    writeText: () => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError')),
    readText: () => Promise.reject(new DOMException('Read permission denied.', 'NotAllowedError')),
    execCopy: (text) => {
      if (!execCopyWorks) return false;
      copied.push(text);
      return true;
    },
  };
  return { surface, copied };
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    clientMessageId: 'c1',
    conversationId: 'conv1',
    senderId: 'u1',
    kind: 'TEXT',
    body: 'hello there',
    createdAt: '2026-09-21T10:00:00.000Z',
    deliveryState: 'SENT',
    attachment: null,
    replyTo: null,
    isForwarded: false,
    editedAt: null,
    pinnedAt: null,
    deletedAt: null,
    reactions: [],
    ...overrides,
  };
}

function attachment(filename: string) {
  return {
    id: 'a1',
    filename,
    byteSize: '2048',
    mimeType: 'application/pdf',
    extension: 'pdf',
    createdAt: '2026-09-21T10:00:00.000Z',
  };
}

/* --------------------------------------------------------------------------------------------- */
/* What Copy puts on the clipboard                                                                  */
/* --------------------------------------------------------------------------------------------- */

describe('copyTextFor — what Copy copies', () => {
  it('copies a text message exactly, trimmed as it is stored', () => {
    expect(copyTextFor(message({ body: 'the quarterly report is ready' }))).toBe(
      'the quarterly report is ready',
    );
  });

  it('keeps the internal shape of a multi-line message', () => {
    const body = 'line one\nline two\n\nline four';
    expect(copyTextFor(message({ body }))).toBe(body);
  });

  it('copies the CAPTION of a file message, not its filename', () => {
    const text = copyTextFor(
      message({ kind: 'FILE', body: 'Q3 numbers', attachment: attachment('report.pdf') }),
    );
    expect(text).toBe('Q3 numbers');
    expect(text).not.toContain('report.pdf');
  });

  it('copies the FILENAME of an attachment with no caption', () => {
    expect(
      copyTextFor(message({ kind: 'FILE', body: null, attachment: attachment('budget.xlsx') })),
    ).toBe('budget.xlsx');
  });

  it('never returns anything for a tombstone', () => {
    expect(
      copyTextFor(message({ body: null, deletedAt: '2026-09-21T11:00:00.000Z' })),
    ).toBe('');
  });

  it('returns nothing when a message is only whitespace', () => {
    expect(copyTextFor(message({ body: '   \n  ' }))).toBe('');
  });
});

/* --------------------------------------------------------------------------------------------- */
/* Whether the copy actually happened                                                               */
/* --------------------------------------------------------------------------------------------- */

describe('writeClipboardText — and reporting honestly', () => {
  it('uses the modern API when it works', async () => {
    const { surface, written } = workingClipboard();

    await expect(writeClipboardText('hello', surface)).resolves.toBe(true);
    expect(written).toEqual(['hello']);
  });

  it('FALLS BACK when the modern API is refused — the desktop client case', async () => {
    const { surface, copied } = deniedClipboard(true);

    /*
     * The fix, in one assertion. `writeText` rejects exactly as it does inside the desktop
     * client, and the text still reaches the clipboard by the legacy path — which is gated on
     * user activation rather than on the permissions system, so the session's blanket denial
     * cannot reach it.
     */
    await expect(writeClipboardText('copy me', surface)).resolves.toBe(true);
    expect(copied).toEqual(['copy me']);
  });

  it('falls back when the modern API is absent entirely', async () => {
    const copied: string[] = [];
    const surface: ClipboardSurface = {
      execCopy: (text) => {
        copied.push(text);
        return true;
      },
    };

    await expect(writeClipboardText('older browser', surface)).resolves.toBe(true);
    expect(copied).toEqual(['older browser']);
  });

  it('REPORTS FAILURE when nothing worked, rather than claiming success', async () => {
    const { surface } = deniedClipboard(false);

    // The property that matters: the interface reads this boolean to decide whether to say
    // "Copied". A copy that did not happen must not be reported as one that did — which is
    // precisely what the old implementation did by swallowing the rejection.
    await expect(writeClipboardText('nowhere to go', surface)).resolves.toBe(false);
  });

  it('reports failure when there is no clipboard at all', async () => {
    await expect(writeClipboardText('anything', {})).resolves.toBe(false);
  });

  it('survives a legacy path that throws rather than returning false', async () => {
    const surface: ClipboardSurface = {
      execCopy: () => {
        throw new Error('execCommand exploded');
      },
    };
    await expect(writeClipboardText('boom', surface)).resolves.toBe(false);
  });

  it('refuses to write nothing, so Copy cannot silently clear a clipboard', async () => {
    const { surface, written } = workingClipboard();

    await expect(writeClipboardText('', surface)).resolves.toBe(false);
    expect(written).toEqual([]);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* The legacy path, against a hand-written document                                                 */
/* --------------------------------------------------------------------------------------------- */

describe('the execCommand fallback, against a fake document', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'navigator');
  });

  /**
   * The smallest document the fallback needs, recording what it was asked to do.
   *
   * Hand-written rather than jsdom: the project has deliberately never added a DOM environment
   * (vitest.config.mts), and what is being checked here is a short, specific sequence — create a
   * field, select it, copy, clean up — which a fake describes more clearly than a real DOM would.
   */
  function fakeDocument(copySucceeds: boolean) {
    const appended: unknown[] = [];
    const removed: unknown[] = [];
    const commands: string[] = [];
    let selected = false;
    let refocused = false;

    const activeElement = {
      focus: () => {
        refocused = true;
      },
    };

    const element = {
      value: '',
      readOnly: false,
      tabIndex: 0,
      style: {} as Record<string, string>,
      setAttribute: () => {},
      select: () => {
        selected = true;
      },
      setSelectionRange: () => {},
      remove: () => {
        removed.push(element);
      },
    };

    const document = {
      activeElement,
      createElement: () => element,
      body: {
        appendChild: (node: unknown) => {
          appended.push(node);
        },
      },
      execCommand: (command: string) => {
        commands.push(command);
        return copySucceeds;
      },
    };

    return {
      document,
      element,
      state: () => ({
        appended: appended.length,
        removed: removed.length,
        commands,
        selected,
        refocused,
      }),
    };
  }

  it('writes through a real document when the modern API is missing', async () => {
    const fake = fakeDocument(true);
    Object.defineProperty(globalThis, 'document', { value: fake.document, configurable: true });
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });

    await expect(writeClipboardText('through the fallback')).resolves.toBe(true);

    const state = fake.state();
    expect(fake.element.value).toBe('through the fallback');
    expect(state.selected).toBe(true);
    expect(state.commands).toEqual(['copy']);
    // The field is added and taken away again: nothing is left behind in the document.
    expect(state.appended).toBe(1);
    expect(state.removed).toBe(1);
    // And focus goes back where it was, so copying does not steal the caret from the composer.
    expect(state.refocused).toBe(true);
  });

  it('reports failure — and still cleans up — when the document refuses the copy', async () => {
    const fake = fakeDocument(false);
    Object.defineProperty(globalThis, 'document', { value: fake.document, configurable: true });
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });

    await expect(writeClipboardText('refused')).resolves.toBe(false);
    expect(fake.state().removed).toBe(1);
    expect(fake.state().refocused).toBe(true);
  });

  it('browserClipboard reports no surface at all when there is no browser', () => {
    const surface = browserClipboard();
    expect(surface.writeText).toBeUndefined();
    expect(surface.readText).toBeUndefined();
    expect(surface.execCopy).toBeUndefined();
    expect(canReadClipboard(surface)).toBe(false);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* Reading                                                                                          */
/* --------------------------------------------------------------------------------------------- */

describe('readClipboardText — and telling "empty" from "refused"', () => {
  it('returns the text when the clipboard can be read', async () => {
    const surface: ClipboardSurface = { readText: async () => 'pasted words' };
    await expect(readClipboardText(surface)).resolves.toBe('pasted words');
  });

  it('returns an empty STRING for an empty clipboard', async () => {
    const surface: ClipboardSurface = { readText: async () => '' };
    await expect(readClipboardText(surface)).resolves.toBe('');
  });

  it('returns NULL when reading is refused — not an empty string', async () => {
    const { surface } = deniedClipboard(true);

    /*
     * The distinction the interface depends on. Collapsing a refusal into `''` would make the
     * desktop client tell an employee their clipboard was empty when it had never been consulted,
     * instead of telling them to press Ctrl+V.
     */
    await expect(readClipboardText(surface)).resolves.toBeNull();
  });

  it('returns null when there is no read API', async () => {
    await expect(readClipboardText({})).resolves.toBeNull();
    expect(canReadClipboard({})).toBe(false);
  });

  it('canReadClipboard is a capability check that never calls the API', () => {
    let called = false;
    const surface: ClipboardSurface = {
      readText: async () => {
        called = true;
        return '';
      },
    };

    // It must not be able to provoke a permission prompt merely because somebody right-clicked.
    expect(canReadClipboard(surface)).toBe(true);
    expect(called).toBe(false);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* Inserting                                                                                        */
/* --------------------------------------------------------------------------------------------- */

describe('applyPaste — where the text lands', () => {
  it('pastes into an empty composer', () => {
    expect(applyPaste({ value: '', selectionStart: 0, selectionEnd: 0 }, 'hello')).toEqual({
      value: 'hello',
      cursor: 5,
    });
  });

  it('inserts at the caret, preserving the text already there', () => {
    expect(
      applyPaste({ value: 'the  fox', selectionStart: 4, selectionEnd: 4 }, 'quick'),
    ).toEqual({ value: 'the quick fox', cursor: 9 });
  });

  it('appends when the caret is at the end', () => {
    expect(applyPaste({ value: 'hello', selectionStart: 5, selectionEnd: 5 }, ' world')).toEqual({
      value: 'hello world',
      cursor: 11,
    });
  });

  it('REPLACES the selection when there is one', () => {
    expect(
      applyPaste({ value: 'hello cruel world', selectionStart: 6, selectionEnd: 11 }, 'lovely'),
    ).toEqual({ value: 'hello lovely world', cursor: 12 });
  });

  it('preserves existing multiline text and pastes multiline text', () => {
    const result = applyPaste(
      { value: 'first line\nsecond line', selectionStart: 10, selectionEnd: 10 },
      '\ninserted',
    );
    expect(result.value).toBe('first line\ninserted\nsecond line');
  });

  it('normalises Windows line endings, which a textarea never holds', () => {
    const result = applyPaste({ value: '', selectionStart: 0, selectionEnd: 0 }, 'a\r\nb\rc');

    // Otherwise the composer's character count disagrees with what the server stores.
    expect(result.value).toBe('a\nb\nc');
    expect(result.cursor).toBe(5);
  });

  it('copes with a backwards selection', () => {
    // A selection made by dragging right-to-left reports start > end.
    expect(
      applyPaste({ value: 'hello world', selectionStart: 11, selectionEnd: 6 }, 'there'),
    ).toEqual({ value: 'hello there', cursor: 11 });
  });

  it('copes with a stale selection pointing past the end', () => {
    const result = applyPaste({ value: 'short', selectionStart: 99, selectionEnd: 99 }, '!');
    expect(result.value).toBe('short!');
    expect(result.cursor).toBe(6);
  });

  it('inserts markup as LITERAL TEXT', () => {
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const result = applyPaste({ value: '', selectionStart: 0, selectionEnd: 0 }, hostile);

    /*
     * Character for character. The value goes into a controlled textarea and is rendered by React
     * as a text node; nothing in this application sets it as HTML, and there is no
     * `dangerouslySetInnerHTML` anywhere near the composer or the message list.
     */
    expect(result.value).toBe(hostile);
  });

  it('does not cap the pasted length, exactly as Ctrl+V does not', () => {
    const long = 'x'.repeat(50_000);
    const result = applyPaste({ value: '', selectionStart: 0, selectionEnd: 0 }, long);

    // A menu that truncated where the keyboard did not would be the more surprising of the two.
    // The composer's counter and the server both refuse an over-long message on their own.
    expect(result.value).toHaveLength(50_000);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* The paste decision                                                                               */
/* --------------------------------------------------------------------------------------------- */

describe('pasteIntoComposer — the whole decision', () => {
  const empty = { value: '', selectionStart: 0, selectionEnd: 0 };

  it('inserts what the clipboard holds', async () => {
    const surface: ClipboardSurface = { readText: async () => 'from the clipboard' };

    await expect(pasteIntoComposer(empty, surface)).resolves.toEqual({
      kind: 'inserted',
      value: 'from the clipboard',
      cursor: 18,
    });
  });

  it('reports an empty clipboard as empty, and changes nothing', async () => {
    const surface: ClipboardSurface = { readText: async () => '' };
    await expect(pasteIntoComposer(empty, surface)).resolves.toEqual({ kind: 'empty' });
  });

  it('reports a refusal as a refusal — the desktop client case', async () => {
    const { surface } = deniedClipboard(true);
    await expect(pasteIntoComposer(empty, surface)).resolves.toEqual({ kind: 'refused' });
  });

  it('takes no mode and no conversation, so it behaves identically everywhere', async () => {
    const surface: ClipboardSurface = { readText: async () => 'same text' };
    const target = { value: 'draft ', selectionStart: 6, selectionEnd: 6 };

    /*
     * This is the strongest form the claim can take without a DOM, and it is a real one: the
     * function's inputs are a value, a selection and the clipboard. There is no argument by which
     * a direct chat, a group, reply mode or edit mode could reach it — so all four give the same
     * answer, and none of them can be cancelled by pasting, because nothing here can cancel
     * anything.
     */
    const results = await Promise.all([
      pasteIntoComposer(target, surface),
      pasteIntoComposer(target, surface),
      pasteIntoComposer(target, surface),
      pasteIntoComposer(target, surface),
    ]);

    for (const result of results) {
      expect(result).toEqual({ kind: 'inserted', value: 'draft same text', cursor: 15 });
    }
  });
});

/* --------------------------------------------------------------------------------------------- */
/* What clipboard work must NOT do                                                                  */
/* --------------------------------------------------------------------------------------------- */

describe('clipboard work is local and nothing else', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('makes no network request, opens no socket and raises no notification', async () => {
    const fetchSpy = vi.fn();
    const notificationSpy = vi.fn();
    const sendBeaconSpy = vi.fn();
    const xhrSpy = vi.fn();

    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('Notification', notificationSpy);
    vi.stubGlobal('XMLHttpRequest', xhrSpy);
    vi.stubGlobal('navigator', { sendBeacon: sendBeaconSpy });

    const { surface } = workingClipboard();

    await writeClipboardText(copyTextFor(message({ body: 'copy this' })), surface);
    await pasteIntoComposer({ value: '', selectionStart: 0, selectionEnd: 0 }, surface);

    /*
     * Copy and paste happen inside one browser. Neither may create a database record, send a
     * request, emit a socket event, move an unread count or announce anything — and the cheapest
     * way to be sure is that there is no way out of this module at all.
     */
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(notificationSpy).not.toHaveBeenCalled();
    expect(sendBeaconSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
  });

  it('returns only text and a caret — there is no state for it to disturb', async () => {
    const surface: ClipboardSurface = { readText: async () => 'text' };
    const outcome = await pasteIntoComposer(
      { value: '', selectionStart: 0, selectionEnd: 0 },
      surface,
    );

    // No unread count, no conversation, no message id: nothing it could change even in principle.
    expect(Object.keys(outcome).sort()).toEqual(['cursor', 'kind', 'value']);
  });
});
