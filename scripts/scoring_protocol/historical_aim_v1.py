from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from .common import PROTOCOL_VERSION, canonical_sha256, load_json, normalized_text_sha256

# Read-only compatibility authority for validating already-stored Aim v1 artifacts.
HISTORICAL_AIM_V1_CLEANER_VERSION = "jd-cleaner-v3"
HISTORICAL_AIM_V1_RUNNER_PROMPT_VERSION = "aim-question-workers-v4"
HISTORICAL_AIM_V1_INPUT_VERSION_HASHES = (
    "efdd2c89daeb2e811fce3b09c0b1e2cdc9282680d40da463484d407a15f2a12c",
)


def _file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _files_hash(repo_root: Path, paths: list[str]) -> str:
    return canonical_sha256([
        {"path": path, "sha256": _file_sha256(repo_root / path)}
        for path in paths
    ])


def historical_aim_v1_input_versions(repo_root: Path) -> dict[str, str]:
    aim_policy_hash = canonical_sha256(load_json(repo_root / "data/scoring/aim-policy-v1.json"))
    employer_overrides_hash = canonical_sha256(load_json(repo_root / "data/scoring/aim-employer-overrides-v1.json"))
    aim_schema_hash = canonical_sha256([
        load_json(repo_root / "data/scoring/schemas/aim-export-v1.schema.json"),
        load_json(repo_root / "data/scoring/schemas/aim-result-v1.schema.json"),
    ])
    runner_protocol_hash = canonical_sha256(load_json(repo_root / "data/scoring/runner-protocol-v1.json"))
    aim_prompts_hash = _files_hash(repo_root, [
        "data/scoring/prompts/jd-cleaner-v3.md",
        "data/scoring/prompts/jd-coverage-auditor-v2.md",
        "data/scoring/prompts/aim-evaluator-v3.md",
    ])
    aim_input_versions_hash = canonical_sha256({
        "protocolVersion": PROTOCOL_VERSION,
        "policyHash": aim_policy_hash,
        "employerOverridesHash": employer_overrides_hash,
        "schemaHash": aim_schema_hash,
        "cleanerVersion": HISTORICAL_AIM_V1_CLEANER_VERSION,
        "runnerProtocolHash": runner_protocol_hash,
        "promptsHash": aim_prompts_hash,
    })
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "aimPolicyHash": aim_policy_hash,
        "employerOverridesHash": employer_overrides_hash,
        "aimInputVersionsHash": aim_input_versions_hash,
    }


def historical_aim_v1_input_hash(
    job: dict[str, Any], versions: dict[str, str], global_input_versions_hash: str | None = None
) -> str:
    return canonical_sha256({
        "stage": "aim",
        "protocolVersion": versions["protocolVersion"],
        "schemaVersion": "career-dashboard-aim-export-v1",
        "globalInputVersionsHash": global_input_versions_hash or versions["aimInputVersionsHash"],
        "policyHash": versions["aimPolicyHash"],
        "sourceJdHash": job["sourceJdHash"],
        "metadataHash": job["metadataHash"],
        "employerOverridesHash": versions["employerOverridesHash"],
        "preferencesHash": versions["aimPolicyHash"],
    })


def validate_historical_aim_v1_export(exported: dict[str, Any], repo_root: Path) -> None:
    versions = historical_aim_v1_input_versions(repo_root)
    batch = exported["batch"]
    preferences = exported["preferences"]
    if batch["protocolVersion"] != versions["protocolVersion"]:
        raise ValueError("historical Aim export protocol version is stale")
    if preferences["policyHash"] != versions["aimPolicyHash"]:
        raise ValueError("historical Aim export policy hash is stale")
    if preferences["employerOverridesHash"] != versions["employerOverridesHash"]:
        raise ValueError("historical Aim export employer-overrides hash is stale")
    if canonical_sha256(preferences["employerOverrides"]) != versions["employerOverridesHash"]:
        raise ValueError("historical Aim export employer overrides do not match their hash")
    compatible_hashes = {versions["aimInputVersionsHash"], *HISTORICAL_AIM_V1_INPUT_VERSION_HASHES}
    cohort_matches = set(compatible_hashes)
    for job in exported["jobs"]:
        if normalized_text_sha256(job["originalJd"]) != job["sourceJdHash"]:
            raise ValueError(f"historical Aim export source JD hash mismatch at ordinal {job['ordinal']}")
        metadata_hash = canonical_sha256({
            "company": job["company"], "title": job["title"], "location": job["location"], "sourceUrl": job["sourceUrl"],
        })
        if metadata_hash != job["metadataHash"]:
            raise ValueError(f"historical Aim export metadata hash mismatch at ordinal {job['ordinal']}")
        job_matches = {
            version_hash for version_hash in compatible_hashes
            if historical_aim_v1_input_hash(job, versions, version_hash) == job["inputHash"]
        }
        cohort_matches.intersection_update(job_matches)
        if not cohort_matches:
            raise ValueError(f"historical Aim export input versions are stale at ordinal {job['ordinal']}")
