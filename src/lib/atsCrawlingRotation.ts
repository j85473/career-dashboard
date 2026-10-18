import { createHash } from 'node:crypto';
import { NON_API_ATS_PLATFORMS } from './browserAtsBoards';
import { assignedRotationDay, atsRotationDayWindow, ATS_ROTATION_DAY_NAMES, nextAtsBoardCheckDateForDay } from './atsRotation';

export type CrawlRotationBoard = {
  slug: string;
  platform: string;
  status: string;
  checkDay: number;
  jobsFound: number;
  failCount: number;
  retryCount: number;
  nextCheckDate: Date;
  discoveredAt: Date;
  lastAttemptedAt: Date | null;
  lastRespondedAt: Date | null;
  lastCheckedAt: Date | null;
  lastSynchronizedAt: Date | null;
  lastProcessedAt: Date | null;
  rotationMovedAt: Date | null;
  hasSweep: boolean;
  hasOpenWork: boolean;
  taskLeased: boolean;
};

export type CrawlCycleRun = {
  source: string;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  seenCount: number;
  reconciled: boolean;
  checkpoint: unknown;
};
export type CrawlCycleSample = { slug: string; platform: string; workerMs: number; jobs: number; completedAt: Date; turns: number };
export type CrawlWorkloadProfile = { workerMs: number; msPerJob: number; typicalJobs: number; samples: number; basis: string };
export type CrawlRotationDay = { day: number; dayName: string; boards: number; workerMs: number; browserWorkerMs: number; httpWorkerMs: number };
export type CrawlRotationAssignment = {
  slug: string; platform: string; status: string; discoveredAt: Date;
  fromDay: number; toDay: number; fromNextCheckDate: Date; nextCheckDate: Date; workerMs: number;
};

const key = (platform: string, slug: string) => JSON.stringify([platform, slug]);

/** Discovery historically represented a ready browser board as parked with
 * failCount=1. That placeholder is not evidence of a failed crawl. A real
 * validation hold is future-dated; a real crawl writes contact/progress first.
 * rotationMovedAt also recognizes a placeholder already given its first slot.
 */
export function untouchedPendingCrawl(board: CrawlRotationBoard): boolean {
  return board.status === 'parked' && board.failCount === 1 && board.retryCount === 0 && board.jobsFound === 0
    && board.lastAttemptedAt === null && board.lastRespondedAt === null && board.lastCheckedAt === null
    && board.lastSynchronizedAt === null && board.lastProcessedAt === null && !board.hasSweep && !board.hasOpenWork
    && (board.nextCheckDate.valueOf() <= board.discoveredAt.valueOf() + 60_000 || board.rotationMovedAt !== null);
}

/** Repository-owned predicate shared by selection and guarded application.
 * The outer board alias is intentionally fixed; no identifiers are supplied.
 */
export const CRAWL_PENDING_DISCOVERY_SQL = `(
  board.status='parked' AND board."failCount"=1 AND board."retryCount"=0 AND board."jobsFound"=0
  AND board."lastAttemptedAt" IS NULL AND board."lastRespondedAt" IS NULL AND board."lastCheckedAt" IS NULL
  AND board."lastSynchronizedAt" IS NULL AND board."lastProcessedAt" IS NULL
  AND (board."nextCheckDate"<=board."discoveredAt"+INTERVAL '60 seconds' OR board."rotationMovedAt" IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM "AtsBrowserSweep" pending_sweep WHERE pending_sweep.slug=board.slug AND pending_sweep.platform=board.platform)
  AND NOT EXISTS (SELECT 1 FROM "AtsIngestionBatch" pending_work WHERE pending_work.slug=board.slug AND pending_work.platform=board.platform
    AND (pending_work.status IN ('fetching','partial','queued','processing','synchronized','reset_synchronized','reset_draining')
      OR pending_work."leaseExpiresAt">(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      OR pending_work."acquisitionLeaseExpiresAt">(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')))
)`;
function crawlCheckpoint(checkpoint: unknown): Record<string, unknown> | null {
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return null;
  const crawl = (checkpoint as Record<string, unknown>).crawl;
  return crawl && typeof crawl === 'object' && !Array.isArray(crawl) ? crawl as Record<string, unknown> : null;
}

