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
 * Most arms only report. One does not: the liveness arm applies itself, because
 * Joseph asked on 2026-09-03 for the board catalog to be kept clean weekly
 * without a human in the loop. That arm carries its own brakes for exactly that
 * reason -- see `refresh_ats_board_liveness.ts` -- and it is the only arm marked
 * `autoApply`. Every other arm still prints a command and waits.
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
 * The reporting arms make no external requests: they judge evidence already in
 * the database. The liveness arm is the exception and contacts every demoted
 * board, out of band -- no provider reservation, no circuit -- so a weekly sweep
 * can never trip a breaker that stops real acquisition.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Where the report goes so something other than the system journal can read it.
 *
 * The whole reason the demoted tier grew past the active catalog unnoticed is
 * that this review already computed the numbers and then printed them where
 * nobody looks. It lives under the shared runtime directory, which is symlinked
 * into each release, so the last review survives a deploy.
 */
const REPORT_PATH = process.env.ATS_BOARD_REVIEW_REPORT
  || path.join(process.cwd(), 'data', 'runtime', 'ats-board-review.json');

type Arm = {
  key: string;
  script: string;
  /** What retiring these boards costs if we are wrong about them. */
  reversible: boolean;
  summary: string;
  /**
   * Whether the weekly run may act on this arm's own findings. Only the
   * liveness arm does, and only because it re-contacts each board and refuses
   * to retire anything when the sweep looks untrustworthy.
   */
  autoApply?: boolean;
};

const ARMS: Arm[] = [
  {
    key: 'board_liveness',
    script: 'refresh_ats_board_liveness.ts',
    reversible: false,
    autoApply: true,
    summary: 'Contacts every demoted board. Boards answering with postings return to the '
      + 'rotation; boards confirmed gone are retired. Refuses to retire anything when the '
      + 'sweep was throttled or when one platform dominates the proposed retirements.',
  },
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
  applied?: {
    promoted: number;
    excluded: number;
    retirementBlocked: string | null;
    writeFailures: number;
  };
  error?: string;
};

async function readArm(arm: Arm): Promise<ArmResult> {
  const base: ArmResult = { arm: arm.key, reversible: arm.reversible, summary: arm.summary };
  try {
    // An arm's progress goes to its stderr, and swallowing it made this unit
    // silent for the hour the liveness sweep takes. Silence is not a neutral
    // default: a deployment that printed nothing while it waited was cancelled
    // mid-flight on 2026-09-03 because it looked hung. Forward it so the
    // journal shows the run advancing.
    const child = run(
      process.execPath,
      ['--import', 'tsx', path.join('scripts', arm.script), ...(arm.autoApply ? ['--auto'] : [])],
      { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 },
    );
    child.child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[${arm.key}] ${chunk.toString()}`);
    });
    const { stdout } = await child;
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
      // An auto-applying arm has already acted, so printing a command to run
      // would invite someone to run it twice.
      approvalCommand: !arm.autoApply && boards > 0 && hash
        ? `node --import tsx scripts/${arm.script} --apply --selection-hash ${hash}`
        : undefined,
      applied: arm.autoApply
        ? {
          promoted: Number(report.promoted || 0),
          excluded: Number(report.excluded || 0),
          retirementBlocked: (report.retirementBlocked as string | null) ?? null,
          writeFailures: Number(report.writeFailures || 0),
        }
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

  const report = {
    version: 'ats-board-pruning-review-v1',
    generatedAt: new Date().toISOString(),
    readOnly: false,
    totals: {
      candidateBoards: boards,
      postingsPerRotation: postings,
    },
    arms: results,
    note: 'The liveness arm contacts every demoted board and acts on what it finds; its '
      + '`applied` block is what it did. Every other arm is gated behind --apply '
      + '--selection-hash because an excluded board is never re-judged: review the candidates, '
      + 'then run the printed command for the arms you approve. A hash stops matching once the '
      + 'candidate set drifts, which is deliberate -- approval is for one reviewed list, not a '
      + 'standing intent.',
  };
  console.log(JSON.stringify(report, null, 2));

  // Written last and atomically: a half-written report read mid-run would show
  // the Dashboard a review that never happened.
  try {
    mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    const temporary = `${REPORT_PATH}.partial`;
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, REPORT_PATH);
  } catch (error) {
    // Failing to publish the report must not make an otherwise good review look
    // like a failed one, but it must be visible.
    console.error(`Could not write ${REPORT_PATH}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }

  const failed = results.filter((row) => row.error);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
