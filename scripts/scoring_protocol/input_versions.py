from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from .aim_identity import extraction_identity, source_identity, source_jd_hash, trusted_metadata_hash
from .common import canonical_sha256, load_json, normalized_text_sha256, normalize_source_text


def worker_prompt_version(name: str) -> str:
    return f"{name}-v1"


def current_aim_v2_authority_bindings(repo_root: Path) -> dict[str, Any]:
    from .aim_registry import load_aim_authorities

    authorities = load_aim_authorities(repo_root)
    runner = authorities.runner_protocol
    return {
        "protocolVersion": "career-dashboard-scoring-protocol-v2",
        "exportSchemaVersion": "career-dashboard-aim-export-v2",
        "questionRegistryVersion": authorities.registry["questionRegistryVersion"],
        "questionRegistryHash": authorities.question_registry_hash,
        "scoringPolicyVersion": authorities.policy["policyVersion"],
        "scoringPolicyHash": authorities.scoring_policy_hash,
        "resultBuilderSemanticVersion": authorities.policy["resultBuilderSemanticVersion"],
        "promptContractVersion": "aim-stage1-factual-stage2-holistic-v1",
        "promptContractHash": authorities.prompt_contract_hash,
        "responseContractVersion": authorities.response_schema["schemaVersion"],
        "responseContractHash": authorities.response_contract_hash,
        "runnerProtocolVersion": runner["runnerProtocolVersion"],
        "runnerProtocolHash": authorities.runner_protocol_hash,
        "packetStrategyVersion": runner["packetStrategy"]["packetStrategyVersion"],
        "packetStrategyHash": authorities.packet_strategy_hash,
        "canonicalizationVersion": "aim-text-canonicalization-v1",
        "anonymizationPolicyVersion": authorities.anonymization_policy["anonymizationPolicyVersion"],
        "anonymizationPolicyHash": authorities.anonymization_policy_hash,
        "extractorSemanticVersion": runner["extractorSemanticVersion"],
    }


def expected_aim_v2_input_hash(job: dict[str, Any], batch: dict[str, Any]) -> str:
    return canonical_sha256({
        "kind": "aim_batch_item_input_v2",
        "stage": "aim",
        "protocolVersion": batch["protocolVersion"],
        "exportSchemaVersion": batch["exportSchemaVersion"],
        "sourceIdentity": job["sourceIdentity"],
        "extractionIdentity": job["extractionIdentity"],
        "scoringPolicyHash": batch["scoringPolicyHash"],
        "runnerProtocolHash": batch["runnerProtocolHash"],
    })


def validate_current_aim_v2_export(exported: dict[str, Any], repo_root: Path) -> None:
    from .aim_registry import load_aim_authorities, validate_export_authority_bindings

    authorities = load_aim_authorities(repo_root)
    batch = exported["batch"]
    validate_export_authority_bindings(batch, authorities)
    for job in exported["jobs"]:
        source = job["source"]["originalJd"]
        metadata = job["trustedMetadata"]
        source_hash = source_jd_hash(source)
        metadata_hash = trusted_metadata_hash(metadata)
        source_id = source_identity(source_hash, metadata_hash)
        if source_hash != job["source"]["sourceJdHash"] or metadata_hash != job["trustedMetadataHash"] or source_id != job["sourceIdentity"]:
            raise ValueError(f"Aim v2 source/trusted-metadata binding mismatch at ordinal {job['ordinal']}")
        extraction_id = extraction_identity({
            "sourceIdentity": source_id,
            **{key: batch[key] for key in (
                "questionRegistryVersion", "questionRegistryHash", "promptContractVersion", "promptContractHash",
                "responseContractVersion", "responseContractHash", "packetStrategyVersion", "packetStrategyHash",
                "canonicalizationVersion", "anonymizationPolicyVersion", "anonymizationPolicyHash", "extractorSemanticVersion",
            )},
        })
        if extraction_id != job["extractionIdentity"]:
            raise ValueError(f"Aim v2 extraction identity mismatch at ordinal {job['ordinal']}")
        if expected_aim_v2_input_hash(job, batch) != job["inputHash"]:
            raise ValueError(f"Aim v2 transport input hash mismatch at ordinal {job['ordinal']}")


