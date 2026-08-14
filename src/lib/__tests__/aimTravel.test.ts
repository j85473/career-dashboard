import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveAimTravel } from '../aimTravel';
import { loadAimQuestionRegistry } from '../aimQuestionRegistry';
import { loadAimScoringPolicy } from '../aimScoringPolicy';
import { allExactCodePointOccurrences } from '../aimEvidence';
import { aimEvidenceId } from '../aimIdentity';
import type { AimEvidenceEntry, AimFactualVector } from '../aimV2Types';

const { registry } = loadAimQuestionRegistry();
const { policy } = loadAimScoringPolicy(registry);

function vector(source: string, yesIds: string[], evidenceByQuestion: Record<string, string> = {}): AimFactualVector {
  const catalog: AimEvidenceEntry[] = [];
  const answers = [...new Set([...yesIds, ...Object.keys(evidenceByQuestion)])].map((questionId) => {
    const quote = evidenceByQuestion[questionId];
    if (quote !== undefined) {
      const evidence: AimEvidenceEntry = {
        evidenceId: '', source: 'original_jd', field: null, exactQuote: quote,
        occurrences: allExactCodePointOccurrences(source, quote),
      };
      evidence.evidenceId = aimEvidenceId(evidence);
      catalog.push(evidence);
      return { questionId, answer: 'yes' as const, evidenceIds: [evidence.evidenceId] };
    }
    return { questionId, answer: 'yes' as const, evidenceIds: [] };
  });
  return { answers, evidenceCatalog: catalog } as unknown as AimFactualVector;
}

test('Aim travel treats up to zero as zero and equivalent 50-percent intervals equally', () => {
  const upToZeroSource = 'Travel: up to 0%.';
  const upToZero = deriveAimTravel(upToZeroSource, vector(upToZeroSource, [], { 'S2.TR.Q01': 'Travel: up to 0%.' }), policy);
  assert.equal(upToZero.points, 0);
  assert.equal(upToZero.positiveTravel, false);

  const cases = [
    ['Travel may be up to 50%.', 'Travel may be up to 50%.'],
    ['Travel is 20-50%.', 'Travel is 20-50%.'],
    ['Travel is at least 20% and up to 50%.', 'Travel is at least 20% and up to 50%.'],
  ] as const;
  const intensities = cases.map(([source, quote]) => deriveAimTravel(source, vector(source, [], { 'S2.TR.Q01': quote }), policy).intensityPoints);
  assert.deepEqual(intensities, [8, 8, 8]);
});

test('Aim travel cascades reach and separates external engagement', () => {
  const source = 'This role requires up to 50% global travel for recurring in-person partner meetings.';
  const result = deriveAimTravel(source, vector(source, ['S2.TR.Q09', 'S2.TR.Q10'], {
    'S2.TR.Q01': source,
    'S2.TR.Q09': source,
    'S2.TR.Q10': source,
  }), policy);
  assert.equal(result.geographicReachPoints, 15);
  assert.equal(result.intensityPoints, 8);
  assert.equal(result.fieldEngagementPoints, 5);
  assert.equal(result.points, 28);
});

test('Aim travel rejects positive/no-travel conflict and uncovered numeric clauses', () => {
  const conflictSource = 'No travel is required. Travel to customer sites is required.';
  const conflict = deriveAimTravel(conflictSource, vector(conflictSource, ['S2.TR.Q02', 'S2.TR.Q11'], {
    'S2.TR.Q02': 'No travel is required.',
    'S2.TR.Q11': 'Travel to customer sites is required.',
  }), policy);
  assert.equal(conflict.comparisonState, 'conflicting');
  assert.equal(conflict.points, 0);

  const uncoveredSource = 'Travel is 10%. In peak season, travel is 30%. International travel may be 50%.';
  const uncovered = deriveAimTravel(uncoveredSource, vector(uncoveredSource, [], { 'S2.TR.Q01': 'Travel is 10%.' }), policy);
  assert.equal(uncovered.coverageState, 'ambiguous');
  assert.equal(uncovered.points, 0);
});

test('Aim travel uses qualitative intensity only when numeric evidence is absent', () => {
  const source = 'Frequent travel is required for regional customer visits.';
  const result = deriveAimTravel(source, vector(source, ['S2.TR.Q03', 'S2.TR.Q06', 'S2.TR.Q11'], {
    'S2.TR.Q03': source,
    'S2.TR.Q06': source,
    'S2.TR.Q11': source,
  }), policy);
  assert.equal(result.intensityPoints, 8);
  assert.equal(result.geographicReachPoints, 7);
  assert.equal(result.fieldEngagementPoints, 4);
  assert.equal(result.points, 19);
});

test('Aim travel treats third, conditioned, and unknown-qualifier numeric clauses as ambiguous zero', () => {
  const sources = [
    'Travel is up to 10%, up to 25%, or up to 50% by region.',
    'Travel is up to 20% depending on location.',
    'Travel is approximately 25%.',
  ];
  for (const source of sources) {
    const result = deriveAimTravel(source, vector(source, [], { 'S2.TR.Q01': source }), policy);
    assert.equal(result.coverageState, 'ambiguous', source);
    assert.equal(result.points, 0, source);
    assert.equal(result.positiveTravel, false, source);
  }
});

test('Aim travel intensity is monotonic for an added lower bound and may fall for a tighter ceiling', () => {
  const ceiling50Source = 'Travel is up to 50%.';
  const ceiling50 = deriveAimTravel(ceiling50Source, vector(ceiling50Source, [], {
    'S2.TR.Q01': ceiling50Source,
  }), policy);
  const intervalSource = 'Travel is at least 20% and up to 50%.';
  const interval = deriveAimTravel(intervalSource, vector(intervalSource, [], {
    'S2.TR.Q01': intervalSource,
  }), policy);
  const ceiling30Source = 'Travel is up to 30%.';
  const ceiling30 = deriveAimTravel(ceiling30Source, vector(ceiling30Source, [], {
    'S2.TR.Q01': ceiling30Source,
  }), policy);
  assert.ok(interval.intensityPoints >= ceiling50.intensityPoints);
  assert.ok(ceiling30.intensityPoints < ceiling50.intensityPoints);
});
