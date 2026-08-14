from __future__ import annotations

import re
import uuid
from pathlib import Path
from typing import Any

from .aim_identity import (
    extraction_identity,
    result_envelope_hash,
    result_item_hash,
    source_identity,
    source_jd_hash,
    trusted_metadata_hash,
)
from .common import canonical_json, canonical_sha256, exact_codepoint_quote, load_json, normalize_source_text
from .historical_aim_v1 import validate_historical_aim_v1_export

HASH_RE = re.compile(r"^[a-f0-9]{64}$")
MAX_AIM_V2_RESULT_BYTES = 31_000_000
MAX_AIM_V2_RESULT_ITEM_BYTES = 1_500_000
MAX_AIM_V2_UNIQUE_EVIDENCE_CODE_POINTS = 160_000


def _record(value: Any) -> bool:
    return isinstance(value, dict)


def _type_matches(value: Any, kind: str) -> bool:
    if kind == "null":
        return value is None
    if kind == "object":
        return isinstance(value, dict)
    if kind == "array":
        return isinstance(value, list)
    if kind == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if kind == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "string":
        return isinstance(value, str)
    return False


def _resolve(
    root: dict[str, Any], reference: str, external_schemas: dict[str, dict[str, Any]]
) -> tuple[dict[str, Any], dict[str, Any]]:
    prefix = "#/$defs/"
    if reference.startswith(prefix):
        definition = root.get("$defs", {}).get(reference[len(prefix):])
        if not isinstance(definition, dict):
            raise ValueError(f"unknown schema reference {reference}")
        return definition, root
    definition = external_schemas.get(reference)
    if not isinstance(definition, dict):
        raise ValueError(f"unsupported schema reference {reference}")
    return definition, definition


def validate_schema(
    value: Any,
    schema: dict[str, Any],
    root: dict[str, Any] | None = None,
    path: str = "$",
    external_schemas: dict[str, dict[str, Any]] | None = None,
) -> None:
    root = root or schema
    external_schemas = external_schemas or {}
    if "$ref" in schema:
        resolved, resolved_root = _resolve(root, schema["$ref"], external_schemas)
        validate_schema(value, resolved, resolved_root, path, external_schemas)
        return
    for child in schema.get("allOf", []):
        validate_schema(value, child, root, path, external_schemas)
    if "anyOf" in schema:
        if not any(_valid(value, child, root, path, external_schemas) for child in schema["anyOf"]):
            raise ValueError(f"{path} does not match any allowed schema")
    if "oneOf" in schema:
        if sum(_valid(value, child, root, path, external_schemas) for child in schema["oneOf"]) != 1:
            raise ValueError(f"{path} must match exactly one allowed schema")
    if "const" in schema and value != schema["const"]:
        raise ValueError(f"{path} has the wrong constant value")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"{path} contains an unknown enum value")
    if "type" in schema:
        kinds = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_type_matches(value, kind) for kind in kinds):
            raise ValueError(f"{path} has the wrong type")
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            raise ValueError(f"{path} is too short")
        if len(value) > schema.get("maxLength", len(value)):
            raise ValueError(f"{path} is too long")
        if "pattern" in schema and re.search(schema["pattern"], value) is None:
            raise ValueError(f"{path} has invalid format")
        if schema.get("format") == "uuid":
            try:
                uuid.UUID(value)
            except (ValueError, AttributeError) as error:
                raise ValueError(f"{path} is not a UUID") from error
    if isinstance(value, int) and not isinstance(value, bool):
        if value < schema.get("minimum", value):
            raise ValueError(f"{path} is below minimum")
        if value > schema.get("maximum", value):
            raise ValueError(f"{path} exceeds maximum")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            raise ValueError(f"{path} has too few items")
        if len(value) > schema.get("maxItems", len(value)):
            raise ValueError(f"{path} has too many items")
        if schema.get("uniqueItems") is True:
            serialized = [str(item) if not isinstance(item, (dict, list)) else repr(item) for item in value]
            if len(serialized) != len(set(serialized)):
                raise ValueError(f"{path} contains duplicate items")
        if isinstance(schema.get("items"), dict):
            for index, item in enumerate(value):
                validate_schema(item, schema["items"], root, f"{path}[{index}]", external_schemas)
    if isinstance(value, dict):
        if len(value) < schema.get("minProperties", 0):
            raise ValueError(f"{path} has too few properties")
        if len(value) > schema.get("maxProperties", len(value)):
            raise ValueError(f"{path} has too many properties")
        properties = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                raise ValueError(f"{path}.{key} is required")
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in properties:
                    raise ValueError(f"{path}.{key} is not allowed")
        for key, child in properties.items():
            if key in value:
                validate_schema(value[key], child, root, f"{path}.{key}", external_schemas)
        additional = schema.get("additionalProperties")
        if isinstance(additional, dict):
            for key in value:
                if key not in properties:
                    validate_schema(value[key], additional, root, f"{path}.{key}", external_schemas)


