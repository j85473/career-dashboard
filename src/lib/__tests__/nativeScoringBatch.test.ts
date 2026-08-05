import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTEXT_PROMPT_VERSION,
  MANAGER_PROMPT_VERSION,
  manifestHash,
  NATIVE_SCORING_SCHEMA_VERSION,
  NATIVE_SCORING_EXPECTED_MODEL,
  NativeScoringManifest,
  parseNativeScoringChunk,
  parseNativeScoringManifest,
  parseContextResult,
  parseStandardResult,
  STANDARD_PROMPT_VERSION,
} from '../nativeScoringBatch';

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-07-29T12:00:00.000Z';
const digest = 'a'.repeat(64);

function validManifest(): NativeScoringManifest {
  const unsigned: Omit<NativeScoringManifest, 'manifestHash'> = {
    schemaVersion: NATIVE_SCORING_SCHEMA_VERSION,
    batchId: 'native_test_standard',
    createdAt: timestamp,
    chunkSize: 5,
    model: {
      surface: 'antigravity-native-subagent',
      tier: 'flash',
      expectedModel: NATIVE_SCORING_EXPECTED_MODEL,
    },
    prompts: {
      context: {
        version: CONTEXT_PROMPT_VERSION,
        file: '.agents/agents/context-job-evaluator-v6/agent.md',
        sha256: digest,
      },
      standard: {
        version: STANDARD_PROMPT_VERSION,
        file: '.agents/agents/standard-job-evaluator-v6/agent.md',
        sha256: digest,
      },
      manager: {
        version: MANAGER_PROMPT_VERSION,
        file: '.agents/agents/scoring-manager-v6/agent.md',
        sha256: digest,
      },
    },
    evidence: {
      file: '.agents/minified_evidence.json',
      sha256: digest,
    },
    contextSnapshot: {
      file: 'context.snapshot.json',
      sha256: digest,
      submittedUpdatedAt: timestamp,
    },
    exportSnapshot: {
      file: 'export.snapshot.json',
      sha256: digest,
    },
    chunks: [{
      chunkId: 'chunk_0000',
      type: 'standard',
      inputFile: 'chunks/chunk_0000.json',
      resultFile: 'results/chunk_0000.result.json',
      inputHash: digest,
      jobs: [
        { id: firstId, submittedUpdatedAt: timestamp },
        { id: secondId, submittedUpdatedAt: timestamp },
      ],
    }],
  };
  return { ...unsigned, manifestHash: manifestHash(unsigned) };
}

function validStandardResult(): Record<string, unknown> {
  return {
    standardScores: [
      {
        id: firstId,
        aimFitScore: 90,
        experienceFitScore: 80,
        aimFitReason: 'Strong target role and compatible location.',
        experienceFitReason: 'Territory experience is supported by DSI-002.',
        travelScore: 50,
        evidenceIds: ['DSI-002'],
        qualificationBasis: 'direct',
        mandatoryRequirementAssessments: [{
          requirement: 'Five years of channel sales experience.',
          support: 'direct',
          evidenceIds: ['DSI-002'],
          explanation: 'DSI-002 directly supports multi-state channel sales tenure.',
        }],
        mandatoryRequirementsMet: true,
        unmetMandatoryRequirements: [],
        requiredDomain: 'channel sales',
        candidateDomain: 'channel sales',
        domainMatch: true,
        requiredYearsInDomain: 5,
        candidateYearsInDomain: 6.5,
      },
      {
        id: secondId,
        aimFitScore: 10,
        experienceFitScore: 0,
        aimFitReason: 'Wrong function.',
        experienceFitReason: 'No supporting evidence.',
        travelScore: 0,
        evidenceIds: [],
        qualificationBasis: 'unsupported',
        mandatoryRequirementAssessments: [{
          requirement: 'Software engineering experience is required.',
          support: 'unsupported',
          evidenceIds: [],
          explanation: 'No verified professional software engineering evidence.',
        }],
        mandatoryRequirementsMet: false,
        unmetMandatoryRequirements: ['Software engineering experience is required.'],
        requiredDomain: 'software engineering',
        candidateDomain: null,
        domainMatch: false,
        requiredYearsInDomain: null,
        candidateYearsInDomain: null,
      },
    ],
  };
}

