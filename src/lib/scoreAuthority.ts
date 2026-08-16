import { travelRangeFromScorePayload, type TravelRange } from './nativeScoringPacket';

export const LEGACY_SCORE_EVENT_TYPES = ['standard', 'ae_fit'] as const;
export const STAGED_SCORE_EVENT_TYPES = ['aim_fit', 'experience_fit'] as const;
export const AUTHORITATIVE_SCORE_EVENT_TYPES = [...LEGACY_SCORE_EVENT_TYPES, ...STAGED_SCORE_EVENT_TYPES] as const;

export type ScoreAuthorityState = 'current' | 'stale_replay_needed' | 'unscored';

export type ScoreAuthorityEvent = {
  evaluationType: string;
  staleAt?: Date | string | null;
  staleReason?: string | null;
};

export type ScoreProjectionEvent = ScoreAuthorityEvent & {
  id?: string;
  schemaVersion?: string | null;
  passed?: boolean;
  inputBindingsCurrent?: boolean;
  sourceAimEventId?: string | null;
  cleanedJdArtifactId?: string | null;
  aimFactualExtractionId?: string | null;
  semanticResultHash?: string | null;
  aimFitScore?: number | null;
  experienceFitScore?: number | null;
  travelScore?: number | null;
  aimReason?: string | null;
  experienceReason?: string | null;
  mandatoryRequirementAssessments?: unknown;
  travelAssessment?: unknown;
  compensationAssessment?: unknown;
  inputBindings?: unknown;
};

function compensationAmount(value: unknown, currency: string): string | null {
  if (!Number.isSafeInteger(value)) return null;
  const amount = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value));
  return currency === 'USD' ? `$${amount}` : currency ? `${currency} ${amount}` : amount;
}

function compensationRange(minimum: unknown, maximum: unknown, currency: string): string | null {
  const low = compensationAmount(minimum, currency);
  const high = compensationAmount(maximum, currency);
  if (low && high) return low === high ? low : `${low}–${high}`;
  return low || high;
}

export function compensationDisplayFromAssessment(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const assessment = value as Record<string, unknown>;
  if ('normalizationVersion' in assessment) {
    const currency = typeof assessment.currency === 'string' ? assessment.currency.toUpperCase() : '';
    const low = compensationAmount(
      Number.isSafeInteger(assessment.normalizedAnnualLowerCents) ? Number(assessment.normalizedAnnualLowerCents) / 100 : null,
      currency,
    );
    const high = compensationAmount(
      Number.isSafeInteger(assessment.normalizedAnnualUpperCents) ? Number(assessment.normalizedAnnualUpperCents) / 100 : null,
      currency,
    );
    const range = low && high ? (low === high ? low : `${low}–${high}`) : low || high;
    if (range) return `${range}/annual`;
    if (assessment.comparisonState === 'missing') return null;
    if (typeof assessment.reasonCode === 'string' && assessment.reasonCode) {
      return `Compensation stated · ${assessment.reasonCode.replaceAll('_', ' ')}`;
    }
    return 'Compensation stated';
  }
  if (assessment.stated !== true) return null;
  const currency = typeof assessment.currency === 'string' ? assessment.currency.toUpperCase() : '';
  const period = typeof assessment.period === 'string' && assessment.period.trim() ? `/${assessment.period.trim()}` : '';
  const base = compensationRange(assessment.baseMinimum, assessment.baseMaximum, currency);
  const total = compensationRange(assessment.totalMinimum, assessment.totalMaximum, currency);
  const parts: string[] = [];
  if (base) parts.push(`Base ${base}${period}`);
  if (total) parts.push(`Total ${total}${period}`);
  if (parts.length) return parts.join(' · ');
  if (typeof assessment.variablePayContext === 'string' && assessment.variablePayContext.trim()) return assessment.variablePayContext.trim();
  const source = assessment.source && typeof assessment.source === 'object' && !Array.isArray(assessment.source)
    ? assessment.source as Record<string, unknown>
    : null;
  return typeof source?.exactQuote === 'string' && source.exactQuote.trim() ? source.exactQuote.trim() : 'Compensation stated';
}

