import {
  ATS_API_ROTATION_DAYS as ATS_ROTATION_DAYS,
  ATS_API_ROTATION_DAY_NAMES as ATS_ROTATION_DAY_NAMES,
  atsApiRotationCycleCutoff as atsRotationCycleCutoff,
  requiredAtsBoardChecksPerDay,
  summarizeApiRotationBalance as summarizeRotationBalance,
} from './atsRotation';

/**
 * Whether the ATS rotation is actually running.
 *
 * The schedule itself lives in `atsRotation.ts`: every board is assigned a
 * cycle day and swept once every four days. This measures the result — the share of active
 * boards seen within one full rotation and the throughput the schedule demands.
 * Cohort board counts are informational: workload balancing assigns by
 * processing time, so unequal counts do not establish missed coverage.
 *
 * Observability only. Nothing here changes a schedule, retires a board, or
 * drops work.
 */

export { ATS_ROTATION_DAYS, atsRotationCycleCutoff };

/** Share of active boards that must be swept within one rotation. */
export const ATS_COVERAGE_OBJECTIVE = 0.99;

export type AtsCoverageInput = {
  activeBoards: number;
  /** Active boards discovered recently whose first scheduled sweep is still in the future. */
  boardsAwaitingFirstCheck?: number;
  /** Active boards swept within one full rotation. */
  boardsCheckedWithinCycle: number;
  /** Active boards that are already due but have never been swept. */
  boardsNeverChecked: number;
  /** Oldest last-swept timestamp among active boards. */
  oldestCheckedAt: Date | null;
  /** Active board count per stored assignment; legacy weekdays fold into four API cohorts. */
  boardsByRotationDay?: Readonly<Record<number, number>>;
  now?: Date;
};

export type AtsCoverageSlo = {
  activeBoards: number;
  eligibleBoards: number;
  boardsAwaitingFirstCheck: number;
  rotationDays: number;
  boardsCheckedWithinCycle: number;
  boardsOutsideCycle: number;
  boardsNeverChecked: number;
  coverageRatio: number;
  objective: number;
  /** Sweeps per day the rotation requires at the current inventory size. */
  requiredChecksPerDay: number;
  cohorts: Array<{ day: number; dayName: string; boards: number }>;
  cohortImbalance: number;
  oldestCheckedAt: string | null;
  oldestCheckedAgeDays: number | null;
  status: 'healthy' | 'at_risk' | 'breached';
  breachReasons: string[];
};

function ageInDays(from: Date, now: Date): number {
  return Math.max(0, (now.valueOf() - from.valueOf()) / 86_400_000);
}

export function evaluateAtsCoverageSlo(input: AtsCoverageInput): AtsCoverageSlo {
  const now = input.now || new Date();
  const activeBoards = Math.max(0, input.activeBoards);
  const boardsAwaitingFirstCheck = Math.min(
    Math.max(0, input.boardsAwaitingFirstCheck || 0),
    activeBoards,
  );
  const eligibleBoards = activeBoards - boardsAwaitingFirstCheck;
  const checked = Math.min(Math.max(0, input.boardsCheckedWithinCycle), eligibleBoards);
  const boardsOutsideCycle = eligibleBoards - checked;
  const coverageRatio = eligibleBoards === 0 ? 1 : checked / eligibleBoards;
  const oldestCheckedAgeDays = input.oldestCheckedAt ? ageInDays(input.oldestCheckedAt, now) : null;
  const balance = summarizeRotationBalance(input.boardsByRotationDay || {});

  const breachReasons: string[] = [];
  if (coverageRatio < ATS_COVERAGE_OBJECTIVE) {
    breachReasons.push(
      `${boardsOutsideCycle.toLocaleString()} of ${eligibleBoards.toLocaleString()} eligible active boards `
      + `were not swept in the last ${ATS_ROTATION_DAYS} days `
      + `(${Math.round(coverageRatio * 100)}% covered, objective ${Math.round(ATS_COVERAGE_OBJECTIVE * 100)}%)`,
    );
  }
  if (input.boardsNeverChecked > 0) {
    breachReasons.push(`${input.boardsNeverChecked.toLocaleString()} active boards have never been swept`);
  }
  return {
    activeBoards,
    eligibleBoards,
    boardsAwaitingFirstCheck,
    rotationDays: ATS_ROTATION_DAYS,
    boardsCheckedWithinCycle: checked,
    boardsOutsideCycle,
    boardsNeverChecked: Math.max(0, input.boardsNeverChecked),
    coverageRatio,
    objective: ATS_COVERAGE_OBJECTIVE,
    requiredChecksPerDay: requiredAtsBoardChecksPerDay(eligibleBoards),
    cohorts: balance.cohorts,
    cohortImbalance: balance.maxDeviation,
    oldestCheckedAt: input.oldestCheckedAt ? input.oldestCheckedAt.toISOString() : null,
    oldestCheckedAgeDays: oldestCheckedAgeDays === null ? null : Math.floor(oldestCheckedAgeDays),
    status: breachReasons.length > 0
      ? 'breached'
      : coverageRatio < 1 ? 'at_risk' : 'healthy',
    breachReasons,
  };
}

export { ATS_ROTATION_DAY_NAMES };
