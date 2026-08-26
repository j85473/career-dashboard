import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import canonicalFixture from '../../../tests/fixtures/scoring/canonical-golden-v1.json';
import aimPolicy from '../../../data/scoring/aim-policy-v1.json';
import experiencePolicy from '../../../data/scoring/archive/experience-v1/experience-policy-v1.json';
import {
  assertExactCodePointQuote,
  canonicalJson,
  canonicalJsonSha256,
  normalizeScoringText,
  normalizedTextSha256,
} from '../scoringCanonicalJson';
import {
  deriveCompoundOutcome,
  deriveExperienceDecision,
  preferredExperiencePoints,
  stableCriterionId,
  type ExperienceCriterionSummary,
} from '../scoringCriteria';
import { parseCoreEvidenceMarkdown } from '../scoringEvidence';
import { parseScoringExchangeJson, validateExportManifest } from '../scoringExchange';
import { scoringManifestHash } from '../scoringInputBinding';
import {
  HISTORICAL_AIM_V1_HARD_STOP_CODES as AIM_HARD_STOP_CODES,
  HISTORICAL_AIM_V1_RUBRIC_POINTS as AIM_RUBRIC_POINTS,
  deriveHistoricalAimV1Decision as deriveAimDecision,
  type HistoricalAimV1RubricBands as AimRubricBands,
} from '../historicalAimScoringPolicy';
import { validateCleanedJdArtifact } from '../scoringArtifact';

const HASH = 'a'.repeat(64);
const BATCH_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';

test('canonical JSON fixture is stable and text normalization is source-safe', () => {
  assert.equal(canonicalJson(canonicalFixture.input), canonicalFixture.canonical);
  assert.equal(canonicalJsonSha256(canonicalFixture.input), canonicalFixture.sha256);
  assert.equal(normalizeScoringText('Cafe\u0301\r\nLine'), 'Café\nLine');
  assert.equal(normalizeScoringText('   \t\n'), '   \t\n');
  assert.throws(() => normalizeScoringText('bad\u0000text'), /NUL/);
  assert.throws(() => normalizeScoringText('bad\uD800text'), /valid Unicode/);
  assert.throws(() => canonicalJson({ value: undefined }), /not a JSON value/);
  assert.throws(() => canonicalJson({ value: Number.NaN }), /non-finite/);
});

test('source spans use Unicode code points rather than UTF-16 offsets', () => {
  assert.doesNotThrow(() => assertExactCodePointQuote('A😀BC', { startCodePoint: 1, endCodePoint: 3 }, '😀B'));
  assert.throws(() => assertExactCodePointQuote('A😀BC', { startCodePoint: 1, endCodePoint: 3 }, '😀BC'), /does not match/);
});

test('cleaned artifacts must be the deterministic source-minus-spans reconstruction', () => {
  const source = 'Role 😀. Benefits: snacks. Required: five years.';
  const quote = 'Benefits: snacks. ';
  const startCodePoint = [...source].indexOf('B');
  const span = {
    startCodePoint,
    endCodePoint: startCodePoint + [...quote].length,
    exactQuote: quote,
    classification: 'benefits' as const,
  };
  const cleanedText = 'Role 😀. Required: five years.';
  const artifact = {
    cleanerVersion: 'jd-cleaner-v2',
    sourceJdHash: normalizedTextSha256(source),
    cleanedText,
    cleanedTextHash: normalizedTextSha256(cleanedText),
    removedSpans: [span],
    coverageAudit: { complete: true, findings: [] },
    repairHistory: [],
  };
  assert.doesNotThrow(() => validateCleanedJdArtifact(source, artifact));
  const inconsistent = { ...artifact, cleanedText: 'Role 😀. Required: 5 years.', cleanedTextHash: normalizedTextSha256('Role 😀. Required: 5 years.') };
  assert.throws(() => validateCleanedJdArtifact(source, inconsistent), /exactly the source minus declared spans/);
  const emptySpan = { ...span, endCodePoint: span.startCodePoint, exactQuote: '' };
  assert.throws(() => validateCleanedJdArtifact(source, { ...artifact, removedSpans: [emptySpan] }), /non-empty/);
});

test('historical v1 policy remains isolated for replay and Experience keeps strict credential handling', () => {
  assert.deepEqual(aimPolicy.hardStops.map((entry) => entry.code), AIM_HARD_STOP_CODES);
  assert.equal(aimPolicy.numericGateEnabled, false);
  assert.equal(experiencePolicy.strictRoleDefiningCredential.classification, 'substantive_required');
  assert.equal(experiencePolicy.strictRoleDefiningCredential.missingEvidenceOutcome, 'cannot_evaluate');
  assert.equal(experiencePolicy.strictRoleDefiningCredential.excludeFromEvidenceGapRegister, true);
  assert.equal(experiencePolicy.strictRoleDefiningCredential.rescuable, false);
});

