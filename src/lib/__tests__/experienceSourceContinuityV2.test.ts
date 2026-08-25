import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { aimSourceJdHash, aimTrustedMetadataHash } from '../aimIdentity';
import { canonicalJson, canonicalJsonSha256 } from '../scoringCanonicalJson';
import { loadCoreEvidenceSnapshot } from '../scoringEvidence';
import { assertExperienceHardRequirementEvidence } from '../experienceScoringPolicy';
import { buildScoringImportPreview } from '../scoringImport';
import { scoringManifestHash } from '../scoringInputBinding';
import { currentScoringInputVersions } from '../scoringInputVersions';

const BATCH_ID = '71111111-1111-4111-8111-111111111111';
const ITEM_ID = '72222222-2222-4222-8222-222222222222';
const JOB_ID = '73333333-3333-4333-8333-333333333333';
const AIM_EVENT_ID = '74444444-4444-4444-8444-444444444444';
const EXTRACTION_ID = '75555555-5555-4555-8555-555555555555';

function fixture(score = 82, hardMismatch = false) {
  const versions = currentScoringInputVersions();
  const evidence = loadCoreEvidenceSnapshot();
  const originalJd = 'Required: channel sales experience. Active CPA license is required. This original-only sentence must remain available.';
  const sourceJdHash = aimSourceJdHash(originalJd);
  const trustedMetadata = { company: 'Example', title: 'Channel Manager', location: 'Minneapolis, MN' };
  const trustedMetadataHash = aimTrustedMetadataHash(trustedMetadata);
  const aimSemanticResultHash = 'a'.repeat(64);
  const inputHash = canonicalJsonSha256({
    kind: 'experience_batch_item_input_v2',
    stage: 'experience',
    protocolVersion: 'career-dashboard-scoring-protocol-v2',
    exportSchemaVersion: 'career-dashboard-experience-export-v2',
    globalInputVersionsHash: versions.experienceInputVersionsHash,
    sourceAimEventId: AIM_EVENT_ID,
    aimFactualExtractionId: EXTRACTION_ID,
    sourceJdHash,
    trustedMetadataHash,
    aimSemanticResultHash,
    resumeHash: versions.resumeHash,
    evidenceHash: versions.evidenceHash,
  });
  const manifestHash = scoringManifestHash({
    batchId: BATCH_ID,
    stage: 'experience',
    schemaVersion: 'career-dashboard-experience-export-v2',
    protocolVersion: 'career-dashboard-scoring-protocol-v2',
    policyVersion: 'experience-policy-v2',
    items: [{ ordinal: 0, jobId: JOB_ID, inputHash }],
  });
  const submittedAt = new Date('2026-08-13T11:00:00.000Z');
  const createdAt = new Date('2026-08-13T10:59:00.000Z');
  const expiresAt = new Date('2026-08-14T10:59:00.000Z');
  const job = {
    jobId: JOB_ID,
    ordinal: 0,
    submittedUpdatedAt: submittedAt.toISOString(),
    sourceAimEventId: AIM_EVENT_ID,
    aimFactualExtractionId: EXTRACTION_ID,
    sourceJdHash,
    originalJd,
    trustedMetadata,
    trustedMetadataHash,
    aimSemanticResultHash,
    inputHash,
  };
  const exportPayload = {
    schemaVersion: 'career-dashboard-experience-export-v2',
    batch: {
      id: BATCH_ID,
      stage: 'experience',
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      protocolVersion: 'career-dashboard-scoring-protocol-v2',
      exportSchemaVersion: 'career-dashboard-experience-export-v2',
      policyVersion: 'experience-policy-v2',
      manifestHash,
    },
    resume: { filename: 'JosephLamb_Resume.docx', hash: versions.resumeHash, extractedText: 'Transport-bound resume text.' },
    evidence,
    jobs: [job],
  };
  const pass1RawOutput = hardMismatch
    ? 'Yes. Active CPA license is required and Joe does not hold one.'
    : 'No hard requirements identified.';
  const result = hardMismatch ? {
    kind: 'evaluation',
    decision: 'hard_requirement_mismatch',
    hardRequirementsNotMet: ['Active CPA license — Joe does not hold one.'],
    hardRequirementEvidence: [{
      requirement: 'Active CPA license — Joe does not hold one.',
      category: 'role_defining_credential',
      source: {
        startCodePoint: originalJd.indexOf('Active CPA license is required.'),
        endCodePoint: originalJd.indexOf('Active CPA license is required.') + 'Active CPA license is required.'.length,
        exactQuote: 'Active CPA license is required.',
      },
      absoluteBarCue: 'required',
      inventoryComparison: 'The exhaustive evidence inventory contains no active CPA credential.',
    }],
    experienceFitScore: 0,
    rationale: pass1RawOutput,
    pass1RawOutput,
    pass2RawOutput: null,
  } : {
    kind: 'evaluation',
    decision: 'scored',
    hardRequirementsNotMet: [],
    experienceFitScore: score,
    rationale: `${score}/100. Strong channel and distributor alignment.`,
    pass1RawOutput,
    pass2RawOutput: `${score}/100. Strong channel and distributor alignment.`,
  };
  const workers = hardMismatch ? [{
    phase: 'experience_hard_gate', model: 'test-model', effort: 'medium',
    promptVersion: 'experience-hard-gate-v1', startedAt: createdAt.toISOString(),
    completedAt: submittedAt.toISOString(), invocationReceipt: 'test-hard-gate',
  }] : [{
    phase: 'experience_hard_gate', model: 'test-model', effort: 'medium',
    promptVersion: 'experience-hard-gate-v1', startedAt: createdAt.toISOString(),
    completedAt: submittedAt.toISOString(), invocationReceipt: 'test-hard-gate',
  }, {
    phase: 'experience_holistic', model: 'test-model', effort: 'high',
    promptVersion: 'experience-holistic-v1', startedAt: createdAt.toISOString(),
    completedAt: submittedAt.toISOString(), invocationReceipt: 'test-holistic',
  }];
  const withoutItemHash = {
    jobId: JOB_ID, ordinal: 0, inputHash,
    sourceAimEventId: AIM_EVENT_ID, aimFactualExtractionId: EXTRACTION_ID,
    sourceJdHash, trustedMetadataHash, aimSemanticResultHash,
    workers, result,
  };
  const resultItem = { ...withoutItemHash, resultHash: canonicalJsonSha256(withoutItemHash) };
  const withoutEnvelopeHash = {
    schemaVersion: 'career-dashboard-experience-result-v2',
    batch: {
      id: BATCH_ID, stage: 'experience', protocolVersion: 'career-dashboard-scoring-protocol-v2',
      exportSchemaVersion: 'career-dashboard-experience-export-v2', policyVersion: 'experience-policy-v2',
      resultSchemaVersion: 'career-dashboard-experience-result-v2', manifestHash,
    },
    resumeHash: versions.resumeHash,
    evidenceHash: versions.evidenceHash,
    runner: {
      runnerVersion: 'career-dashboard-scoring-runner-v2', model: 'test-model', effort: hardMismatch ? 'medium' : 'high',
      promptVersion: 'experience-two-pass-v1', startedAt: createdAt.toISOString(),
      completedAt: submittedAt.toISOString(), invocationReceipt: 'test-runner-receipt',
    },
    results: [resultItem],
  };
  const resultPayload = { ...withoutEnvelopeHash, resultHash: canonicalJsonSha256(withoutEnvelopeHash) };
  const exportJson = canonicalJson(exportPayload);
  const batch = {
    id: BATCH_ID, stage: 'experience', status: 'exported',
    schemaVersion: 'career-dashboard-experience-export-v2',
    protocolVersion: 'career-dashboard-scoring-protocol-v2', policyVersion: 'experience-policy-v2',
    exportHash: canonicalJsonSha256(exportPayload), manifestHash,
    preferenceHash: null, employerOverridesHash: null,
    resumeHash: versions.resumeHash, evidenceHash: versions.evidenceHash,
    inputVersionsHash: versions.experienceInputVersionsHash,
    manifestSnapshot: [{ ordinal: 0, jobId: JOB_ID, inputHash }],
    exportJson, exportByteLength: Buffer.byteLength(exportJson), acceptedResultHash: null,
    createdAt, expiresAt, completedAt: null, releasedAt: null, supersededAt: null, supersededReason: null,
    questionRegistryHash: null, promptContractHash: null, responseContractHash: null,
    runnerProtocolHash: null, packetStrategyHash: null, scoringPolicyHash: null,
    anonymizationPolicyHash: null, resultBuilderSemanticVersion: null,
    items: [{
      id: ITEM_ID, batchId: BATCH_ID, jobId: JOB_ID, stage: 'experience', ordinal: 0,
      status: 'leased', submittedUpdatedAt: submittedAt, sourceJdHash, inputHash,
      inputSnapshot: { ...job, globalInputVersionsHash: versions.experienceInputVersionsHash },
      sourceAimEventId: AIM_EVENT_ID, aimFactualExtractionId: EXTRACTION_ID,
      cleanedArtifactId: null, acceptedResultHash: null, acceptedResultSnapshot: null,
      importedScoreEventId: null, latestPacketPlanHash: null,
      manualRetryOfFailureReceiptId: null, manualRetryReason: null,
      createdAt, importedAt: null, releasedAt: null,
    }],
  };
  return { batch, resultPayload, originalJd };
}

