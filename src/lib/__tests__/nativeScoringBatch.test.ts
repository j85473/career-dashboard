import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MANAGER_PROMPT_VERSION,
  manifestHash,
  NATIVE_SCORING_SCHEMA_VERSION,
  NativeScoringManifest,
  parseNativeScoringChunk,
  parseNativeScoringManifest,
  parseStandardResult,
  parseWildcardResult,
  STANDARD_PROMPT_VERSION,
  WILDCARD_PROMPT_VERSION,
} from '../nativeScoringBatch';

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-07-29T12:00:00.000Z';
const digest = 'a'.repeat(64);

function validManifest(): NativeScoringManifest {
  const unsigned: Omit<NativeScoringManifest, 'manifestHash'> = {
    schemaVersion: NATIVE_SCORING_SCHEMA_VERSION,
    batchId: 'manual_export_test',
    createdAt: timestamp,
    chunkSize: 5,
    model: {
      surface: 'antigravity-native-subagent',
      tier: 'flash',
      expectedModel: 'gemini-3.6-flash',
    },
    prompts: {
      standard: {
        version: STANDARD_PROMPT_VERSION,
        file: '.agents/agents/standard-job-evaluator-v6/agent.md',
        sha256: digest,
      },
      wildcard: {
        version: WILDCARD_PROMPT_VERSION,
        file: '.agents/agents/wildcard-job-evaluator-v6/agent.md',
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
      },
      {
        id: secondId,
        aimFitScore: 10,
        experienceFitScore: 0,
        aimFitReason: 'Wrong function.',
        experienceFitReason: 'No supporting evidence.',
        travelScore: 0,
        evidenceIds: [],
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
});

test('chunk parser requires a closed, versioned 1-5 job input contract', () => {
  const chunk = {
    schemaVersion: NATIVE_SCORING_SCHEMA_VERSION,
    batchId: 'manual_export_test',
    chunkId: 'chunk_0000',
    type: 'standard',
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
});

test('wildcard result parser rejects extra keys and incomplete batches', () => {
  const valid = {
    wildcardScores: [{
      id: firstId,
      vibeFitScore: 88,
      vibeFitReason: 'Strong builder and autonomy signals.',
    }],
  };
  assert.equal(parseWildcardResult(valid, [firstId]).length, 1);
  assert.throws(
    () => parseWildcardResult({
      wildcardScores: [{
        ...valid.wildcardScores[0],
        aimFitScore: 88,
      }],
    }, [firstId]),
    /exactly these keys/,
  );
  assert.throws(
    () => parseWildcardResult(valid, [firstId, secondId]),
    /input order/,
  );
});
