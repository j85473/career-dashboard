import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { canonicalJsonSha256 } from './scoringCanonicalJson';
import { SCORING_PROTOCOL_V2 } from './scoringExchange';
import { loadCoreEvidenceSnapshot } from './scoringEvidence';
import { aimV2TransportVersionsHash } from './scoringInputBinding';
import type { ScoringStage } from './scoringInputBinding';

type VersionedAuthority = Record<string, unknown>;

export type CurrentScoringInputVersions = {
  protocolVersion: typeof SCORING_PROTOCOL_V2;
  aimPolicyVersion: string;
  aimPolicyHash: string;
  questionRegistryVersion: string;
  questionRegistryHash: string;
  promptContractVersion: string;
  promptContractHash: string;
  responseContractVersion: string;
  responseContractHash: string;
  runnerProtocolVersion: string;
  runnerProtocolHash: string;
  packetStrategyVersion: string;
  packetStrategyHash: string;
  canonicalizationVersion: 'aim-text-canonicalization-v1';
  anonymizationPolicyVersion: string;
  anonymizationPolicyHash: string;
  extractorSemanticVersion: string;
  resultBuilderSemanticVersion: string;
  aimExtractionVersionsHash: string;
  aimScoringVersionsHash: string;
  aimInputVersionsHash: string;
  employerOverridesHash: string;
  experiencePolicyHash: string;
  resumeHash: string;
  evidenceSourceHash: string;
  evidenceHash: string;
  aimSchemaHash: string;
  experienceSchemaHash: string;
  cleanerVersion: string;
  experienceControllerVersion: string;
  experienceRunnerProtocolHash: string;
  aimPromptsHash: string;
  experiencePromptsHash: string;
  experienceInputVersionsHash: string;
  allInputVersionsHash: string;
};

/** Read-only historical replay constant; new Aim export/import must never accept it. */
export const LEGACY_AIM_INPUT_VERSIONS_HASHES = [
  'efdd2c89daeb2e811fce3b09c0b1e2cdc9282680d40da463484d407a15f2a12c',
] as const;

function jsonValue(path: string): VersionedAuthority {
  return JSON.parse(fs.readFileSync(path, 'utf8')) as VersionedAuthority;
}

function jsonHash(path: string): string {
  return canonicalJsonSha256(jsonValue(path));
}

function fileHash(path: string): string {
  return createHash('sha256').update(fs.readFileSync(path)).digest('hex');
}

function filesHash(paths: string[]): string {
  return canonicalJsonSha256(paths.map((path) => ({ path, sha256: fileHash(path) })));
}