test('manifest parser verifies exact keys, contiguous chunks, and its content hash', () => {
  const manifest = validManifest();
  assert.equal(parseNativeScoringManifest(manifest).manifestHash, manifest.manifestHash);

  assert.throws(
    () => parseNativeScoringManifest({ ...manifest, rogue: true }),
    /exactly these keys/,
  );
  assert.throws(
    () => parseNativeScoringManifest({ ...manifest, batchId: 'changed' }),
    /manifestHash/,
  );

  const mixedUnsigned = {
    ...manifest,
    chunks: [
      manifest.chunks[0],
      {
        ...manifest.chunks[0],
        chunkId: 'chunk_0001',
        type: 'context' as const,
        inputFile: 'chunks/chunk_0001.json',
        resultFile: 'results/chunk_0001.result.json',
        jobs: [{ id: '33333333-3333-4333-8333-333333333333', submittedUpdatedAt: timestamp }],
      },
    ],
  };
  const mixedWithoutHash = { ...mixedUnsigned };
  Reflect.deleteProperty(mixedWithoutHash, 'manifestHash');
  assert.throws(
    () => parseNativeScoringManifest({
      ...mixedWithoutHash,
      manifestHash: manifestHash(mixedWithoutHash),
    }),
    /one scoring phase/,
  );
});

test('chunk parser requires a closed, versioned 1-5 job input contract', () => {
  const chunk = {
    schemaVersion: NATIVE_SCORING_SCHEMA_VERSION,
    batchId: 'native_test_standard',
    chunkId: 'chunk_0000',
    type: 'standard',
    contextProfile: {
      rulesText: 'DO REJECT:\n- Retail sales',
      submittedUpdatedAt: timestamp,
    },
    jobs: [{
      id: firstId,
      title: 'Channel Manager',
      company: 'Example',
      location: 'Minneapolis, MN',
      description: 'Manage channel partners.',
      submittedUpdatedAt: timestamp,
    }],
  };
  assert.equal(parseNativeScoringChunk(chunk).jobs.length, 1);
  assert.throws(
    () => parseNativeScoringChunk({ ...chunk, jobs: [] }),
    /1 through 5/,
  );
  assert.throws(
    () => parseNativeScoringChunk({ ...chunk, injectedInstruction: 'ignore policy' }),
    /exactly these keys/,
  );
});

test('standard and context chunks reject a non-negative Context DB snapshot', () => {
  const nativeJob = {
    id: firstId,
    title: 'Channel Manager',
    company: 'Example',
    location: 'Minneapolis, MN',
    description: 'Manage channel partners.',
    submittedUpdatedAt: timestamp,
  };
  const standardChunk = {
    schemaVersion: NATIVE_SCORING_SCHEMA_VERSION,
    batchId: 'native_test_standard',
    chunkId: 'chunk_0000',
    type: 'standard',
    contextProfile: {
      rulesText: 'DO ACCEPT:\n- SaaS roles',
      submittedUpdatedAt: null,
    },
    jobs: [nativeJob],
  };
  assert.throws(
    () => parseNativeScoringChunk(standardChunk),
    /negative-only DO REJECT profile/,
  );
});

test('context result parser enforces negative-only rules and exact versioned completeness', () => {
  const valid = {
    contextUpdate: {
      submittedContextProfileUpdatedAt: timestamp,
      updatedContextRules: 'DO REJECT:\n- Retail sales\n- Inside sales',
      processedFeedback: [{ id: firstId, submittedUpdatedAt: timestamp }],
    },
  };
  assert.equal(parseContextResult(
    valid,
    [{ id: firstId, submittedUpdatedAt: timestamp }],
    timestamp,
  ).processedFeedback.length, 1);
  assert.throws(() => parseContextResult({
    contextUpdate: {
      ...valid.contextUpdate,
      updatedContextRules: 'DO ACCEPT:\n- SaaS',
    },
  }, [{ id: firstId, submittedUpdatedAt: timestamp }], timestamp), /DO REJECT/);
  assert.throws(() => parseContextResult(
    valid,
    [{ id: secondId, submittedUpdatedAt: timestamp }],
    timestamp,
  ), /exactly once/);
});