export function travelRangeFromAssessment(value: unknown): TravelRange | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const assessment = value as Record<string, unknown>;
  if ('coverageState' in assessment) {
    const interval = assessment.interval && typeof assessment.interval === 'object' && !Array.isArray(assessment.interval)
      ? assessment.interval as Record<string, unknown>
      : null;
    const lower = interval && Number.isInteger(interval.lower) ? Number(interval.lower) : null;
    const upper = interval && Number.isInteger(interval.upper) ? Number(interval.upper) : null;
    const lowerExplicit = interval?.lowerExplicit === true;
    const upperExplicit = interval?.upperExplicit === true;
    const qualitative = typeof assessment.qualitativeTerm === 'string' ? assessment.qualitativeTerm.trim() : '';
    if (assessment.comparisonState === 'missing') {
      return { kind: 'none', minimumPercent: 0, maximumPercent: 0, label: 'Not stated', sourceText: null };
    }
    if (lower !== null && upper !== null) {
      if (lower === upper) return { kind: 'point', minimumPercent: lower, maximumPercent: upper, label: `${lower}%`, sourceText: null };
      if (!lowerExplicit && upperExplicit) return { kind: 'maximum', minimumPercent: 0, maximumPercent: upper, label: `Up to ${upper}%`, sourceText: null };
      if (lowerExplicit && !upperExplicit) return { kind: 'minimum', minimumPercent: lower, maximumPercent: 100, label: `At least ${lower}%`, sourceText: null };
      return { kind: 'range', minimumPercent: lower, maximumPercent: upper, label: `${lower}–${upper}%`, sourceText: null };
    }
    if (qualitative) return { kind: 'qualitative', minimumPercent: 0, maximumPercent: 0, label: qualitative, sourceText: qualitative };
    return null;
  }
  const kind = assessment.kind;
  const minimum = Number.isInteger(assessment.minimumPercent) ? Number(assessment.minimumPercent) : null;
  const maximum = Number.isInteger(assessment.maximumPercent) ? Number(assessment.maximumPercent) : null;
  const qualitative = typeof assessment.qualitativeFrequency === 'string' ? assessment.qualitativeFrequency.trim() : '';
  const source = assessment.source && typeof assessment.source === 'object' && !Array.isArray(assessment.source)
    ? assessment.source as Record<string, unknown>
    : null;
  const sourceText = source && typeof source.exactQuote === 'string' ? source.exactQuote : qualitative || null;
  if (kind === 'unstated') return { kind: 'none', minimumPercent: 0, maximumPercent: 0, label: 'Not stated', sourceText: null };
  if (kind === 'qualitative') return { kind: 'qualitative', minimumPercent: 0, maximumPercent: 0, label: qualitative || 'Travel stated', sourceText };
  if (kind === 'point' && minimum !== null && maximum !== null) return { kind: 'point', minimumPercent: minimum, maximumPercent: maximum, label: `${minimum}%`, sourceText };
  if (kind === 'range' && minimum !== null && maximum !== null) return { kind: 'range', minimumPercent: minimum, maximumPercent: maximum, label: `${minimum}–${maximum}%`, sourceText };
  if (kind === 'up_to' && maximum !== null) return { kind: 'maximum', minimumPercent: 0, maximumPercent: maximum, label: `Up to ${maximum}%`, sourceText };
  if (kind === 'at_least' && minimum !== null) return { kind: 'minimum', minimumPercent: minimum, maximumPercent: 100, label: `At least ${minimum}%`, sourceText };
  return null;
}