def _file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _core_evidence_snapshot(repo_root: Path) -> dict[str, Any]:
    source_path = "docs/Candidate_Evidence_Inventory_-_Core_v1.md"
    markdown = (repo_root / source_path).read_text(encoding="utf-8")
    normalized = normalize_source_text(markdown)
    lines = normalized.split("\n")
    try:
        heading = lines.index("## Sheet: Core Evidence")
        header = next(index for index in range(heading + 1, len(lines)) if lines[index].startswith("| claim_willingness |"))
    except (ValueError, StopIteration) as error:
        raise ValueError("Core Evidence table is missing") from error
    headers = [cell.strip().replace(r"\|", "|") for cell in lines[header][1:-1].split("|")]
    expected = [
        "claim_willingness", "evidence_id", "baseline", "employer", "role_title", "date_range",
        "baseline_section", "evidence_text", "neutral_capability_tags", "scope_notes",
        "verification_status", "retired", "notes",
    ]
    if headers != expected:
        raise ValueError("Core Evidence headers do not match the approved schema")
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for line in lines[header + 2:]:
        if not line.startswith("|"):
            break
        cells = [cell.strip().replace(r"\|", "|") for cell in line[1:-1].split("|")]
        if len(cells) != len(headers):
            raise ValueError("Core Evidence row has the wrong field count")
        row = dict(zip(headers, cells))
        if row["retired"].casefold() not in ("true", "false"):
            raise ValueError("Core Evidence row has invalid retired state")
        if row["retired"].casefold() == "true":
            continue
        evidence_id = row["evidence_id"]
        if evidence_id in seen:
            raise ValueError(f"duplicate evidence ID {evidence_id}")
        seen.add(evidence_id)
        records.append({
            "evidenceId": evidence_id,
            "claimWillingness": row["claim_willingness"],
            "baseline": row["baseline"],
            "employer": row["employer"],
            "roleTitle": row["role_title"],
            "dateRange": row["date_range"],
            "baselineSection": row["baseline_section"],
            "evidenceText": row["evidence_text"],
            "neutralCapabilityTags": [value.strip() for value in row["neutral_capability_tags"].split(";") if value.strip()],
            "scopeNotes": row["scope_notes"],
            "verificationStatus": row["verification_status"],
            "notes": row["notes"],
        })
    payload = {
        "schemaVersion": "career-dashboard-evidence-snapshot-v1",
        "sourcePath": source_path,
        "sourceHash": normalized_text_sha256(normalized),
        "records": records,
    }
    return {**payload, "evidenceHash": canonical_sha256(payload)}


def current_experience_v2_input_versions(repo_root: Path) -> dict[str, str]:
    evidence = _core_evidence_snapshot(repo_root)
    schema_hash = canonical_sha256([
        load_json(repo_root / "data/scoring/schemas/experience-export-v2.schema.json"),
        load_json(repo_root / "data/scoring/schemas/experience-result-v2.schema.json"),
    ])
    prompt_paths = [
        "data/scoring/prompts/experience-hard-gate-v1.md",
        "data/scoring/prompts/experience-holistic-v1.md",
    ]
    prompts_hash = canonical_sha256([
        {"path": path, "sha256": _file_hash(repo_root / path)} for path in prompt_paths
    ])
    policy = load_json(repo_root / "data/scoring/experience-policy-v2.json")
    runner = load_json(repo_root / "data/scoring/experience-runner-protocol-v2.json")
    resume_hash = _file_hash(repo_root / "data/resumes/JosephLamb_Resume.docx")
    input_hash = canonical_sha256({
        "kind": "experience_input_versions_v2",
        "protocolVersion": "career-dashboard-scoring-protocol-v2",
        "exportSchemaVersion": "career-dashboard-experience-export-v2",
        "policyHash": canonical_sha256(policy),
        "schemaHash": schema_hash,
        "resumeHash": resume_hash,
        "evidenceSourceHash": _file_hash(repo_root / "docs/Candidate_Evidence_Inventory_-_Core_v1.md"),
        "evidenceHash": evidence["evidenceHash"],
        "experienceControllerVersion": runner["controllerVersion"],
        "runnerProtocolHash": canonical_sha256(runner),
        "promptsHash": prompts_hash,
        "sourceContract": "canonical-original-jd-v1",
    })
    return {
        "policyVersion": policy["policyVersion"],
        "resumeHash": resume_hash,
        "evidenceHash": evidence["evidenceHash"],
        "inputVersionsHash": input_hash,
    }


def validate_current_experience_v2_export(exported: dict[str, Any], repo_root: Path) -> None:
    current = current_experience_v2_input_versions(repo_root)
    if exported["batch"]["policyVersion"] != current["policyVersion"]:
        raise ValueError("Experience v2 policy version is stale")
    if exported["resume"]["hash"] != current["resumeHash"]:
        raise ValueError("Experience v2 resume hash is stale")
    if exported["evidence"]["evidenceHash"] != current["evidenceHash"]:
        raise ValueError("Experience v2 evidence hash is stale")
    for job in exported["jobs"]:
        expected = canonical_sha256({
            "kind": "experience_batch_item_input_v2",
            "stage": "experience",
            "protocolVersion": exported["batch"]["protocolVersion"],
            "exportSchemaVersion": exported["batch"]["exportSchemaVersion"],
            "globalInputVersionsHash": current["inputVersionsHash"],
            "sourceAimEventId": job["sourceAimEventId"],
            "aimFactualExtractionId": job["aimFactualExtractionId"],
            "sourceJdHash": job["sourceJdHash"],
            "trustedMetadataHash": job["trustedMetadataHash"],
            "aimSemanticResultHash": job["aimSemanticResultHash"],
            "resumeHash": current["resumeHash"],
            "evidenceHash": current["evidenceHash"],
        })
        if job["inputHash"] != expected:
            raise ValueError(f"Experience v2 transport input hash mismatch at ordinal {job['ordinal']}")
