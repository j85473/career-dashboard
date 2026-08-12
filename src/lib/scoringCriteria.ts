import { createHash } from 'node:crypto';

export type ScoringCriterionOutcome = 'direct' | 'partial' | 'cannot_evaluate' | 'does_not_meet';
export type StoredScoringCriterionOutcome = ScoringCriterionOutcome | 'excluded';
export type CriterionClassification = 'required' | 'preferred';
export type CriterionLogicalOperator = 'single' | 'all' | 'any';
export type CriterionCategory = 'substantive' | 'role_defining_credential' | 'administrative' | 'subjective_boilerplate';

export type CriterionLeafOutcome = {
  leafId: string;
  outcome: ScoringCriterionOutcome;
};

export type ExperienceCriterionSummary = {
  criterionId: string;
  classification: CriterionClassification;
  category: CriterionCategory;
  operator: CriterionLogicalOperator;
  leaves: readonly CriterionLeafOutcome[];
  declaredOutcome: StoredScoringCriterionOutcome;
};

export type ExperienceDecision = {
  decision: 'qualified' | 'hard_requirement_not_fully_supported';
  experienceFitScore: number | null;
  preferredPoints: number | null;
  blockingCriteria: Array<{ criterionId: string; outcome: ScoringCriterionOutcome }>;
  explanation: string;
};

export function stableCriterionId(inputHash: string, classification: CriterionClassification, sourceStart: number, sourceEnd: number): string {
  if (!/^[a-f0-9]{64}$/.test(inputHash)) throw new Error('criterion inputHash must be lowercase SHA-256');
  if (![sourceStart, sourceEnd].every(Number.isSafeInteger) || sourceStart < 0 || sourceEnd <= sourceStart) {
    throw new Error('criterion source span is invalid');
  }
  const digest = createHash('sha256')
    .update(`${inputHash}\u0000${classification}\u0000${sourceStart}\u0000${sourceEnd}`, 'utf8')
    .digest('hex');
  return `criterion-${digest.slice(0, 32)}`;
}

export function deriveCompoundOutcome(
  operator: CriterionLogicalOperator,
  leaves: readonly CriterionLeafOutcome[],
): ScoringCriterionOutcome {
  if (leaves.length === 0) throw new Error('criterion must contain at least one atomic leaf');
  if (operator === 'single' && leaves.length !== 1) throw new Error('single criterion must contain exactly one leaf');
  const outcomes = leaves.map((leaf) => leaf.outcome);
  if (operator === 'any') {
    if (outcomes.includes('direct')) return 'direct';
    if (outcomes.includes('partial')) return 'partial';
    if (outcomes.includes('cannot_evaluate')) return 'cannot_evaluate';
    return 'does_not_meet';
  }
  if (outcomes.includes('does_not_meet')) return 'does_not_meet';
  if (outcomes.includes('cannot_evaluate')) return 'cannot_evaluate';
  if (outcomes.includes('partial')) return 'partial';
  return 'direct';
}

export function preferredExperiencePoints(outcomes: readonly ScoringCriterionOutcome[]): number {
  if (outcomes.length === 0) return 0;
  const units = outcomes.reduce((total, outcome) => total + (outcome === 'direct' ? 2 : outcome === 'partial' ? 1 : 0), 0);
  return Math.floor((20 * units + outcomes.length) / (2 * outcomes.length));
}

export function deriveExperienceDecision(criteria: readonly ExperienceCriterionSummary[]): ExperienceDecision {
  const active = criteria.filter((criterion) => criterion.category !== 'administrative' && criterion.category !== 'subjective_boilerplate');
  for (const criterion of criteria) {
    const expected = criterion.category === 'administrative' || criterion.category === 'subjective_boilerplate'
      ? 'excluded'
      : deriveCompoundOutcome(criterion.operator, criterion.leaves);
    if (criterion.declaredOutcome !== expected) throw new Error(`criterion ${criterion.criterionId} outcome mismatch`);
  }
  const blockingCriteria = active
    .filter((criterion) => criterion.classification === 'required' && criterion.declaredOutcome !== 'direct')
    .map((criterion) => ({ criterionId: criterion.criterionId, outcome: criterion.declaredOutcome as ScoringCriterionOutcome }));
  if (blockingCriteria.length > 0) {
    return {
      decision: 'hard_requirement_not_fully_supported',
      experienceFitScore: null,
      preferredPoints: null,
      blockingCriteria,
      explanation: 'one or more explicit substantive hard requirements are not fully supported by the approved evidence',
    };
  }
  const preferred = active
    .filter((criterion) => criterion.classification === 'preferred')
    .map((criterion) => criterion.declaredOutcome as ScoringCriterionOutcome);
  const preferredPoints = preferredExperiencePoints(preferred);
  return {
    decision: 'qualified',
    experienceFitScore: 80 + preferredPoints,
    preferredPoints,
    blockingCriteria: [],
    explanation: preferred.length === 0 ? 'no preferred qualifications stated' : 'all hard requirements fully supported',
  };
}

export function isStrictCredentialGap(criterion: Pick<ExperienceCriterionSummary, 'classification' | 'category' | 'declaredOutcome'>): boolean {
  return criterion.classification === 'required'
    && criterion.category === 'role_defining_credential'
    && criterion.declaredOutcome === 'cannot_evaluate';
}
