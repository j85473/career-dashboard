/**
 * Suppressing listings that repeat a job Joseph has already acted on.
 *
 * ## Why the key is identityFingerprint and not title+company
 *
 * The first audit grouped on title+company and reported 128 live duplicate
 * groups. Most were not duplicates: Breezy posts one requisition per city, so
 * "Field Inspector 1099 Contractor" at seeknow appeared 133 times across
 * Olympia, Fairfax, Tacoma and thirty more. Home Depot's "Sales Specialist"
 * appeared eight times the same way.
 *
 * Applying *there* would have hidden a Duluth role because he applied to the
 * Minneapolis one. `identityFingerprint` is `company|title|location`, which is
 * the honest key: same role, same employer, same place.
 *
 * ## Why it hides rather than deletes
 *
 * A suppressed row is dismissed with a reason that names the job it repeats,
 * so it stays findable under dismissed and the match can be checked. A wrong
 * match must be visible, not silent.
 */

import { isWorkdayLocationsPlaceholder } from './workdayLocation';

/**
 * Statuses that mean a decision has already been made on this posting. `passed`
 * counts: re-surfacing something deliberately passed on is the same noise as
 * re-surfacing something applied to.
 */
export const DECIDED_STATUSES = ['applied', 'passed', 'cooldown', 'interviewing'] as const;

/** Statuses that are already out of sight; nothing to suppress. */
export const INVISIBLE_STATUSES = ['archived', 'dismissed', 'expired'] as const;

const REASON_PREFIX = 'Duplicate of a job already';

export type DecidedStatus = (typeof DECIDED_STATUSES)[number];

export type DuplicateCandidate = {
  id: string;
  identityFingerprint: string | null;
  status: string;
};

export type DecidedJob = {
  id: string;
  identityFingerprint: string | null;
  status: string;
  company: string | null;
  title: string | null;
  location: string | null;
};

export type SuppressionPlan = {
  jobId: string;
  duplicateOfJobId: string;
  reason: string;
};

/**
 * Locations that do not identify a place.
 *
 * This guard is load-bearing. `identityFingerprint` is company|title|location,
 * so it only separates two postings when the location actually says where the
 * job is. Workday writes "2 Locations" for any multi-city requisition — 7,695
 * stored rows carry that shape — which means six different cities collapse
 * into one fingerprint. Suppressing on that would hide a real job in another
 * state on the strength of a placeholder.
 *
 * The first dry run surfaced exactly this: a Graco "Senior Account Manager" at
 * "2 Locations" matched one already passed on, and there is no way to tell from
 * the stored data whether it is the same posting. Refuse rather than guess.
 */
export function isUnreliableLocation(location: string | null | undefined): boolean {
  const value = String(location || '').trim();
  if (!value) return true;
  if (isWorkdayLocationsPlaceholder(value)) return true;
  return /^(unknown location|unknown|n\/a|-)$/i.test(value);
}

export function isDecidedStatus(status: string | null | undefined): boolean {
  return (DECIDED_STATUSES as readonly string[]).includes(String(status || ''));
}

export function isInvisibleStatus(status: string | null | undefined): boolean {
  return (INVISIBLE_STATUSES as readonly string[]).includes(String(status || ''));
}

/**
 * The stored reason has to survive being read months later with no context, so
 * it names the decision and the posting rather than just saying "duplicate".
 */
export function buildAppliedDuplicateReason(decided: DecidedJob): string {
  const where = String(decided.location || '').trim();
  const what = [String(decided.title || '').trim(), String(decided.company || '').trim()]
    .filter(Boolean)
    .join(' at ');
  const tail = [what, where].filter(Boolean).join(' — ');
  return tail
    ? `${REASON_PREFIX} ${decided.status}: ${tail}`
    : `${REASON_PREFIX} ${decided.status}`;
}

/** Lets the UI badge a row without re-deriving why it was dismissed. */
export function isAppliedDuplicateReason(passReason: string | null | undefined): boolean {
  return String(passReason || '').startsWith(REASON_PREFIX);
}

/**
 * Pure planning step, so the decision is testable without a database.
 *
 * A candidate is suppressed only when it shares a *non-null* fingerprint with a
 * decided job that is not itself. Null fingerprints never match each other:
 * that would collapse every row the fingerprint generator could not identify.
 */
export function planAppliedDuplicateSuppression(
  candidates: DuplicateCandidate[],
  decided: DecidedJob[],
): SuppressionPlan[] {
  const decidedByFingerprint = new Map<string, DecidedJob>();
  for (const job of decided) {
    const fingerprint = job.identityFingerprint;
    if (!fingerprint || !isDecidedStatus(job.status)) continue;
    // A fingerprint built on a placeholder location does not identify a
    // posting, so it cannot justify hiding one.
    if (isUnreliableLocation(job.location)) continue;
    // First writer wins, and `applied` outranks the rest: the reason should
    // name the strongest commitment, not whichever row was read last.
    const existing = decidedByFingerprint.get(fingerprint);
    if (!existing || (existing.status !== 'applied' && job.status === 'applied')) {
      decidedByFingerprint.set(fingerprint, job);
    }
  }

  const plans: SuppressionPlan[] = [];
  for (const candidate of candidates) {
    const fingerprint = candidate.identityFingerprint;
    if (!fingerprint) continue;
    if (isDecidedStatus(candidate.status) || isInvisibleStatus(candidate.status)) continue;
    const match = decidedByFingerprint.get(fingerprint);
    if (!match || match.id === candidate.id) continue;
    plans.push({
      jobId: candidate.id,
      duplicateOfJobId: match.id,
      reason: buildAppliedDuplicateReason(match),
    });
  }
  return plans;
}
