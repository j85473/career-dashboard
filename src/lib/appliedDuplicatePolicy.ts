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
import { splitLocationOptions } from './jobLocationPolicy';

/**
 * The only lifecycle statuses allowed to authorize automatic suppression.
 * Joseph explicitly limited this policy to affirmative application evidence;
 * Passed and Cooldown are never authority, even when they already carry a
 * stored fingerprint.
 */
export const APPLIED_DUPLICATE_AUTHORITY_STATUSES = ['applied', 'interviewing'] as const;

/**
 * Candidate lifecycle states automation must not alter. This is deliberately
 * broader than authority: a Passed or Cooldown row cannot hide another job,
 * but it also cannot itself be rewritten as a dismissed duplicate.
 */
export const APPLIED_DUPLICATE_CANDIDATE_PROTECTED_STATUSES = [
  'applied',
  'passed',
  'cooldown',
  'interviewing',
] as const;

/** Statuses that are already out of sight; nothing to suppress. */
export const INVISIBLE_STATUSES = ['archived', 'dismissed', 'expired'] as const;

const REASON_PREFIX = 'Duplicate of a job already';
/** Only this scheme hashes location, so only this scheme can identify a posting. */
export const V4_FINGERPRINT_PREFIX = 'v4:';
export const ALREADY_APPLIED_REASON = 'Already applied';

export type AppliedDuplicateAuthorityStatus = (typeof APPLIED_DUPLICATE_AUTHORITY_STATUSES)[number];

export type DuplicateCandidate = {
  id: string;
  identityFingerprint: string | null;
  fingerprint?: string | null;
  status: string;
};

