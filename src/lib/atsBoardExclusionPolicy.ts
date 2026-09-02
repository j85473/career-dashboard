/**
 * Which boards have earned a permanent place outside the weekly rotation.
 *
 * This is the irreversible sibling of `atsBoardYield`, and it deliberately uses
 * a stricter test. Demotion's safety argument is that "a demoted board returns
 * on its own and is re-judged", so a wrong call there costs one longer cadence.
 * An excluded board is never re-judged, so the same evidence bar is not good
 * enough: the bar has to be strong enough that being wrong is rare, because
 * nothing downstream will catch it.
 *
 * Two independent arms, either of which is sufficient. Both additionally
 * require that the board has never produced a single job that survived triage.
 *
 *   proven_unproductive  Enough postings observed that "none survived" is
 *                        surprising rather than merely unlucky.
 *   out_of_territory     Every posting whose location could be read at all is
 *                        outside Minnesota.
 *
 * Why the second arm exists: the yield arm alone cannot see an out-of-state
 * hospital with forty postings, and the catalog is full of them. Geography is
 * also the sounder signal of the two -- where an employer hires is a standing
 * fact about that employer, so it does not degrade when the sweep falls behind,
 * whereas "zero survivors" is a sample statistic that gets weaker the less
 * often a board is checked.
 */

/**
 * Postings required before "none survived" is treated as proof.
 *
 * Measured on the live catalog: among boards that do produce survivors, the
 * median survival rate is 3.13% (p10 0.60%, p90 10.00%). At 3.13%, a genuinely
 * productive board shows zero survivors in 150 postings about 0.9% of the time,
 * in 100 about 4%, and in 50 about 20%. Fifty is therefore fine for a 28-day
 * demotion and indefensible for a permanent exclusion, which is why this bar is
 * 150 and not `ATS_YIELD_MIN_EVIDENCE`'s value by coincidence.
 */
export const ATS_EXCLUSION_MIN_UNPRODUCTIVE_EVIDENCE = 150;

/**
 * Located postings required before "all of them are out of state" is treated as
 * proof. Geography does not resample, so this bar buys certainty that the
 * board's hiring footprint was read correctly rather than statistical power.
 * Ambiguous locations -- "Remote", "United States", "2 Locations", blank -- are
 * never counted as out of state; they are left out of the denominator entirely,
 * so a remote-friendly employer cannot be excluded for having a Texas office.
 */
export const ATS_EXCLUSION_MIN_LOCATED_POSTINGS = 25;

export type BoardExclusionEvidence = {
  /** Jobs from this board that could be attributed to it. */
  storedJobs: number;
  /** Attributed jobs not dismissed, archived, or expired. */
  survivingJobs: number;
  /**
   * Attributed jobs that reached `scoringStatus = 'scored'`.
   *
   * This is the sharper of the two keep-signals and the reason it exists: a
   * scored job cleared the deterministic local gates -- language, authoritative
   * metadata, territory, and title triage -- so the board demonstrably publishes
   * roles of the right kind in the right place. Lifecycle status alone misses
   * that, because a job can be scored and then dismissed, and `dismissed` reads
   * identical to a posting that was deterministically rejected at the prefilter.
   * Judging on status alone retired 259 boards that had produced scored jobs,
   * Axon among them with thirty-eight.
   */
  locallyScoredJobs: number;
  /** Attributed jobs whose location was specific enough to place. */
  locatedJobs: number;
  /** Placed jobs that are outside Minnesota. */
  outOfTerritoryJobs: number;
};

export type BoardExclusionVerdict =
  | { exclude: false; reason: string }
  | { exclude: true; basis: 'proven_unproductive' | 'out_of_territory'; reason: string };

/**
 * A board is only excluded on evidence it produced itself. A board with no
 * attributed postings has not been judged at all -- most of those are simply
 * boards the overdue rotation has not reached yet -- and is never excluded here.
 */
