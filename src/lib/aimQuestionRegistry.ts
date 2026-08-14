import fs from 'node:fs';

import registrySchema from '../../data/scoring/schemas/aim-question-registry-v2.schema.json';

import { canonicalJsonSha256 } from './scoringCanonicalJson';
import { validateJsonSchema, type JsonSchema } from './scoringJsonSchema';
import { deepFreezeJson, type AimMetadataField, type AimQuestionRegistry } from './aimV2Types';

const REGISTRY_PATH = 'data/scoring/aim-question-registry-v2.json';
const EXPECTED_PREFIX_COUNTS: Readonly<Record<string, number>> = {
  'S1.': 7,
  'S2.F1.': 20,
  'S2.F2.': 20,
  'S2.F3.': 27,
  'S2.F4.': 30,
  'S2.F5.': 35,
  'S2.F6.': 35,
  'S2.F7.': 35,
  'S2.F8.': 35,
  'S2.F9.': 43,
  'S2.F10.': 30,
  'S2.F11.': 32,
};
const STAGE1_METADATA: Readonly<Record<string, AimMetadataField[]>> = {
  'S1.Q01': ['title'],
  'S1.Q02': ['title'],
  'S1.Q03': ['title', 'location'],
  'S1.Q04': ['title'],
  'S1.Q05': ['title'],
  'S1.Q06': ['company', 'title'],
  'S1.Q07': ['company'],
};

function asRegistry(value: unknown): AimQuestionRegistry {
  validateJsonSchema(value, registrySchema as JsonSchema);
  return value as AimQuestionRegistry;
}

export function validateAimQuestionRegistry(value: unknown): AimQuestionRegistry {
  const registry = asRegistry(structuredClone(value));
  const ids = new Set<string>();
  const wordings = new Set<string>();
  for (const question of registry.questions) {
    if (ids.has(question.id)) throw new Error(`duplicate Aim question ID ${question.id}`);
    if (wordings.has(question.wording)) throw new Error(`duplicate Aim question wording at ${question.id}`);
    ids.add(question.id);
    wordings.add(question.wording);
    const expectedMetadata = STAGE1_METADATA[question.id] ?? [];
    if (canonicalJsonSha256(question.allowedMetadataFields) !== canonicalJsonSha256(expectedMetadata)) {
      throw new Error(`${question.id} has invalid metadata authorization`);
    }
    const stage1 = question.id.startsWith('S1.');
    const expectedSources = stage1 ? ['original_jd', 'trusted_metadata'] : ['original_jd'];
    if (canonicalJsonSha256(question.allowedSources) !== canonicalJsonSha256(expectedSources)) {
      throw new Error(`${question.id} has invalid source authorization`);
    }
    if (question.privatePhase !== (stage1 ? 'stage1' : 'stage2')) throw new Error(`${question.id} has invalid private phase`);
    if (stage1 && question.parserInput !== 'stage1_fact') throw new Error(`${question.id} has invalid parser input`);
    if (question.id.startsWith('S2.F10.') && question.parserInput !== 'compensation_fact') throw new Error(`${question.id} has invalid parser input`);
    if (question.id.startsWith('S2.F11.') && question.parserInput !== 'travel_fact') throw new Error(`${question.id} has invalid parser input`);
    if (/^S2\.F(?:[1-9])\./.test(question.id) && question.parserInput !== 'score_fact') throw new Error(`${question.id} has invalid parser input`);
    if (question.evidenceRule.yes.minimumExactExcerpts !== 1 || question.evidenceRule.yes.maximumExactExcerpts !== 2
      || question.evidenceRule.no.minimumExactExcerpts !== 0 || question.evidenceRule.no.maximumExactExcerpts !== 0
      || question.evidenceRule.unsupported.minimumExactExcerpts !== 0 || question.evidenceRule.unsupported.maximumExactExcerpts !== 0) {
      throw new Error(`${question.id} has invalid evidence cardinality`);
    }
  }
  for (const [prefix, expected] of Object.entries(EXPECTED_PREFIX_COUNTS)) {
    const actual = registry.questions.filter((question) => question.id.startsWith(prefix)).length;
    if (actual !== expected) throw new Error(`${prefix} expected ${expected} questions, found ${actual}`);
  }
  return deepFreezeJson(registry);
}

export function loadAimQuestionRegistry(expectedHash?: string): { registry: AimQuestionRegistry; questionRegistryHash: string } {
  const registry = validateAimQuestionRegistry(JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')));
  const questionRegistryHash = canonicalJsonSha256(registry);
  if (expectedHash !== undefined && expectedHash !== questionRegistryHash) throw new Error('Aim question registry hash mismatch');
  return { registry, questionRegistryHash };
}
