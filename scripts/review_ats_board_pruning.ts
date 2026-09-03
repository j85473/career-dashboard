/**
 * The weekly board-pruning review.
 *
 * Pruning the catalog has always been possible and has always been done as
 * incident response: something falls over, somebody remembers these scripts
 * exist, and a few thousand boards get retired. Between incidents the rotation
 * quietly refills with boards that cannot produce anything, and the cost is
 * invisible because nothing reports it.
 *
 * This makes the *detection* standing. It runs each pruning arm in its own
 * dry-run mode, adds up what they would reclaim, and prints the exact approved
 * command for each one.
 *
 * It deliberately does not apply anything, and it deliberately cannot.
 *
 * Every exclusion arm is gated behind `--apply --selection-hash <hash>`, where
 * the hash must match the candidate set that was actually reviewed. That gate
 * is not an inconvenience to route around: an excluded board is never
 * re-judged, so a wrong call there is permanent and nothing downstream will
 * catch it. Automating an irreversible retirement on a timer would defeat the
 * one control that makes it safe. A human reads this report and approves a
 * specific list, or nothing happens.
 *
 * Demotion is the exception in kind though not in handling -- a demoted board
 * returns on its own and is re-judged -- but it shares the same gate and is
 * reported here the same way.
 *
 * Read-only. Makes no external requests: every arm below judges evidence
 * already in the database. The endpoint-absence arm is deliberately excluded
 * because it probes live endpoints, which is not something a report should do
 * on a timer.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

type Arm = {
  key: string;
  script: string;
  /** What retiring these boards costs if we are wrong about them. */
  reversible: boolean;
  summary: string;
};

const ARMS: Arm[] = [
  {
    key: 'never_relevant_geography',
    script: 'exclude_never_relevant_ats_boards.ts',
    reversible: false,
    summary: 'Boards whose every readable posting is outside the searched territory, '
      + 'judged on retained listing payloads rather than stored jobs.',
  },
  {
    key: 'unproductive_or_out_of_territory',
    script: 'exclude_unproductive_ats_boards.ts',
    reversible: false,
    summary: 'Boards with enough evidence that "none survived triage" is proof rather than luck, '
      + 'or whose located postings are all out of state.',
  },
  {
    key: 'low_yield_demotion',
    script: 'demote_low_yield_ats_boards.ts',
    reversible: true,
    summary: 'Boards moved to a slower cadence rather than retired. A demoted board returns '
      + 'on its own and is re-judged, so this is the reversible arm.',
  },
];

type ArmResult = {
  arm: string;
  reversible: boolean;
  summary: string;
  selectionHash?: string;
  boards?: number;
  postingsPerRotation?: number;
  workerHoursPerDayReclaimed?: number;
  approvalCommand?: string;
  error?: string;
};

async function readArm(arm: Arm): Promise<ArmResult> {
  const base: ArmResult = { arm: arm.key, reversible: arm.reversible, summary: arm.summary };
  try {
    const { stdout } = await run(
      process.execPath,
      ['--import', 'tsx', path.join('scripts', arm.script)],
      { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 },
    );
    const report = JSON.parse(stdout) as Record<string, unknown>;
    const boards = Number(
      report.boards ?? report.exclusionCandidates ?? report.demotionCandidates ?? 0,
    );
    const hash = typeof report.selectionHash === 'string' ? report.selectionHash : undefined;
    return {
      ...base,
      selectionHash: hash,
      boards,
      postingsPerRotation: Number(
        report.postingsReclaimedPerRotation ?? report.postingsPerCycle ?? 0,
      ) || undefined,
      workerHoursPerDayReclaimed: typeof report.workerHoursPerDayReclaimed === 'number'
        ? report.workerHoursPerDayReclaimed
        : undefined,
      // Printed rather than run. The hash pins the exact list reviewed here, so
      // it stops matching the moment the candidate set drifts -- which is the
      // point: an approval is for one list, not for a standing intent.
      approvalCommand: boards > 0 && hash
        ? `node --import tsx scripts/${arm.script} --apply --selection-hash ${hash}`
        : undefined,
    };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  // Sequential on purpose: each arm scans the whole board catalog, and running
  // them together only makes the pruning review compete with acquisition for
  // the same connection pool.
  const results: ArmResult[] = [];
  for (const arm of ARMS) results.push(await readArm(arm));

  const boards = results.reduce((sum, row) => sum + (row.boards || 0), 0);
  const postings = results.reduce((sum, row) => sum + (row.postingsPerRotation || 0), 0);

  console.log(JSON.stringify({
    version: 'ats-board-pruning-review-v1',
    generatedAt: new Date().toISOString(),
    readOnly: true,
    totals: {
      candidateBoards: boards,
      postingsPerRotation: postings,
    },
    arms: results,
    note: 'Read-only. Every arm is gated behind --apply --selection-hash because an excluded '
      + 'board is never re-judged. Review the candidates, then run the printed command for the '
      + 'arms you approve. A hash stops matching once the candidate set drifts, which is '
      + 'deliberate: approval is for one reviewed list, not a standing intent.',
  }, null, 2));

  const failed = results.filter((row) => row.error);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
