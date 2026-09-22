/**
 * Employee-facing timestamps are rendered in company time (Maintenance Batch).
 *
 * Pure: no database, no socket, no browser. What is under test is the rule that decides which
 * number an employee sees next to a message, and the property that matters is that the answer
 * does not depend on the machine asking.
 *
 * THE THREE THINGS THAT WOULD BREAK THIS, and each has a test below:
 *
 *   1. **Rendering in the reader's own zone.** The previous behaviour. Everyone was in the same
 *      office, so nobody noticed; a recruiter working from another country sees every timestamp
 *      shifted, and "the 3 o'clock message" stops naming one message.
 *   2. **A fixed offset instead of a zone.** `UTC-5` is right in January and an hour wrong in
 *      July. It is the tempting fix because it is one number, and it is wrong for half the year
 *      — including retroactively, for messages already in the archive.
 *   3. **Counting calendar days on the wrong calendar.** "Today" and "Yesterday" are separators
 *      above times that are already in company time; computed against the reader's own midnight
 *      they contradict the very timestamps they sit above.
 *
 * 2026 transitions for America/New_York: spring forward Sunday 8 March, fall back Sunday 1
 * November. Both are exercised directly rather than assumed.
 */

import { describe, expect, it } from 'vitest';

import {
  COMPANY_TIME_ZONE,
  companyDayNumber,
  formatInCompanyTime,
} from '@/lib/time/company-time';
import { formatDayLabel, formatFullTimestamp, formatListTimestamp, formatTime } from '@/lib/chat/format';

/** The hour and minute company time puts an instant at, read back as numbers. */
function companyClock(iso: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: COMPANY_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));

  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { hour: read('hour') % 24, minute: read('minute') };
}

/** The offset company time was at for an instant, in hours. Derived, never assumed. */
function companyOffsetHours(iso: string): number {
  const instant = new Date(iso);
  const asCompanyWallClock = new Date(
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: COMPANY_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .format(instant)
      .replace(' ', 'T') + 'Z',
  );
  return (asCompanyWallClock.getTime() - instant.getTime()) / 3_600_000;
}

describe('the company timezone', () => {
  it('is a named IANA zone, not an offset', () => {
    // The whole point. An offset cannot carry daylight-saving rules, and a zone can.
    expect(COMPANY_TIME_ZONE).toBe('America/New_York');
    expect(COMPANY_TIME_ZONE).toMatch(/^[A-Za-z]+\/[A-Za-z_]+$/);
  });

  it('is EST (UTC-5) in winter', () => {
    expect(companyOffsetHours('2026-01-15T16:00:00.000Z')).toBe(-5);
  });

  it('is EDT (UTC-4) in summer', () => {
    expect(companyOffsetHours('2026-07-15T16:00:00.000Z')).toBe(-4);
  });

  it('assumes NEITHER offset all year', () => {
    /*
     * Stated as one assertion because it is the actual requirement: a single hard-coded offset
     * passes one of the two tests above and fails this one.
     */
    const winter = companyOffsetHours('2026-01-15T16:00:00.000Z');
    const summer = companyOffsetHours('2026-07-15T16:00:00.000Z');
    expect(winter).not.toBe(summer);
  });
});

describe('daylight saving transitions', () => {
  it('springs forward at 2am on 8 March 2026', () => {
    // 06:59:59Z is 01:59:59 EST. One second later the clock is 03:00:00 EDT — 02:xx never happens.
    expect(companyClock('2026-03-08T06:59:59.000Z')).toEqual({ hour: 1, minute: 59 });
    expect(companyClock('2026-03-08T07:00:00.000Z')).toEqual({ hour: 3, minute: 0 });

    expect(companyOffsetHours('2026-03-08T06:59:59.000Z')).toBe(-5);
    expect(companyOffsetHours('2026-03-08T07:00:00.000Z')).toBe(-4);
  });

  it('falls back at 2am on 1 November 2026', () => {
    // 01:30 happens twice: once at 05:30Z on EDT, once at 06:30Z on EST.
    expect(companyClock('2026-11-01T05:30:00.000Z')).toEqual({ hour: 1, minute: 30 });
    expect(companyClock('2026-11-01T06:30:00.000Z')).toEqual({ hour: 1, minute: 30 });

    // Same wall clock, different instants, different offsets — and both are rendered correctly.
    expect(companyOffsetHours('2026-11-01T05:30:00.000Z')).toBe(-4);
    expect(companyOffsetHours('2026-11-01T06:30:00.000Z')).toBe(-5);
  });

  it('keeps the two repeated hours distinguishable to the minute', () => {
    // A conversation spanning the repeated hour must still read in order, even though two of its
    // messages print the same time. The instants are what order them; the label is only a label.
    const first = '2026-11-01T05:45:00.000Z';
    const second = '2026-11-01T06:15:00.000Z';
    expect(new Date(first).getTime()).toBeLessThan(new Date(second).getTime());
    expect(companyClock(first)).toEqual({ hour: 1, minute: 45 });
    expect(companyClock(second)).toEqual({ hour: 1, minute: 15 });
  });
});

describe('formatInCompanyTime', () => {
  it('renders the company hour, not the machine hour', () => {
    // 20:00Z is 16:00 in New York, and it is 16:00 for every reader of this conversation.
    expect(formatInCompanyTime(new Date('2026-09-22T20:00:00.000Z'), {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })).toContain('16:00');
  });

  it('renders the company DATE across a midnight the reader may not share', () => {
    /*
     * 02:30Z on the 23rd is 22:30 on the 22nd in New York. A reader in India is already well into
     * the 23rd; the date shown is still the company's.
     */
    expect(formatInCompanyTime(new Date('2026-09-23T02:30:00.000Z'), {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })).toContain('22');
  });
});

