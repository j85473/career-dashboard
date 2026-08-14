import builderInputSchema from '../../data/scoring/schemas/aim-builder-input-v1.schema.json';
import vectorSchema from '../../data/scoring/schemas/aim-factual-vector-v1.schema.json';

import type { AimCompensationResult } from './aimCompensation';
import { validateAimFactualVector } from './aimEvidence';
import {
  aimLocalPolicyFactsHash,
  aimLocalPolicyScoringIdentity,
  aimScoringIdentity,
  aimSourceIdentity,
  aimSourceJdHash,
  aimTrustedMetadataHash,
  normalizeAimSource,
  normalizeAimTrustedMetadata,
} from './aimIdentity';
import { canonicalJsonSha256 } from './scoringCanonicalJson';
import { validateJsonSchema, type JsonSchema } from './scoringJsonSchema';
import { evaluateAimLocalPolicy, evaluateAimStage1 } from './aimStage1';
import type {
  AimFactualVector,
  AimQuestionRegistry,
  AimScoringPolicy,
  AimTrustedMetadata,
} from './aimV2Types';

export type AimBuilderInput = {
  schemaVersion: 'aim-builder-input-v1';
  purpose: 'checkpoint' | 'final';
  controllerScope: 'local_policy' | 'stage1' | 'compensation_preflight' | 'complete';
  canonicalSource: { originalJd: string; sourceJdHash: string };
  trustedMetadata: AimTrustedMetadata & { trustedMetadataHash: string };
  factualVector: AimFactualVector | null;
  holisticAssessment: { score: number; rationale: string } | null;
  authorityBindings: {
    questionRegistryVersion: string;
    questionRegistryHash: string;
    scoringPolicyVersion: string;
    scoringPolicyHash: string;
    resultBuilderSemanticVersion: string;
    runnerProtocolVersion: string;
    runnerProtocolHash: string;
    anonymizationPolicyVersion: string;
    anonymizationPolicyHash: string;
  };
  expectedExtractionIdentity: string | null;
};

export type AimBand = {
  code: string;
  label: string;
  minimum: number;
  maximum: number;
};

export type AimTerminalResult =
  | {
      variant: 'local_policy_kill';
      trustedMetadataHash: string;
      scoringPolicyHash: string;
      scoringIdentity: string;
      localTriggerCodes: string[];
      decision: 'killed_local_policy';
      score: null;
      band: null;
    }
  | {
      variant: 'factual_screen_kill';
      factualVector: AimFactualVector;
      scoringIdentity: string;
      triggerQuestionIds: string[];
      decision: 'killed_by_factual_screen';
      score: null;
      band: null;
    }
  | {
      variant: 'compensation_floor_kill';
      factualVector: AimFactualVector;
      scoringIdentity: string;
      compensation: AimCompensationResult;
      decision: 'killed_by_compensation_floor';
      score: null;
      band: null;
    }
  | {
      variant: 'scored_survivor';
      factualVector: AimFactualVector;
      scoringIdentity: string;
      decision: 'scored_survivor';
      score: number;
      rationale: string;
      band: AimBand;
    };

export type AimCheckpointContinuation = {
  variant: 'continue_to_stage1' | 'continue_to_compensation' | 'continue_to_complete';
  decision: 'continue_to_stage1' | 'continue_to_compensation' | 'continue_to_complete';
};

export type AimBuilderResult = AimTerminalResult | AimCheckpointContinuation;

export type AimBuilderAuthorities = {
  registry: AimQuestionRegistry;
  policy: AimScoringPolicy;
};

function assertFrozenAuthorities(authorities: AimBuilderAuthorities): void {
  if (!Object.isFrozen(authorities.registry) || !Object.isFrozen(authorities.policy)) {
    throw new Error('Aim builder authorities must be validated and deeply frozen');
  }
}

function validateInputShape(value: unknown): AimBuilderInput {
  const cloned = structuredClone(value);
  validateJsonSchema(cloned, builderInputSchema as JsonSchema, {
    externalSchemas: new Map([['career-dashboard-aim-factual-vector-v1', vectorSchema as JsonSchema]]),
  });
  return cloned as AimBuilderInput;
}

function assertPurposeScope(input: AimBuilderInput): void {
  if (input.purpose === 'checkpoint' && input.controllerScope === 'complete') {
    throw new Error('Aim checkpoint purpose does not accept complete scope');
  }
  const local = input.controllerScope === 'local_policy';
  if (local !== (input.factualVector === null) || local !== (input.expectedExtractionIdentity === null)) {
    throw new Error('Aim local-policy scope is the only scope without a factual vector and extraction identity');
  }
  if (!local && input.factualVector?.scope !== input.controllerScope) {
    throw new Error('Aim controller scope does not match factual-vector scope');
  }
  const holisticFinal = input.purpose === 'final' && input.controllerScope === 'stage1';
  if (holisticFinal !== (input.holisticAssessment !== null)) {
    throw new Error('Aim holistic assessment is allowed only for a final Stage 1 survivor');
  }
}

function assertAuthorityBindings(
  input: AimBuilderInput,
  authorities: AimBuilderAuthorities,
): { questionRegistryHash: string; scoringPolicyHash: string } {
  const questionRegistryHash = canonicalJsonSha256(authorities.registry);
  const scoringPolicyHash = canonicalJsonSha256(authorities.policy);
  const bindings = input.authorityBindings;
  if (bindings.questionRegistryVersion !== authorities.registry.questionRegistryVersion
    || bindings.questionRegistryHash !== questionRegistryHash) {
    throw new Error('Aim builder question-registry authority mismatch');
  }
  if (bindings.scoringPolicyVersion !== authorities.policy.policyVersion
    || bindings.scoringPolicyHash !== scoringPolicyHash
    || bindings.resultBuilderSemanticVersion !== authorities.policy.resultBuilderSemanticVersion) {
    throw new Error('Aim builder scoring-policy authority mismatch');
  }
  return { questionRegistryHash, scoringPolicyHash };
}

