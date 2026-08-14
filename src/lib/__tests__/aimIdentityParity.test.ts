import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  aimBaseMembershipHash,
  aimExtractionIdentity,
  aimModelVisibleMetadataProjectionHash,
  aimPacketManifestHash,
  aimPacketPlanHash,
  aimScoringIdentity,
  aimSourceIdentity,
  aimTrustedMetadataHash,
} from '../aimIdentity';

test('Aim v2 composite identities use named canonical JSON preimages', () => {
  const fixture = JSON.parse(readFileSync(
    'tests/fixtures/scoring/aim-v2/identity-parity-vectors.json', 'utf8',
  )) as { input: Record<string, string | null | Record<string, string | null>>; expected: Record<string, string> };
  const input = fixture.input;
  const trustedMetadataHash = aimTrustedMetadataHash(input.trustedMetadata as {
    company: string; title: string; location: string | null;
  });
  const sourceIdentity = aimSourceIdentity(input.sourceJdHash as string, trustedMetadataHash);
  const extractionIdentity = aimExtractionIdentity({
    sourceIdentity,
    questionRegistryVersion: 'aim-question-registry-v2',
    questionRegistryHash: input.questionRegistryHash as string,
    promptContractVersion: 'aim-factual-questions-v1',
    promptContractHash: input.promptContractHash as string,
    responseContractVersion: 'aim-factual-worker-response-v1',
    responseContractHash: input.responseContractHash as string,
    packetStrategyVersion: 'aim-stage2-packetizer-v1',
    packetStrategyHash: input.packetStrategyHash as string,
    canonicalizationVersion: 'aim-text-canonicalization-v1',
    anonymizationPolicyVersion: 'aim-anonymization-policy-v1',
    anonymizationPolicyHash: input.anonymizationPolicyHash as string,
    extractorSemanticVersion: 'aim-factual-extractor-v1',
  });
  const projectionHash = aimModelVisibleMetadataProjectionHash({ title: 'Channel Manager' });
  const membershipHash = aimBaseMembershipHash(input.packetStrategyHash as string, 0, ['S2.CP.Q02', 'S2.CP.Q01']);
  const packetManifestHash = aimPacketManifestHash({
    baseOrdinal: 0, physicalOrdinal: 0,
    orderedQuestionIds: ['S2.CP.Q02', 'S2.CP.Q01'],
    modelVisibleMetadataProjectionHash: projectionHash,
  });
  const packetPlanHash = aimPacketPlanHash([packetManifestHash]);
  assert.deepEqual(
    { trustedMetadataHash, sourceIdentity, extractionIdentity, projectionHash, membershipHash, packetManifestHash, packetPlanHash },
    fixture.expected,
  );
});

test('Aim extraction identity invalidates every semantic input but excludes execution provenance', () => {
  const base = {
    sourceIdentity: '1'.repeat(64),
    questionRegistryVersion: 'aim-question-registry-v2',
    questionRegistryHash: '2'.repeat(64),
    promptContractVersion: 'aim-factual-questions-v1',
    promptContractHash: '3'.repeat(64),
    responseContractVersion: 'aim-factual-worker-response-v1',
    responseContractHash: '4'.repeat(64),
    packetStrategyVersion: 'aim-stage2-packetizer-v1',
    packetStrategyHash: '5'.repeat(64),
    canonicalizationVersion: 'aim-text-canonicalization-v1',
    anonymizationPolicyVersion: 'aim-anonymization-policy-v1',
    anonymizationPolicyHash: '6'.repeat(64),
    extractorSemanticVersion: 'aim-factual-extractor-v1',
  };
  const identity = aimExtractionIdentity(base);
  for (const field of Object.keys(base) as Array<keyof typeof base>) {
    assert.notEqual(
      aimExtractionIdentity({ ...base, [field]: `${base[field]}-changed` }),
      identity,
      `${field} must invalidate extraction identity`,
    );
  }

  // Physical packet plans, model, and effort are deliberately absent from the
  // semantic preimage. They cannot silently invalidate a production vector.
  assert.equal(aimExtractionIdentity({ ...base }), identity);
  assert.notEqual(
    aimPacketPlanHash(['7'.repeat(64)]),
    aimPacketPlanHash(['8'.repeat(64)]),
  );

  const factualVectorHash = '9'.repeat(64);
  const scoringBase = {
    factualVectorHash,
    trustedMetadataHash: 'a'.repeat(64),
    scoringPolicyVersion: 'aim-policy-v2',
    scoringPolicyHash: 'b'.repeat(64),
    resultBuilderSemanticVersion: 'aim-result-builder-v2',
  };
  assert.notEqual(
    aimScoringIdentity(scoringBase),
    aimScoringIdentity({ ...scoringBase, scoringPolicyHash: 'c'.repeat(64) }),
  );
});