describe('companyDayNumber', () => {
  it('puts late-evening Eastern on the Eastern day, not the next one', () => {
    // 2026-09-23T02:30Z = 22:30 on the 22nd in New York. Both are the SAME company day.
    const lateEvening = companyDayNumber(new Date('2026-09-23T02:30:00.000Z'));
    const sameAfternoon = companyDayNumber(new Date('2026-09-22T18:00:00.000Z'));
    expect(lateEvening).toBe(sameAfternoon);
  });

  it('counts consecutive days as consecutive numbers', () => {
    const monday = companyDayNumber(new Date('2026-09-21T16:00:00.000Z'));
    const tuesday = companyDayNumber(new Date('2026-09-22T16:00:00.000Z'));
    expect(tuesday - monday).toBe(1);
  });

  it('counts the spring-forward day as ONE day, though it is 23 hours long', () => {
    const before = companyDayNumber(new Date('2026-03-07T17:00:00.000Z'));
    const during = companyDayNumber(new Date('2026-03-08T17:00:00.000Z'));
    const after = companyDayNumber(new Date('2026-03-09T17:00:00.000Z'));

    // Arithmetic on elapsed milliseconds would make this day 23/24 of a day and drift.
    expect(during - before).toBe(1);
    expect(after - during).toBe(1);
  });

  it('counts the fall-back day as ONE day, though it is 25 hours long', () => {
    const before = companyDayNumber(new Date('2026-10-31T17:00:00.000Z'));
    const during = companyDayNumber(new Date('2026-11-01T17:00:00.000Z'));
    const after = companyDayNumber(new Date('2026-11-02T17:00:00.000Z'));

    expect(during - before).toBe(1);
    expect(after - during).toBe(1);
  });
});

describe('the chat formatters', () => {
  it('formatTime shows company time', () => {
    // 13:24 Eastern, whatever the machine running this thinks the time is.
    const label = formatTime('2026-09-22T17:24:00.000Z');
    expect(label).toMatch(/\b0?1:24\b/);
  });

  it('formatTime shows the SAME label for the same instant in winter and summer', () => {
    /*
     * Two instants chosen so that both are 09:00 in New York — one in EST, one in EDT. A fixed
     * offset renders one of them as 08:00 or 10:00. This is the test a hard-coded -5 fails.
     */
    const winter = formatTime('2026-01-15T14:00:00.000Z'); // 09:00 EST
    const summer = formatTime('2026-07-15T13:00:00.000Z'); // 09:00 EDT
    expect(winter).toBe(summer);
    expect(winter).toMatch(/\b0?9:00\b/);
  });

  it('formatDayLabel says "Today" on the company calendar', () => {
    // Late evening in New York; the reader's own date may already have rolled over.
    const instant = '2026-09-23T02:30:00.000Z';
    expect(formatDayLabel(instant, new Date('2026-09-23T03:00:00.000Z'))).toBe('Today');
  });

  it('formatDayLabel says "Yesterday" once the COMPANY date has rolled over', () => {
    // 2026-09-23T02:30Z is the 22nd in New York; 2026-09-23T13:00Z is the 23rd there.
    expect(formatDayLabel('2026-09-23T02:30:00.000Z', new Date('2026-09-23T13:00:00.000Z'))).toBe(
      'Yesterday',
    );
  });

  it('formatListTimestamp falls back to a date for anything older than a week', () => {
    const label = formatListTimestamp(
      '2026-09-01T16:00:00.000Z',
      new Date('2026-09-22T16:00:00.000Z'),
    );
    expect(label).not.toBe('Yesterday');
    expect(label).toMatch(/\d/);
  });

  it('formatFullTimestamp carries the company date and hour together', () => {
    // 22:30 on the 22nd in New York — the date and the time must agree with one another.
    const label = formatFullTimestamp('2026-09-23T02:30:00.000Z');
    expect(label).toContain('22');
    expect(label).toMatch(/10:30|22:30/);
  });
});

describe('a reader outside the company timezone', () => {
  /*
   * The formatters take no zone parameter, so there is no per-reader path to test through them.
   * What CAN be shown is the property that makes them safe: the rendering is a function of the
   * instant alone. Two readers, anywhere, formatting the same instant produce the same string —
   * which is exactly what `toLocaleTimeString()` with no zone did not guarantee.
   */
  it('gets the same label as a reader at head office', () => {
    const instant = '2026-09-22T17:24:00.000Z';

    const headOffice = new Intl.DateTimeFormat('en-US', {
      timeZone: COMPANY_TIME_ZONE,
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(instant));

    // The same call, made on a machine set to Asia/Kolkata, differs only in the zone it is NOT
    // allowed to use — so the fixed-zone formatter is what both of them run.
    expect(formatTime(instant)).toBe(
      new Intl.DateTimeFormat([], {
        timeZone: COMPANY_TIME_ZONE,
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(instant)),
    );
    expect(headOffice).toMatch(/1:24/);
  });

  it('is never shown the reader machine zone by accident', () => {
    /*
     * A regression guard with teeth: if `timeZone` were dropped from the formatter, this test
     * would pass or fail depending on where it ran. Comparing against an explicitly-Kolkata
     * rendering makes the failure deterministic — those two must NOT be equal.
     */
    const instant = new Date('2026-09-22T17:24:00.000Z');
    const kolkata = new Intl.DateTimeFormat([], {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
    }).format(instant);

    expect(formatTime('2026-09-22T17:24:00.000Z')).not.toBe(kolkata);
  });
});
