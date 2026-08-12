import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { canonicalJsonSha256 } from './scoringCanonicalJson';
import { SCORING_PROTOCOL_VERSION } from './scoringExchange';
import { loadCoreEvidenceSnapshot } from './scoringEvidence';
import type { ScoringStage } from './scoringInputBinding';

export type CurrentScoringInputVersions = {
  protocolVersion: string;
  aimPolicyHash: string;
  employerOverridesHash: string;
  experiencePolicyHash: string;
  resumeHash: string;
  evidenceSourceHash: string;
  evidenceHash: string;
  aimSchemaHash: string;
  experienceSchemaHash: string;
  cleanerVersion: string;
  requirementExtractorVersion: string;
  runnerProtocolHash: string;
  aimPromptsHash: string;
  experiencePromptsHash: string;
  aimInputVersionsHash: string;
  experienceInputVersionsHash: string;
  allInputVersionsHash: string;
};

function jsonHash(path: string): string {
  return canonicalJsonSha256(JSON.parse(fs.readFileSync(path, 'utf8')));
}

function fileHash(path: string): string {
  return createHash('sha256').update(fs.readFileSync(path)).digest('hex');
}

function filesHash(paths: string[]): string {
  return canonicalJsonSha256(paths.map((path) => ({ path, sha256: fileHash(path) })));
}

export function currentScoringInputVersions(): CurrentScoringInputVersions {
  const evidence = loadCoreEvidenceSnapshot();
  const base = {
    protocolVersion: SCORING_PROTOCOL_VERSION,
    aimPolicyHash: jsonHash('data/scoring/aim-policy-v1.json'),
    employerOverridesHash: jsonHash('data/scoring/aim-employer-overrides-v1.json'),
    experiencePolicyHash: jsonHash('data/scoring/experience-policy-v1.json'),
    resumeHash: fileHash('data/resumes/JosephLamb_Resume.docx'),
    evidenceSourceHash: fileHash('docs/Candidate_Evidence_Inventory_-_Core_v1.md'),
    evidenceHash: evidence.evidenceHash,
    aimSchemaHash: canonicalJsonSha256([
      JSON.parse(fs.readFileSync('data/scoring/schemas/aim-export-v1.schema.json', 'utf8')),
      JSON.parse(fs.readFileSync('data/scoring/schemas/aim-result-v1.schema.json', 'utf8')),
    ]),
    experienceSchemaHash: canonicalJsonSha256([
      JSON.parse(fs.readFileSync('data/scoring/schemas/experience-export-v1.schema.json', 'utf8')),
      JSON.parse(fs.readFileSync('data/scoring/schemas/experience-result-v1.schema.json', 'utf8')),
    ]),
    cleanerVersion: 'jd-cleaner-v1',
    requirementExtractorVersion: 'requirement-extractor-v1',
    runnerProtocolHash: jsonHash('data/scoring/runner-protocol-v1.json'),
    aimPromptsHash: filesHash([
      'data/scoring/prompts/jd-cleaner-v1.md',
      'data/scoring/prompts/jd-coverage-auditor-v1.md',
      'data/scoring/prompts/aim-evaluator-v1.md',
      'data/scoring/prompts/targeted-repair-v1.md',
    ]),
    experiencePromptsHash: filesHash([
      'data/scoring/prompts/requirement-extractor-v1.md',
      'data/scoring/prompts/requirement-coverage-auditor-v1.md',
      'data/scoring/prompts/evidence-evaluator-v1.md',
      'data/scoring/prompts/targeted-repair-v1.md',
    ]),
  };
  const aimInputVersionsHash = canonicalJsonSha256({
    protocolVersion: base.protocolVersion, policyHash: base.aimPolicyHash, employerOverridesHash: base.employerOverridesHash,
    schemaHash: base.aimSchemaHash, cleanerVersion: base.cleanerVersion,
    runnerProtocolHash: base.runnerProtocolHash, promptsHash: base.aimPromptsHash,
  });
  const experienceInputVersionsHash = canonicalJsonSha256({
    protocolVersion: base.protocolVersion, policyHash: base.experiencePolicyHash, schemaHash: base.experienceSchemaHash,
    resumeHash: base.resumeHash, evidenceSourceHash: base.evidenceSourceHash, evidenceHash: base.evidenceHash, requirementExtractorVersion: base.requirementExtractorVersion,
    runnerProtocolHash: base.runnerProtocolHash, promptsHash: base.experiencePromptsHash,
  });
  return {
    ...base,
    aimInputVersionsHash,
    experienceInputVersionsHash,
    allInputVersionsHash: canonicalJsonSha256({ aimInputVersionsHash, experienceInputVersionsHash }),
  };
}

export function eventInputBindingsCurrent(stage: ScoringStage, bindings: unknown, versions = currentScoringInputVersions()): boolean {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return false;
  const expected = stage === 'aim' ? versions.aimInputVersionsHash : versions.experienceInputVersionsHash;
  return (bindings as Record<string, unknown>).globalInputVersionsHash === expected;
}
