/**
 * Pasting a screenshot into the composer (Batch 1.10).
 *
 * Win+Shift+S, Snipping Tool, Print Screen, or "Copy image" in another application leaves a
 * bitmap on the clipboard. Pressing Ctrl+V in the composer then fires an ordinary `paste` event
 * whose `clipboardData` carries that bitmap as a file item — a TRUSTED user action, so it needs no
 * clipboard permission. That matters because the desktop client denies every permission
 * (desktop/main.ts, `hardenSession`): the async `navigator.clipboard` API is refused there, but the
 * paste event is not part of the permission system at all. This is why the feature needs only a
 * change to the page the server serves, and no new desktop installer.
 *
 * WHAT THIS DECIDES, and nothing more: whether a paste is an IMAGE paste, and what to call the
 * file. Pure — no DOM, no React, no request — so the rule is testable in the Node test
 * environment. The composer hands the result to its existing file selection, which applies the
 * size limit, shows the existing file card, takes an optional caption and uploads only when Send
 * is pressed, through the existing upload route and its server-side validation.
 *
 * TEXT ALWAYS WINS. If the clipboard holds any plain text, this returns null and the browser
 * pastes the text exactly as it always has. Copying cells in Excel or a paragraph in Word puts a
 * picture of the selection on the clipboard ALONGSIDE the text; somebody pressing Ctrl+V there
 * means the text, and the Batch 1.2 promise — native Ctrl+V is never taken over — holds for it.
 *
 * RASTER IMAGES ONLY. The formats a screenshot or a copied picture actually arrives as. Anything
 * else (an SVG, a file copied in Explorer) is not treated as a screenshot and is left to the
 * browser's default, which for a textarea is to insert nothing.
 */

/** Extension for each image type a pasted screenshot can arrive as. */
const PASTED_IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

/** The parts of `DataTransferItem` read here. */
export interface ClipboardItemLike {
  kind: string;
  type: string;
  getAsFile(): File | null;
}

/** The parts of a paste event's `DataTransfer` read here. */
export interface ClipboardDataLike {
  getData(format: string): string;
  items?: ArrayLike<ClipboardItemLike> | undefined;
  files?: ArrayLike<File> | undefined;
}

export function isPastableImageType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(PASTED_IMAGE_EXTENSIONS, type.toLowerCase());
}

/**
 * The image a paste carries, or null when this is not an image paste.
 *
 * Null — leave the paste to the browser — when the clipboard has plain text (see TEXT ALWAYS WINS
 * above), when it has no supported image, or when the data cannot be read. Only the FIRST image
 * is taken: the composer holds one file at a time, exactly as the attach button does.
 */
export function imageFromClipboard(data: ClipboardDataLike | null | undefined): File | null {
  if (!data) return null;

  let text = '';
  try {
    text = data.getData('text/plain') ?? '';
  } catch {
    text = '';
  }
  if (text.trim().length > 0) return null;

  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file' || !isPastableImageType(item.type)) continue;
    const file = item.getAsFile();
    if (file) return file;
  }

  // Some browsers populate `files` but not `items` for a pasted bitmap.
  for (const file of Array.from(data.files ?? [])) {
    if (isPastableImageType(file.type)) return file;
  }

  return null;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * A readable name for a pasted screenshot, e.g. "Screenshot 2026-10-01 104512.png".
 *
 * The clipboard gives every bitmap the same meaningless name ("image.png"), which is what the
 * recipient would otherwise see on every screenshot in the conversation. Local time, because that
 * is the clock the sender just looked at; no colons, because the name becomes the filename when
 * the recipient saves it on Windows.
 */
export function pastedImageName(type: string, now: Date): string {
  const extension = PASTED_IMAGE_EXTENSIONS[type.toLowerCase()] ?? 'png';
  const date = `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`;
  const time = `${twoDigits(now.getHours())}${twoDigits(now.getMinutes())}${twoDigits(now.getSeconds())}`;
  return `Screenshot ${date} ${time}.${extension}`;
}

/**
 * The pasted image as a File the existing attachment flow can take: same bytes, same type, a
 * readable name. Nothing is read or converted here — the bytes are handed on untouched, and the
 * server decides what they are, as it does for any attachment.
 */
export function pastedImageFile(image: Blob, now: Date = new Date()): File {
  const type = image.type.toLowerCase();
  return new File([image], pastedImageName(type, now), { type, lastModified: now.getTime() });
}
