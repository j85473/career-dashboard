from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = REPO_ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from scoring_protocol.aim_identity import (  # noqa: E402
    base_membership_hash,
    extraction_identity,
    model_metadata_projection_hash,
    packet_manifest_hash,
    packet_plan_hash,
    source_identity,
    trusted_metadata_hash,
)


class AimIdentityTests(unittest.TestCase):
    def test_python_matches_typescript_named_preimage_fixture(self) -> None:
        fixture = json.loads((
            REPO_ROOT / "tests/fixtures/scoring/aim-v2/identity-parity-vectors.json"
        ).read_text(encoding="utf-8"))
        values = fixture["input"]
        expected = fixture["expected"]
        metadata_hash = trusted_metadata_hash(values["trustedMetadata"])
        source_id = source_identity(values["sourceJdHash"], metadata_hash)
        extraction_id = extraction_identity({
            "sourceIdentity": source_id,
            "questionRegistryVersion": "aim-question-registry-v2",
            "questionRegistryHash": values["questionRegistryHash"],
            "promptContractVersion": "aim-factual-questions-v1",
            "promptContractHash": values["promptContractHash"],
            "responseContractVersion": "aim-factual-worker-response-v1",
            "responseContractHash": values["responseContractHash"],
            "packetStrategyVersion": "aim-stage2-packetizer-v1",
            "packetStrategyHash": values["packetStrategyHash"],
            "canonicalizationVersion": "aim-text-canonicalization-v1",
            "anonymizationPolicyVersion": "aim-anonymization-policy-v1",
            "anonymizationPolicyHash": values["anonymizationPolicyHash"],
            "extractorSemanticVersion": "aim-factual-extractor-v1",
        })
        projection = model_metadata_projection_hash({"title": "Channel Manager"})
        membership = base_membership_hash(values["packetStrategyHash"], 0, ["S2.CP.Q02", "S2.CP.Q01"])
        manifest = packet_manifest_hash(0, 0, ["S2.CP.Q02", "S2.CP.Q01"], projection)
        plan = packet_plan_hash([manifest])
        self.assertEqual({
            "trustedMetadataHash": metadata_hash,
            "sourceIdentity": source_id,
            "extractionIdentity": extraction_id,
            "projectionHash": projection,
            "membershipHash": membership,
            "packetManifestHash": manifest,
            "packetPlanHash": plan,
        }, expected)


if __name__ == "__main__":
    unittest.main()
