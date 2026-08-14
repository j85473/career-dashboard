import assert from 'node:assert/strict';
import test from 'node:test';

import { allExactCodePointOccurrences, validateAimFactualVector } from '../aimEvidence';
import {
  AIM_CANONICALIZATION_VERSION,
  aimEvidenceId,
  aimExtractionIdentity,
  aimFactualVectorHash,
  aimSourceIdentity,
  aimSourceJdHash,
  aimTrustedMetadataHash,
} from '../aimIdentity';
import { loadAimQuestionRegistry } from '../aimQuestionRegistry';
import { loadAimScoringPolicy } from '../aimScoringPolicy';
import type { AimEvidenceEntry, AimFactualVector, AimTrustedMetadata } from '../aimV2Types';

const HASHES = {
  prompt: 'a'.repeat(64),
  response: 'b'.repeat(64),
  runner: 'c'.repeat(64),
  packet: 'd'.repeat(64),
  anonymization: 'e'.repeat(64),
};

function factualVector(
  source: string,
  metadata: AimTrustedMetadata,
  evidenceCatalog: AimEvidenceEntry[] = [],
  scope: AimFactualVector['scope'] = 'stage1',
): AimFactualVector {
  const { registry, questionRegistryHash } = loadAimQuestionRegistry();
  const sourceJdHash = aimSourceJdHash(source);
  const trustedMetadataHash = aimTrustedMetadataHash(metadata);
  const sourceIdentity = aimSourceIdentity(sourceJdHash, trustedMetadataHash);
  const extractionIdentity = aimExtractionIdentity({
    sourceIdentity,
    questionRegistryVersion: registry.questionRegistryVersion,
    questionRegistryHash,
    promptContractVersion: 'aim-factual-questions-v1',
    promptContractHash: HASHES.prompt,
    responseContractVersion: 'aim-factual-worker-response-v1',
    responseContractHash: HASHES.response,
    packetStrategyVersion: 'aim-stage2-packetizer-v1',
    packetStrategyHash: HASHES.packet,
    canonicalizationVersion: AIM_CANONICALIZATION_VERSION,
    anonymizationPolicyVersion: 'aim-anonymization-policy-v1',
    anonymizationPolicyHash: HASHES.anonymization,
    extractorSemanticVersion: 'aim-factual-extractor-v1',
  });
  const scopedQuestions = scope === 'complete'
    ? registry.questions
    : registry.questions.filter((question) => question.privatePhase === 'stage1');
  const answers = scopedQuestions.map((question) => ({
    questionId: question.id,
    answer: 'unsupported' as const,
    evidenceIds: [] as string[],
  }));
  const vector: AimFactualVector = {
    schemaVersion: 'career-dashboard-aim-factual-vector-v1',
    scope,
    sourceJdHash,
    trustedMetadataHash,
    sourceIdentity,
    questionRegistryVersion: registry.questionRegistryVersion,
    questionRegistryHash,
    promptContractVersion: 'aim-factual-questions-v1',
    promptContractHash: HASHES.prompt,
    responseContractVersion: 'aim-factual-worker-response-v1',
    responseContractHash: HASHES.response,
    runnerProtocolVersion: 'career-dashboard-runner-protocol-v2',
    runnerProtocolHash: HASHES.runner,
    packetStrategyVersion: 'aim-stage2-packetizer-v1',
    packetStrategyHash: HASHES.packet,
    canonicalizationVersion: AIM_CANONICALIZATION_VERSION,
    anonymizationPolicyVersion: 'aim-anonymization-policy-v1',
    anonymizationPolicyHash: HASHES.anonymization,
    extractorSemanticVersion: 'aim-factual-extractor-v1',
    extractionIdentity,
    answers,
    evidenceCatalog,
    factualVectorHash: '',
    provenance: { disposition: 'fresh', sourceExtractionId: null, packetPlanHash: null, packets: [] },
  };
  vector.factualVectorHash = aimFactualVectorHash(vector);
  return vector;
}

