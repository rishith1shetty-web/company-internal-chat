/**
 * Filenames for saved attachments.
 *
 * ONE PROPERTY IS BEING PROTECTED, and everything below is a way of trying to break it: whatever
 * goes in, what comes out is a bare filename that cannot escape the folder it is saved into. The
 * input is influenced by whoever uploaded the file, so `..\..\Startup\x.bat` is exactly the shape
 * to expect rather than a contrived example.
 *
 * Chromium sanitises download names itself; this is a second pass. A separator reaching a save
 * path is not a property worth sharing between two layers and trusting neither to hold.
 */

import { describe, expect, it } from 'vitest';

import { FALLBACK_FILENAME, MAX_FILENAME_LENGTH, safeDownloadName } from '@/desktop/downloads';

/** The one thing that must be true of every result, whatever the input. */
function isBareFilename(name: string): boolean {
  return name.length > 0 && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..';
}

describe('ordinary business filenames survive intact', () => {
  it('keeps them exactly as they are', () => {
    for (const name of [
      'Quarterly Report.pdf',
      'candidate-cv.docx',
      'Payroll 2026-09.xlsx',
      'Notes (final).txt',
      'photo.JPG',
      'archive.tar.gz',
      'Rising Path — Offer Letter.pdf',
      'Bewerbung Müller.pdf',
      '面接記録.docx',
    ]) {
      expect(safeDownloadName(name), name).toBe(name);
    }
  });
});

describe('path traversal', () => {
  it('keeps only the final segment, on either separator', () => {
    expect(safeDownloadName('../../etc/passwd')).toBe('passwd');
    expect(safeDownloadName('..\\..\\Startup\\evil.bat')).toBe('evil.bat');
    expect(safeDownloadName('C:\\Windows\\System32\\calc.exe')).toBe('calc.exe');
    expect(safeDownloadName('/var/www/html/index.html')).toBe('index.html');
    expect(safeDownloadName('folder/sub/report.pdf')).toBe('report.pdf');
  });

  it('never returns something containing a separator', () => {
    const attempts = [
      '../../../Users/Public/Desktop/x.lnk',
      '..\\..\\..\\Windows\\Temp\\a.dll',
      'a/b\\c/d.txt',
      '....//....//x',
      'C:/x',
      '\\\\server\\share\\file.doc',
      '..',
      '.',
      '../',
      '..\\',
    ];

    for (const attempt of attempts) {
      const result = safeDownloadName(attempt);
      expect(isBareFilename(result), `${attempt} -> ${result}`).toBe(true);
    }
  });

  it('does not collapse to a directory reference', () => {
    // `.` and `..` are directories. A name that reduced to either would be a save into the parent
    // folder rather than a file in it.
    expect(safeDownloadName('..')).toBe(FALLBACK_FILENAME);
    expect(safeDownloadName('.')).toBe(FALLBACK_FILENAME);
    expect(safeDownloadName('...')).toBe(FALLBACK_FILENAME);
  });
});

describe('characters Windows will not accept', () => {
  it('replaces the illegal ones rather than dropping them', () => {
    // Replaced, so `a:b.txt` stays recognisably one name rather than becoming `ab.txt`, which
    // could collide with a different file.
    expect(safeDownloadName('a:b.txt')).toBe('a_b.txt');
    expect(safeDownloadName('what?.pdf')).toBe('what_.pdf');
    expect(safeDownloadName('a<b>c|d*e.txt')).toBe('a_b_c_d_e.txt');
    expect(safeDownloadName('quote".txt')).toBe('quote_.txt');
  });

  it('strips control characters, including a newline in the middle of a name', () => {
    expect(safeDownloadName('report\r\n.pdf')).toBe('report__.pdf');
    expect(safeDownloadName('a\u0000b.txt')).toBe('a_b.txt');
  });

  it('removes a trailing dot or space', () => {
    /*
     * Windows silently drops these when creating a file, so `report.pdf.` becomes `report.pdf` on
     * disk. Leaving it in means the name checked is not the name written — a small gap, and one
     * that has historically been used to sidestep extension checks.
     */
    expect(safeDownloadName('report.pdf.')).toBe('report.pdf');
    expect(safeDownloadName('report.pdf   ')).toBe('report.pdf');
    expect(safeDownloadName('report.pdf . . ')).toBe('report.pdf');
  });
});

describe('names Windows reserves for devices', () => {
  it('prefixes them, whatever the extension', () => {
    // `CON.txt` addresses the console device rather than a file. Opening one is not a file
    // operation at all.
    expect(safeDownloadName('CON')).toBe('_CON');
    expect(safeDownloadName('con.txt')).toBe('_con.txt');
    expect(safeDownloadName('PRN.pdf')).toBe('_PRN.pdf');
    expect(safeDownloadName('aux.docx')).toBe('_aux.docx');
    expect(safeDownloadName('NUL')).toBe('_NUL');
    expect(safeDownloadName('COM1.log')).toBe('_COM1.log');
    expect(safeDownloadName('LPT9')).toBe('_LPT9');
  });

  it('leaves an ordinary name that merely starts the same way', () => {
    expect(safeDownloadName('CONTRACT.pdf')).toBe('CONTRACT.pdf');
    expect(safeDownloadName('console-notes.txt')).toBe('console-notes.txt');
    expect(safeDownloadName('COM10.log')).toBe('COM10.log');
  });
});

describe('very long names', () => {
  it('truncates the stem and keeps the extension', () => {
    /*
     * The extension is the part Windows needs: a spreadsheet that arrives without its `.xlsx`
     * does not open on a double-click, which turns a cosmetic problem into a support call.
     */
    const long = `${'a'.repeat(400)}.xlsx`;
    const result = safeDownloadName(long);

    expect(result.length).toBe(MAX_FILENAME_LENGTH);
    expect(result.endsWith('.xlsx')).toBe(true);
  });

  it('truncates plainly when there is no usable extension', () => {
    const result = safeDownloadName('b'.repeat(400));

    expect(result.length).toBe(MAX_FILENAME_LENGTH);
  });

  it('does not treat a long tail after a dot as an extension', () => {
    // `.<200 characters>` is not an extension, and keeping it would defeat the length cap.
    const result = safeDownloadName(`name.${'c'.repeat(300)}`);

    expect(result.length).toBe(MAX_FILENAME_LENGTH);
  });
});

describe('nothing usable at all', () => {
  it('falls back rather than returning an empty name', () => {
    for (const value of ['', '   ', '///', '\\\\', '...', null, undefined, 42, {}, []]) {
      expect(safeDownloadName(value), JSON.stringify(value)).toBe(FALLBACK_FILENAME);
    }
  });
});