function requiredString(authority: VersionedAuthority, key: string, source: string): string {
  const value = authority[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${source}.${key} is required`);
  return value;
}

export function currentScoringInputVersions(): CurrentScoringInputVersions {
  const evidence = loadCoreEvidenceSnapshot();
  const registry = jsonValue('data/scoring/aim-question-registry-v2.json');
  const policy = jsonValue('data/scoring/aim-policy-v2.json');
  const runner = jsonValue('data/scoring/runner-protocol-v2.json');
  const packetStrategy = runner.packetStrategy as VersionedAuthority;
  const anonymization = jsonValue('data/scoring/aim-anonymization-policy-v1.json');
  const response = jsonValue('data/scoring/schemas/aim-factual-worker-response-v1.schema.json');

  const aim = {
    protocolVersion: SCORING_PROTOCOL_V2,
    exportSchemaVersion: 'career-dashboard-aim-export-v2',
    questionRegistryVersion: requiredString(registry, 'questionRegistryVersion', 'Aim registry'),
    questionRegistryHash: canonicalJsonSha256(registry),
    scoringPolicyVersion: requiredString(policy, 'policyVersion', 'Aim policy'),
    scoringPolicyHash: canonicalJsonSha256(policy),
    promptContractVersion: 'aim-stage1-factual-stage2-holistic-v1',
    promptContractHash: filesHash([
      'data/scoring/prompts/aim-factual-questions-v1.md',
      'data/scoring/prompts/aim-stage2-holistic-v1.md',
    ]),
    responseContractVersion: requiredString(response, 'schemaVersion', 'Aim response schema'),
    responseContractHash: canonicalJsonSha256(response),
    runnerProtocolVersion: requiredString(runner, 'runnerProtocolVersion', 'Aim runner protocol'),
    runnerProtocolHash: canonicalJsonSha256(runner),
    packetStrategyVersion: requiredString(packetStrategy, 'packetStrategyVersion', 'Aim packet strategy'),
    packetStrategyHash: canonicalJsonSha256(packetStrategy),
    canonicalizationVersion: 'aim-text-canonicalization-v1' as const,
    anonymizationPolicyVersion: requiredString(anonymization, 'anonymizationPolicyVersion', 'Aim anonymization policy'),
    anonymizationPolicyHash: canonicalJsonSha256(anonymization),
    extractorSemanticVersion: requiredString(runner, 'extractorSemanticVersion', 'Aim runner protocol'),
    resultBuilderSemanticVersion: requiredString(policy, 'resultBuilderSemanticVersion', 'Aim policy'),
  };
  const aimInputVersionsHash = aimV2TransportVersionsHash({
    protocolVersion: aim.protocolVersion,
    exportSchemaVersion: aim.exportSchemaVersion,
    questionRegistryHash: aim.questionRegistryHash,
    scoringPolicyHash: aim.scoringPolicyHash,
    promptContractHash: aim.promptContractHash,
    responseContractHash: aim.responseContractHash,
    runnerProtocolHash: aim.runnerProtocolHash,
    packetStrategyHash: aim.packetStrategyHash,
    canonicalizationVersion: aim.canonicalizationVersion,
    anonymizationPolicyVersion: aim.anonymizationPolicyVersion,
    anonymizationPolicyHash: aim.anonymizationPolicyHash,
    extractorSemanticVersion: aim.extractorSemanticVersion,
    resultBuilderSemanticVersion: aim.resultBuilderSemanticVersion,
  });
  const aimExtractionVersionsHash = canonicalJsonSha256({
    kind: 'aim_extraction_versions_v1',
    questionRegistryHash: aim.questionRegistryHash,
    promptContractHash: aim.promptContractHash,
    responseContractHash: aim.responseContractHash,
    packetStrategyHash: aim.packetStrategyHash,
    canonicalizationVersion: aim.canonicalizationVersion,
    anonymizationPolicyVersion: aim.anonymizationPolicyVersion,
    anonymizationPolicyHash: aim.anonymizationPolicyHash,
    extractorSemanticVersion: aim.extractorSemanticVersion,
  });
  const aimScoringVersionsHash = canonicalJsonSha256({
    kind: 'aim_scoring_versions_v1',
    scoringPolicyHash: aim.scoringPolicyHash,
    resultBuilderSemanticVersion: aim.resultBuilderSemanticVersion,
  });

  const experiencePolicy = jsonValue('data/scoring/experience-policy-v2.json');
  const experienceProtocol = jsonValue('data/scoring/experience-runner-protocol-v2.json');
  const experiencePolicyHash = canonicalJsonSha256(experiencePolicy);
  const resumeHash = fileHash('data/resumes/JosephLamb_Resume.docx');
  const evidenceSourceHash = fileHash('docs/Candidate_Evidence_Inventory_-_Core_v1.md');
  const experienceSchemaHash = canonicalJsonSha256([
    jsonValue('data/scoring/schemas/experience-export-v2.schema.json'),
    jsonValue('data/scoring/schemas/experience-result-v2.schema.json'),
  ]);
  const experienceRunnerProtocolHash = canonicalJsonSha256(experienceProtocol);
  const experiencePromptsHash = filesHash([
    'data/scoring/prompts/experience-hard-gate-v1.md',
    'data/scoring/prompts/experience-holistic-v1.md',
  ]);
  const experienceInputVersionsHash = canonicalJsonSha256({
    kind: 'experience_input_versions_v2',
    protocolVersion: SCORING_PROTOCOL_V2,
    exportSchemaVersion: 'career-dashboard-experience-export-v2',
    policyHash: experiencePolicyHash,
    schemaHash: experienceSchemaHash,
    resumeHash,
    evidenceSourceHash,
    evidenceHash: evidence.evidenceHash,
    experienceControllerVersion: requiredString(experienceProtocol, 'controllerVersion', 'Experience runner protocol'),
    runnerProtocolHash: experienceRunnerProtocolHash,
    promptsHash: experiencePromptsHash,
    sourceContract: 'canonical-original-jd-v1',
  });

  return {
    protocolVersion: SCORING_PROTOCOL_V2,
    aimPolicyVersion: aim.scoringPolicyVersion,
    aimPolicyHash: aim.scoringPolicyHash,
    questionRegistryVersion: aim.questionRegistryVersion,
    questionRegistryHash: aim.questionRegistryHash,
    promptContractVersion: aim.promptContractVersion,
    promptContractHash: aim.promptContractHash,
    responseContractVersion: aim.responseContractVersion,
    responseContractHash: aim.responseContractHash,
    runnerProtocolVersion: aim.runnerProtocolVersion,
    runnerProtocolHash: aim.runnerProtocolHash,
    packetStrategyVersion: aim.packetStrategyVersion,
    packetStrategyHash: aim.packetStrategyHash,
    canonicalizationVersion: aim.canonicalizationVersion,
    anonymizationPolicyVersion: aim.anonymizationPolicyVersion,
    anonymizationPolicyHash: aim.anonymizationPolicyHash,
    extractorSemanticVersion: aim.extractorSemanticVersion,
    resultBuilderSemanticVersion: aim.resultBuilderSemanticVersion,
    aimExtractionVersionsHash,
    aimScoringVersionsHash,
    aimInputVersionsHash,
    employerOverridesHash: jsonHash('data/scoring/aim-employer-overrides-v1.json'),
    experiencePolicyHash,
    resumeHash,
    evidenceSourceHash,
    evidenceHash: evidence.evidenceHash,
    aimSchemaHash: canonicalJsonSha256([
      jsonValue('data/scoring/schemas/aim-export-v2.schema.json'),
      jsonValue('data/scoring/schemas/aim-result-v2.schema.json'),
      jsonValue('data/scoring/schemas/aim-factual-vector-v1.schema.json'),
    ]),
    experienceSchemaHash,
    cleanerVersion: 'jd-cleaner-v3',
    experienceControllerVersion: requiredString(experienceProtocol, 'controllerVersion', 'Experience runner protocol'),
    experienceRunnerProtocolHash,
    aimPromptsHash: filesHash([
      'data/scoring/prompts/aim-factual-questions-v1.md',
      'data/scoring/prompts/aim-stage2-holistic-v1.md',
    ]),
    experiencePromptsHash,
    experienceInputVersionsHash,
    allInputVersionsHash: canonicalJsonSha256({ aimInputVersionsHash, experienceInputVersionsHash }),
  };
}

export function eventInputBindingsCurrent(
  stage: ScoringStage,
  bindings: unknown,
  versions = currentScoringInputVersions(),
): boolean {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return false;
  const expected = stage === 'aim' ? versions.aimInputVersionsHash : versions.experienceInputVersionsHash;
  return (bindings as Record<string, unknown>).globalInputVersionsHash === expected;
}
