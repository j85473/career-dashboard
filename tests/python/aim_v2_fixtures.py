from __future__ import annotations

from pathlib import Path
from typing import Any

from scoring_protocol.aim_identity import (
    extraction_identity,
    source_identity,
    source_jd_hash,
    trusted_metadata_hash,
)
from scoring_protocol.aim_registry import AimAuthorities, load_aim_authorities
from scoring_protocol.common import canonical_sha256


def make_aim_v2_export(
    repo_root: Path,
    sources: list[str] | None = None,
    companies: list[str] | None = None,
) -> tuple[dict[str, Any], AimAuthorities]:
    authorities = load_aim_authorities(repo_root)
    sources = sources or ["No relevant facts are stated."]
    companies = companies or ["Example"] * len(sources)
    batch: dict[str, Any] = {
        "id": "11111111-1111-4111-8111-111111111111",
        "stage": "aim",
        "createdAt": "2026-08-13T12:00:00.000Z",
        "expiresAt": "2026-08-14T12:00:00.000Z",
        "protocolVersion": "career-dashboard-scoring-protocol-v2",
        "exportSchemaVersion": "career-dashboard-aim-export-v2",
        "questionRegistryVersion": authorities.registry["questionRegistryVersion"],
        "questionRegistryHash": authorities.question_registry_hash,
        "scoringPolicyVersion": authorities.policy["policyVersion"],
        "scoringPolicyHash": authorities.scoring_policy_hash,
        "promptContractVersion": "aim-stage1-factual-stage2-holistic-v1",
        "promptContractHash": authorities.prompt_contract_hash,
        "responseContractVersion": authorities.response_schema["schemaVersion"],
        "responseContractHash": authorities.response_contract_hash,
        "runnerProtocolVersion": authorities.runner_protocol["runnerProtocolVersion"],
        "runnerProtocolHash": authorities.runner_protocol_hash,
        "packetStrategyVersion": authorities.runner_protocol["packetStrategy"]["packetStrategyVersion"],
        "packetStrategyHash": authorities.packet_strategy_hash,
        "canonicalizationVersion": "aim-text-canonicalization-v1",
        "anonymizationPolicyVersion": authorities.anonymization_policy["anonymizationPolicyVersion"],
        "anonymizationPolicyHash": authorities.anonymization_policy_hash,
        "extractorSemanticVersion": authorities.runner_protocol["extractorSemanticVersion"],
        "resultBuilderSemanticVersion": authorities.policy["resultBuilderSemanticVersion"],
        "manifestHash": "",
    }
    jobs: list[dict[str, Any]] = []
    for ordinal, (source, company) in enumerate(zip(sources, companies)):
        metadata = {"company": company, "title": "Channel Manager", "location": "Minneapolis, MN"}
        source_hash = source_jd_hash(source)
        metadata_hash = trusted_metadata_hash(metadata)
        source_id = source_identity(source_hash, metadata_hash)
        extraction_id = extraction_identity({
            "sourceIdentity": source_id,
            **{key: batch[key] for key in (
                "questionRegistryVersion", "questionRegistryHash", "promptContractVersion", "promptContractHash",
                "responseContractVersion", "responseContractHash", "packetStrategyVersion", "packetStrategyHash",
                "canonicalizationVersion", "anonymizationPolicyVersion", "anonymizationPolicyHash", "extractorSemanticVersion",
            )},
        })
        input_hash = canonical_sha256({
            "kind": "aim_batch_item_input_v2",
            "stage": "aim",
            "protocolVersion": batch["protocolVersion"],
            "exportSchemaVersion": batch["exportSchemaVersion"],
            "sourceIdentity": source_id,
            "extractionIdentity": extraction_id,
            "scoringPolicyHash": batch["scoringPolicyHash"],
            "runnerProtocolHash": batch["runnerProtocolHash"],
        })
        jobs.append({
            "jobId": f"{ordinal + 2:08d}-2222-4222-8222-{ordinal + 2:012d}",
            "ordinal": ordinal,
            "submittedUpdatedAt": "2026-08-13T11:00:00.000Z",
            "inputHash": input_hash,
            "trustedMetadata": metadata,
            "trustedMetadataHash": metadata_hash,
            "source": {"originalJd": source, "sourceJdHash": source_hash},
            "sourceIdentity": source_id,
            "extractionIdentity": extraction_id,
            "transportProvenance": {"sourceUrl": None},
            "reuse": None,
        })
    batch["manifestHash"] = canonical_sha256({
        "kind": "aim_export_manifest_v2",
        "batchId": batch["id"],
        "stage": "aim",
        "protocolVersion": batch["protocolVersion"],
        "exportSchemaVersion": batch["exportSchemaVersion"],
        "scoringPolicyVersion": batch["scoringPolicyVersion"],
        "questionRegistryHash": batch["questionRegistryHash"],
        "promptContractHash": batch["promptContractHash"],
        "responseContractHash": batch["responseContractHash"],
        "packetStrategyHash": batch["packetStrategyHash"],
        "items": [
            {"ordinal": job["ordinal"], "jobId": job["jobId"], "inputHash": job["inputHash"]}
            for job in jobs
        ],
    })
    return {"schemaVersion": "career-dashboard-aim-export-v2", "batch": batch, "jobs": jobs}, authorities