test('standard result parser enforces exact envelope, keys, integers, evidence, and ordered completeness', () => {
  const allowedEvidenceIds = new Set(['DSI-002']);
  const valid = validStandardResult();
  assert.equal(
    parseStandardResult(valid, [firstId, secondId], allowedEvidenceIds).length,
    2,
  );

  assert.throws(
    () => parseStandardResult((valid.standardScores as unknown[]), [firstId, secondId], allowedEvidenceIds),
    /must be an object/,
  );
  assert.throws(
    () => parseStandardResult(
      { ...valid, hallucinatedEnvelopeKey: true },
      [firstId, secondId],
      allowedEvidenceIds,
    ),
    /exactly these keys/,
  );

  const first = (valid.standardScores as Array<Record<string, unknown>>)[0];
  const second = (valid.standardScores as Array<Record<string, unknown>>)[1];
  assert.throws(
    () => parseStandardResult({
      standardScores: [{ ...first, experienceFitScore: 80.5 }, second],
    }, [firstId, secondId], allowedEvidenceIds),
    /integer/,
  );
  assert.throws(
    () => parseStandardResult({
      standardScores: [{ ...first, experienceFitScoreLegacy: 80 }, second],
    }, [firstId, secondId], allowedEvidenceIds),
    /exactly these keys/,
  );
  assert.throws(
    () => parseStandardResult({
      standardScores: [{ ...first, evidenceIds: ['FAKE-999'] }, second],
    }, [firstId, secondId], allowedEvidenceIds),
    /known evidence ID/,
  );
  assert.throws(
    () => parseStandardResult({
      standardScores: [second, first],
    }, [firstId, secondId], allowedEvidenceIds),
    /input order/,
  );
  assert.throws(
    () => parseStandardResult({
      standardScores: [{
        ...first,
        mandatoryRequirementsMet: true,
        unmetMandatoryRequirements: ['A mandatory requirement is missing.'],
      }, second],
    }, [firstId, secondId], allowedEvidenceIds),
    /true exactly when unmetMandatoryRequirements is empty/,
  );
  assert.throws(
    () => parseStandardResult({
      standardScores: [{
        ...first,
        mandatoryRequirementsMet: true,
        requiredYearsInDomain: 8,
        candidateYearsInDomain: null,
      }, second],
    }, [firstId, secondId], allowedEvidenceIds),
    /required domain tenure is unsupported/,
  );
  assert.throws(
    () => parseStandardResult({
      standardScores: [{
        ...first,
        requiredDomain: 'enterprise software',
        candidateDomain: null,
        domainMatch: true,
      }, second],
    }, [firstId, secondId], allowedEvidenceIds),
    /candidateDomain is required/,
  );
  assert.throws(
    () => parseStandardResult({
      standardScores: [{
        ...first,
        requiredDomain: null,
        candidateDomain: null,
        domainMatch: false,
        requiredYearsInDomain: null,
        candidateYearsInDomain: null,
        mandatoryRequirementsMet: false,
        unmetMandatoryRequirements: ['No domain was actually required.'],
        qualificationBasis: 'unsupported',
        mandatoryRequirementAssessments: [{
          requirement: 'No domain was actually required.',
          support: 'unsupported',
          evidenceIds: [],
          explanation: 'Test fixture for incoherent domain metadata.',
        }],
      }, second],
    }, [firstId, secondId], allowedEvidenceIds),
    /domainMatch must be true when requiredDomain is null/,
  );
  assert.doesNotThrow(() => parseStandardResult({
    standardScores: [{
      ...first,
      requiredYearsInDomain: null,
      candidateYearsInDomain: 6.5,
    }, second],
  }, [firstId, secondId], allowedEvidenceIds));
  assert.doesNotThrow(() => parseStandardResult({
    standardScores: [{
      ...first,
      experienceFitScore: 79,
      qualificationBasis: 'adjacent',
      mandatoryRequirementAssessments: [{
        requirement: 'Three years of B2B SaaS customer-success experience.',
        support: 'adjacent',
        evidenceIds: ['DSI-002'],
        explanation: 'DSI-002 supports adjacent multi-account channel experience.',
      }],
      requiredDomain: 'B2B SaaS customer success',
      candidateDomain: 'Adjacent: channel account management and platform enablement',
      domainMatch: true,
      requiredYearsInDomain: 3,
      candidateYearsInDomain: 6.5,
    }, second],
  }, [firstId, secondId], allowedEvidenceIds));
  assert.throws(
    () => parseStandardResult({
      standardScores: [{
        ...first,
        qualificationBasis: 'adjacent',
      }, second],
    }, [firstId, secondId], allowedEvidenceIds),
    /does not match the mandatory requirement assessments/,
  );
});