// Dynamic adversarial mutation is the purpose of this boundary test harness.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rehashExperienceResult(payload: Record<string, any>): Record<string, any> {
  const copy = structuredClone(payload);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  copy.results = copy.results.map((raw: Record<string, any>) => {
    const item = { ...raw };
    delete item.resultHash;
    return { ...item, resultHash: canonicalJsonSha256(item) };
  });
  delete copy.resultHash;
  copy.resultHash = canonicalJsonSha256(copy);
  return copy;
}

test('Experience v2 previews a holistic score from plain Terra responses', () => {
  const { batch, resultPayload } = fixture(82);
  const preview = buildScoringImportPreview(batch as never, resultPayload, { now: batch.createdAt });
  assert.equal(preview.applicable, true);
  assert.equal(preview.projections[0].score, 82);
  assert.equal(preview.projections[0].variant, 'scored_survivor');
  assert.equal(JSON.stringify(batch).includes('cleanedText'), false);
});

test('Experience v2 uses the Dashboard threshold after scoring', () => {
  const { batch, resultPayload } = fixture(69);
  const preview = buildScoringImportPreview(batch as never, resultPayload, { now: batch.createdAt });
  assert.equal(preview.projections[0].score, 69);
  assert.equal(preview.projections[0].variant, 'score_below_threshold');
});

