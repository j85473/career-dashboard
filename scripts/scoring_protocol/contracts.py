from __future__ import annotations

import re
import uuid
from pathlib import Path
from typing import Any

from .common import canonical_sha256, exact_codepoint_quote, load_json

HASH_RE = re.compile(r"^[a-f0-9]{64}$")


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


def _resolve(root: dict[str, Any], reference: str) -> dict[str, Any]:
    prefix = "#/$defs/"
    if not reference.startswith(prefix):
        raise ValueError(f"unsupported schema reference {reference}")
    definition = root.get("$defs", {}).get(reference[len(prefix):])
    if not isinstance(definition, dict):
        raise ValueError(f"unknown schema reference {reference}")
    return definition


def validate_schema(value: Any, schema: dict[str, Any], root: dict[str, Any] | None = None, path: str = "$") -> None:
    root = root or schema
    if "$ref" in schema:
        validate_schema(value, _resolve(root, schema["$ref"]), root, path)
        return
    for child in schema.get("allOf", []):
        validate_schema(value, child, root, path)
    if "anyOf" in schema:
        if not any(_valid(value, child, root, path) for child in schema["anyOf"]):
            raise ValueError(f"{path} does not match any allowed schema")
    if "oneOf" in schema:
        if sum(_valid(value, child, root, path) for child in schema["oneOf"]) != 1:
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
        if isinstance(schema.get("items"), dict):
            for index, item in enumerate(value):
                validate_schema(item, schema["items"], root, f"{path}[{index}]")
    if isinstance(value, dict):
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
                validate_schema(value[key], child, root, f"{path}.{key}")


def _valid(value: Any, schema: dict[str, Any], root: dict[str, Any], path: str) -> bool:
    try:
        validate_schema(value, schema, root, path)
        return True
    except ValueError:
        return False


def schema_path(repo_root: Path, schema_version: str) -> Path:
    names = {
        "career-dashboard-aim-export-v1": "aim-export-v1.schema.json",
        "career-dashboard-aim-result-v1": "aim-result-v1.schema.json",
        "career-dashboard-experience-export-v1": "experience-export-v1.schema.json",
        "career-dashboard-experience-result-v1": "experience-result-v1.schema.json",
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
    validate_schema(value, schema)
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
        expected = canonical_sha256({key: item for key, item in value.items() if key != "resultHash"})
        if value["resultHash"] != expected:
            raise ValueError("full-file resultHash mismatch")
    for item in value.get("results", []):
        if item["resultHash"] != canonical_sha256({key: entry for key, entry in item.items() if key != "resultHash"}):
            raise ValueError(f"resultHash mismatch for {item['jobId']}")


def validate_export(value: dict[str, Any], repo_root: Path, expected_stage: str) -> None:
    validate_exchange(value, repo_root)
    batch = value["batch"]
    if batch["stage"] != expected_stage:
        raise ValueError(f"expected {expected_stage} export")
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


def validate_result_against_export(result: dict[str, Any], exported: dict[str, Any], repo_root: Path) -> None:
    validate_exchange(result, repo_root)
    for key in ("id", "stage", "protocolVersion", "policyVersion", "manifestHash"):
        if result["batch"][key] != exported["batch"][key]:
            raise ValueError(f"result batch {key} mismatch")
    if len(result["results"]) != len(exported["jobs"]):
        raise ValueError("result has partial or extra membership")
    for index, (item, job) in enumerate(zip(result["results"], exported["jobs"])):
        if (item["jobId"], item["ordinal"], item["inputHash"]) != (job["jobId"], job["ordinal"], job["inputHash"]):
            raise ValueError(f"result membership mismatch at ordinal {index}")


def validate_span(source: str, span: dict[str, Any]) -> None:
    exact_codepoint_quote(source, span["startCodePoint"], span["endCodePoint"], span["exactQuote"])
