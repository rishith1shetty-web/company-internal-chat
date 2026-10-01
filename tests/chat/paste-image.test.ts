/**
 * Screenshot paste (Batch 1.10): which pastes are image pastes, what the file is called, and how
 * the composer hands it to the existing attachment flow.
 *
 * The rule is pure (lib/chat/paste-image.ts) and is driven here with fake clipboard data, the way
 * a browser's paste event presents it. The composer wiring is checked at source level, like the
 * other wiring tests — the suite runs under `environment: 'node'` with no DOM.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  imageFromClipboard,
  isPastableImageType,
  pastedImageFile,
  pastedImageName,
  type ClipboardDataLike,
  type ClipboardItemLike,
} from '@/lib/chat/paste-image';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function imageFile(type = 'image/png', name = 'image.png'): File {
  return new File([PNG_BYTES], name, { type });
}

function fileItem(file: File): ClipboardItemLike {
  return { kind: 'file', type: file.type, getAsFile: () => file };
}

function stringItem(type: string): ClipboardItemLike {
  return { kind: 'string', type, getAsFile: () => null };
}

/** A paste event's `clipboardData`, as Chromium/Electron presents it. */
function clipboard(options: {
  text?: string;
  html?: string;
  items?: ClipboardItemLike[];
  files?: File[];
}): ClipboardDataLike {
  return {
    getData: (format: string) =>
      format === 'text/plain' ? (options.text ?? '') : format === 'text/html' ? (options.html ?? '') : '',
    items: options.items ?? [],
    files: options.files ?? [],
  };
}

describe('which pastes are screenshots', () => {
  it('a Snipping Tool / Win+Shift+S / Print Screen bitmap is an image paste', () => {
    const shot = imageFile();
    expect(imageFromClipboard(clipboard({ items: [fileItem(shot)], files: [shot] }))).toBe(shot);
  });

  it('plain text is NOT taken over — Ctrl+V pastes text normally', () => {
    expect(imageFromClipboard(clipboard({ text: 'hello', items: [stringItem('text/plain')] }))).toBeNull();
  });

  it('text with a picture beside it (Excel cells, Word) pastes the TEXT', () => {
    const picture = imageFile();
    const data = clipboard({
      text: 'Name\tScore\nRahul\t42',
      html: '<table>…</table>',
      items: [stringItem('text/plain'), stringItem('text/html'), fileItem(picture)],
      files: [picture],
    });
    expect(imageFromClipboard(data)).toBeNull();
  });

  it('"Copy image" from a browser or app (picture + HTML, no plain text) is an image paste', () => {
    const picture = imageFile();
    const data = clipboard({
      html: '<img src="https://example.invalid/a.png">',
      items: [stringItem('text/html'), fileItem(picture)],
    });
    expect(imageFromClipboard(data)).toBe(picture);
  });

  it('whitespace-only text does not hide an image', () => {
    const shot = imageFile();
    expect(imageFromClipboard(clipboard({ text: '  \r\n', items: [fileItem(shot)] }))).toBe(shot);
  });

  it('JPEG, GIF, WebP and BMP are accepted; SVG and non-images are not', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'IMAGE/PNG']) {
      expect(isPastableImageType(type), type).toBe(true);
    }
    for (const type of ['image/svg+xml', 'application/pdf', 'text/plain', '']) {
      expect(isPastableImageType(type), type).toBe(false);
    }

    const pdf = new File([PNG_BYTES], 'report.pdf', { type: 'application/pdf' });
    const svg = new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' });
    expect(imageFromClipboard(clipboard({ items: [fileItem(pdf), fileItem(svg)], files: [pdf, svg] }))).toBeNull();
  });

  it('takes the first image when there are several, as the composer holds one file', () => {
    const first = imageFile('image/png', 'a.png');
    const second = imageFile('image/jpeg', 'b.jpg');
    expect(imageFromClipboard(clipboard({ items: [fileItem(first), fileItem(second)] }))).toBe(first);
  });

  it('falls back to `files` when `items` is empty', () => {
    const shot = imageFile();
    expect(imageFromClipboard(clipboard({ files: [shot] }))).toBe(shot);
  });

  it('is safe with missing or unreadable clipboard data', () => {
    expect(imageFromClipboard(null)).toBeNull();
    expect(imageFromClipboard(undefined)).toBeNull();
    expect(imageFromClipboard({ getData: () => '' })).toBeNull();

    const shot = imageFile();
    const throwing: ClipboardDataLike = {
      getData: () => {
        throw new Error('not readable');
      },
      items: [fileItem(shot)],
    };
    expect(imageFromClipboard(throwing)).toBe(shot);

    const empty: ClipboardItemLike = { kind: 'file', type: 'image/png', getAsFile: () => null };
    expect(imageFromClipboard(clipboard({ items: [empty] }))).toBeNull();
  });
});

