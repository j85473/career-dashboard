import fs from 'node:fs';

import policySchema from '../../data/scoring/schemas/aim-policy-v2.schema.json';

import { canonicalJsonSha256 } from './scoringCanonicalJson';
import { validateAimStage2Projection } from './aimQuestionProjection';
import { validateJsonSchema, type JsonSchema } from './scoringJsonSchema';
import { deepFreezeJson, type AimQuestionRegistry, type AimScoringPolicy } from './aimV2Types';

const POLICY_PATH = 'data/scoring/aim-policy-v2.json';
const QUESTION_ID = /^(?:S1\.Q\d{2}|S2\.(?:F(?:[1-9]|1[01])|CML|BA|LI|TX|SC|PD|CP|TR)\.Q\d{1,2})$/;

function collectQuestionReferences(value: unknown, output: Set<string>): void {
  if (typeof value === 'string' && QUESTION_ID.test(value)) output.add(value);
  else if (Array.isArray(value)) value.forEach((item) => collectQuestionReferences(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectQuestionReferences(item, output));
}

function assertTierShape(policy: AimScoringPolicy): void {
  const expectedRanges: Record<string, readonly [number, number]> = {
    travel: [-8, 30],
    building: [0, 30],
    autonomy: [0, 22],
    channelPartnership: [0, 8],
    farming: [0, 5],
    industryInterest: [-5, 5],
    technicalPresalesDeduction: [-14, 0],
    huntingDeduction: [-20, 0],
  };
  const scoring = policy.preferenceScoring;
  if (canonicalJsonSha256(scoring.formula) !== canonicalJsonSha256(Object.keys(expectedRanges))) {
    throw new Error('Aim preference component formula is not the approved order');
  }
  if (Object.values(expectedRanges).reduce((sum, [, maximum]) => sum + maximum, 0) !== 100) {
    throw new Error('Aim positive component caps must total 100');
  }
  for (const [componentName, [expectedMinimum, expectedCap]] of Object.entries(expectedRanges)) {
    const component = scoring.components[componentName as keyof typeof scoring.components];
    if (!component || component.minimum !== expectedMinimum || component.cap !== expectedCap) {
      throw new Error(`${componentName} component range must be ${expectedMinimum} through ${expectedCap}`);
    }
    for (const tier of component.tiers ?? []) {
      if (!Number.isSafeInteger(tier.points) || tier.points < component.minimum || tier.points > component.cap) {
        throw new Error(`${componentName} has an invalid tier`);
      }
    }
    for (const tier of component.reachTiers ?? []) {
      if (!Number.isSafeInteger(tier.minimumPoints) || !Number.isSafeInteger(tier.maximumPoints)
        || tier.minimumPoints < component.minimum || tier.maximumPoints > component.cap
        || tier.minimumPoints > tier.maximumPoints) {
        throw new Error(`${componentName} has an invalid reach tier`);
      }
    }
    for (const cap of component.caps ?? []) {
      if (!Number.isSafeInteger(cap.maximumPoints)
        || cap.maximumPoints < component.minimum || cap.maximumPoints > component.cap) {
        throw new Error(`${componentName} has an invalid evidence cap`);
      }
    }
  }
}

export function validateAimScoringPolicy(value: unknown, registry: AimQuestionRegistry): AimScoringPolicy {
  const cloned = structuredClone(value);
  validateJsonSchema(cloned, policySchema as JsonSchema);
  const policy = cloned as AimScoringPolicy;
  const ids = new Set(registry.questions.map((question) => question.id));
  const derivedIds = validateAimStage2Projection(registry, policy);
  const references = new Set<string>();
  collectQuestionReferences(policy, references);
  for (const reference of references) {
    if (!ids.has(reference) && !derivedIds.has(reference)) {
      throw new Error(`Aim policy references unknown question or derived fact ${reference}`);
    }
  }
  for (const question of registry.questions) {
    if (JSON.stringify(policy).includes(question.wording)) throw new Error(`Aim policy repeats question wording for ${question.id}`);
  }
  assertTierShape(policy);
  if (policy.preferenceScoring.totalMinimum !== 0 || policy.preferenceScoring.totalMaximum !== 100) {
    throw new Error('Aim score range must be 0 through 100');
  }
  const expectedBands = [[85, 100], [70, 84], [55, 69], [40, 54], [0, 39]];
  if (canonicalJsonSha256(policy.bands.map((band) => [band.minimum, band.maximum])) !== canonicalJsonSha256(expectedBands)) {
    throw new Error('Aim bands do not match policy v2');
  }
  return deepFreezeJson(policy);
}

export function loadAimScoringPolicy(
  registry: AimQuestionRegistry,
  expectedHash?: string,
): { policy: AimScoringPolicy; scoringPolicyHash: string } {
  const policy = validateAimScoringPolicy(JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8')), registry);
  const scoringPolicyHash = canonicalJsonSha256(policy);
  if (expectedHash !== undefined && expectedHash !== scoringPolicyHash) throw new Error('Aim scoring policy hash mismatch');
  return { policy, scoringPolicyHash };
}