def _valid(
    value: Any,
    schema: dict[str, Any],
    root: dict[str, Any],
    path: str,
    external_schemas: dict[str, dict[str, Any]],
) -> bool:
    try:
        validate_schema(value, schema, root, path, external_schemas)
        return True
    except ValueError:
        return False


def schema_path(repo_root: Path, schema_version: str) -> Path:
    names = {
        "career-dashboard-aim-export-v1": "aim-export-v1.schema.json",
        "career-dashboard-aim-result-v1": "aim-result-v1.schema.json",
        "career-dashboard-aim-export-v2": "aim-export-v2.schema.json",
        "career-dashboard-aim-result-v2": "aim-result-v2.schema.json",
        "career-dashboard-experience-export-v1": "experience-export-v1.schema.json",
        "career-dashboard-experience-result-v1": "experience-result-v1.schema.json",
        "career-dashboard-experience-export-v2": "experience-export-v2.schema.json",
        "career-dashboard-experience-result-v2": "experience-result-v2.schema.json",
    }
    try:
        return repo_root / "data" / "scoring" / "schemas" / names[schema_version]
    except KeyError as error:
        raise ValueError(f"unsupported schemaVersion {schema_version}") from error


def validate_exchange(value: dict[str, Any], repo_root: Path) -> None:
    version = value.get("schemaVersion")
    if not isinstance(version, str):
        raise ValueError("schemaVersion is required")
    schema = load_json(schema_path(repo_root, version))
    external_schemas = {
        "career-dashboard-aim-factual-vector-v1": load_json(
            repo_root / "data/scoring/schemas/aim-factual-vector-v1.schema.json"
        )
    }
    validate_schema(value, schema, external_schemas=external_schemas)
    members = value.get("jobs", value.get("results", []))
    seen: set[str] = set()
    for index, item in enumerate(members):
        if item.get("ordinal") != index:
            raise ValueError(f"member {index} has an invalid ordinal")
        job_id = item.get("jobId")
        if not isinstance(job_id, str) or job_id in seen:
            raise ValueError(f"member {index} has a duplicate or invalid job ID")
        seen.add(job_id)
    if "resultHash" in value:
        without_hash = {key: item for key, item in value.items() if key != "resultHash"}
        expected = result_envelope_hash(without_hash) if version == "career-dashboard-aim-result-v2" else canonical_sha256(without_hash)
        if value["resultHash"] != expected:
            raise ValueError("full-file resultHash mismatch")
    for item in value.get("results", []):
        without_hash = {key: entry for key, entry in item.items() if key != "resultHash"}
        expected = result_item_hash(without_hash) if version == "career-dashboard-aim-result-v2" else canonical_sha256(without_hash)
        if item["resultHash"] != expected:
            raise ValueError(f"resultHash mismatch for {item['jobId']}")
    if version == "career-dashboard-aim-result-v2":
        _validate_aim_v2_result_bounds(value)


