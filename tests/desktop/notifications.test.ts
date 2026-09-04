/**
 * What the renderer is allowed to put on the Windows desktop.
 *
 * The main process re-validates a payload it appears to have sent itself, and the reason is worth
 * stating plainly: a renderer is the least trustworthy part of an Electron application, and "we
 * sent it" is not a property the main process can check. What arrives on the IPC channel is
 * whatever reached that channel.
 *
 * The stakes here are lower than in navigation.ts — a Windows toast renders text, not markup, so
 * there is no injection to prevent — but a payload of the wrong shape reaching `new Notification`
 * throws inside the message handler, and a title made of newlines is a broken-looking popup
 * carrying the company's name.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_BODY_LENGTH,
  MAX_TAG_LENGTH,
  MAX_TITLE_LENGTH,
  sanitizeNotificationRequest,
} from '@/desktop/notifications';

describe('a well-formed request', () => {
  it('passes through unchanged', () => {
    expect(
      sanitizeNotificationRequest({
        title: 'Engineering Team',
        body: 'Rishith sent report.pdf',
        tag: 'cm2x8p1q40000',
        silent: true,
      }),
    ).toEqual({
      title: 'Engineering Team',
      body: 'Rishith sent report.pdf',
      tag: 'cm2x8p1q40000',
      silent: true,
    });
  });

  it('accepts a direct message with no group prefix', () => {
    const result = sanitizeNotificationRequest({
      title: 'Rishith Shetty',
      body: 'Can you review the report?',
      tag: 'c1',
      silent: false,
    });

    expect(result?.title).toBe('Rishith Shetty');
    expect(result?.silent).toBe(false);
  });
});

describe('a request that is not one', () => {
  it('is refused rather than thrown on', () => {
    /*
     * Returning null rather than throwing matters: this runs inside an IPC message handler, and
     * an exception there is an unhandled error in the main process for a message somebody sent.
     */
    for (const payload of [null, undefined, 'text', 42, [], true]) {
      expect(sanitizeNotificationRequest(payload), JSON.stringify(payload)).toBeNull();
    }
  });

  it('is refused when there is no title, because there would be nothing to read', () => {
    expect(sanitizeNotificationRequest({ body: 'hello' })).toBeNull();
    expect(sanitizeNotificationRequest({ title: '', body: 'hello' })).toBeNull();
    expect(sanitizeNotificationRequest({ title: '     ', body: 'hello' })).toBeNull();
    expect(sanitizeNotificationRequest({ title: 42, body: 'hello' })).toBeNull();
  });
});

describe('fields of the wrong type', () => {
  it('become empty rather than reaching the Windows shell', () => {
    const result = sanitizeNotificationRequest({
      title: 'Engineering Team',
      body: { toString: () => 'nope' },
      tag: 12345,
      silent: 'yes',
    });

    expect(result).toEqual({ title: 'Engineering Team', body: '', tag: '', silent: false });
  });

  it('treats anything but true as not silent', () => {
    // `silent` decides whether Windows plays its own sound on top of the application's chime.
    // Defaulting a malformed value to "not silent" errs towards an audible notification.
    for (const value of [undefined, null, 0, 1, 'true', {}]) {
      expect(sanitizeNotificationRequest({ title: 'x', silent: value })?.silent, String(value)).toBe(
        false,
      );
    }
    expect(sanitizeNotificationRequest({ title: 'x', silent: true })?.silent).toBe(true);
  });

  it('ignores extra fields entirely', () => {
    // Nothing beyond the four is read, so a renderer cannot widen what it is asking for.
    const result = sanitizeNotificationRequest({
      title: 'Engineering Team',
      body: 'hello',
      tag: 'c1',
      silent: true,
      icon: 'C:/Windows/System32/shell32.dll',
      actions: [{ type: 'button', text: 'Run' }],
    });

    expect(Object.keys(result ?? {}).sort()).toEqual(['body', 'silent', 'tag', 'title']);
  });
});

describe('text that would render badly', () => {
  it('collapses newlines and control characters into single spaces', () => {
    // A Windows toast is one line. A body full of newlines is a popup that looks broken while
    // carrying the company's name on it.
    const result = sanitizeNotificationRequest({
      title: 'Project\nTeam',
      body: 'line one\r\nline two\ttabbed\u0000nul',
      tag: 'c1',
    });

    expect(result?.title).toBe('Project Team');
    expect(result?.body).toBe('line one line two tabbed nul');
  });

  it('trims the ends', () => {
    expect(sanitizeNotificationRequest({ title: '  Rishith  ', body: '  hi  ' })).toEqual({
      title: 'Rishith',
      body: 'hi',
      tag: '',
      silent: false,
    });
  });

  it('caps each field', () => {
    const result = sanitizeNotificationRequest({
      title: 'T'.repeat(500),
      body: 'B'.repeat(2000),
      tag: 'G'.repeat(500),
      silent: false,
    });

    expect(result?.title).toHaveLength(MAX_TITLE_LENGTH);
    expect(result?.body).toHaveLength(MAX_BODY_LENGTH);
    expect(result?.tag).toHaveLength(MAX_TAG_LENGTH);
  });

  it('leaves ordinary punctuation and non-Latin text alone', () => {
    const result = sanitizeNotificationRequest({
      title: 'Müller & Co. — Recruiting',
      body: '面接は15:00からです',
      tag: 'c1',
    });

    expect(result?.title).toBe('Müller & Co. — Recruiting');
    expect(result?.body).toBe('面接は15:00からです');
  });
});