test('Experience v2 hard requirement mismatch is a deterministic zero', () => {
  const { batch, resultPayload } = fixture(0, true);
  const preview = buildScoringImportPreview(batch as never, resultPayload, { now: batch.createdAt });
  assert.equal(preview.projections[0].score, 0);
  assert.equal(preview.projections[0].decision, 'hard_requirement_mismatch');
  assert.equal(preview.projections[0].variant, 'hard_requirement_mismatch');
});

test('Experience canonical boundary accepts substantive absolute categories', () => {
  const cases = [
    ['minimum_experience', 'At least 8 years of enterprise sales experience required.', 'At least', 'The exhaustive inventory documents only six years of enterprise sales experience.'],
    ['industry_experience', 'Pharmaceutical industry experience is required.', 'required', 'The exhaustive evidence inventory contains no pharmaceutical industry experience.'],
    ['role_specific_experience', 'Must have experience managing strategic alliances.', 'Must have', 'The exhaustive inventory contains no strategic-alliance management experience.'],
    ['role_defining_credential', 'An active CPA license is required.', 'required', 'The exhaustive evidence inventory contains no active CPA license.'],
  ] as const;
  for (const [category, quote, cue, comparison] of cases) {
    assert.doesNotThrow(() => assertExperienceHardRequirementEvidence({
      originalJd: quote,
      result: {
        decision: 'hard_requirement_mismatch',
        hardRequirementsNotMet: [quote],
        hardRequirementEvidence: [{
          requirement: quote,
          category,
          source: { startCodePoint: 0, endCodePoint: [...quote].length, exactQuote: quote },
          absoluteBarCue: cue,
          inventoryComparison: comparison,
        }],
      },
    }), category);
  }
});

