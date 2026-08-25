import { MIN_SCORABLE_JD_CHARACTERS } from './jobDescriptionQuality';
import { JD_RECOVERY_MANUAL_REVIEW_REASON } from './jdRecoveryPolicy';

/**
 * Classification only. Nothing in this module expires, dismisses, hides, or
 * requeues a job.
 *
 * The August 23 audit found Action Needed carrying 275 terminal JD failures
 * with no final disposition policy, and asked for them to be split into
 * explicit operational outcomes. It also said plainly that any rule which
 * expires or dismisses jobs changes what Joseph sees and must be approved
 * before implementation. So this file answers "what kind of failure is this?"
 * and stops there; choosing what happens to each bucket is a separate,
 * approved decision.
 */
export const JD_TERMINAL_DISPOSITIONS = [
  'proven_unavailable',
  'presently_recoverable',
  'unproven',
] as const;

export type JdTerminalDisposition = typeof JD_TERMINAL_DISPOSITIONS[number];

export type JdTerminalClassification = {
  disposition: JdTerminalDisposition;
  cause: string;
  /** Whether re-fetching this posting could plausibly change the outcome. */
  retryable: boolean;
  rationale: string;
};

const CLOSED_SHELL_REASON = 'expired, closed, login, cookie, or portal shell';

const LEGACY_JD_PASS_REASONS = new Set([
  JD_RECOVERY_MANUAL_REVIEW_REASON,
  'JD recovery failed. Manual review required.',
  'Failed to fetch JD after 3 attempts. Needs manual review.',
  'Error calling Jina. Manual review required.',
]);

export function isTerminalJdFailure(job: {
  scoringStatus: string;
  scoreError: string | null;
  passReason: string | null;
}): boolean {
  if (job.scoringStatus !== 'failed') return false;
  return String(job.scoreError || '').startsWith('JD recovery rejected:')
    || LEGACY_JD_PASS_REASONS.has(String(job.passReason || ''));
}

/**
 * `proven_unavailable` means the bounded recovery series ended against a page
 * that is not a job posting at all. `presently_recoverable` means real posting
 * text was retrieved and simply fell short of the quality floor, so a better
 * fetch or a hand-pasted JD would resolve it. `unproven` is everything the
 * stored evidence does not settle — it is deliberately not a synonym for
 * "safe to expire".
 */
export function classifyTerminalJdFailure(job: {
  scoringStatus: string;
  scoreError: string | null;
  passReason: string | null;
  description: string | null;
}): JdTerminalClassification | null {
  if (!isTerminalJdFailure(job)) return null;
  const scoreError = String(job.scoreError || '');
  const descriptionLength = String(job.description || '').trim().length;

  if (scoreError.includes(CLOSED_SHELL_REASON)) {
    return {
      disposition: 'proven_unavailable',
      cause: 'closed_or_portal_shell',
      retryable: false,
      rationale: 'Bounded recovery ended on a page that is a shell, login wall, or dead posting rather than a job description.',
    };
  }

  if (scoreError.includes('no usable role duties')) {
    return {
      disposition: 'presently_recoverable',
      cause: 'no_usable_duties',
      retryable: true,
      rationale: 'Posting text was retrieved but carried no duties section; a fuller fetch or a pasted JD resolves it.',
    };
  }

  if (scoreError.includes('no usable qualifications')) {
    return {
      disposition: 'presently_recoverable',
      cause: 'no_usable_qualifications',
      retryable: true,
      rationale: 'Posting text was retrieved but carried no qualifications section; a fuller fetch or a pasted JD resolves it.',
    };
  }

  if (scoreError.includes('visibly truncated description')) {
    return {
      disposition: 'presently_recoverable',
      cause: 'truncated_description',
      retryable: true,
      rationale: 'The provider returned a truncated body; the full posting was never seen.',
    };
  }

  if (descriptionLength > 0 && descriptionLength < MIN_SCORABLE_JD_CHARACTERS) {
    return {
      disposition: 'presently_recoverable',
      cause: 'below_length_floor',
      retryable: true,
      rationale: `Stored description is ${descriptionLength} characters, under the ${MIN_SCORABLE_JD_CHARACTERS}-character floor, but is real posting text.`,
    };
  }

  if (LEGACY_JD_PASS_REASONS.has(String(job.passReason || '')) && !scoreError) {
    return {
      disposition: 'unproven',
      cause: 'legacy_transport_failure',
      retryable: true,
      rationale: 'A legacy fetch/transport failure with no stored quality verdict. Nothing here proves the posting is gone.',
    };
  }

  return {
    disposition: 'unproven',
    cause: 'unclassified',
    retryable: true,
    rationale: 'Stored evidence does not establish whether the posting is retrievable.',
  };
}

export type JdTerminalSummary = Record<JdTerminalDisposition, {
  jobs: number;
  causes: Record<string, number>;
}>;

export function summarizeTerminalJdFailures(
  jobs: ReadonlyArray<Parameters<typeof classifyTerminalJdFailure>[0]>,
): JdTerminalSummary {
  const summary = Object.fromEntries(
    JD_TERMINAL_DISPOSITIONS.map((disposition) => [disposition, { jobs: 0, causes: {} }]),
  ) as JdTerminalSummary;
  for (const job of jobs) {
    const classification = classifyTerminalJdFailure(job);
    if (!classification) continue;
    const bucket = summary[classification.disposition];
    bucket.jobs += 1;
    bucket.causes[classification.cause] = (bucket.causes[classification.cause] || 0) + 1;
  }
  return summary;
}
