import { createHash } from 'node:crypto';

/**
 * The ATS board rotation.
 *
 * Every board is assigned one weekday and swept on that day, so the catalog is
 * divided into seven fixed cohorts rather than drained from a queue. The
 * previous scheme rescheduled each board a fixed interval after its last check,
 * which is a rolling queue: it inherited whatever uneven distribution the
 * catalog already had, reported all 43,461 active boards as overdue at once,
 * and could not answer "which boards run today".
 */

/** Days in one full rotation. One cohort per day. */
export const ATS_ROTATION_DAYS = 7;

/**
 * Operating target for the fixed weekday cohorts.
 *
 * The current catalog is roughly 43,000 active boards, so a complete weekly
 * sweep needs about 6,165 checks a day. Keeping a small explicit floor above
 * that value absorbs newly discovered boards without silently slipping below
 * one full catalog pass per week.
 */
export const ATS_DAILY_BOARD_TARGET = 6_200;

export function requiredAtsBoardChecksPerDay(activeBoards: number): number {
  const active = Math.max(0, Math.floor(activeBoards));
  if (active === 0) return 0;
  return Math.min(active, Math.max(ATS_DAILY_BOARD_TARGET, Math.ceil(active / ATS_ROTATION_DAYS)));
}

/** The calendar the rotation is stated in. "Sunday" means Sunday here. */
export const ATS_ROTATION_TIME_ZONE = 'America/Chicago';

export const ATS_ROTATION_DAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

/**
 * The weekday a board belongs to, derived from its identity.
 *
 * Deterministic on purpose: the same board always lands on the same day, so a
 * re-run of the backfill cannot reshuffle the catalog, and a board rediscovered
 * after being dropped returns to the cohort it left. Over tens of thousands of
 * boards an MD5 prefix keeps the seven cohorts within a few percent.
 */
export function assignedRotationDay(slug: string, platform: string): number {
  const digest = createHash('md5').update(`${slug}::${platform}`).digest();
  return digest.readUInt32BE(0) % ATS_ROTATION_DAYS;
}

/** Today's cohort, in the rotation's own calendar rather than the server's. */
export function rotationDayFor(
  now: Date = new Date(),
  timeZone = ATS_ROTATION_TIME_ZONE,
): number {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(now);
  const index = ATS_ROTATION_DAY_NAMES.indexOf(weekday as typeof ATS_ROTATION_DAY_NAMES[number]);
  if (index < 0) throw new Error(`Unrecognized rotation weekday: ${weekday}`);
  return index;
}

/**
 * The board's next slot: the same weekday, one rotation later.
 *
 * `nextCheckDate` stays the "not eligible again yet" guard so a board cannot be
 * swept twice in one rotation, while `checkDay` decides which boards are picked
 * today. The failure backoff writes its own longer values to the same column
 * and is deliberately left alone.
 */
export function nextAtsBoardCheckDate(
  now: Date = new Date(),
  rotationDays = ATS_ROTATION_DAYS,
): Date {
  return new Date(now.valueOf() + rotationDays * 86_400_000);
}

/**
 * Next occurrence of a board's assigned weekday.
 *
 * This differs from simply adding seven days when a missed board is caught up
 * on the wrong weekday: the catch-up must rejoin its assigned cohort instead
 * of drifting into a permanent rolling cooldown.
 */
export function nextAtsBoardCheckDateForDay(
  checkDay: number,
  now: Date = new Date(),
): Date {
  if (!Number.isInteger(checkDay) || checkDay < 0 || checkDay >= ATS_ROTATION_DAYS) {
    throw new Error(`Invalid ATS rotation day: ${checkDay}`);
  }
  const currentDay = rotationDayFor(now);
  const daysAhead = (checkDay - currentDay + ATS_ROTATION_DAYS) % ATS_ROTATION_DAYS || ATS_ROTATION_DAYS;
  return new Date(now.valueOf() + daysAhead * 86_400_000);
}

/** Boards not swept within a full rotation have missed their slot. */
export function atsRotationCycleCutoff(
  now: Date = new Date(),
  rotationDays = ATS_ROTATION_DAYS,
): Date {
  return new Date(now.valueOf() - rotationDays * 86_400_000);
}

/**
 * Statuses that hold a weekly rotation slot.
 *
 * `parked` and `blacklisted` are boards that have failed one to three times.
 * They keep their own failCount backoff and are still retried, but they do not
 * compete for the rotation: 60,954 of them shared the sweep budget with 43,461
 * active boards while only about 2% of them returned anything, which is why the
 * active catalog could not complete a weekly pass.
 */
export const ATS_ROTATION_STATUSES = ['active'] as const;

/** Failing boards, retried on their backoff with whatever capacity is left. */
export const ATS_RECOVERY_STATUSES = ['parked', 'blacklisted'] as const;

/**
 * Whether a board identity is worth spending a request on at all.
 *
 * Workday legitimately uses a `tenant::site` slug, so each part is judged
 * separately rather than rejecting the separator. Only nine boards in the
 * catalog fail this — slugs like `...`, `=`, and `-` captured by a bad
 * discovery parse — but nothing should re-enter the rotation on one.
 */
export function isSchedulableBoardSlug(slug: string): boolean {
  const trimmed = String(slug || '').trim();
  if (trimmed.length === 0) return false;
  return trimmed.split('::').every((part) => /[a-zA-Z0-9]/.test(part));
}

export type RotationCohortBalance = {
  day: number;
  dayName: string;
  boards: number;
};

/**
 * How evenly the catalog is spread across the week. A cohort far from the mean
 * means one weekday is carrying work another weekday has capacity for.
 */
export function summarizeRotationBalance(
  countsByDay: Readonly<Record<number, number>>,
): { cohorts: RotationCohortBalance[]; mean: number; maxDeviation: number } {
  const cohorts = ATS_ROTATION_DAY_NAMES.map((dayName, day) => ({
    day,
    dayName,
    boards: countsByDay[day] || 0,
  }));
  const total = cohorts.reduce((sum, cohort) => sum + cohort.boards, 0);
  const mean = total / ATS_ROTATION_DAYS;
  const maxDeviation = mean === 0
    ? 0
    : Math.max(...cohorts.map((cohort) => Math.abs(cohort.boards - mean))) / mean;
  return { cohorts, mean, maxDeviation };
}
