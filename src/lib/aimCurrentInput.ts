import {
  aimBatchItemInputHash,
  aimExtractionIdentity,
  aimSourceIdentity,
  aimSourceJdHash,
  aimTrustedMetadataHash,
  normalizeAimTrustedMetadata,
} from './aimIdentity';
import { normalizeScoringText } from './scoringCanonicalJson';
import type { CurrentScoringInputVersions } from './scoringInputVersions';

export type CurrentAimInputJob = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  description: string | null;
};

export type CurrentAimFailureIdentity = {
  sourceIdentity: string;
  inputHash: string;
  extractionIdentity: string;
  runnerProtocolHash: string;
  scoringPolicyHash: string;
  resultBuilderSemanticVersion: string;
};

export function aimExtractionBinding(
  versions: CurrentScoringInputVersions,
  sourceIdentity: string,
): string {
  return aimExtractionIdentity({
    sourceIdentity,
    questionRegistryVersion: versions.questionRegistryVersion,
    questionRegistryHash: versions.questionRegistryHash,
    promptContractVersion: versions.promptContractVersion,
    promptContractHash: versions.promptContractHash,
    responseContractVersion: versions.responseContractVersion,
    responseContractHash: versions.responseContractHash,
    packetStrategyVersion: versions.packetStrategyVersion,
    packetStrategyHash: versions.packetStrategyHash,
    canonicalizationVersion: versions.canonicalizationVersion,
    anonymizationPolicyVersion: versions.anonymizationPolicyVersion,
    anonymizationPolicyHash: versions.anonymizationPolicyHash,
    extractorSemanticVersion: versions.extractorSemanticVersion,
  });
}

/**
 * Rebuild the exact Aim failure identity used by the v2 exporter from the
 * job's current authoritative inputs. This intentionally does not mutate or
 * clear historical failure receipts when their identity becomes stale.
 */
export function currentAimFailureIdentity(
  job: CurrentAimInputJob,
  versions: CurrentScoringInputVersions,
): CurrentAimFailureIdentity {
  const originalJd = normalizeScoringText(job.description || '');
  const trustedMetadata = normalizeAimTrustedMetadata({
    company: job.company,
    title: job.title,
    location: job.location,
  });
  const sourceIdentity = aimSourceIdentity(
    aimSourceJdHash(originalJd),
    aimTrustedMetadataHash(trustedMetadata),
  );
  const extractionIdentity = aimExtractionBinding(versions, sourceIdentity);
  const inputHash = aimBatchItemInputHash({
    protocolVersion: versions.protocolVersion,
    exportSchemaVersion: 'career-dashboard-aim-export-v2',
    sourceIdentity,
    extractionIdentity,
    scoringPolicyHash: versions.aimPolicyHash,
    runnerProtocolHash: versions.runnerProtocolHash,
  });
  return {
    sourceIdentity,
    inputHash,
    extractionIdentity,
    runnerProtocolHash: versions.runnerProtocolHash,
    scoringPolicyHash: versions.aimPolicyHash,
    resultBuilderSemanticVersion: versions.resultBuilderSemanticVersion,
  };
}
