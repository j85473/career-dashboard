from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any

from .common import load_json


def _closed(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {"type": "object", "additionalProperties": False, "required": required, "properties": properties}


def _explicit_primitive_types(value: Any) -> None:
    if isinstance(value, list):
        for child in value:
            _explicit_primitive_types(child)
        return
    if not isinstance(value, dict):
        return
    if "type" not in value:
        candidates = value.get("enum")
        if candidates is None and "const" in value:
            candidates = [value["const"]]
        if isinstance(candidates, list) and candidates:
            if all(isinstance(candidate, str) for candidate in candidates):
                value["type"] = "string"
            elif all(isinstance(candidate, bool) for candidate in candidates):
                value["type"] = "boolean"
            elif all(isinstance(candidate, int) and not isinstance(candidate, bool) for candidate in candidates):
                value["type"] = "integer"
    for child in value.values():
        _explicit_primitive_types(child)


def _structured_output_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Make the unchanged exchange contract valid and minimal for a worker."""
    value = deepcopy(schema)
    all_defs = value.pop("$defs", {})
    referenced: set[str] = set()

    def collect(node: Any) -> None:
        if isinstance(node, list):
            for child in node:
                collect(child)
            return
        if not isinstance(node, dict):
            return
        reference = node.get("$ref")
        if isinstance(reference, str) and reference.startswith("#/$defs/"):
            name = reference[len("#/$defs/"):]
            if name not in referenced:
                if name not in all_defs:
                    raise ValueError(f"worker schema references unknown definition {name}")
                referenced.add(name)
                collect(all_defs[name])
        for child in node.values():
            collect(child)

    collect(value)
    if referenced:
        value["$defs"] = {name: deepcopy(all_defs[name]) for name in sorted(referenced)}
    _explicit_primitive_types(value)
    return value


def aim_worker_schemas(repo_root: Path) -> dict[str, dict[str, Any]]:
    schema = load_json(repo_root / "data/scoring/schemas/aim-factual-worker-response-v1.schema.json")
    for key in ("$schema", "$id", "schemaVersion"):
        schema.pop(key, None)
    return {"factual": schema}


def experience_worker_schemas(repo_root: Path) -> dict[str, dict[str, Any]]:
    final = load_json(repo_root / "data/scoring/schemas/experience-result-v1.schema.json")
    defs = deepcopy(final["$defs"])
    evaluation = defs["evaluation"]
    return {
        "requirement_extractor": _structured_output_schema(_closed({"criteria": evaluation["properties"]["criteria"]}, ["criteria"]) | {"$defs": defs}),
        "requirement_coverage_auditor": _structured_output_schema(deepcopy(evaluation["properties"]["coverageAudit"]) | {"$defs": defs}),
        "evidence_evaluator": _structured_output_schema(_closed({"outcomes": evaluation["properties"]["outcomes"]}, ["outcomes"]) | {"$defs": defs}),
    }
