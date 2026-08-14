import { canonicalJsonSha256 } from './scoringCanonicalJson';

export type ScoringStage = 'aim' | 'experience';

export type SemanticInputBinding = {
  stage: ScoringStage;
  protocolVersion: string;
  schemaVersion: string;
  globalInputVersionsHash: string;
  policyHash: string;
  sourceJdHash: string;
  metadataHash: string;
  employerOverridesHash?: string;
  preferencesHash?: string;
  cleanedArtifactHash?: string;
  sourceAimEventHash?: string;
  resumeHash?: string;
  evidenceHash?: string;
};

export function scoringInputHash(binding: SemanticInputBinding): string {
  if (!/^[a-f0-9]{64}$/.test(binding.globalInputVersionsHash)) throw new Error('global input versions hash is invalid');
  if (binding.stage === 'aim' && (binding.resumeHash || binding.evidenceHash || binding.cleanedArtifactHash || binding.sourceAimEventHash)) {
    throw new Error('Aim input binding must not include Experience-only inputs');
  }
  if (binding.stage === 'experience' && (!binding.resumeHash || !binding.evidenceHash || !binding.cleanedArtifactHash || !binding.sourceAimEventHash)) {
    throw new Error('Experience input binding is incomplete');
  }
  return canonicalJsonSha256(binding);
}

export function scoringManifestHash(input: {
  batchId: string;
  stage: ScoringStage;
  schemaVersion: string;
  protocolVersion: string;
  policyVersion: string;
  items: Array<{ ordinal: number; jobId: string; inputHash: string }>;
}): string {
  return canonicalJsonSha256(input);
}

export function aimV2ManifestHash(input: {
  batchId: string;
  protocolVersion: string;
  exportSchemaVersion: string;
  scoringPolicyVersion: string;
  questionRegistryHash: string;
  promptContractHash: string;
  responseContractHash: string;
  packetStrategyHash: string;
  items: Array<{ ordinal: number; jobId: string; inputHash: string }>;
}): string {
  return canonicalJsonSha256({ kind: 'aim_export_manifest_v2', stage: 'aim', ...input });
}

export type AimV2TransportVersions = {
  protocolVersion: string;
  exportSchemaVersion: string;
  questionRegistryHash: string;
  scoringPolicyHash: string;
  promptContractHash: string;
  responseContractHash: string;
  runnerProtocolHash: string;
  packetStrategyHash: string;
  canonicalizationVersion: string;
  anonymizationPolicyVersion: string;
  anonymizationPolicyHash: string;
  extractorSemanticVersion: string;
  resultBuilderSemanticVersion: string;
};

export function aimV2TransportVersionsHash(input: AimV2TransportVersions): string {
  return canonicalJsonSha256({ kind: 'aim_input_versions_transport_v2', ...input });
}
