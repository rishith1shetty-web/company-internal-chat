/**
 * Filenames for saved attachments.
 *
 * The server already decides what a download is called and whether this employee may have it at
 * all (app/api/attachments/[id]/download). This module exists for the one thing only the client
 * can get wrong: the name Chromium is about to write onto a Windows filesystem.
 *
 * The concern is not hypothetical. A download filename is influenced by whoever uploaded the
 * file, and a name like `..\..\Startup\x.bat` is a path rather than a name. Chromium sanitises
 * download names itself, so this is a second pass rather than the only one — a directory
 * separator reaching a save path is not a property worth sharing between two layers.
 */

/** Characters Windows forbids in a filename, plus the control range. */
const ILLEGAL_CHARACTERS = /[<>:"/\\|?*\u0000-\u001F\u007F]/g;

/**
 * Names Windows reserves whatever the extension. `CON.txt` addresses a device rather than a file,
 * so a name of that shape is prefixed rather than allowed through.
 */
const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

/** Long enough for any real business filename, short of the Windows path limit. */
export const MAX_FILENAME_LENGTH = 180;

/** Used when nothing usable survives sanitisation. */
export const FALLBACK_FILENAME = 'download';

/**
 * Reduces a server-supplied filename to something safe to write to disk.
 *
 * Always returns a bare filename with no directory component. That is the property worth stating
 * plainly: whatever goes in, what comes out cannot escape the folder it is saved into.
 */
export function safeDownloadName(raw: unknown): string {
  if (typeof raw !== 'string') return FALLBACK_FILENAME;

  /*
   * Take the last path segment FIRST, on either separator. `../../etc/passwd` is a path whose
   * filename is `passwd`; stripping the separators instead would give `......etcpasswd`, which is
   * safe but unrecognisable — and being unrecognisable is how a correct sanitiser gets replaced
   * by a worse one later.
   */
  const segments = raw.split(/[\\/]/);
  const last = segments[segments.length - 1] ?? '';

  let name = last
    .replace(ILLEGAL_CHARACTERS, '_')
    // Windows silently strips a trailing dot or space on creation, which is a way to end up
    // holding a different file from the one that was named.
    .replace(/[. ]+$/, '')
    .trim();

  // Leading dots go, so a name cannot collapse to `.` or `..` — both directories, not files.
  name = name.replace(/^\.+/, '');

  if (name.length === 0) return FALLBACK_FILENAME;

  if (RESERVED_NAMES.test(name)) name = `_${name}`;

  if (name.length > MAX_FILENAME_LENGTH) {
    /*
     * Truncate the stem, never the extension. A spreadsheet that arrives without its `.xlsx` does
     * not open on a double-click, and the extension is the part Windows actually needs.
     */
    const dot = name.lastIndexOf('.');
    const hasUsableExtension = dot > 0 && name.length - dot <= 12;

    if (hasUsableExtension) {
      const extension = name.slice(dot);
      name = name.slice(0, MAX_FILENAME_LENGTH - extension.length) + extension;
    } else {
      name = name.slice(0, MAX_FILENAME_LENGTH);
    }
  }

  return name;
}