describe('the pasted file', () => {
  const now = new Date(2026, 9, 1, 9, 5, 7); // 1 Oct 2026, 09:05:07 local

  it('gets a readable, Windows-safe name instead of "image.png"', () => {
    expect(pastedImageName('image/png', now)).toBe('Screenshot 2026-10-01 090507.png');
    expect(pastedImageName('image/jpeg', now)).toBe('Screenshot 2026-10-01 090507.jpg');
    expect(pastedImageName('image/bmp', now)).toBe('Screenshot 2026-10-01 090507.bmp');
    expect(pastedImageName('image/png', now)).not.toMatch(/[\\/:*?"<>|]/);
  });

  it('keeps the bytes and the type untouched', async () => {
    const file = pastedImageFile(imageFile(), now);
    expect(file.name).toBe('Screenshot 2026-10-01 090507.png');
    expect(file.type).toBe('image/png');
    expect(file.size).toBe(PNG_BYTES.length);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG_BYTES);
  });
});

describe('composer wiring', () => {
  const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8');
  const composer = read('components', 'chat', 'MessageComposer.tsx');
  const handler = composer.slice(
    composer.indexOf('const pasteImage = '),
    composer.indexOf('const submit = '),
  );

  it('hands the image to the EXISTING file selection — size check, file card, caption', () => {
    expect(handler).toContain('chooseFile(pastedImageFile(image));');
    // chooseFile is the same function the paperclip uses, and it applies the size limit.
    const chooseFile = composer.slice(composer.indexOf('const chooseFile = '), composer.indexOf('const clearFile = '));
    expect(chooseFile).toContain('chosen.size > maxFileSize');
    expect(composer).toContain('onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}');
  });

  it('uploads nothing on paste — only Send uploads', () => {
    expect(handler).not.toContain('onSendFile');
    expect(handler).not.toContain('uploadAttachment');
    expect(handler).not.toContain('fetch(');
  });

  it('text pastes return before anything is prevented', () => {
    expect(handler.indexOf('if (!image) return;')).toBeGreaterThan(-1);
    expect(handler.indexOf('if (!image) return;')).toBeLessThan(handler.indexOf('event.preventDefault()'));
  });

  it('refuses a screenshot while editing, before selecting any file', () => {
    expect(handler.indexOf('if (editing) {')).toBeGreaterThan(handler.indexOf('event.preventDefault()'));
    expect(handler.indexOf('if (editing) {')).toBeLessThan(handler.indexOf('chooseFile('));
    expect(handler).toContain('setPasteError(');
  });

  it('a pasted image is not typing and is not a draft (Batches 1.8, 1.9)', () => {
    expect(handler).not.toContain('noteTyping');
    expect(handler).not.toContain('noteDraft');
    expect(handler).not.toContain('typingSignal');
  });

  it('the rule module is renderer-only: no imports, no Electron, no clipboard permission API', () => {
    const rule = read('lib', 'chat', 'paste-image.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(rule).not.toMatch(/^\s*import\s/m);
    for (const forbidden of ['electron', 'ipcRenderer', 'navigator.clipboard', 'fetch(', 'localStorage']) {
      expect(rule, forbidden).not.toContain(forbidden);
    }
  });

  it('the desktop shell does not intercept Ctrl+V — only the DevTools shortcuts', () => {
    const main = read('desktop', 'main.ts');
    const input = main.slice(
      main.indexOf("window.webContents.on('before-input-event'"),
      main.indexOf('setVisualZoomLevelLimits'),
    );
    expect(input).toContain('if (opensDevTools) event.preventDefault();');
    expect(input.match(/preventDefault\(\)/g) ?? []).toHaveLength(1);
    expect(input).not.toMatch(/'v'/);
    expect(main).not.toMatch(/paste/i);
  });
});