/** Sum all observed turns between completions, never just the final short turn.
 * Reconcile the sum of turn outcomes with the durable cumulative posting count.
 * Gusto's historical pass receipts have no board identity and cannot be used.
 */
export function completedCrawlCycleSamples(runs: readonly CrawlCycleRun[], now: Date): CrawlCycleSample[] {
  const grouped = new Map<string, Array<{ run: CrawlCycleRun; crawl: Record<string, unknown>; platform: string; slug: string }>>();
  for (const run of runs) {
    const crawl = crawlCheckpoint(run.checkpoint);
    const platform = run.source === 'Gusto' ? 'gusto' : run.source.replace(/^ATS-/, '');
    if (!NON_API_ATS_PLATFORMS.includes(platform) || typeof crawl?.board !== 'string') continue;
    if (!run.finishedAt || run.finishedAt > now || run.startedAt > now) continue;
    const identity = key(platform, crawl.board);
    const rows = grouped.get(identity) || [];
    rows.push({ run, crawl, platform, slug: crawl.board });
    grouped.set(identity, rows);
  }
  const samples: CrawlCycleSample[] = [];
  for (const rows of grouped.values()) {
    rows.sort((a, b) => a.run.finishedAt!.valueOf() - b.run.finishedAt!.valueOf()
      || a.run.startedAt.valueOf() - b.run.startedAt.valueOf());
    let cycle: typeof rows = [];
    let latest: CrawlCycleSample | undefined;
    for (const row of rows) {
      cycle.push(row);
      if (row.crawl.complete !== true) continue;
      const jobs = row.crawl.processed;
      const valid = Number.isSafeInteger(jobs) && Number(jobs) >= 0 && cycle.every(({ run }) => run.reconciled
        && Number.isFinite(run.durationMs) && Number(run.durationMs) > 0
        && run.finishedAt! >= run.startedAt
        && Math.abs(run.finishedAt!.valueOf() - run.startedAt.valueOf() - Number(run.durationMs)) < 1000
        && Number.isSafeInteger(run.seenCount) && run.seenCount >= 0);
      if (valid && cycle.reduce((sum, item) => sum + item.run.seenCount, 0) === jobs) {
        latest = { slug: row.slug, platform: row.platform, workerMs: cycle.reduce((sum, item) => sum + Number(item.run.durationMs), 0), jobs: Number(jobs), completedAt: row.run.finishedAt!, turns: cycle.length };
      }
      // A rejected or incomplete measurement must not bleed into the next cycle.
      cycle = [];
    }
    if (latest) samples.push(latest);
  }
  return samples.sort((a, b) => a.platform.localeCompare(b.platform) || a.slug.localeCompare(b.slug));
}