function vectorWithOriginalEvidence(
  source: string,
  metadata: AimTrustedMetadata,
  questionId: string,
  exactQuote: string,
): AimFactualVector {
  const evidence: AimEvidenceEntry = {
    evidenceId: '', source: 'original_jd', field: null, exactQuote,
    occurrences: allExactCodePointOccurrences(source, exactQuote),
  };
  evidence.evidenceId = aimEvidenceId(evidence);
  const scope: AimFactualVector['scope'] = questionId.startsWith('S1.') ? 'stage1' : 'complete';
  const vector = factualVector(source, metadata, [evidence], scope);
  const answer = vector.answers.find((candidate) => candidate.questionId === questionId)!;
  answer.answer = 'yes';
  answer.evidenceIds = [evidence.evidenceId];
  vector.factualVectorHash = aimFactualVectorHash(vector);
  return vector;
}

test('Aim evidence binds every exact Unicode occurrence without whitespace coercion', () => {
  const source = 'Café\trole. Café\trole.';
  assert.deepEqual(allExactCodePointOccurrences(source, 'Café\trole'), [
    { startCodePoint: 0, endCodePoint: 9 },
    { startCodePoint: 11, endCodePoint: 20 },
  ]);
  assert.deepEqual(allExactCodePointOccurrences('A😀B😀B', '😀B'), [
    { startCodePoint: 1, endCodePoint: 3 },
    { startCodePoint: 3, endCodePoint: 5 },
  ]);
});

test('Aim factual vector validates exact evidence, ordering, authority, and hashes', () => {
  const source = 'This position is temporary. This position is temporary.';
  const metadata = { company: 'Example', title: 'Channel Manager', location: 'Minneapolis, MN' };
  const occurrences = allExactCodePointOccurrences(source, 'This position is temporary.');
  const evidence: AimEvidenceEntry = {
    evidenceId: '', source: 'original_jd', field: null,
    exactQuote: 'This position is temporary.', occurrences,
  };
  evidence.evidenceId = aimEvidenceId(evidence);
  const vector = factualVector(source, metadata, [evidence]);
  vector.answers[0] = { questionId: 'S1.Q01', answer: 'yes', evidenceIds: [evidence.evidenceId] };
  vector.factualVectorHash = aimFactualVectorHash(vector);
  const { registry } = loadAimQuestionRegistry();
  const { policy } = loadAimScoringPolicy(registry);
  assert.doesNotThrow(() => validateAimFactualVector({ vector, canonicalOriginalJd: source, trustedMetadata: metadata, registry, policy }));

  const alteredQuote = structuredClone(vector);
  alteredQuote.evidenceCatalog[0].exactQuote = 'This position is temp-orary.';
  assert.throws(() => validateAimFactualVector({ vector: alteredQuote, canonicalOriginalJd: source, trustedMetadata: metadata, registry }), /not an exact source substring/);

  const missingOccurrence = structuredClone(vector);
  missingOccurrence.evidenceCatalog[0].occurrences.pop();
  assert.throws(() => validateAimFactualVector({ vector: missingOccurrence, canonicalOriginalJd: source, trustedMetadata: metadata, registry }), /every exact occurrence/);
});

test('Aim factual vector rejects evidence on unsupported and unauthorized Stage 2 metadata', () => {
  const source = 'Nothing relevant.';
  const metadata = { company: 'Example', title: 'Channel Manager', location: 'Minneapolis, MN' };
  const titleOccurrences = allExactCodePointOccurrences(metadata.title, metadata.title);
  const evidence: AimEvidenceEntry = {
    evidenceId: '', source: 'trusted_metadata', field: 'title', exactQuote: metadata.title, occurrences: titleOccurrences,
  };
  evidence.evidenceId = aimEvidenceId(evidence);
  const vector = factualVector(source, metadata, [evidence]);
  vector.answers[0].evidenceIds = [evidence.evidenceId];
  vector.factualVectorHash = aimFactualVectorHash(vector);
  const { registry } = loadAimQuestionRegistry();
  assert.throws(() => validateAimFactualVector({ vector, canonicalOriginalJd: source, trustedMetadata: metadata, registry }), /invalid evidence cardinality/);
});

