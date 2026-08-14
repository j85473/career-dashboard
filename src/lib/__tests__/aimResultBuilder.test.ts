import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { allExactCodePointOccurrences } from '../aimEvidence';
import {
  AIM_CANONICALIZATION_VERSION,
  aimEvidenceId,
  aimExtractionIdentity,
  aimFactualVectorHash,
  aimSourceIdentity,
  aimSourceJdHash,
  aimTrustedMetadataHash,
  sourceOrderAimEvidenceCatalog,
} from '../aimIdentity';
import { loadAimQuestionRegistry } from '../aimQuestionRegistry';
import { sourceQuestionIdsForDerivedFact } from '../aimQuestionProjection';
import { buildAimResultFromFactualVector, type AimBuilderInput } from '../aimResultBuilder';
import { loadAimScoringPolicy } from '../aimScoringPolicy';
import { canonicalJson, canonicalJsonSha256 } from '../scoringCanonicalJson';
import type { AimEvidenceEntry, AimFactualVector, AimTrustedMetadata } from '../aimV2Types';

const { registry, questionRegistryHash } = loadAimQuestionRegistry();
const { policy, scoringPolicyHash } = loadAimScoringPolicy(registry);
const authorities = { registry, policy };
const metadata: AimTrustedMetadata = { company: 'Example', title: 'Channel Manager', location: 'Minneapolis, MN' };
const HASHES = {
  prompt: 'a'.repeat(64), response: 'b'.repeat(64), runner: 'c'.repeat(64),
  packet: 'd'.repeat(64), anonymization: 'e'.repeat(64),
};

function questionIdsForScope(scope: AimFactualVector['scope']): string[] {
  if (scope === 'stage1') return registry.questions.filter((question) => question.privatePhase === 'stage1').map((question) => question.id);
  if (scope === 'complete') return registry.questions.map((question) => question.id);
  const compensation = new Set(registry.questions.filter((question) => question.parserInput === 'compensation_fact').map((question) => question.id));
  const supplemental = registry.questions.filter((question) => question.privatePhase === 'stage2' && !compensation.has(question.id)).slice(0, 14);
  const selected = new Set([...compensation, ...supplemental.map((question) => question.id)]);
  return registry.questions.filter((question) => question.privatePhase === 'stage1' || selected.has(question.id)).map((question) => question.id);
}

function factualVector(
  source: string,
  scope: AimFactualVector['scope'],
  yesEvidence: Record<string, string> = {},
): AimFactualVector {
  const sourceJdHash = aimSourceJdHash(source);
  const trustedMetadataHash = aimTrustedMetadataHash(metadata);
  const sourceIdentity = aimSourceIdentity(sourceJdHash, trustedMetadataHash);
  const extractionIdentity = aimExtractionIdentity({
    sourceIdentity,
    questionRegistryVersion: registry.questionRegistryVersion,
    questionRegistryHash,
    promptContractVersion: 'aim-factual-questions-v1', promptContractHash: HASHES.prompt,
    responseContractVersion: 'aim-factual-worker-response-v1', responseContractHash: HASHES.response,
    packetStrategyVersion: 'aim-stage2-packetizer-v4', packetStrategyHash: HASHES.packet,
    canonicalizationVersion: AIM_CANONICALIZATION_VERSION,
    anonymizationPolicyVersion: 'aim-anonymization-policy-v1', anonymizationPolicyHash: HASHES.anonymization,
    extractorSemanticVersion: 'aim-factual-extractor-v5',
  });
  const byQuestion = new Map<string, AimEvidenceEntry>();
  for (const [desiredQuestionId, quote] of Object.entries(yesEvidence)) {
    const questionId = registry.questions.some((question) => question.id === desiredQuestionId)
      ? desiredQuestionId
      : sourceQuestionIdsForDerivedFact(desiredQuestionId)[0];
    if (!questionId) continue;
    const entry: AimEvidenceEntry = {
      evidenceId: '', source: 'original_jd', field: null, exactQuote: quote,
      occurrences: allExactCodePointOccurrences(source, quote),
    };
    entry.evidenceId = aimEvidenceId(entry);
    byQuestion.set(questionId, entry);
  }
  const evidenceCatalog = sourceOrderAimEvidenceCatalog([...new Map([...byQuestion.values()].map((entry) => [entry.evidenceId, entry])).values()]);
  const answers = questionIdsForScope(scope).map((questionId) => {
    const evidence = byQuestion.get(questionId);
    return evidence
      ? { questionId, answer: 'yes' as const, evidenceIds: [evidence.evidenceId] }
      : { questionId, answer: 'unsupported' as const, evidenceIds: [] };
  });
  const vector: AimFactualVector = {
    schemaVersion: 'career-dashboard-aim-factual-vector-v1', scope, sourceJdHash, trustedMetadataHash, sourceIdentity,
    questionRegistryVersion: registry.questionRegistryVersion, questionRegistryHash,
    promptContractVersion: 'aim-factual-questions-v1', promptContractHash: HASHES.prompt,
    responseContractVersion: 'aim-factual-worker-response-v1', responseContractHash: HASHES.response,
    runnerProtocolVersion: 'career-dashboard-runner-protocol-v2', runnerProtocolHash: HASHES.runner,
    packetStrategyVersion: 'aim-stage2-packetizer-v4', packetStrategyHash: HASHES.packet,
    canonicalizationVersion: AIM_CANONICALIZATION_VERSION,
    anonymizationPolicyVersion: 'aim-anonymization-policy-v1', anonymizationPolicyHash: HASHES.anonymization,
    extractorSemanticVersion: 'aim-factual-extractor-v5', extractionIdentity,
    answers, evidenceCatalog, factualVectorHash: '',
    provenance: { disposition: 'fresh', sourceExtractionId: null, packetPlanHash: null, packets: [] },
  };
  vector.factualVectorHash = aimFactualVectorHash(vector);
  return vector;
}