export function classifyBoardForExclusion(
  input: BoardExclusionEvidence,
  bars: {
    minUnproductiveEvidence?: number;
    minLocatedPostings?: number;
  } = {},
): BoardExclusionVerdict {
  const minEvidence = bars.minUnproductiveEvidence ?? ATS_EXCLUSION_MIN_UNPRODUCTIVE_EVIDENCE;
  const minLocated = bars.minLocatedPostings ?? ATS_EXCLUSION_MIN_LOCATED_POSTINGS;

  // One good posting is enough to keep a board forever. The whole point of the
  // rotation is to find these, so evidence that it worked outranks every
  // efficiency argument for dropping the board. Both signals count, and a board
  // needs only one of them: a job still alive in its lifecycle, or a job local
  // scoring judged worth scoring at all, whatever became of it afterwards.
  if (input.locallyScoredJobs > 0) {
    return {
      exclude: false,
      reason: `${input.locallyScoredJobs} job(s) from this board passed local scoring`,
    };
  }
  if (input.survivingJobs > 0) {
    return { exclude: false, reason: `${input.survivingJobs} job(s) from this board survived triage` };
  }
  if (input.storedJobs <= 0) {
    return { exclude: false, reason: 'no attributed postings; this board has never been judged' };
  }
  if (
    input.locatedJobs >= minLocated
    && input.outOfTerritoryJobs === input.locatedJobs
  ) {
    return {
      exclude: true,
      basis: 'out_of_territory',
      reason: `all ${input.locatedJobs} located posting(s) are outside Minnesota and none survived triage`,
    };
  }
  // The unproductive arm is a sample statistic, and a board that hires in
  // Minnesota is exactly where a wrong call costs the most. Essentia Health --
  // 157 postings, 149 of them in Minnesota, zero survivors -- sat one posting
  // over the bar and would have been retired permanently on the strength of a
  // triage record, not a fact about the employer. Any Minnesota posting is
  // enough to keep the board: "none survived so far" is too weak to end a
  // local employer's place in the rotation. Boards whose postings are all
  // remote or unplaceable have no territory evidence either way and stay
  // judgeable on yield alone.
  const minnesotaPostings = Math.max(0, input.locatedJobs - input.outOfTerritoryJobs);
  if (input.storedJobs >= minEvidence && minnesotaPostings === 0) {
    return {
      exclude: true,
      basis: 'proven_unproductive',
      reason: `${input.storedJobs} stored posting(s), none in Minnesota, and none survived triage`,
    };
  }
  if (input.storedJobs >= minEvidence && minnesotaPostings > 0) {
    return {
      exclude: false,
      reason: `${minnesotaPostings} Minnesota posting(s); a local employer is not retired on triage history alone`,
    };
  }
  return {
    exclude: false,
    reason: `only ${input.storedJobs} stored and ${input.locatedJobs} located posting(s); not enough to judge permanently`,
  };
}

/**
 * The third arm: the board's endpoint is not there.
 *
 * The two arms above judge what a board *published*, so both are sample
 * statistics and both carry the bars that go with that. This arm judges whether
 * the board exists at all, which is a different kind of claim. A 404 from a
 * well-formed provider API URL is the provider stating that no such board is
 * registered -- not a quiet week, not a filtered posting, not an unlucky draw.
 *
 * That is why this arm does not need a 150-posting bar. It needs something the
 * other two cannot have: a *fresh* observation. A historical 404 alone is thin,
 * because most of these boards were contacted exactly once in the six days of
 * receipt history the ledger retains, and a single old failure cannot rule out
 * a transient outage or a board registered later. So the caller must re-check
 * the endpoint at exclusion time and pass the live status here. Without it this
 * arm always declines.
 *
 * The keep-signals stay absolute, exactly as in the other arms: one 2xx ever,
 * one job ever, and the board is kept regardless of how many 404s follow. A
 * board that answered once and 404s now was renamed or retired by its owner --
 * that is a redirect problem, not an absent endpoint, and it is not settled by
 * retiring the board permanently.
 */
export const ATS_ABSENCE_LIVE_STATUSES = [404, 410] as const;

export type BoardAbsenceEvidence = {
  /** Recorded 404s across v2 work receipts and legacy check attempts. */
  historicalNotFound: number;
  /** Whether any 2xx was ever recorded against this board. */
  everResponded2xx: boolean;
  /** Whether any batch from this board ever reported a job count above zero. */
  everYieldedJobs: boolean;
  /** Jobs ever inserted into the catalog from this board's segments. */
  jobsInserted: number;
  /**
   * Status from re-contacting the board's listing endpoint at exclusion time.
   * `null` means the check did not complete -- a timeout, a DNS failure, a
   * connection reset. That is not evidence of absence and never excludes.
   */
  liveStatus: number | null;
};

export type BoardAbsenceVerdict =
  | { exclude: false; reason: string }
  | { exclude: true; basis: 'endpoint_absent'; reason: string };

export function classifyBoardForAbsence(input: BoardAbsenceEvidence): BoardAbsenceVerdict {
  if (input.everResponded2xx) {
    return { exclude: false, reason: 'this board returned a successful response at least once' };
  }
  if (input.everYieldedJobs || input.jobsInserted > 0) {
    return {
      exclude: false,
      reason: `this board produced ${input.jobsInserted} stored job(s); absence is not the explanation`,
    };
  }
  if (input.historicalNotFound <= 0) {
    return { exclude: false, reason: 'no recorded not-found response; this board has not been judged absent' };
  }
  if (input.liveStatus === null) {
    return { exclude: false, reason: 'live re-check did not complete; absence unconfirmed' };
  }
  if (!ATS_ABSENCE_LIVE_STATUSES.includes(input.liveStatus as typeof ATS_ABSENCE_LIVE_STATUSES[number])) {
    return {
      exclude: false,
      reason: `live re-check returned HTTP ${input.liveStatus}; the endpoint is reachable`,
    };
  }
  return {
    exclude: true,
    basis: 'endpoint_absent',
    reason: `${input.historicalNotFound} recorded not-found response(s) and a live HTTP ${input.liveStatus}; `
      + 'the provider reports no such board, and it has never responded or produced a job',
  };
}
