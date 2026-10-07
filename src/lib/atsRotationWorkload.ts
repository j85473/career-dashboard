import {
  assignedRotationDay,
  ATS_ROTATION_DAYS,
  ATS_ROTATION_DAY_NAMES,
  isAtsBoardEnabledForIngestion,
  nextAtsBoardCheckDateForDay,
} from './atsRotation';

export const ATS_ROTATION_BALANCE_POLICY = {
  triggerDeviation: 0.15,
  maximumMoves: 100,
  maximumBoardFraction: 0.02,
  minimumVarianceImprovement: 0.05,
  reviewIntervalMs: 7 * 86_400_000,
  boardMoveCooldownMs: 28 * 86_400_000,
  minimumNoticeMs: 86_400_000,
  minimumCycleGapMs: 4 * 86_400_000,
  sampleMaxAgeMs: 30 * 86_400_000,
} as const;

export type AtsWorkloadBoard = {
  slug: string;
  platform: string;
  checkDay: number;
  jobsFound: number;
  failCount: number;
  retryCount: number;
  nextCheckDate: Date;
  lastProcessedAt: Date | null;
  rotationMovedAt: Date | null;
  hasOpenWork: boolean;
  sampleJobs: number | null;
  workerMs: number | null;
  sampleAt: Date | null;
};

export type AtsWorkloadProfile = { msPerJob: number; typicalJobs: number; samples: number };
export type AtsWorkloadProfiles = Record<string, AtsWorkloadProfile>;
export type AtsWorkloadDay = { day: number; dayName: string; boards: number; workerMs: number };
export type AtsRotationMove = {
  slug: string;
  platform: string;
  fromDay: number;
  toDay: number;
  workerMs: number;
  fromNextCheckDate: Date;
  nextCheckDate: Date;
  lastProcessedAt: Date;
};