test('historical Aim v1 artifacts still recompute without supplying active Aim authority', () => {
  const emptyHardStops = Object.fromEntries(AIM_HARD_STOP_CODES.map((code) => [code, 'absent'])) as Record<(typeof AIM_HARD_STOP_CODES)[number], 'absent'>;
  let combinations = 0;
  for (const coreWork of Object.keys(AIM_RUBRIC_POINTS.coreWork)) {
    for (const buildingAutonomy of Object.keys(AIM_RUBRIC_POINTS.buildingAutonomy)) {
      for (const productIndustry of Object.keys(AIM_RUBRIC_POINTS.productIndustry)) {
        for (const travel of Object.keys(AIM_RUBRIC_POINTS.travel)) {
          const rubric = { coreWork, buildingAutonomy, productIndustry, travel } as AimRubricBands;
          const result = deriveAimDecision({ hardStops: emptyHardStops, rubric });
          assert.equal(result.aimFitScore,
            Number(AIM_RUBRIC_POINTS.coreWork[coreWork as keyof typeof AIM_RUBRIC_POINTS.coreWork])
            + Number(AIM_RUBRIC_POINTS.buildingAutonomy[buildingAutonomy as keyof typeof AIM_RUBRIC_POINTS.buildingAutonomy])
            + Number(AIM_RUBRIC_POINTS.productIndustry[productIndustry as keyof typeof AIM_RUBRIC_POINTS.productIndustry])
            + Number(AIM_RUBRIC_POINTS.travel[travel as keyof typeof AIM_RUBRIC_POINTS.travel]));
          combinations += 1;
        }
      }
    }
  }
  assert.equal(combinations, 600);
  assert.deepEqual(deriveAimDecision({ hardStops: { ...emptyHardStops, inside_sales: 'present' }, rubric: null }), {
    decision: 'rejected_hard_stop', aimFitScore: null, hardStopCodes: ['inside_sales'],
  });
  assert.throws(() => deriveAimDecision({ hardStops: { ...emptyHardStops, inside_sales: 'present' }, rubric: { coreWork: 'unclear', buildingAutonomy: 'unclear', productIndustry: 'neutral_or_unclear', travel: 'none_or_unstated' } }), /must not carry/);
});

test('compound outcomes and half-up qualified-survivor scoring match policy', () => {
  const leaves = (outcomes: Array<'direct' | 'partial' | 'cannot_evaluate' | 'does_not_meet'>) => outcomes.map((outcome, index) => ({ leafId: `leaf-${index}`, outcome }));
  assert.equal(deriveCompoundOutcome('all', leaves(['direct', 'cannot_evaluate', 'partial'])), 'cannot_evaluate');
  assert.equal(deriveCompoundOutcome('all', leaves(['direct', 'does_not_meet', 'cannot_evaluate'])), 'does_not_meet');
  assert.equal(deriveCompoundOutcome('any', leaves(['does_not_meet', 'cannot_evaluate'])), 'cannot_evaluate');
  assert.equal(deriveCompoundOutcome('any', leaves(['partial', 'does_not_meet'])), 'partial');
  assert.equal(preferredExperiencePoints(['direct', 'partial', 'cannot_evaluate']), 10);
  assert.equal(preferredExperiencePoints([]), 0);

  const criterion = (partial: Partial<ExperienceCriterionSummary> & Pick<ExperienceCriterionSummary, 'criterionId'>): ExperienceCriterionSummary => ({
    classification: 'required', category: 'substantive', operator: 'single', leaves: leaves(['direct']), declaredOutcome: 'direct', ...partial,
  });
  assert.deepEqual(deriveExperienceDecision([]), {
    decision: 'qualified', experienceFitScore: 80, preferredPoints: 0, blockingCriteria: [], explanation: 'no preferred qualifications stated',
  });
  const credentialGap = criterion({ criterionId: 'rn', category: 'role_defining_credential', leaves: leaves(['cannot_evaluate']), declaredOutcome: 'cannot_evaluate' });
  assert.deepEqual(deriveExperienceDecision([credentialGap]).blockingCriteria, [{ criterionId: 'rn', outcome: 'cannot_evaluate' }]);
  assert.equal(deriveExperienceDecision([criterion({ criterionId: 'req' }), criterion({ criterionId: 'pref', classification: 'preferred' })]).experienceFitScore, 100);
  assert.equal(deriveExperienceDecision([criterion({ criterionId: 'admin', category: 'administrative', leaves: leaves(['cannot_evaluate']), declaredOutcome: 'excluded' })]).experienceFitScore, 80);
});

