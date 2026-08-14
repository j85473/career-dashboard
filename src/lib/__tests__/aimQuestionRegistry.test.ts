import assert from 'node:assert/strict';
import test from 'node:test';

import crosswalk from '../../../data/scoring/aim-question-crosswalk-v2.json';
import registrySource from '../../../data/scoring/aim-question-registry-v2.json';
import { validateAimStage2Projection } from '../aimQuestionProjection';
import { loadAimQuestionRegistry, validateAimQuestionRegistry } from '../aimQuestionRegistry';
import { loadAimScoringPolicy } from '../aimScoringPolicy';
import { canonicalJsonSha256 } from '../scoringCanonicalJson';

test('Aim v2 registry is exact, unique, immutable, and hash-bound', () => {
  const loaded = loadAimQuestionRegistry();
  assert.equal(loaded.questionRegistryHash, '8813d7c352d003953142ede9af7faf31f74d8f56bd4b304db7d299ef8f54d046');
  assert.equal(loaded.registry.questions.filter((question) => question.privatePhase === 'stage1').length, 7);
  assert.equal(loaded.registry.questions.filter((question) => question.privatePhase === 'stage2').length, 342);
  assert.equal(new Set(loaded.registry.questions.map((question) => question.id)).size, 349);
  assert.equal(new Set(loaded.registry.questions.map((question) => question.wording)).size, 349);
  assert.equal(loaded.registry.questions.every((question) => (
    question.evidenceRule.yes.minimumExactExcerpts === 1
    && question.evidenceRule.no.maximumExactExcerpts === 0
    && question.evidenceRule.unsupported.maximumExactExcerpts === 0
  )), true);
  assert.equal(Object.isFrozen(loaded.registry), true);
  assert.equal(Object.isFrozen(loaded.registry.questions[0]), true);
  assert.throws(() => loadAimQuestionRegistry('f'.repeat(64)), /hash mismatch/);
});

test('Aim v2 registry rejects duplicated wording and widened metadata authority', () => {
  const duplicate = structuredClone(registrySource);
  duplicate.questions[1].wording = duplicate.questions[0].wording;
  assert.throws(() => validateAimQuestionRegistry(duplicate), /duplicate Aim question wording/);

  const widened = structuredClone(registrySource);
  widened.questions.find((question) => question.id === 'S2.F1.Q1')!.allowedMetadataFields = ['title'];
  assert.throws(() => validateAimQuestionRegistry(widened), /invalid metadata authorization/);
});

test('Aim v2 crosswalk accounts for all original atomics and three approved industry distinctions exactly once', () => {
  const { registry } = loadAimQuestionRegistry();
  const { policy } = loadAimScoringPolicy(registry);
  assert.equal(canonicalJsonSha256(crosswalk), 'a978a9ef4d16231dd215ed63c885e7246dbc2d842668bf1545987071e878d4b3');
  assert.equal(crosswalk.sourceQuestionBankVersion, 'aim-stage2-question-bank-342-v1');
  assert.equal(crosswalk.targetQuestionRegistryVersion, registry.questionRegistryVersion);
  assert.equal(crosswalk.entries.length, 342);
  assert.equal(new Set(crosswalk.entries.map((entry) => entry.sourceId)).size, 342);
  assert.deepEqual(
    Object.fromEntries(['keep', 'merge', 'replace', 'remove'].map((disposition) => [
      disposition,
      crosswalk.entries.filter((entry) => entry.disposition === disposition).length,
    ])),
    crosswalk.expectedDispositionCounts,
  );
  const stage2Ids = new Set(
    registry.questions.filter((question) => question.privatePhase === 'stage2').map((question) => question.id),
  );
  for (const entry of crosswalk.entries) {
    assert.ok(stage2Ids.has(entry.sourceId), `${entry.sourceId} is not a Stage 2 source question`);
    assert.equal(new Set(entry.targetIds).size, entry.targetIds.length, `${entry.sourceId} repeats a target`);
    assert.equal(entry.disposition === 'remove', entry.targetIds.length === 0, `${entry.sourceId} has invalid target cardinality`);
    for (const targetId of entry.targetIds) assert.match(targetId, /^S2\.(?:CML|BA|LI|TX|SC|PD|CP|TR)\.Q\d{2}$/u);
  }
  assert.deepEqual(new Set(crosswalk.entries.map((entry) => entry.sourceId)), stage2Ids);
  const targeted = new Set(crosswalk.entries.flatMap((entry) => entry.targetIds));
  assert.equal(targeted.size, 153);
  assert.deepEqual(policy.stage2Projection.derivedOnlyQuestionIds, [
    'S2.CML.Q18', 'S2.CML.Q24', 'S2.BA.Q23', 'S2.BA.Q24',
  ]);
  assert.equal(validateAimStage2Projection(registry, policy).size, 157);
});
