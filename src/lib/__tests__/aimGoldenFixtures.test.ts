import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import {
  aimBatchItemInputHash,
  aimExtractionIdentity,
  aimSourceIdentity,
  aimSourceJdHash,
  aimTrustedMetadataHash,
} from '../aimIdentity';
import { loadAimQuestionRegistry } from '../aimQuestionRegistry';
import {
  MAX_SCORING_EXCHANGE_BYTES,
  parseScoringExchangeJson,
  validateResultAgainstExport,
} from '../scoringExchange';
import { aimV2ManifestHash } from '../scoringInputBinding';

const ROOT = 'tests/fixtures/scoring/aim-v2';

function bytes(name: string): Buffer {
  return readFileSync(`${ROOT}/${name}`);
}

function json(name: string): Record<string, unknown> {
  return JSON.parse(bytes(name).toString('utf8')) as Record<string, unknown>;
}

test('required Aim v2 golden fixtures exist and every exchange replays against its export', () => {
  const required = [
    'valid-export.json', 'valid-stage1-kill-result.json', 'valid-local-policy-kill-result.json',
    'valid-low-compensation-scored-result.json', 'valid-scored-result.json', 'valid-mixed-result.json',
    'invalid-evidence-missing-quote.json', 'invalid-evidence-paraphrase.json',
    'valid-evidence-duplicate-all-occurrences.json', 'invalid-evidence-duplicate-inadequate-context.json',
    'invalid-evidence-unauthorized-metadata.json', 'identity-parity-vectors.json',
    'privacy-render-stage1.txt', 'privacy-render-stage2.txt', 'compensation-cases.json',
    'travel-cases.json', 'overlap-dedup-vectors.json', 'monotonicity-vectors.json',
    'observed-24d-provenance.json', 'observed-8254-mixed-provenance.json',
  ];
  const present = new Set(readdirSync(ROOT));
  for (const name of required) assert.ok(present.has(name), `missing ${name}`);

  const pairs = [
    ['valid-scored-result.json', 'valid-export.json', ['scored_survivor']],
    ['valid-local-policy-kill-result.json', 'valid-local-policy-kill-export.json', ['local_policy_kill']],
    ['valid-stage1-kill-result.json', 'valid-stage1-kill-export.json', ['factual_screen_kill']],
    ['valid-low-compensation-scored-result.json', 'valid-low-compensation-scored-export.json', ['scored_survivor']],
    ['valid-mixed-result.json', 'valid-mixed-export.json', ['scored_survivor', 'safe_failure']],
  ] as const;
  for (const [resultName, exportName, variants] of pairs) {
    const result = parseScoringExchangeJson(bytes(resultName));
    const exported = parseScoringExchangeJson(bytes(exportName));
    assert.doesNotThrow(() => validateResultAgainstExport(result, exported), resultName);
    assert.deepEqual(
      (result.results as Array<{ result: { variant: string } }>).map((item) => item.result.variant),
      variants,
    );
  }
});

test('adversarial evidence fixtures encode exact occurrence and authority failures', () => {
  const missing = json('invalid-evidence-missing-quote.json');
  assert.equal(missing.answer, 'yes');
  assert.deepEqual(missing.supportingText, []);

  const paraphrase = json('invalid-evidence-paraphrase.json');
  assert.equal(String(paraphrase.source).includes((paraphrase.supportingText as string[])[0]), false);

  const duplicate = json('valid-evidence-duplicate-all-occurrences.json');
  assert.deepEqual(duplicate.expectedOccurrences, [
    { startCodePoint: 0, endCodePoint: 18 },
    { startCodePoint: 19, endCodePoint: 37 },
  ]);
  assert.equal(String(duplicate.source).split(String((duplicate.supportingText as string[])[0])).length - 1, 2);

  const inadequate = json('invalid-evidence-duplicate-inadequate-context.json');
  assert.equal(String(inadequate.expectedError).includes('majority-work'), true);

  const unauthorized = json('invalid-evidence-unauthorized-metadata.json');
  const { registry } = loadAimQuestionRegistry();
  const question = registry.questions.find((candidate) => candidate.id === unauthorized.questionId)!;
  assert.equal(question.allowedMetadataFields.includes('company'), false);
  assert.equal((unauthorized.supportingText as string[])[0], (unauthorized.trustedMetadata as { company: string }).company);
});

test('case-vector fixtures cover the declared compensation, travel, overlap, and monotonicity edges', () => {
  const compensationIds = new Set((json('compensation-cases.json').cases as Array<{ id: string }>).map((item) => item.id));
  for (const id of ['exact-floor', 'below-exhaustive', 'base-only-low', 'ote-only-low', 'uncapped-variable',
    'non-usd', 'bare-dollar', 'monthly', 'weekly', 'equity-only', 'sign-on-only', 'location-conflict']) {
    assert.ok(compensationIds.has(id), `missing compensation case ${id}`);
  }
  const travelIds = new Set((json('travel-cases.json').cases as Array<{ id: string }>).map((item) => item.id));
  for (const id of ['up-to-zero', 'up-to-fifty', 'twenty-to-fifty', 'at-least', 'three-clauses',
    'no-travel-conflict', 'frequent', 'periodic', 'as-needed', 'occasional', 'unknown-adjective',
    'global', 'north-american', 'national', 'regional', 'local']) {
    assert.ok(travelIds.has(id), `missing travel case ${id}`);
  }
  assert.equal((json('overlap-dedup-vectors.json').cases as unknown[]).length, 3);
  assert.equal((json('monotonicity-vectors.json').pairs as unknown[]).length, 3);
});

