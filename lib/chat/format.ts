/**
 * Presentation helpers for the chat UI. Pure functions, no React, no data access.
 *
 * Timestamps arrive as ISO-8601 UTC strings and are rendered in COMPANY time — America/New_York,
 * whatever the reader's machine is set to. That replaces assumption A-05 ("the browser's local
 * timezone"), which was fine while everyone was in the office and wrong as soon as anyone was
 * not: two people discussing "the 3 o'clock message" have to be looking at the same number.
 * See lib/time/company-time.ts for why the zone is named rather than offset.
 *
 * Because the same component tree renders on the server during SSR and again in the browser,
 * any locale-dependent output must still be marked with `suppressHydrationWarning` at the
 * element that prints it — see components/chat/MessageBubble.tsx. Fixing the timezone removes
 * one source of that mismatch, not the locale itself.
 */

import { companyDayNumber, formatInCompanyTime } from '@/lib/time/company-time';

import type { Conversation, UserSummary } from './types';

/** Initials for an avatar: at most two letters, derived from the display name. */
export function initials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1] ?? '') : '';
  const letters = `${first.charAt(0)}${last.charAt(0)}` || first.charAt(0);
  return letters.toUpperCase();
}

/**
 * Stable avatar tint derived from the user id, so the same person always looks the same.
 * Keyed on the id rather than the name because names are not unique (D-02).
 *
 * One warm family drawn around the company bronze rather than six unrelated hues: a group
 * conversation shows six of these at once, and a rainbow of stock Tailwind colours is the thing
 * that makes an otherwise composed interface look assembled from parts. Each pair is a token
 * defined in app/globals.css, and each foreground is at least 4.5:1 on its own tint.
 */
const AVATAR_TINTS = [
  'bg-tint-amber text-tint-amber-ink',
  'bg-tint-bronze text-tint-bronze-ink',
  'bg-tint-clay text-tint-clay-ink',
  'bg-tint-olive text-tint-olive-ink',
  'bg-tint-teal text-tint-teal-ink',
  'bg-tint-sand text-tint-sand-ink',
] as const;

export function avatarTint(userId: string): string {
  let hash = 0;
  for (let index = 0; index < userId.length; index += 1) {
    hash = (hash * 31 + userId.charCodeAt(index)) >>> 0;
  }
  return AVATAR_TINTS[hash % AVATAR_TINTS.length] ?? AVATAR_TINTS[0];
}

/**
 * Short, human-usable discriminator for a user id.
 *
 * Required by D-02: two employees may both be "Sarah Chen", so any picker that shows a name
 * must also show something that tells them apart.
 */
export function userDiscriminator(userId: string): string {
  return userId.slice(-4).toUpperCase();
}

/** True when more than one user in the list shares this display name (case-insensitive). */
export function hasNameCollision(users: readonly UserSummary[], user: UserSummary): boolean {
  const normalized = user.displayName.trim().toLowerCase();
  return users.some(
    (other) => other.id !== user.id && other.displayName.trim().toLowerCase() === normalized,
  );
}

/** Time of day in company time, e.g. "09:24". */
export function formatTime(isoTimestamp: string): string {
  return formatInCompanyTime(new Date(isoTimestamp), { hour: '2-digit', minute: '2-digit' });
}

/** Day label used for message separators: "Today", "Yesterday", or a full date. */
export function formatDayLabel(isoTimestamp: string, now: Date = new Date()): string {
  const value = new Date(isoTimestamp);
  const dayDifference = daysBetween(value, now);
  if (dayDifference === 0) return 'Today';
  if (dayDifference === 1) return 'Yesterday';
  return formatInCompanyTime(value, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Compact stamp for the conversation list: time today, weekday this week, else a date. */
export function formatListTimestamp(isoTimestamp: string, now: Date = new Date()): string {
  const value = new Date(isoTimestamp);
  const dayDifference = daysBetween(value, now);
  if (dayDifference === 0) return formatTime(isoTimestamp);
  if (dayDifference === 1) return 'Yesterday';
  if (dayDifference < 7) return formatInCompanyTime(value, { weekday: 'short' });
  return formatInCompanyTime(value, { day: '2-digit', month: '2-digit', year: '2-digit' });
}

/** Full company-time timestamp, used in tooltips, the details panel and the admin console. */
export function formatFullTimestamp(isoTimestamp: string): string {
  return formatInCompanyTime(new Date(isoTimestamp), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "Online", or a last-seen phrase for an offline user. */
export function formatPresence(user: UserSummary): string {
  if (user.presence === 'ONLINE') return 'Online';
  if (!user.lastSeenAt) return 'Offline';
  return `Last seen ${formatListTimestamp(user.lastSeenAt)}`;
}

/** Byte size for file rows (Phase 7 renders real values; Phase 2 has none). */
export function formatByteSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value >= 10 || unitIndex === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

/**
 * Whole days between two instants, counted on the COMPANY's calendar.
 *
 * "Today" has to mean today in New York. Counted on the reader's own calendar instead, a message
 * sent at 21:00 Eastern is already "Yesterday" to a colleague in India whose date has rolled
 * over — sitting directly above a timestamp that still says 21:00.
 */
function daysBetween(value: Date, now: Date): number {
  return companyDayNumber(now) - companyDayNumber(value);
}

/** Member count phrase for a group header. */
export function memberCountLabel(conversation: Conversation): string {
  const count = conversation.members.length;
  return `${count} ${count === 1 ? 'member' : 'members'}`;
}

/**
 * A byte count as a person would say it: "312 KB", "1.4 GB".
 *
 * Base-1024 with the familiar KB/MB/GB labels, which is what Windows and every file manager the
 * staff use show — being pedantically correct with KiB here would just look wrong to them.
 *
 * Takes a string because the wire carries `byteSize` as a decimal string (the column is a
 * BigInt). An unparseable value produces an empty label rather than "NaN B".
 */
export function formatFileSize(bytes: string | number): string {
  const value = typeof bytes === 'number' ? bytes : Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value === 0) return 'Empty file';
  if (value < 1024) return `${value} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;

  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }

  // One decimal below 10 so "1.4 MB" is not rounded to "1 MB"; none above, where it is noise.
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

/**
 * A short, uppercase label for a file — "PDF", "XLSX", "MP4", or "FILE".
 *
 * Cosmetic only. Nothing in this application behaves differently because of it, which is what
 * makes it safe to derive from a name the sender chose.
 */
export function fileTypeLabel(attachment: { filename: string; extension: string }): string {
  if (attachment.extension.length > 0) return attachment.extension.toUpperCase().slice(0, 5);

  const dot = attachment.filename.lastIndexOf('.');
  if (dot > 0 && dot < attachment.filename.length - 1) {
    return attachment.filename.slice(dot + 1).toUpperCase().slice(0, 5);
  }

  return 'FILE';
}
