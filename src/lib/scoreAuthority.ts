import { travelRangeFromScorePayload, type TravelRange } from './nativeScoringPacket';

export const AUTHORITATIVE_SCORE_EVENT_TYPES = ['standard', 'ae_fit'] as const;

export type ScoreAuthorityState = 'current' | 'stale_replay_needed' | 'unscored';

export type ScoreAuthorityEvent = {
  evaluationType: string;
  staleAt?: Date | string | null;
  staleReason?: string | null;
};

export type ScoreProjectionEvent = ScoreAuthorityEvent & {
  aimFitScore?: number | null;
  experienceFitScore?: number | null;
  travelScore?: number | null;
  aimReason?: string | null;
  experienceReason?: string | null;
  mandatoryRequirementAssessments?: unknown;
};

/**
 * Events must be newest-first. Authority belongs only to the newest standard
 * A/E event; an invalidated newest event deliberately suppresses every older
 * event so callers cannot silently resurrect obsolete scoring provenance.
 */
export function resolveScoreAuthority<T extends ScoreAuthorityEvent>(
  newestFirstEvents: readonly T[],
): {
  scoreAuthorityState: ScoreAuthorityState;
  currentScore: T | null;
  staleScore: T | null;
  staleScoreReason: string | null;
} {
  const newest = newestFirstEvents.find((event) => (
    AUTHORITATIVE_SCORE_EVENT_TYPES.includes(
      event.evaluationType as typeof AUTHORITATIVE_SCORE_EVENT_TYPES[number],
    )
  ));

  if (!newest) {
    return {
      scoreAuthorityState: 'unscored',
      currentScore: null,
      staleScore: null,
      staleScoreReason: null,
    };
  }

  if (newest.staleAt) {
    return {
      scoreAuthorityState: 'stale_replay_needed',
      currentScore: null,
      staleScore: newest,
      staleScoreReason: newest.staleReason || 'The newest score was invalidated and must be replayed.',
    };
  }

  return {
    scoreAuthorityState: 'current',
    currentScore: newest,
    staleScore: null,
    staleScoreReason: null,
  };
}

export function scoreInvalidationReason(changedFields: readonly string[]): string {
  const fields = [...new Set(changedFields)].sort();
  return `job-input-edited:${fields.length > 0 ? fields.join(',') : 'forced_rescore'}`;
}

export function scoringInputMutationPolicy(input: {
  scoringInputChanged: boolean;
  forceRescore: boolean;
  skipRescore: boolean;
}): { shouldInvalidateScores: boolean; shouldQueueRescore: boolean } {
  const shouldInvalidateScores = input.scoringInputChanged || input.forceRescore;
  return {
    shouldInvalidateScores,
    shouldQueueRescore: shouldInvalidateScores && !input.skipRescore,
  };
}

export function projectJobScoreAuthority<
  T extends {
    status: string;
    passReason?: string | null;
    compensation?: string | null;
  },
  E extends ScoreProjectionEvent,
>(job: T, newestScoreEvent: E | null): T & {
  scoreAuthorityState: ScoreAuthorityState;
  currentScore: E | null;
  staleScore: E | null;
  staleScoreReason: string | null;
  aimFitScore: number | null;
  reqFitScore: number | null;
  travelScore: number | null;
  travelRange: TravelRange | null;
  reqFitRationale: string | null;
} {
  const authority = resolveScoreAuthority(newestScoreEvent ? [newestScoreEvent] : []);
  const currentScore = authority.currentScore;
  const humanDecisionReason = job.status === 'passed' || /^Promoted by user:/i.test(job.passReason || '')
    ? job.passReason
    : null;

  return {
    ...job,
    aimFitScore: currentScore?.aimFitScore ?? null,
    reqFitScore: currentScore?.experienceFitScore ?? null,
    travelScore: currentScore?.travelScore ?? null,
    travelRange: currentScore ? travelRangeFromScorePayload(currentScore.mandatoryRequirementAssessments) : null,
    passReason: humanDecisionReason ?? currentScore?.aimReason ?? null,
    reqFitRationale: currentScore?.experienceReason ?? null,
    // Compensation is deterministically projected from the same immutable
    // packet but is not yet copied into JobScoreEvent. Hide the mutable Job
    // projection when no score event is current.
    compensation: currentScore ? job.compensation : null,
    ...authority,
  };
}