def _validate_aim_v2_result_bounds(value: dict[str, Any]) -> None:
    if len(canonical_json(value).encode("utf-8")) > MAX_AIM_V2_RESULT_BYTES:
        raise ValueError("Aim v2 result exceeds its batch byte contract")
    batch = value["batch"]
    controller = value["controller"]
    if (
        controller["controllerVersion"] != "career-dashboard-aim-controller-v5"
        or controller["promptContractVersion"] != batch["promptContractVersion"]
        or controller["responseContractVersion"] != batch["responseContractVersion"]
        or controller["completedAt"] < controller["startedAt"]
    ):
        raise ValueError("Aim v2 controller authority or timestamps are inconsistent")
    workers: list[dict[str, Any]] = []
    for index, item in enumerate(value["results"]):
        if len(canonical_json(item).encode("utf-8")) > MAX_AIM_V2_RESULT_ITEM_BYTES:
            raise ValueError(f"Aim v2 result item {index} exceeds its byte contract")
        for worker in item["workers"]:
            if (
                worker["completedAt"] < worker["startedAt"]
                or worker["startedAt"] < controller["startedAt"]
                or worker["completedAt"] > controller["completedAt"]
            ):
                raise ValueError(f"Aim v2 worker {index} timestamps are inconsistent")
            workers.append(worker)
        vector = item["result"].get("factualVector")
        if vector is None:
            continue
        evidence_points = sum(len(entry["exactQuote"]) for entry in vector["evidenceCatalog"])
        if evidence_points > MAX_AIM_V2_UNIQUE_EVIDENCE_CODE_POINTS:
            raise ValueError(f"Aim v2 evidence catalog exceeds its code-point contract at ordinal {index}")
        manifests = {packet["packetManifestHash"] for packet in vector["provenance"]["packets"]}
        factual_workers = [worker for worker in item["workers"] if worker["effort"] == "medium"]
        holistic_workers = [worker for worker in item["workers"] if worker["effort"] == "high"]
        if any(worker["packetManifestHash"] not in manifests for worker in factual_workers):
            raise ValueError(f"Aim v2 worker packet binding is missing at ordinal {index}")
        expected_holistic = 1 if item["result"]["variant"] == "scored_survivor" else 0
        if len(holistic_workers) != expected_holistic:
            raise ValueError(f"Aim v2 holistic worker count is invalid at ordinal {index}")
        if any(worker["packetManifestHash"] in manifests for worker in holistic_workers):
            raise ValueError(f"Aim v2 holistic worker reused a factual packet binding at ordinal {index}")
    if controller["totalModelCalls"] != len(workers):
        raise ValueError("Aim v2 controller model-call count does not match worker receipts")
    models = controller["models"]
    if (len(workers) == 0) != (len(models) == 0):
        raise ValueError("Aim v2 controller model provenance is inconsistent with its call count")
    if workers:
        model_names = {entry["model"] for entry in models}
        if len(model_names) != 1:
            raise ValueError("Aim v2 production controller must use one selected model")
        selected_model = next(iter(model_names))
        efforts: list[str] = []
        for worker in workers:
            if worker["effort"] not in efforts:
                efforts.append(worker["effort"])
        if models != [{"model": selected_model, "effort": effort} for effort in efforts]:
            raise ValueError("Aim v2 controller model/effort provenance does not match worker receipts")
        for index, item in enumerate(value["results"]):
            vector = item["result"].get("factualVector")
            if vector is None:
                continue
            packet_models = {
                packet["packetManifestHash"]: packet["model"]
                for packet in vector["provenance"]["packets"]
            }
            factual_workers = [worker for worker in item["workers"] if worker["effort"] == "medium"]
            if any(packet_models[worker["packetManifestHash"]] != selected_model for worker in factual_workers):
                raise ValueError(f"Aim v2 worker model does not match its packet at ordinal {index}")
    expected_receipt = f"aim-two-stage-calls:{len(workers)};run:{batch['id']}"
    if controller["invocationReceipt"] != expected_receipt:
        raise ValueError("Aim v2 controller invocation receipt does not bind its batch and call count")


def validate_export(value: dict[str, Any], repo_root: Path, expected_stage: str) -> None:
    validate_exchange(value, repo_root)
    batch = value["batch"]
    if batch["stage"] != expected_stage:
        raise ValueError(f"expected {expected_stage} export")
    if value["schemaVersion"] == "career-dashboard-aim-export-v2":
        manifest = {
            "kind": "aim_export_manifest_v2",
            "batchId": batch["id"],
            "stage": batch["stage"],
            "protocolVersion": batch["protocolVersion"],
            "exportSchemaVersion": batch["exportSchemaVersion"],
            "scoringPolicyVersion": batch["scoringPolicyVersion"],
            "questionRegistryHash": batch["questionRegistryHash"],
            "promptContractHash": batch["promptContractHash"],
            "responseContractHash": batch["responseContractHash"],
            "packetStrategyHash": batch["packetStrategyHash"],
            "items": [
                {"ordinal": job["ordinal"], "jobId": job["jobId"], "inputHash": job["inputHash"]}
                for job in value["jobs"]
            ],
        }
    else:
        manifest = {
            "batchId": batch["id"],
            "stage": batch["stage"],
            "schemaVersion": value["schemaVersion"],
            "protocolVersion": batch["protocolVersion"],
            "policyVersion": batch["policyVersion"],
            "items": [
                {"ordinal": job["ordinal"], "jobId": job["jobId"], "inputHash": job["inputHash"]}
                for job in value["jobs"]
            ],
        }
    if canonical_sha256(manifest) != batch["manifestHash"]:
        raise ValueError("export manifestHash mismatch")
    if value["schemaVersion"] == "career-dashboard-aim-export-v2":
        for job in value["jobs"]:
            source = job["source"]["originalJd"]
            metadata = job["trustedMetadata"]
            if source != normalize_source_text(source):
                raise ValueError(f"Aim export source is not canonical at ordinal {job['ordinal']}")
            if source_jd_hash(source) != job["source"]["sourceJdHash"]:
                raise ValueError(f"Aim export source JD hash mismatch at ordinal {job['ordinal']}")
            metadata_hash = trusted_metadata_hash(metadata)
            if metadata_hash != job["trustedMetadataHash"]:
                raise ValueError(f"Aim export trusted metadata hash mismatch at ordinal {job['ordinal']}")
            source_id = source_identity(job["source"]["sourceJdHash"], metadata_hash)
            if source_id != job["sourceIdentity"]:
                raise ValueError(f"Aim export source identity mismatch at ordinal {job['ordinal']}")
            extraction_id = extraction_identity({"sourceIdentity": source_id, **{
                key: batch[key] for key in (
                    "questionRegistryVersion", "questionRegistryHash", "promptContractVersion", "promptContractHash",
                    "responseContractVersion", "responseContractHash", "packetStrategyVersion", "packetStrategyHash",
                    "canonicalizationVersion", "anonymizationPolicyVersion", "anonymizationPolicyHash", "extractorSemanticVersion",
                )
            }})
            if extraction_id != job["extractionIdentity"]:
                raise ValueError(f"Aim export extraction identity mismatch at ordinal {job['ordinal']}")
            expected_input_hash = canonical_sha256({
                "kind": "aim_batch_item_input_v2",
                "stage": "aim",
                "protocolVersion": batch["protocolVersion"],
                "exportSchemaVersion": batch["exportSchemaVersion"],
                "sourceIdentity": source_id,
                "extractionIdentity": extraction_id,
                "scoringPolicyHash": batch["scoringPolicyHash"],
                "runnerProtocolHash": batch["runnerProtocolHash"],
            })
            if expected_input_hash != job["inputHash"]:
                raise ValueError(f"Aim export input hash mismatch at ordinal {job['ordinal']}")
    elif value["schemaVersion"] == "career-dashboard-experience-export-v2":
        for job in value["jobs"]:
            source = job["originalJd"]
            metadata = job["trustedMetadata"]
            if source != normalize_source_text(source):
                raise ValueError(f"Experience export source is not canonical at ordinal {job['ordinal']}")
            if source_jd_hash(source) != job["sourceJdHash"]:
                raise ValueError(f"Experience export source JD hash mismatch at ordinal {job['ordinal']}")
            if trusted_metadata_hash(metadata) != job["trustedMetadataHash"]:
                raise ValueError(f"Experience export trusted metadata hash mismatch at ordinal {job['ordinal']}")
    elif expected_stage == "aim":
        validate_historical_aim_v1_export(value, repo_root)


