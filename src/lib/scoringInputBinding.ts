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