function median(values: number[], fallback: number): number {
  if (!values.length) return fallback;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function crawlWorkloadProfiles(samples: readonly CrawlCycleSample[]): Record<string, CrawlWorkloadProfile> {
  const profile = (rows: readonly CrawlCycleSample[], fallbackMs: number): CrawlWorkloadProfile => ({
    workerMs: median(rows.map(row => row.workerMs), fallbackMs),
    msPerJob: median(rows.map(row => row.workerMs / Math.max(1, row.jobs)), fallbackMs / 10),
    typicalJobs: median(rows.map(row => Math.max(1, row.jobs)), 10),
    samples: rows.length, basis: rows.length ? 'observed completed cycles with reconciled posting counts' : 'unmeasured planning assumption',
  });
  const browser = profile(samples.filter(sample => sample.platform !== 'adp'), 30_000);
  const result: Record<string, CrawlWorkloadProfile> = { '*': browser };
  for (const platform of NON_API_ATS_PLATFORMS) {
    const rows = samples.filter(sample => sample.platform === platform);
    result[platform] = rows.length ? profile(rows, 30_000) : platform === 'adp'
      ? profile([], 3_000) : { ...browser, samples: 0, basis: browser.samples ? 'other browser providers completed-cycle median' : browser.basis };
  }
  return result;
}

export function cleanFirstCrawlBoard(board: CrawlRotationBoard): boolean {
  return NON_API_ATS_PLATFORMS.includes(board.platform) && ['active', 'parked'].includes(board.status)
    && board.lastAttemptedAt === null && board.lastRespondedAt === null && board.lastCheckedAt === null
    && board.lastSynchronizedAt === null && board.lastProcessedAt === null && board.rotationMovedAt === null
    && (board.failCount === 0 || untouchedPendingCrawl(board)) && board.retryCount === 0 && !board.hasSweep && !board.hasOpenWork && !board.taskLeased;
}

/** Same-day slots remain eligible if their hash time already passed. Future
 * slots stay inside the assigned Chicago calendar day, including DST days. */
function weeklySlotPicker(now: Date): (identity: string, day: number) => Date {
  if (!Number.isFinite(now.valueOf())) throw Error('Invalid first-crawl weekly slot');
  const today = atsRotationDayWindow(now);
  const spans = ATS_ROTATION_DAY_NAMES.map((_name, day) => {
    // The API rotation opens at 00:01. Browser work is spread over the actual
    // local calendar day, so its final minute must not land tomorrow at 00:00.
    const opening = day === today.rotationDay ? today.startsAt : nextAtsBoardCheckDateForDay(day, now);
    const start = new Date(opening.valueOf() - 60_000);
    const end = new Date(atsRotationDayWindow(new Date(opening.valueOf() + 60_000)).endsAt.valueOf() - 60_000);
    return { start, minutes: Math.floor((end.valueOf() - start.valueOf()) / 60_000) };
  });
  return (identity, day) => {
    if (!Number.isInteger(day) || day < 0 || day > 6) throw Error('Invalid first-crawl weekly slot');
    const { start, minutes } = spans[day];
    const offset = createHash('sha256').update(identity).digest().readUInt32BE(0) % minutes;
    return new Date(Math.max(now.valueOf(), Math.min(start.valueOf() + offset * 60_000, now.valueOf() + 7 * 86_400_000)));
  };
}
export function firstCrawlWeeklySlot(identity: string, day: number, now: Date): Date { return weeklySlotPicker(now)(identity, day); }

function emptyDays(): CrawlRotationDay[] {
  return ATS_ROTATION_DAY_NAMES.map((dayName, day) => ({ day, dayName, boards: 0, workerMs: 0, browserWorkerMs: 0, httpWorkerMs: 0 }));
}
function addWork(day: CrawlRotationDay, platform: string, workerMs: number): void {
  day.boards++; day.workerMs += workerMs;
  if (platform === 'adp') day.httpWorkerMs += workerMs; else day.browserWorkerMs += workerMs;
}
function workload(board: CrawlRotationBoard, samples: Map<string, CrawlCycleSample>, profiles: Record<string, CrawlWorkloadProfile>): number {
  const sample = samples.get(key(board.platform, board.slug));
  if (sample) return Math.max(1_000, sample.workerMs);
  const profile = profiles[board.platform] || profiles['*'];
  return Math.max(1_000, board.jobsFound > 1 ? Math.max(profile.workerMs / 4, board.jobsFound * profile.msPerJob) : profile.workerMs);
}

/** First reservations only. Attempted, failed, continued, established and
 * already-reserved boards contribute workload but retain their exact schedule.
 */
export function planCrawlingRotation(boards: readonly CrawlRotationBoard[], runs: readonly CrawlCycleRun[], now = new Date()) {
  if (!Number.isFinite(now.valueOf())) throw Error('Invalid crawling rotation observation time');
  const enabled = boards.filter(board => NON_API_ATS_PLATFORMS.includes(board.platform) && ['active', 'parked'].includes(board.status));
  const seen = new Set<string>();
  for (const board of enabled) {
    if (seen.has(key(board.platform, board.slug))) throw Error('Duplicate board in crawling rotation snapshot');
    seen.add(key(board.platform, board.slug));
    if (!Number.isInteger(board.checkDay) || board.checkDay < 0 || board.checkDay > 6
      || !Number.isFinite(board.nextCheckDate.valueOf()) || !Number.isFinite(board.discoveredAt.valueOf())) throw Error('Invalid board schedule in crawling rotation snapshot');
  }
  const cycleSamples = completedCrawlCycleSamples(runs, now);
  const samples = new Map(cycleSamples.map(sample => [key(sample.platform, sample.slug), sample]));
  const profiles = crawlWorkloadProfiles(cycleSamples);
  const before = emptyDays(), after = emptyDays();
  const candidates: Array<{ board: CrawlRotationBoard; workerMs: number }> = [];
  for (const board of enabled) {
    const workerMs = workload(board, samples, profiles);
    addWork(before[board.checkDay], board.platform, workerMs);
    if (cleanFirstCrawlBoard(board) && board.nextCheckDate <= now) candidates.push({ board, workerMs });
    else addWork(after[board.checkDay], board.platform, workerMs);
  }
  candidates.sort((a, b) => b.workerMs - a.workerMs || a.board.platform.localeCompare(b.board.platform) || a.board.slug.localeCompare(b.board.slug));
  const assignments: CrawlRotationAssignment[] = [];
  const slotFor = weeklySlotPicker(now);
  for (const { board, workerMs } of candidates) {
    const preferred = assignedRotationDay(board.slug, board.platform);
    // Independent HTTP/browser loads: a cheap HTTP cohort cannot conceal an
    // overloaded licensed-browser day after ADP leaves the shared browser seat.
    const metric = board.platform === 'adp' ? 'httpWorkerMs' : 'browserWorkerMs';
    const day = [...after].sort((a, b) => a[metric] - b[metric] || a.workerMs - b.workerMs || a.boards - b.boards
      || (a.day - preferred + 7) % 7 - (b.day - preferred + 7) % 7)[0].day;
    const slot = slotFor(`${board.platform}:${board.slug}`, day);
    // A reservation never pulls a future-dated board ahead of an existing hold.
    if (slot < board.nextCheckDate) { addWork(after[board.checkDay], board.platform, workerMs); continue; }
    assignments.push({ slug: board.slug, platform: board.platform, status: board.status, discoveredAt: board.discoveredAt,
      fromDay: board.checkDay, toDay: day, fromNextCheckDate: board.nextCheckDate, nextCheckDate: slot, workerMs });
    addWork(after[day], board.platform, workerMs);
  }
  const totalMs = after.reduce((sum, day) => sum + day.workerMs, 0);
  const browserMs = after.reduce((sum, day) => sum + day.browserWorkerMs, 0);
  const httpMs = after.reduce((sum, day) => sum + day.httpWorkerMs, 0);
  const selectionHash = createHash('sha256').update(JSON.stringify({ version: 1, observedAt: now.toISOString(), assignments })).digest('hex');
  const hours = (ms: number) => ms / 3_600_000;
  return { version: 1, observedAt: now, selectionHash, boardCount: enabled.length, candidates: candidates.length,
    reservedBoards: assignments.length, untouchedBoards: enabled.length - assignments.length,
    movedWeekday: assignments.filter(assignment => assignment.fromDay !== assignment.toDay).length,
    movedLater: assignments.filter(assignment => assignment.nextCheckDate > assignment.fromNextCheckDate).length,
    maximumDelayFromNowHours: assignments.reduce((maximum, assignment) => Math.max(maximum, (assignment.nextCheckDate.valueOf() - now.valueOf()) / 3_600_000), 0),
    before, after, profiles, cycleSamples: cycleSamples.length,
    measuredBoards: enabled.filter(board => samples.has(key(board.platform, board.slug))).length,
    estimatedBoards: enabled.filter(board => !samples.has(key(board.platform, board.slug))).length,
    capacity: { estimatedWorkerHoursPerWeek: hours(totalMs), estimatedWorkerHoursPerDay: hours(totalMs / 7),
      browserHoursPerWeek: hours(browserMs), browserHoursPerDay: hours(browserMs / 7), httpHoursPerWeek: hours(httpMs),
      browserShareOfOneContinuousSeat: browserMs / (7 * 86_400_000),
      perDay: after.map(day => ({ day: day.dayName, boards: day.boards, workerHours: hours(day.workerMs), browserHours: hours(day.browserWorkerMs), httpHours: hours(day.httpWorkerMs) })) },
    limitations: ['Workload estimates are planning inputs, not measured future throughput or a weekly completion guarantee.',
      'Historical completed cycles reconcile observed posting counts, but prior zero-output time outside the snapshot can be missing.',
      'Completed-board samples favor boards that already finished; large unfinished or failing catalogues can cost materially more.',
      'Initial crawls and duplicate-heavy refresh costs are not yet measured separately.',
      'Historical Gusto pass durations without per-board provenance are excluded from cost samples.',
      'Unknown boards use provider medians; without measurements the assumptions are 30 seconds per browser board and 3 seconds per HTTP ADP board.',
      'Capacity excludes discovery, resolver seat use, newly discovered boards, future daily refreshes and additional retry work.'], assignments };
}