def validate_result_against_export(result: dict[str, Any], exported: dict[str, Any], repo_root: Path) -> None:
    validate_exchange(result, repo_root)
    if result["schemaVersion"] == "career-dashboard-aim-result-v2":
        keys = [key for key in exported["batch"] if key not in ("createdAt", "expiresAt")]
        keys.remove("exportSchemaVersion")
        if result["batch"]["exportSchemaVersion"] != exported["batch"]["exportSchemaVersion"]:
            raise ValueError("result batch exportSchemaVersion mismatch")
    elif result["schemaVersion"] == "career-dashboard-experience-result-v2":
        keys = ("id", "stage", "protocolVersion", "exportSchemaVersion", "policyVersion", "manifestHash")
        if result["batch"]["resultSchemaVersion"] != "career-dashboard-experience-result-v2":
            raise ValueError("Experience result batch resultSchemaVersion mismatch")
        if result["resumeHash"] != exported["resume"]["hash"]:
            raise ValueError("Experience result resumeHash mismatch")
        if result["evidenceHash"] != exported["evidence"]["evidenceHash"]:
            raise ValueError("Experience result evidenceHash mismatch")
    else:
        keys = ("id", "stage", "protocolVersion", "policyVersion", "manifestHash")
    for key in keys:
        if result["batch"][key] != exported["batch"][key]:
            raise ValueError(f"result batch {key} mismatch")
    if len(result["results"]) != len(exported["jobs"]):
        raise ValueError("result has partial or extra membership")
    for index, (item, job) in enumerate(zip(result["results"], exported["jobs"])):
        if (item["jobId"], item["ordinal"], item["inputHash"]) != (job["jobId"], job["ordinal"], job["inputHash"]):
            raise ValueError(f"result membership mismatch at ordinal {index}")
        if result["schemaVersion"] == "career-dashboard-aim-result-v2":
            if item["sourceJdHash"] != job["source"]["sourceJdHash"] or item["trustedMetadataHash"] != job["trustedMetadataHash"]:
                raise ValueError(f"result source binding mismatch at ordinal {index}")
        elif result["schemaVersion"] == "career-dashboard-experience-result-v2":
            for key in (
                "sourceAimEventId", "aimFactualExtractionId", "sourceJdHash",
                "trustedMetadataHash", "aimSemanticResultHash",
            ):
                if item[key] != job[key]:
                    raise ValueError(f"Experience result {key} mismatch at ordinal {index}")


def validate_span(source: str, span: dict[str, Any]) -> None:
    exact_codepoint_quote(source, span["startCodePoint"], span["endCodePoint"], span["exactQuote"])