function median(values: number[], fallback: number): number {
  if (!values.length) return fallback;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function usableSample(board: AtsWorkloadBoard, now: Date): boolean {
  return board.sampleAt !== null && board.sampleAt <= now
    && now.valueOf() - board.sampleAt.valueOf() <= ATS_ROTATION_BALANCE_POLICY.sampleMaxAgeMs
    && Number.isFinite(board.workerMs) && Number(board.workerMs) > 0
    && Number.isFinite(board.sampleJobs) && Number(board.sampleJobs) >= 0;
}

/** Provider medians let an unmeasured board reserve work instead of counting as zero. */
export function buildAtsWorkloadProfiles(boards: AtsWorkloadBoard[], now: Date): AtsWorkloadProfiles {
  const samples = boards.filter((board) => usableSample(board, now));
  const profile = (rows: AtsWorkloadBoard[]): AtsWorkloadProfile => ({
    msPerJob: Math.max(1, median(rows.map((row) => Number(row.workerMs) / Math.max(1, Number(row.sampleJobs))), 1_000)),
    typicalJobs: Math.max(1, median(rows.map((row) => Math.max(1, Number(row.sampleJobs))), 10)),
    samples: rows.length,
  });
  const result: AtsWorkloadProfiles = { '*': profile(samples) };
  for (const platform of new Set(samples.map((board) => board.platform))) {
    result[platform] = profile(samples.filter((board) => board.platform === platform));
  }
  return result;
}

export function estimateNewAtsBoardWorkload(
  platform: string, jobsFound: number | undefined, profiles: AtsWorkloadProfiles,
): number {
  const profile = profiles[platform] || profiles['*'] || { msPerJob: 1_000, typicalJobs: 10, samples: 0 };
  // A discovery placeholder of one is not a completed, one-job collection.
  const jobs = Number.isFinite(jobsFound) && Number(jobsFound) > 1 ? Number(jobsFound) : profile.typicalJobs;
  return Math.max(1_000, jobs * profile.msPerJob);
}

export function estimateAtsBoardWorkload(
  board: AtsWorkloadBoard, profiles: AtsWorkloadProfiles, now: Date,
): { workerMs: number; measured: boolean } {
  const measured = usableSample(board, now);
  return {
    workerMs: measured ? Math.max(1_000, Number(board.workerMs))
      : estimateNewAtsBoardWorkload(board.platform, board.jobsFound, profiles),
    measured,
  };
}

/** Stable identity breaks ties; persisted weekday remains authoritative afterward. */
export function lightestAtsWorkloadDay(slug: string, platform: string, days: AtsWorkloadDay[]): number {
  if (days.length !== ATS_ROTATION_DAYS || days.some((day, index) => day.day !== index
    || !Number.isFinite(day.workerMs) || day.workerMs < 0)) {
    return assignedRotationDay(slug, platform);
  }
  const preferred = assignedRotationDay(slug, platform);
  return [...days].sort((a, b) => a.workerMs - b.workerMs || a.boards - b.boards
    || ((a.day - preferred + 7) % 7) - ((b.day - preferred + 7) % 7))[0].day;
}

function variance(days: AtsWorkloadDay[]): number {
  const mean = days.reduce((sum, day) => sum + day.workerMs, 0) / ATS_ROTATION_DAYS;
  return days.reduce((sum, day) => sum + (day.workerMs - mean) ** 2, 0);
}

export function summarizeAtsWorkload(days: AtsWorkloadDay[]) {
  const meanWorkerMs = days.reduce((sum, day) => sum + day.workerMs, 0) / ATS_ROTATION_DAYS;
  return { meanWorkerMs, maxDeviation: meanWorkerMs === 0 ? 0
    : Math.max(...days.map((day) => Math.abs(day.workerMs - meanWorkerMs))) / meanWorkerMs };
}

/** Pure preview: never alters a board, receipt, queue, or saved job. */
export function planAtsRotationWorkload(boards: AtsWorkloadBoard[], now = new Date()) {
  const enabled = boards.filter((board) => isAtsBoardEnabledForIngestion(board)
    && Number.isInteger(board.checkDay) && board.checkDay >= 0 && board.checkDay < 7);
  const profiles = buildAtsWorkloadProfiles(enabled, now);
  const before: AtsWorkloadDay[] = ATS_ROTATION_DAY_NAMES.map((dayName, day) => ({ day, dayName, boards: 0, workerMs: 0 }));
  let measuredBoards = 0;
  const costs = enabled.map((board) => {
    const estimate = estimateAtsBoardWorkload(board, profiles, now);
    measuredBoards += Number(estimate.measured);
    before[board.checkDay].boards += 1;
    before[board.checkDay].workerMs += estimate.workerMs;
    return { board, ...estimate };
  });
  const after = before.map((day) => ({ ...day }));
  const initialVariance = variance(before);
  const moves: AtsRotationMove[] = [];
  const limit = Math.min(ATS_ROTATION_BALANCE_POLICY.maximumMoves,
    Math.floor(enabled.length * ATS_ROTATION_BALANCE_POLICY.maximumBoardFraction));
  if (summarizeAtsWorkload(before).maxDeviation > ATS_ROTATION_BALANCE_POLICY.triggerDeviation) {
    const candidates = costs.filter(({ board, measured }) => measured && !board.hasOpenWork
      && board.lastProcessedAt !== null && board.lastProcessedAt.valueOf() <= now.valueOf()
      && now.valueOf() - board.lastProcessedAt.valueOf() <= ATS_ROTATION_BALANCE_POLICY.reviewIntervalMs
      && board.sampleAt !== null && board.sampleAt.valueOf() === board.lastProcessedAt.valueOf()
      && board.failCount === 0 && board.retryCount === 0
      && board.nextCheckDate.valueOf() > now.valueOf() + ATS_ROTATION_BALANCE_POLICY.minimumNoticeMs
      && board.nextCheckDate.valueOf() === nextAtsBoardCheckDateForDay(board.checkDay, now).valueOf()
      && (board.rotationMovedAt === null
        || now.valueOf() - board.rotationMovedAt.valueOf() >= ATS_ROTATION_BALANCE_POLICY.boardMoveCooldownMs))
      .sort((a, b) => b.workerMs - a.workerMs || a.board.platform.localeCompare(b.board.platform)
        || a.board.slug.localeCompare(b.board.slug));
    for (const { board, workerMs } of candidates) {
      if (moves.length >= limit) break;
      let best: { day: number; slot: Date; improvement: number } | null = null;
      for (let day = 0; day < ATS_ROTATION_DAYS; day += 1) {
        if (day === board.checkDay) continue;
        const slot = nextAtsBoardCheckDateForDay(day, now);
        // Never delay the already scheduled cycle; give at least four days
        // since the last complete collection and a day's notice before moving.
        if (slot > board.nextCheckDate || slot.valueOf() < now.valueOf() + ATS_ROTATION_BALANCE_POLICY.minimumNoticeMs
          || slot.valueOf() < board.lastProcessedAt!.valueOf() + ATS_ROTATION_BALANCE_POLICY.minimumCycleGapMs) continue;
        const source = after[board.checkDay].workerMs;
        const destination = after[day].workerMs;
        const improvement = 2 * workerMs * (source - destination - workerMs);
        if (improvement > 0 && (!best || improvement > best.improvement)) best = { day, slot, improvement };
      }
      if (!best) continue;
      after[board.checkDay].workerMs -= workerMs;
      after[board.checkDay].boards -= 1;
      after[best.day].workerMs += workerMs;
      after[best.day].boards += 1;
      moves.push({ slug: board.slug, platform: board.platform, fromDay: board.checkDay, toDay: best.day,
        workerMs, fromNextCheckDate: board.nextCheckDate, nextCheckDate: best.slot,
        lastProcessedAt: board.lastProcessedAt! });
    }
  }
  const varianceImprovement = initialVariance > 0 ? (initialVariance - variance(after)) / initialVariance : 0;
  const material = moves.length > 0 && varianceImprovement >= ATS_ROTATION_BALANCE_POLICY.minimumVarianceImprovement;
  return { observedAt: now, policy: ATS_ROTATION_BALANCE_POLICY, profiles, measuredBoards,
    estimatedBoards: enabled.length - measuredBoards, before, after: material ? after : before,
    moves: material ? moves : [], varianceImprovement: material ? varianceImprovement : 0 };
}
