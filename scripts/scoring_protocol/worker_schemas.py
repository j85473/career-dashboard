from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any

from .common import load_json


def _closed(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {"type": "object", "additionalProperties": False, "required": required, "properties": properties}


def aim_worker_schemas(repo_root: Path) -> dict[str, dict[str, Any]]:
    final = load_json(repo_root / "data/scoring/schemas/aim-result-v1.schema.json")
    defs = deepcopy(final["$defs"])
    cleaned = defs["cleanedArtifact"]
    evaluation = defs["evaluation"]
    return {
        "jd_cleaner": _closed(
            {"cleanedText": cleaned["properties"]["cleanedText"], "removedSpans": cleaned["properties"]["removedSpans"]},
            ["cleanedText", "removedSpans"],
        ) | {"$defs": defs},
        "jd_coverage_auditor": deepcopy(cleaned["properties"]["coverageAudit"]) | {"$defs": defs},
        "aim_evaluator": _closed(
            {key: evaluation["properties"][key] for key in ("hardStops", "rubric", "travel", "compensation")},
            ["hardStops", "rubric", "travel", "compensation"],
        ) | {"$defs": defs},
    }


def experience_worker_schemas(repo_root: Path) -> dict[str, dict[str, Any]]:
    final = load_json(repo_root / "data/scoring/schemas/experience-result-v1.schema.json")
    defs = deepcopy(final["$defs"])
    evaluation = defs["evaluation"]
    return {
        "requirement_extractor": _closed({"criteria": evaluation["properties"]["criteria"]}, ["criteria"]) | {"$defs": defs},
        "requirement_coverage_auditor": deepcopy(evaluation["properties"]["coverageAudit"]) | {"$defs": defs},
        "evidence_evaluator": _closed({"outcomes": evaluation["properties"]["outcomes"]}, ["outcomes"]) | {"$defs": defs},
    }
