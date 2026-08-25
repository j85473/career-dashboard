import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { assertExperienceHardRequirementEvidence } from '../experienceScoringPolicy';
import { normalizeScoringText } from '../scoringCanonicalJson';

type CanaryCase = {
  name: string;
  expect: 'accept' | 'reject' | 'notMechanicallyEnforced';
  rejectLabel?: string | null;
  rejectReason?: string;
  requirement: string;
  category: string;
  jdQuote: string;
  absoluteBarCue: string;
  inventoryComparison: string;
  absentFromJd?: boolean;
};

const CANARY = JSON.parse(readFileSync(
  path.join(process.cwd(), 'tests/fixtures/scoring/experience-hard-gate-canary-v1.json'),
  'utf8',
)) as { version: string; cases: CanaryCase[] };

/** Builds the job description the runner would have quoted from. */
function jobDescription(testCase: CanaryCase): string {
  const body = 'About the role. We are hiring a commercial leader for our North America team.';
  return normalizeScoringText(
    testCase.absentFromJd ? body : `${body}\n\n${testCase.jdQuote}\n\nApply on our careers site.`,
  );
}

function resultFor(testCase: CanaryCase, originalJd: string) {
  const codePoints = [...originalJd];
  const start = codePoints.join('').indexOf(testCase.jdQuote);
  const startCodePoint = start < 0 ? 0 : [...originalJd.slice(0, start)].length;
  return {
    decision: 'hard_requirement_mismatch',
    hardRequirementsNotMet: [testCase.requirement],
    hardRequirementEvidence: [{
      requirement: testCase.requirement,
      category: testCase.category,
      source: {
        startCodePoint,
        endCodePoint: startCodePoint + [...testCase.jdQuote].length,
        exactQuote: testCase.jdQuote,
      },
      absoluteBarCue: testCase.absoluteBarCue,
      inventoryComparison: testCase.inventoryComparison,
    }],
  };
}

function evaluate(testCase: CanaryCase): { accepted: boolean; message: string } {
  const originalJd = jobDescription(testCase);
  try {
    assertExperienceHardRequirementEvidence({ result: resultFor(testCase, originalJd), originalJd });
    return { accepted: true, message: '' };
  } catch (error) {
    return { accepted: false, message: error instanceof Error ? error.message : String(error) };
  }
}

test('the Experience hard-gate canary corpus is complete', () => {
  assert.equal(CANARY.version, 'experience-hard-gate-canary-v1');
  const covered = CANARY.cases.map((testCase) => testCase.name.toLowerCase()).join(' | ');
  // The categories the August 23 audit named as required canary coverage.
  for (const topic of [
    'citizenship',
    'work authorization',
    'clearance',
    'lifting',
    'loading',
    'ordinary duty',
    'presentation',
    'preferred',
    'positive control',
  ]) {
    assert.ok(covered.includes(topic), `canary corpus is missing ${topic} coverage`);
  }
  assert.ok(
    CANARY.cases.some((testCase) => testCase.expect === 'accept'),
    'a corpus with no accepted mismatch would pass even if the gate rejected everything',
  );
});

for (const testCase of CANARY.cases) {
  test(`hard-gate canary — ${testCase.name}`, () => {
    const { accepted, message } = evaluate(testCase);

    if (testCase.expect === 'accept') {
      assert.equal(accepted, true, `expected a hard mismatch, got: ${message}`);
      return;
    }

    if (testCase.expect === 'notMechanicallyEnforced') {
      // Recorded on purpose: these clear every mechanical check, and only the
      // prompt keeps them out of the unmet list. If one of them starts being
      // refused, the coverage boundary moved and the note should move with it.
      assert.equal(
        accepted,
        true,
        'this case is documented as prompt-only; the mechanical layer now refuses it',
      );
      return;
    }

    assert.equal(accepted, false, 'expected the boundary to refuse this evidence');
    if (testCase.rejectLabel) {
      assert.match(message, new RegExp(`excluded ${testCase.rejectLabel} requirement`));
    }
  });
}