function builderInput(
  source: string,
  controllerScope: AimBuilderInput['controllerScope'],
  purpose: AimBuilderInput['purpose'],
  vector: AimFactualVector | null,
  trusted: AimTrustedMetadata = metadata,
  holisticAssessment: AimBuilderInput['holisticAssessment'] = null,
): AimBuilderInput {
  return {
    schemaVersion: 'aim-builder-input-v1', purpose, controllerScope,
    canonicalSource: { originalJd: source, sourceJdHash: aimSourceJdHash(source) },
    trustedMetadata: { ...trusted, trustedMetadataHash: aimTrustedMetadataHash(trusted) },
    factualVector: vector,
    holisticAssessment,
    authorityBindings: {
      questionRegistryVersion: registry.questionRegistryVersion, questionRegistryHash,
      scoringPolicyVersion: policy.policyVersion, scoringPolicyHash,
      resultBuilderSemanticVersion: policy.resultBuilderSemanticVersion,
      runnerProtocolVersion: 'career-dashboard-runner-protocol-v2', runnerProtocolHash: HASHES.runner,
      anonymizationPolicyVersion: 'aim-anonymization-policy-v1', anonymizationPolicyHash: HASHES.anonymization,
    },
    expectedExtractionIdentity: vector?.extractionIdentity ?? null,
  };
}

test('Aim builder applies exact local policy before factual extraction', () => {
  const source = 'A role description.';
  const result = buildAimResultFromFactualVector(builderInput(source, 'local_policy', 'checkpoint', null, {
    company: 'PepsiCo, Inc.', title: 'Manager', location: null,
  }), authorities);
  assert.equal(result.variant, 'local_policy_kill');
  if (result.variant === 'local_policy_kill') {
    assert.deepEqual(result.localTriggerCodes, ['direct_pepsico_employer']);
    assert.equal(result.score, null);
  }
  assert.deepEqual(
    buildAimResultFromFactualVector(builderInput(source, 'local_policy', 'checkpoint', null), authorities),
    { variant: 'continue_to_stage1', decision: 'continue_to_stage1' },
  );
});

test('Aim builder enforces Stage 1 hard kills before holistic scoring', () => {
  const killSource = 'This position is temporary.';
  const killVector = factualVector(killSource, 'stage1', { 'S1.Q01': killSource });
  const killed = buildAimResultFromFactualVector(builderInput(killSource, 'stage1', 'checkpoint', killVector), authorities);
  assert.equal(killed.variant, 'factual_screen_kill');

  const passingSource = 'A channel leadership role with substantial travel.';
  const passingVector = factualVector(passingSource, 'stage1');
  assert.deepEqual(
    buildAimResultFromFactualVector(builderInput(passingSource, 'stage1', 'checkpoint', passingVector), authorities),
    { variant: 'continue_to_complete', decision: 'continue_to_complete' },
  );
});

test('Aim builder records the holistic score and rationale without recomputing them', () => {
  const source = 'Build and own a national partner channel with extensive travel.';
  const vector = factualVector(source, 'stage1');
  const assessment = {
    score: 92,
    rationale: 'The role centers on channel ownership, building, autonomy, and extensive travel.',
  };
  const input = builderInput(source, 'stage1', 'final', vector, metadata, assessment);
  const first = buildAimResultFromFactualVector(input, authorities);
  const second = buildAimResultFromFactualVector(structuredClone(input), authorities);
  assert.equal(canonicalJsonSha256(first), canonicalJsonSha256(second));
  assert.equal(first.variant, 'scored_survivor');
  if (first.variant === 'scored_survivor') {
    assert.equal(first.score, assessment.score);
    assert.equal(first.rationale, assessment.rationale);
    assert.equal(first.band.code, 'exceptional');
  }
});

test('Aim builder rejects a final Stage 1 survivor without the Terra assessment', () => {
  const source = 'A role description.';
  const vector = factualVector(source, 'stage1');
  assert.throws(
    () => buildAimResultFromFactualVector(builderInput(source, 'stage1', 'final', vector), authorities),
    /holistic assessment/,
  );
});

test('Aim result builder dependency graph excludes filesystem, database, network, time, and randomness modules', () => {
  const start = path.resolve(process.cwd(), 'src/lib/aimResultBuilder.ts');
  const visited = new Set<string>();
  const forbidden = /(?:node:fs|['"]fs['"]|@prisma\/client|\/prisma(?:['"]|\/)|node:https?|['"]https?['"]|Date\.now|new Date\s*\(|Math\.random|randomUUID)/u;
  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, forbidden, `${path.relative(process.cwd(), file)} crosses the pure builder boundary`);
    for (const match of source.matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/gu)) {
      const candidate = path.resolve(path.dirname(file), match[1]);
      const target = candidate.endsWith('.ts') ? candidate : `${candidate}.ts`;
      if (target.startsWith(path.resolve(process.cwd(), 'src/lib')) && !target.endsWith('.json')) visit(target);
    }
  };
  visit(start);
});

test('DB-free Aim adapter emits the same canonical result as the in-process builder', () => {
  const source = 'A role description.';
  const input = builderInput(source, 'local_policy', 'checkpoint', null);
  const expected = buildAimResultFromFactualVector(input, authorities);
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/build_aim_result.ts'], {
    cwd: process.cwd(), input: canonicalJson(input), encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, canonicalJson(expected));
});