export type AppliedDuplicateAuthorityJob = {
  id: string;
  identityFingerprint: string | null;
  fingerprint?: string | null;
  status: string;
  company: string | null;
  title: string | null;
  location: string | null;
  passReason?: string | null;
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
 *
 * The backfill composes a recovered primary city with the placeholder rather
 * than replacing it ("Youngstown, Ohio; 2 Locations" — see
 * composeMultiSiteLocation in workdayLocation.ts), so the placeholder can
 * arrive as one option among several rather than the whole string. A
 * composed value is just as unreliable for this purpose as the bare
 * placeholder: it still names only one of N sites, so a second posting
 * sharing the same primary-and-count is not provably the same requisition.
 */
export function isUnreliableLocation(location: string | null | undefined): boolean {
  const value = String(location || '').trim();
  if (!value) return true;
  if (splitLocationOptions(value).some((option) => isWorkdayLocationsPlaceholder(option))) return true;
  return /^(unknown location|unknown|n\/a|-)$/i.test(value);
}

/**
 * The identity key, wherever this row happens to store it.
 *
 * Two columns hold the same v4 `company|title|location` hash. Rows written
 * before the identity migration put it in the legacy unique `fingerprint`
 * column and left `identityFingerprint` null; new ingestion does the reverse.
 * Reading only the new column made 476 of 535 Applied/Interviewing rows
 * invisible as authority — an Altria "Sales Manager - St. Paul / Rochester"
 * already at Interviewing could not suppress the copy Adzuna re-listed under a
 * new sourceId, so the repeat surfaced in the inbox.
 *
 * The `v4:` guard is load-bearing and must not be relaxed. The legacy column is
 * the resting place of several retired schemes, and two of them — `v3:` and
 * the bare md5 — hash company and title with *no location*. Honoring those here
 * would make one Breezy city posting suppress the other thirty, which is the
 * precise failure `identityFingerprint` was introduced to prevent. Anything
 * that is not a v4 hash is treated as absent.
 */
export function effectiveIdentityFingerprint(
  job: Pick<DuplicateCandidate, 'identityFingerprint' | 'fingerprint'>,
): string | null {
  if (job.identityFingerprint) return job.identityFingerprint;
  const legacy = String(job.fingerprint || '');
  return legacy.startsWith(V4_FINGERPRINT_PREFIX) ? legacy : null;
}

export function isAppliedDuplicateCandidateProtectedStatus(status: string | null | undefined): boolean {
  return (APPLIED_DUPLICATE_CANDIDATE_PROTECTED_STATUSES as readonly string[]).includes(String(status || ''));
}

export function isInvisibleStatus(status: string | null | undefined): boolean {
  return (INVISIBLE_STATUSES as readonly string[]).includes(String(status || ''));
}

export function isAlreadyAppliedReason(passReason: string | null | undefined): boolean {
  return passReason === ALREADY_APPLIED_REASON;
}

/**
 * Applied and Interviewing are affirmative lifecycle evidence. The exact
 * explicit Already applied reason is also authority even when the pass route
 * stores that user decision with a Passed lifecycle status.
 */
export function isAppliedDuplicateAuthorityEvidence(
  job: Pick<AppliedDuplicateAuthorityJob, 'status' | 'passReason'>,
): boolean {
  return (APPLIED_DUPLICATE_AUTHORITY_STATUSES as readonly string[]).includes(job.status)
    || isAlreadyAppliedReason(job.passReason);
}

/**
 * The stored reason has to survive being read months later with no context, so
 * it names the decision and the posting rather than just saying "duplicate".
 */
export function buildAppliedDuplicateReason(decided: AppliedDuplicateAuthorityJob): string {
  const where = String(decided.location || '').trim();
  const what = [String(decided.title || '').trim(), String(decided.company || '').trim()]
    .filter(Boolean)
    .join(' at ');
  const tail = [what, where].filter(Boolean).join(' — ');
  const decision = isAlreadyAppliedReason(decided.passReason) ? 'applied' : decided.status;
  return tail
    ? `${REASON_PREFIX} ${decision}: ${tail}`
    : `${REASON_PREFIX} ${decision}`;
}

/** Lets the UI badge a row without re-deriving why it was dismissed. */
export function isAppliedDuplicateReason(passReason: string | null | undefined): boolean {
  return String(passReason || '').startsWith(REASON_PREFIX) || isAlreadyAppliedReason(passReason);
}

/**
 * Pure planning step, so the decision is testable without a database.
 *
 * A candidate is suppressed only when it shares a *non-null* fingerprint with a
 * authority job that is not itself. Null fingerprints never match each other:
 * that would collapse every row the fingerprint generator could not identify.
 * The key is read through effectiveIdentityFingerprint, so a pre-migration row
 * carrying its v4 hash in the legacy column participates on equal terms.
 */
export function planAppliedDuplicateSuppression(
  candidates: DuplicateCandidate[],
  authorities: AppliedDuplicateAuthorityJob[],
): SuppressionPlan[] {
  const authorityByFingerprint = new Map<string, AppliedDuplicateAuthorityJob>();
  for (const job of authorities) {
    const fingerprint = effectiveIdentityFingerprint(job);
    if (!fingerprint || !isAppliedDuplicateAuthorityEvidence(job)) continue;
    // A fingerprint built on a placeholder location does not identify a
    // posting, so it cannot justify hiding one.
    if (isUnreliableLocation(job.location)) continue;
    // First writer wins, and `applied` outranks the rest: the reason should
    // name the strongest commitment, not whichever row was read last.
    const existing = authorityByFingerprint.get(fingerprint);
    if (!existing || (existing.status !== 'applied' && job.status === 'applied')) {
      authorityByFingerprint.set(fingerprint, job);
    }
  }

  const plans: SuppressionPlan[] = [];
  for (const candidate of candidates) {
    const fingerprint = effectiveIdentityFingerprint(candidate);
    if (!fingerprint) continue;
    if (isAppliedDuplicateCandidateProtectedStatus(candidate.status) || isInvisibleStatus(candidate.status)) continue;
    const match = authorityByFingerprint.get(fingerprint);
    if (!match || match.id === candidate.id) continue;
    plans.push({
      jobId: candidate.id,
      duplicateOfJobId: match.id,
      reason: buildAppliedDuplicateReason(match),
    });
  }
  return plans;
}