function validatedInputs(input: AimBuilderInput): {
  source: string;
  metadata: AimTrustedMetadata;
  trustedMetadataHash: string;
} {
  const source = normalizeAimSource(input.canonicalSource.originalJd);
  if (source !== input.canonicalSource.originalJd || aimSourceJdHash(source) !== input.canonicalSource.sourceJdHash) {
    throw new Error('Aim builder canonical source/hash mismatch');
  }
  const suppliedMetadata: AimTrustedMetadata = {
    company: input.trustedMetadata.company,
    title: input.trustedMetadata.title,
    location: input.trustedMetadata.location,
  };
  const metadata = normalizeAimTrustedMetadata(suppliedMetadata);
  if (JSON.stringify(metadata) !== JSON.stringify(suppliedMetadata)) {
    throw new Error('Aim builder trusted metadata is not canonical');
  }
  const trustedMetadataHash = aimTrustedMetadataHash(metadata);
  if (trustedMetadataHash !== input.trustedMetadata.trustedMetadataHash) {
    throw new Error('Aim builder trusted-metadata hash mismatch');
  }
  return { source, metadata, trustedMetadataHash };
}

function scoringIdentityForVector(
  vector: AimFactualVector,
  trustedMetadataHash: string,
  scoringPolicyHash: string,
  policy: AimScoringPolicy,
): string {
  return aimScoringIdentity({
    factualVectorHash: vector.factualVectorHash,
    trustedMetadataHash,
    scoringPolicyVersion: policy.policyVersion,
    scoringPolicyHash,
    resultBuilderSemanticVersion: policy.resultBuilderSemanticVersion,
  });
}

function continuation(variant: AimCheckpointContinuation['variant']): AimCheckpointContinuation {
  return { variant, decision: variant };
}

export function buildAimResultFromFactualVector(
  value: unknown,
  authorities: AimBuilderAuthorities,
): AimBuilderResult {
  assertFrozenAuthorities(authorities);
  const input = validateInputShape(value);
  assertPurposeScope(input);
  const { scoringPolicyHash } = assertAuthorityBindings(input, authorities);
  const { source, metadata, trustedMetadataHash } = validatedInputs(input);
  const localPolicy = evaluateAimLocalPolicy(metadata, authorities.policy);

  if (localPolicy.decision === 'killed_local_policy') {
    const localPolicyFactsHash = aimLocalPolicyFactsHash({
      sourceIdentity: aimSourceIdentity(input.canonicalSource.sourceJdHash, trustedMetadataHash),
      trustedMetadataHash,
      orderedLocalTriggerCodes: localPolicy.triggerCodes,
    });
    return {
      variant: 'local_policy_kill',
      trustedMetadataHash,
      scoringPolicyHash,
      scoringIdentity: aimLocalPolicyScoringIdentity({
        localPolicyFactsHash,
        scoringPolicyVersion: authorities.policy.policyVersion,
        scoringPolicyHash,
        resultBuilderSemanticVersion: authorities.policy.resultBuilderSemanticVersion,
      }),
      localTriggerCodes: localPolicy.triggerCodes,
      decision: 'killed_local_policy',
      score: null,
      band: null,
    };
  }

  if (input.controllerScope === 'local_policy') {
    if (input.purpose === 'final') throw new Error('Passing local-policy scope cannot produce a final Aim result');
    return continuation('continue_to_stage1');
  }

  const vector = validateAimFactualVector({
    vector: input.factualVector,
    canonicalOriginalJd: source,
    trustedMetadata: metadata,
    registry: authorities.registry,
    policy: authorities.policy,
  });
  if (vector.questionRegistryVersion !== input.authorityBindings.questionRegistryVersion
    || vector.questionRegistryHash !== input.authorityBindings.questionRegistryHash
    || vector.anonymizationPolicyVersion !== input.authorityBindings.anonymizationPolicyVersion
    || vector.anonymizationPolicyHash !== input.authorityBindings.anonymizationPolicyHash) {
    throw new Error('Aim factual vector does not match builder authority bindings');
  }
  if (vector.extractionIdentity !== input.expectedExtractionIdentity) {
    throw new Error('Aim factual vector does not match expected extraction identity');
  }
  const scoringIdentity = scoringIdentityForVector(vector, trustedMetadataHash, scoringPolicyHash, authorities.policy);
  const stage1 = evaluateAimStage1(vector, metadata, authorities.policy);
  if (stage1.decision === 'killed_by_factual_screen') {
    return {
      variant: 'factual_screen_kill', factualVector: vector, scoringIdentity,
      triggerQuestionIds: stage1.triggerQuestionIds, decision: 'killed_by_factual_screen', score: null, band: null,
    };
  }
  if (input.controllerScope === 'stage1') {
    if (input.purpose === 'checkpoint') return continuation('continue_to_complete');
    const assessment = input.holisticAssessment;
    if (!assessment) throw new Error('Final Stage 1 survivor is missing its holistic assessment');
    const selectedBand = authorities.policy.bands.find(
      (candidate) => assessment.score >= candidate.minimum && assessment.score <= candidate.maximum,
    );
    if (!selectedBand) throw new Error('Aim policy has no score band for the holistic assessment');
    return {
      variant: 'scored_survivor',
      factualVector: vector,
      scoringIdentity,
      decision: 'scored_survivor',
      score: assessment.score,
      rationale: assessment.rationale,
      band: { ...selectedBand },
    };
  }
  throw new Error('Legacy multi-packet Aim Stage 2 scopes are no longer accepted');
}
