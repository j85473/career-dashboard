import crosswalkSource from '../../data/scoring/aim-question-crosswalk-v2.json';

import { canonicalJsonSha256 } from './scoringCanonicalJson';
import type {
  AimFactualAnswer,
  AimFactualVector,
  AimQuestionRegistry,
  AimScoringPolicy,
} from './aimV2Types';

type CrosswalkEntry = {
  sourceId: string;
  disposition: 'keep' | 'merge' | 'replace' | 'remove';
  targetIds: string[];
  rationale: string;
};

type QuestionCrosswalk = {
  schemaVersion: string;
  sourceQuestionBankVersion: string;
  targetQuestionRegistryVersion: string;
  expectedDispositionCounts: Record<string, number>;
  entries: CrosswalkEntry[];
};

const crosswalk = crosswalkSource as QuestionCrosswalk;
const DERIVED_ID = /^S2\.(?:CML|BA|LI|TX|SC|PD|CP|TR)\.Q[0-9]{2}$/;

function derivedIds(policy: AimScoringPolicy): string[] {
  return [...new Set([
    ...crosswalk.entries.flatMap((entry) => entry.targetIds),
    ...policy.stage2Projection.derivedOnlyQuestionIds,
  ])].sort();
}

export function validateAimStage2Projection(
  registry: AimQuestionRegistry,
  policy: AimScoringPolicy,
): ReadonlySet<string> {
  if (crosswalk.schemaVersion !== policy.stage2Projection.crosswalkSchemaVersion
    || canonicalJsonSha256(crosswalk) !== policy.stage2Projection.crosswalkHash) {
    throw new Error('Aim Stage 2 projection crosswalk does not match policy authority');
  }
  if (crosswalk.entries.length !== policy.stage2Projection.sourceQuestionCount) {
    throw new Error('Aim Stage 2 projection has the wrong source-question count');
  }
  const stage2Ids = new Set(
    registry.questions.filter((question) => question.privatePhase === 'stage2').map((question) => question.id),
  );
  const sourceIds = new Set<string>();
  for (const entry of crosswalk.entries) {
    if (!stage2Ids.has(entry.sourceId)) throw new Error(`Aim projection references unknown source ${entry.sourceId}`);
    if (sourceIds.has(entry.sourceId)) throw new Error(`Aim projection repeats source ${entry.sourceId}`);
    sourceIds.add(entry.sourceId);
    if (entry.disposition === 'remove' ? entry.targetIds.length !== 0 : entry.targetIds.length === 0) {
      throw new Error(`Aim projection disposition is inconsistent at ${entry.sourceId}`);
    }
    for (const target of entry.targetIds) {
      if (!DERIVED_ID.test(target)) throw new Error(`Aim projection has invalid derived fact ${target}`);
    }
  }
  if (sourceIds.size !== stage2Ids.size || sourceIds.size !== policy.stage2Projection.sourceQuestionCount) {
    throw new Error('Aim projection does not cover the complete Stage 2 source bank');
  }
  const targets = derivedIds(policy);
  if (targets.length !== policy.stage2Projection.derivedQuestionCount) {
    throw new Error('Aim Stage 2 projection has the wrong derived-fact count');
  }
  return new Set(targets);
}

export function sourceQuestionIdsForDerivedFact(targetId: string): string[] {
  return crosswalk.entries
    .filter((entry) => entry.targetIds.includes(targetId))
    .map((entry) => entry.sourceId);
}

export function projectAimFactualVectorForScoring(
  vector: AimFactualVector,
  registry: AimQuestionRegistry,
  policy: AimScoringPolicy,
): AimFactualVector {
  const targets = validateAimStage2Projection(registry, policy);
  const answerById = new Map(vector.answers.map((answer) => [answer.questionId, answer]));
  const sourceEntriesByTarget = new Map<string, CrosswalkEntry[]>();
  for (const entry of crosswalk.entries) {
    for (const target of entry.targetIds) {
      const existing = sourceEntriesByTarget.get(target) ?? [];
      existing.push(entry);
      sourceEntriesByTarget.set(target, existing);
    }
  }
  const projectedAnswers: AimFactualAnswer[] = vector.answers
    .filter((answer) => answer.questionId.startsWith('S1.'))
    .map((answer) => ({ ...answer, evidenceIds: [...answer.evidenceIds] }));

  for (const target of [...targets].sort()) {
    const evidenceIds: string[] = [];
    let present = false;
    for (const entry of sourceEntriesByTarget.get(target) ?? []) {
      const answer = answerById.get(entry.sourceId);
      if (answer?.answer !== 'yes') continue;
      present = true;
      for (const evidenceId of answer.evidenceIds) {
        if (!evidenceIds.includes(evidenceId)) evidenceIds.push(evidenceId);
      }
    }
    projectedAnswers.push({
      questionId: target,
      answer: present ? 'yes' : 'unsupported',
      evidenceIds,
    });
  }

  // The original end-to-end lifecycle atomic explicitly spans acquisition or
  // pre-sale work through post-sale growth or renewal. When it is present, its
  // exact evidence also closes the two narrower private scoring facts required
  // by the existing deterministic lifecycle rule.
  const endToEnd = projectedAnswers.find((answer) => answer.questionId === 'S2.CML.Q15');
  if (endToEnd?.answer === 'yes') {
    const retention = projectedAnswers.find((answer) => answer.questionId === 'S2.CML.Q14');
    const acquisition = projectedAnswers.find((answer) => answer.questionId === 'S2.CML.Q02');
    const discovery = projectedAnswers.find((answer) => answer.questionId === 'S2.CML.Q06');
    if (retention && retention.answer !== 'yes') {
      retention.answer = 'yes';
      retention.evidenceIds = [...endToEnd.evidenceIds];
    }
    if (acquisition && discovery && acquisition.answer !== 'yes' && discovery.answer !== 'yes') {
      acquisition.answer = 'yes';
      acquisition.evidenceIds = [...endToEnd.evidenceIds];
    }
  }

  return {
    ...vector,
    answers: projectedAnswers,
    evidenceCatalog: vector.evidenceCatalog.map((entry) => ({
      ...entry,
      occurrences: entry.occurrences.map((occurrence) => ({ ...occurrence })),
    })),
  };
}