export type StagedScoreBundle<E extends ScoreProjectionEvent = ScoreProjectionEvent> = {
  legacy: E | null;
  aim: E | null;
  experience: E | null;
  cleanedArtifact: { id: string; contentHash: string; staleAt?: Date | string | null } | null;
  aimExtraction?: { id: string; sourceJdHash: string; staleAt?: Date | string | null } | null;
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export type StagedScoreAuthority<E extends ScoreProjectionEvent = ScoreProjectionEvent> = {
  mode: 'unscored' | 'legacy' | 'staged';
  aimAuthorityState: ScoreAuthorityState;
  experienceAuthorityState: ScoreAuthorityState;
  currentAim: E | null;
  staleAim: E | null;
  currentExperience: E | null;
  staleExperience: E | null;
  currentLegacy: E | null;
  staleScoreReason: string | null;
};

export function resolveStagedScoreAuthority<E extends ScoreProjectionEvent>(bundle: StagedScoreBundle<E>): StagedScoreAuthority<E> {
  if (!bundle.aim) {
    const legacy = resolveScoreAuthority(bundle.legacy ? [bundle.legacy] : []);
    return {
      mode: bundle.legacy ? 'legacy' : 'unscored',
      aimAuthorityState: legacy.scoreAuthorityState,
      experienceAuthorityState: 'unscored',
      currentAim: null,
      staleAim: null,
      currentExperience: null,
      staleExperience: null,
      currentLegacy: legacy.currentScore,
      staleScoreReason: legacy.staleScoreReason,
    };
  }

  const aimCurrent = !bundle.aim.staleAt && bundle.aim.inputBindingsCurrent !== false;
  const artifactCurrent = Boolean(
    aimCurrent
    && bundle.cleanedArtifact
    && !bundle.cleanedArtifact.staleAt
    && bundle.aim.cleanedJdArtifactId === bundle.cleanedArtifact.id,
  );
  const experienceV2 = bundle.experience?.schemaVersion === 'career-dashboard-experience-result-v2';
  const aimInput = objectValue(bundle.aim.inputBindings);
  const aimSource = objectValue(aimInput?.source);
  const aimSourceJdHash = aimSource?.sourceJdHash;
  const experienceInput = objectValue(bundle.experience?.inputBindings);
  const experienceCurrent = Boolean(
    bundle.experience
    && !bundle.experience.staleAt
    && bundle.experience.inputBindingsCurrent !== false
    && aimCurrent
    && bundle.aim.passed
    && bundle.experience.sourceAimEventId === bundle.aim.id
    && (experienceV2
      ? Boolean(
        bundle.aim.schemaVersion === 'career-dashboard-aim-result-v2'
        && bundle.aim.aimFactualExtractionId
        && bundle.experience.aimFactualExtractionId === bundle.aim.aimFactualExtractionId
        && bundle.aimExtraction
        && !bundle.aimExtraction.staleAt
        && bundle.aimExtraction.id === bundle.aim.aimFactualExtractionId
        && bundle.aimExtraction.sourceJdHash === aimSourceJdHash
        && experienceInput?.aimSemanticResultHash === bundle.aim.semanticResultHash
        && experienceInput?.sourceJdHash === aimSourceJdHash
      )
      : artifactCurrent && bundle.experience.cleanedJdArtifactId === bundle.cleanedArtifact?.id),
  );
  const staleScoreReason = !aimCurrent
    ? bundle.aim.staleReason || 'The newest Aim result is stale or its input fingerprints changed.'
    : bundle.experience && !experienceCurrent
      ? bundle.experience.staleReason || 'The newest Experience result is stale or does not bind the current Aim artifact.'
      : null;
  return {
    mode: 'staged',
    aimAuthorityState: aimCurrent ? 'current' : 'stale_replay_needed',
    experienceAuthorityState: !bundle.experience ? 'unscored' : experienceCurrent ? 'current' : 'stale_replay_needed',
    currentAim: aimCurrent ? bundle.aim : null,
    staleAim: aimCurrent ? null : bundle.aim,
    currentExperience: experienceCurrent ? bundle.experience : null,
    staleExperience: bundle.experience && !experienceCurrent ? bundle.experience : null,
    currentLegacy: null,
    staleScoreReason,
  };
}

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
    LEGACY_SCORE_EVENT_TYPES.includes(
      event.evaluationType as typeof LEGACY_SCORE_EVENT_TYPES[number],
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
>(job: T, scoreInput: E | StagedScoreBundle<E> | null): T & {
  scoreAuthorityState: ScoreAuthorityState;
  currentScore: E | null;
  staleScore: E | null;
  staleScoreReason: string | null;
  aimFitScore: number | null;
  reqFitScore: number | null;
  travelScore: number | null;
  travelRange: TravelRange | null;
  reqFitRationale: string | null;
  aimAuthorityState: ScoreAuthorityState;
  experienceAuthorityState: ScoreAuthorityState;
  currentAim: E | null;
  currentExperience: E | null;
} {
  const isBundle = Boolean(scoreInput && 'legacy' in scoreInput && 'aim' in scoreInput && 'experience' in scoreInput);
  const bundle: StagedScoreBundle<E> = isBundle
    ? scoreInput as StagedScoreBundle<E>
    : { legacy: scoreInput as E | null, aim: null, experience: null, cleanedArtifact: null, aimExtraction: null };
  const staged = resolveStagedScoreAuthority(bundle);
  const currentAim = staged.currentAim;
  const currentExperience = staged.currentExperience;
  const currentScore = staged.currentLegacy;
  const humanDecisionReason = job.status === 'passed' || /^Promoted by user:/i.test(job.passReason || '')
    ? job.passReason
    : null;

  return {
    ...job,
    aimFitScore: currentAim?.aimFitScore ?? currentScore?.aimFitScore ?? null,
    reqFitScore: currentExperience?.experienceFitScore ?? currentScore?.experienceFitScore ?? null,
    travelScore: currentAim?.travelScore ?? currentScore?.travelScore ?? null,
    travelRange: currentAim
      ? travelRangeFromAssessment(currentAim.travelAssessment)
      : currentScore ? travelRangeFromScorePayload(currentScore.mandatoryRequirementAssessments) : null,
    passReason: humanDecisionReason ?? currentAim?.aimReason ?? currentScore?.aimReason ?? null,
    reqFitRationale: currentExperience?.experienceReason ?? currentScore?.experienceReason ?? null,
    compensation: currentAim
      ? compensationDisplayFromAssessment(currentAim.compensationAssessment)
      : currentScore ? job.compensation : null,
    scoreAuthorityState: staged.mode === 'staged' ? staged.aimAuthorityState : staged.aimAuthorityState,
    currentScore,
    staleScore: staged.staleAim || staged.staleExperience,
    staleScoreReason: staged.staleScoreReason,
    aimAuthorityState: staged.aimAuthorityState,
    experienceAuthorityState: staged.experienceAuthorityState,
    currentAim,
    currentExperience,
  };
}