test('Experience canonical boundary rejects excluded requirement families even when mislabeled substantive', () => {
  const excluded = [
    ['Citizenship', 'U.S. citizenship is required.'],
    ['Work authorization', 'Work authorization is required.'],
    ['Physical demand', 'Loading and unloading equipment is required.'],
    ['Subjective skill', 'Strong communication skills are required.'],
    ['Ordinary duty', 'You will be responsible for preparing required weekly reports.'],
    ['Preferred', 'SaaS experience is preferred but not required.'],
  ] as const;
  for (const [label, quote] of excluded) {
    assert.throws(() => assertExperienceHardRequirementEvidence({
      originalJd: quote,
      result: {
        decision: 'hard_requirement_mismatch',
        hardRequirementsNotMet: [quote],
        hardRequirementEvidence: [{
          requirement: quote,
          category: 'role_specific_experience',
          source: { startCodePoint: 0, endCodePoint: [...quote].length, exactQuote: quote },
          absoluteBarCue: 'required',
          inventoryComparison: 'The exhaustive evidence inventory contains no matching experience.',
        }],
      },
    }), /excluded/, label);
  }
});

test('Experience preview fails closed for incomplete or unbound hard-mismatch evidence', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mutations: Array<[string, (result: Record<string, any>) => void, RegExp]> = [
    ['quote', (result) => { delete result.hardRequirementEvidence[0].source; }, /source.*(?:required|object)|structured requirement evidence/],
    ['category', (result) => { delete result.hardRequirementEvidence[0].category; }, /category.*(?:required|non-empty)|structured requirement evidence/],
    ['cue', (result) => { delete result.hardRequirementEvidence[0].absoluteBarCue; }, /absoluteBarCue.*(?:required|non-empty)|structured requirement evidence/],
    ['comparison', (result) => { delete result.hardRequirementEvidence[0].inventoryComparison; }, /inventoryComparison.*(?:required|non-empty)|structured requirement evidence/],
    ['inexact quote', (result) => { result.hardRequirementEvidence[0].source.exactQuote = 'not in the JD'; }, /exact quote|span/i],
    ['vague comparison', (result) => { result.hardRequirementEvidence[0].inventoryComparison = 'not found anywhere here'; }, /too short|insufficient Candidate Evidence Inventory comparison/],
  ];
  for (const [label, mutate, expected] of mutations) {
    const { batch, resultPayload } = fixture(0, true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const changed = structuredClone(resultPayload) as Record<string, any>;
    mutate(changed.results[0].result);
    assert.throws(
      () => buildScoringImportPreview(batch as never, rehashExperienceResult(changed), { now: batch.createdAt }),
      expected,
      label,
    );
  }
});

test('manual preview and transactional apply share the Experience semantic boundary', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/lib/scoringImport.ts'), 'utf8');
  assert.match(source, /previewScoringImport[\s\S]*buildScoringImportPreview\(batch, payload/);
  assert.match(source, /applyScoringImport[\s\S]*buildScoringImportPreview\(batch, payload/);
});