test('observed provenance fixtures are hash-only and contain no copied source material', () => {
  const allowed = new Set([
    'schemaVersion', 'batchId', 'sourceFilesCopied', 'exportFileSha256', 'resultFileSha256',
    'manifestHash', 'resultHash', 'counts', 'scoreRange', 'failureCodes',
  ]);
  for (const name of ['observed-24d-provenance.json', 'observed-8254-mixed-provenance.json']) {
    const value = json(name);
    assert.equal(value.sourceFilesCopied, false);
    assert.ok(Object.keys(value).every((key) => allowed.has(key)), `${name} contains an unapproved top-level field`);
    const serialized = JSON.stringify(value).toLocaleLowerCase('en-US');
    for (const forbidden of ['originaljd', 'supportingtext', 'exactquote', 'company', 'title', 'resume']) {
      assert.equal(serialized.includes(forbidden), false, `${name} contains ${forbidden}`);
    }
  }
});

function reboundExport(source: string, members = 1): Record<string, unknown> {
  const exported = structuredClone(json('valid-export.json')) as {
    schemaVersion: string;
    batch: Record<string, string>;
    jobs: Array<Record<string, unknown>>;
  };
  const template = exported.jobs[0];
  exported.jobs = Array.from({ length: members }, (_, ordinal) => {
    const job = structuredClone(template) as Record<string, unknown>;
    const metadata = job.trustedMetadata as { company: string; title: string; location: string | null };
    const sourceJdHash = aimSourceJdHash(source);
    const trustedMetadataHash = aimTrustedMetadataHash(metadata);
    const sourceIdentity = aimSourceIdentity(sourceJdHash, trustedMetadataHash);
    const extractionIdentity = aimExtractionIdentity({
      sourceIdentity,
      questionRegistryVersion: exported.batch.questionRegistryVersion,
      questionRegistryHash: exported.batch.questionRegistryHash,
      promptContractVersion: exported.batch.promptContractVersion,
      promptContractHash: exported.batch.promptContractHash,
      responseContractVersion: exported.batch.responseContractVersion,
      responseContractHash: exported.batch.responseContractHash,
      packetStrategyVersion: exported.batch.packetStrategyVersion,
      packetStrategyHash: exported.batch.packetStrategyHash,
      canonicalizationVersion: exported.batch.canonicalizationVersion,
      anonymizationPolicyVersion: exported.batch.anonymizationPolicyVersion,
      anonymizationPolicyHash: exported.batch.anonymizationPolicyHash,
      extractorSemanticVersion: exported.batch.extractorSemanticVersion,
    });
    const inputHash = aimBatchItemInputHash({
      protocolVersion: exported.batch.protocolVersion,
      exportSchemaVersion: exported.batch.exportSchemaVersion,
      sourceIdentity,
      extractionIdentity,
      scoringPolicyHash: exported.batch.scoringPolicyHash,
      runnerProtocolHash: exported.batch.runnerProtocolHash,
    });
    return {
      ...job,
      jobId: `22222222-2222-4222-8222-${String(ordinal + 2).padStart(12, '0')}`,
      ordinal,
      inputHash,
      source: { originalJd: source, sourceJdHash },
      trustedMetadataHash,
      sourceIdentity,
      extractionIdentity,
      reuse: null,
    };
  });
  exported.batch.manifestHash = aimV2ManifestHash({
    batchId: exported.batch.id,
    protocolVersion: exported.batch.protocolVersion,
    exportSchemaVersion: exported.batch.exportSchemaVersion,
    scoringPolicyVersion: exported.batch.scoringPolicyVersion,
    questionRegistryHash: exported.batch.questionRegistryHash,
    promptContractHash: exported.batch.promptContractHash,
    responseContractHash: exported.batch.responseContractHash,
    packetStrategyHash: exported.batch.packetStrategyHash,
    items: exported.jobs.map((job) => ({
      ordinal: job.ordinal as number,
      jobId: job.jobId as string,
      inputHash: job.inputHash as string,
    })),
  });
  return exported;
}

test('Aim v2 exchange boundaries accept exact maxima and reject one-over inputs', () => {
  assert.doesNotThrow(() => parseScoringExchangeJson(JSON.stringify(reboundExport('x'.repeat(1_500_000)))));
  assert.throws(() => parseScoringExchangeJson(JSON.stringify(reboundExport('x'.repeat(1_500_001)))), /too long/);
  assert.doesNotThrow(() => parseScoringExchangeJson(JSON.stringify(reboundExport('bounded source', 30))));
  assert.throws(() => parseScoringExchangeJson(JSON.stringify(reboundExport('bounded source', 31))), /too many items/);
  assert.throws(() => parseScoringExchangeJson(Buffer.alloc(MAX_SCORING_EXCHANGE_BYTES + 1)), /32 MiB/);
});
