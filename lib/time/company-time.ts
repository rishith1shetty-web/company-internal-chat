/**
 * Company time: the one timezone every employee-facing timestamp is shown in.
 *
 * Rising Path Recruiters operates on U.S. Eastern Time, so a message sent at 09:24 is "09:24" to
 * everybody who reads it — the colleague at the next desk, the recruiter working from home, and
 * the contractor in another country looking at the same thread. Times in a conversation are only
 * useful if two people discussing them mean the same thing, and a timestamp rendered in whatever
 * zone the reader's laptop happens to be set to is not that.
 *
 * WHY AN IANA ZONE AND NOT AN OFFSET. `America/New_York` carries the daylight-saving rules with
 * it: EST in winter, EDT in summer, and the correct one for each individual instant, including
 * for messages sent before the last transition. A fixed `UTC-5` or `UTC-4` would be right for
 * about half the year and quietly wrong for the other half — and wrong in the archive forever.
 *
 * This is the display half of the timestamp model. The storage half is `lib/db/prisma.ts`, which
 * pins the database session to UTC so that the instant being formatted here is the real one.
 * Between them: stored as an absolute instant in UTC, carried over the wire as an ISO-8601 UTC
 * string, rendered in company time at the very last step and nowhere before it.
 *
 * Nothing in this module does timezone arithmetic. `Intl` owns the zone rules; adding or
 * subtracting hours by hand is how the bug this replaces was created.
 */

/** The company's operating timezone. The only zone employee-facing times are rendered in. */
export const COMPANY_TIME_ZONE = 'America/New_York';

/**
 * Formatters are cached because `Intl.DateTimeFormat` construction is the expensive part, and the
 * message list rebuilds a timestamp for every bubble on every render.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * An `Intl.DateTimeFormat` fixed to company time.
 *
 * The locale is left to the reader's browser, as it already was: this change is about WHICH
 * INSTANT a timestamp names, not about whether a date reads "22 September" or "September 22".
 * Pinning the locale too would silently restyle every date in the application for anybody whose
 * machine is not set to US English, which is a separate decision and not one to make by accident.
 */
export function companyTimeFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  const cached = formatterCache.get(key);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat([], { ...options, timeZone: COMPANY_TIME_ZONE });
  formatterCache.set(key, formatter);
  return formatter;
}

/** Formats an instant in company time. */
export function formatInCompanyTime(value: Date, options: Intl.DateTimeFormatOptions): string {
  return companyTimeFormatter(options).format(value);
}

/**
 * The calendar day an instant falls on **in company time**, as a day number that can be
 * subtracted.
 *
 * "Today" and "Yesterday" are the reason this exists. They are questions about a calendar, and
 * the only calendar that makes sense here is the company's: a reader in India opening the app at
 * 09:00 their time is looking at 23:30 the previous evening in New York, and a separator reading
 * "Today" above messages stamped with yesterday's times would be self-contradicting.
 *
 * The parts are read with `formatToParts` and looked up BY NAME rather than by position. A
 * formatted string would have to be parsed, and its field order is the reader's locale's
 * business — `22/09/2026` and `9/22/2026` are the same day written by two colleagues' laptops,
 * and splitting either on punctuation gets one of them backwards. The parts are then converted
 * through `Date.UTC`, so the subtraction is between two plain day counts and never crosses a DST
 * boundary mid-calculation.
 */
export function companyDayNumber(value: Date): number {
  const parts = companyTimeFormatter({
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) throw new Error(`Company time is missing the "${type}" part of a calendar date.`);
    return Number(part.value);
  };

  return Math.round(Date.UTC(read('year'), read('month') - 1, read('day')) / 86_400_000);
}