test('Aim machine guard rejects a primary-work claim without primary or majority evidence', () => {
  const source = 'The role includes inside sales support.';
  const metadata = { company: 'Example', title: 'Sales Manager', location: null };
  const quote = 'The role includes inside sales support.';
  const evidence: AimEvidenceEntry = {
    evidenceId: '', source: 'original_jd', field: null, exactQuote: quote,
    occurrences: allExactCodePointOccurrences(source, quote),
  };
  evidence.evidenceId = aimEvidenceId(evidence);
  const vector = factualVector(source, metadata, [evidence]);
  vector.answers[1] = { questionId: 'S1.Q02', answer: 'yes', evidenceIds: [evidence.evidenceId] };
  vector.factualVectorHash = aimFactualVectorHash(vector);
  const { registry } = loadAimQuestionRegistry();
  const { policy } = loadAimScoringPolicy(registry);
  assert.throws(() => validateAimFactualVector({ vector, canonicalOriginalJd: source, trustedMetadata: metadata, registry, policy }), /primary\/majority/);
});

test('Aim no and unsupported answers carry no evidence and bypass positive machine guards', () => {
  const source = 'EverCommerce is a software company.';
  const metadata = { company: 'EverCommerce', title: 'Customer Success Manager', location: 'Remote- US' };
  const vector = factualVector(source, metadata);
  for (const questionId of ['S1.Q06', 'S1.Q07']) {
    const answer = vector.answers.find((candidate) => candidate.questionId === questionId)!;
    answer.answer = 'no';
    answer.evidenceIds = [];
  }
  vector.factualVectorHash = aimFactualVectorHash(vector);
  const { registry } = loadAimQuestionRegistry();
  const { policy } = loadAimScoringPolicy(registry);
  assert.doesNotThrow(() => validateAimFactualVector({
    vector, canonicalOriginalJd: source, trustedMetadata: metadata, registry, policy,
  }));

  const noncanonical = vectorWithOriginalEvidence(source, metadata, 'S1.Q07', source);
  noncanonical.answers.find((answer) => answer.questionId === 'S1.Q07')!.answer = 'no';
  noncanonical.factualVectorHash = aimFactualVectorHash(noncanonical);
  assert.throws(() => validateAimFactualVector({
    vector: noncanonical, canonicalOriginalJd: source, trustedMetadata: metadata, registry, policy,
  }), /invalid evidence cardinality/);
});

test('Aim machine guards fail closed for every declared guard family', () => {
  const metadata = { company: 'Example', title: 'Channel Manager', location: 'Minneapolis, MN' };
  const { registry } = loadAimQuestionRegistry();
  const { policy } = loadAimScoringPolicy(registry);
  const cases: Array<{ questionId: string; invalid: string; valid: string }> = [
    { questionId: 'S1.Q02', invalid: 'The role includes inside sales.', valid: 'Inside sales is the primary responsibility.' },
    { questionId: 'S1.Q04', invalid: 'The role includes outbound prospecting.', valid: 'Outbound direct prospecting is the primary responsibility.' },
    { questionId: 'S1.Q05', invalid: 'The role supports retail stores.', valid: 'Retail store management is the primary responsibility.' },
    { questionId: 'S1.Q06', invalid: 'The employer is an insurer.', valid: 'The direct employer is an insurance agency.' },
    { questionId: 'S1.Q07', invalid: 'The employer develops software.', valid: 'The direct employer is a religious organization.' },
    { questionId: 'S2.F2.Q12', invalid: 'Serve customers, partners, and internal teams.', valid: 'Manage relationships with implementation partners.' },
    { questionId: 'S2.F3.Q3', invalid: 'The role uses AI for personalized outreach.', valid: 'The role has direct responsibility for outbound prospecting.' },
  ];
  const questionGuards = (policy.machineEvidenceGuards as {
    questionGuards: Record<string, unknown>;
  }).questionGuards;
  assert.deepEqual(Object.keys(questionGuards).sort(), cases.map(({ questionId }) => questionId).sort());
  for (const { questionId, invalid, valid } of cases) {
    assert.throws(
      () => validateAimFactualVector({
        vector: vectorWithOriginalEvidence(invalid, metadata, questionId, invalid),
        canonicalOriginalJd: invalid,
        trustedMetadata: metadata,
        registry,
        policy,
      }),
      Error,
      `${questionId} accepted inadequate guard evidence`,
    );
    assert.doesNotThrow(
      () => validateAimFactualVector({
        vector: vectorWithOriginalEvidence(valid, metadata, questionId, valid),
        canonicalOriginalJd: valid,
        trustedMetadata: metadata,
        registry,
        policy,
      }),
      `${questionId} rejected adequate guard evidence`,
    );
  }
});
