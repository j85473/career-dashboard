import {
  ATS_ROTATION_DAYS,
  ATS_ROTATION_DAY_NAMES,
  atsRotationCycleCutoff,
  requiredAtsBoardChecksPerDay,
  summarizeRotationBalance,
} from './atsRotation';

/**
 * Whether the ATS rotation is actually running.
 *
 * The schedule itself lives in `atsRotation.ts`: every board is assigned a
 * weekday and swept on that day. This measures the result — the share of active
 * boards seen within one full rotation, how evenly the cohorts are sized, and
 * the throughput the schedule demands.
 *
 * Observability only. Nothing here changes a schedule, retires a board, or
 * drops work.
 */

export { ATS_ROTATION_DAYS, atsRotationCycleCutoff };

/** Share of active boards that must be swept within one rotation. */
export const ATS_COVERAGE_OBJECTIVE = 0.99;

/** A cohort more than this far from the mean is unbalanced. */
export const ATS_COHORT_BALANCE_TOLERANCE = 0.1;

export type AtsCoverageInput = {
  activeBoards: number;
  /** Active boards swept within one full rotation. */
  boardsCheckedWithinCycle: number;
  /** Active boards that have never been swept. */
  boardsNeverChecked: number;
  /** Oldest last-swept timestamp among active boards. */
  oldestCheckedAt: Date | null;
  /** Active board count per assigned weekday, keyed 0 = Sunday. */
  boardsByRotationDay?: Readonly<Record<number, number>>;
  now?: Date;
};

export type AtsCoverageSlo = {
  activeBoards: number;
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
  const checked = Math.min(Math.max(0, input.boardsCheckedWithinCycle), activeBoards);
  const boardsOutsideCycle = activeBoards - checked;
  const coverageRatio = activeBoards === 0 ? 1 : checked / activeBoards;
  const oldestCheckedAgeDays = input.oldestCheckedAt ? ageInDays(input.oldestCheckedAt, now) : null;
  const balance = summarizeRotationBalance(input.boardsByRotationDay || {});

  const breachReasons: string[] = [];
  if (coverageRatio < ATS_COVERAGE_OBJECTIVE) {
    breachReasons.push(
      `${boardsOutsideCycle.toLocaleString()} of ${activeBoards.toLocaleString()} active boards `
      + `were not swept in the last ${ATS_ROTATION_DAYS} days `
      + `(${Math.round(coverageRatio * 100)}% covered, objective ${Math.round(ATS_COVERAGE_OBJECTIVE * 100)}%)`,
    );
  }
  if (input.boardsNeverChecked > 0) {
    breachReasons.push(`${input.boardsNeverChecked.toLocaleString()} active boards have never been swept`);
  }
  if (input.boardsByRotationDay && balance.maxDeviation > ATS_COHORT_BALANCE_TOLERANCE) {
    const heaviest = [...balance.cohorts].sort((left, right) => right.boards - left.boards)[0];
    breachReasons.push(
      `rotation cohorts are uneven: ${heaviest.dayName} carries ${heaviest.boards.toLocaleString()} boards `
      + `against a mean of ${Math.round(balance.mean).toLocaleString()}`,
    );
  }

  return {
    activeBoards,
    rotationDays: ATS_ROTATION_DAYS,
    boardsCheckedWithinCycle: checked,
    boardsOutsideCycle,
    boardsNeverChecked: Math.max(0, input.boardsNeverChecked),
    coverageRatio,
    objective: ATS_COVERAGE_OBJECTIVE,
    requiredChecksPerDay: requiredAtsBoardChecksPerDay(activeBoards),
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