test('criterion IDs bind input, classification, and source code-point span', () => {
  const id = stableCriterionId(HASH, 'required', 3, 9);
  assert.match(id, /^criterion-[a-f0-9]{32}$/);
  assert.notEqual(id, stableCriterionId(HASH, 'preferred', 3, 9));
  assert.notEqual(id, stableCriterionId(HASH, 'required', 4, 9));
});

test('Core Evidence parses from the authoritative Markdown with stable hashes', () => {
  const markdown = fs.readFileSync('docs/Candidate_Evidence_Inventory_-_Core_v1.md', 'utf8');
  const snapshot = parseCoreEvidenceMarkdown(markdown);
  assert.equal(snapshot.sourceHash, '2b461eb4b282dcb58bc8178cb8370d440f14faca3e60530799a357c30e771120');
  assert.ok(snapshot.records.length >= 20);
  assert.equal(new Set(snapshot.records.map((record) => record.evidenceId)).size, snapshot.records.length);
  assert.equal(snapshot.records.find((record) => record.evidenceId === 'DSI-001')?.roleTitle, 'Field Sales Representative — Channel Sales');
  assert.match(snapshot.records.find((record) => record.evidenceId === 'DSI-003')?.scopeNotes || '', /Do not imply that Joseph.*formally owned the Costco account/i);
  assert.match(snapshot.records.find((record) => record.evidenceId === 'DSI-011')?.scopeNotes || '', /one specific fraud type/i);
  assert.match(snapshot.records.find((record) => record.evidenceId === 'DSI-022')?.evidenceText || '', /active base of 1,000\+ partner users.*at any given time/i);
  assert.match(snapshot.records.find((record) => record.evidenceId === 'DSI-022')?.scopeNotes || '', /not a cumulative six-year total/i);
  assert.match(snapshot.records.find((record) => record.evidenceId === 'DSI-025')?.evidenceText || '', /exceeding a formal 15% annual territory-growth quota for six straight years/i);
  assert.match(snapshot.records.find((record) => record.evidenceId === 'DSI-026')?.evidenceText || '', /supporting the conservative public figure \$26M\+/i);
});

test('Aim export parser rejects unknown keys and validates exact ordered manifest membership', () => {
  const batchBase = {
    id: BATCH_ID, stage: 'aim', createdAt: '2026-08-12T16:00:00.000Z', expiresAt: '2026-08-13T16:00:00.000Z',
    protocolVersion: 'career-dashboard-scoring-protocol-v1', policyVersion: 'aim-policy-v1',
  };
  const jobs = [{
    jobId: JOB_ID, ordinal: 0, submittedUpdatedAt: '2026-08-12T15:00:00.000Z', company: 'Example', title: 'Channel Manager', location: 'Minneapolis, MN', sourceUrl: null,
    originalJd: 'Build and grow a partner channel.', sourceJdHash: HASH, metadataHash: HASH, inputHash: HASH,
  }];
  const manifestHash = scoringManifestHash({
    batchId: BATCH_ID, stage: 'aim', schemaVersion: 'career-dashboard-aim-export-v1', protocolVersion: batchBase.protocolVersion,
    policyVersion: batchBase.policyVersion, items: [{ ordinal: 0, jobId: JOB_ID, inputHash: HASH }],
  });
  const payload = { schemaVersion: 'career-dashboard-aim-export-v1', batch: { ...batchBase, manifestHash }, preferences: { policyHash: HASH, employerOverridesHash: HASH, employerOverrides: {} }, jobs };
  const parsed = parseScoringExchangeJson(JSON.stringify(payload));
  assert.doesNotThrow(() => validateExportManifest(parsed));
  assert.throws(() => parseScoringExchangeJson(JSON.stringify({ ...payload, unexpected: true })), /not allowed/);
  assert.throws(() => parseScoringExchangeJson(JSON.stringify({ ...payload, jobs: [{ ...jobs[0], ordinal: 1 }] })), /invalid ordinal/);
  const mismatched = parseScoringExchangeJson(JSON.stringify({ ...payload, batch: { ...payload.batch, manifestHash: HASH } }));
  assert.throws(() => validateExportManifest(mismatched), /manifestHash mismatch/);
});
