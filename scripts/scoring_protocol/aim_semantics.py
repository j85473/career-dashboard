from __future__ import annotations

import re
from typing import Any

from .common import normalize_source_text


MODEL_HARD_STOP_CODES = (
    "inside_sales",
    "personal_hunting_over_one_third",
    "non_minneapolis_base_required",
    "part_time_temporary_contract_or_1099",
    "consumer_store_sales",
    "local_insurance_agency",
)

FIT_ANSWER_DEFAULTS = {
    "coreWork": "unclear",
    "buildingAutonomy": "unclear",
    "productIndustry": "neutral_or_unclear",
    "travel": "none_or_unstated",
}

FIT_ANSWER_TO_POLICY_BAND = {
    "coreWork": {
        "exceptional_archetype": "exceptional_archetype",
        "strong_fit": "strong_fit",
        "acceptable_fit": "acceptable_fit",
        "weaker_but_eligible": "weaker_but_eligible",
        "not_specified": "unclear",
    },
    "buildingAutonomy": {
        "ground_floor_or_major_ownership": "ground_floor_or_major_ownership",
        "strong_ownership_or_growth": "strong_ownership_or_growth",
        "some_influence": "some_influence",
        "little_building_or_autonomy": "little_building_or_autonomy",
        "not_specified": "unclear",
    },
    "productIndustry": {
        "highly_fascinating": "highly_fascinating",
        "interesting_technology": "interesting_technology",
        "slight_positive": "slight_positive",
        "neutral": "neutral_or_unclear",
        "not_specified": "neutral_or_unclear",
    },
    "travel": {
        "international": "international",
        "national_air": "national_air",
        "overnight_regional": "overnight_regional",
        "local_territory": "local_territory",
        "mode_unspecified": "mode_unspecified",
        "none": "none_or_unstated",
        "not_specified": "none_or_unstated",
    },
}

_REMOVAL_CLASSES = {
    "legal_boilerplate",
    "benefits",
    "application_instructions",
    "privacy_or_cookie",
    "navigation_or_debris",
    "employer_marketing",
    "duplicate",
}
_MAX_BLOCK_CODEPOINTS = 1600
_MIN_SPLIT_CODEPOINTS = 400
_SEMANTIC_BOUNDARY = re.compile(
    r"\n+|(?<=[.!?])(?:[ \t]+)(?=(?:[A-Z0-9#*•]|[-–—][ \t]))",
    re.UNICODE,
)


def _split_long_range(source: str, start: int, end: int) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    cursor = start
    while end - cursor > _MAX_BLOCK_CODEPOINTS:
        search_start = cursor + _MIN_SPLIT_CODEPOINTS
        search_end = cursor + _MAX_BLOCK_CODEPOINTS
        cut = max(source.rfind(" ", search_start, search_end), source.rfind("\t", search_start, search_end))
        if cut < search_start:
            cut = search_end
        elif cut < end:
            cut += 1
        ranges.append((cursor, cut))
        cursor = cut
    if cursor < end:
        ranges.append((cursor, end))
    return ranges


def segment_jd(source: str) -> list[dict[str, Any]]:
    """Partition one normalized JD into stable, source-addressable semantic blocks."""
    normalized = normalize_source_text(source)
    if not normalized.strip():
        raise ValueError("job description is empty after normalization")
    boundaries = [match.end() for match in _SEMANTIC_BOUNDARY.finditer(normalized)]
    if not boundaries or boundaries[-1] != len(normalized):
        boundaries.append(len(normalized))
    ranges: list[tuple[int, int]] = []
    start = 0
    for end in boundaries:
        if end <= start:
            continue
        if not normalized[start:end].strip():
            continue
        ranges.extend(_split_long_range(normalized, start, end))
        start = end
    if start < len(normalized):
        if ranges:
            ranges[-1] = (ranges[-1][0], len(normalized))
        else:
            ranges.append((0, len(normalized)))
    if ranges and ranges[0][0] != 0:
        ranges[0] = (0, ranges[0][1])
    for index in range(1, len(ranges)):
        if ranges[index - 1][1] != ranges[index][0]:
            ranges[index] = (ranges[index - 1][1], ranges[index][1])
    blocks = [
        {
            "id": f"J{index:04d}",
            "text": normalized[start:end],
            "startCodePoint": start,
            "endCodePoint": end,
        }
        for index, (start, end) in enumerate(ranges, start=1)
    ]
    if "".join(block["text"] for block in blocks) != normalized:
        raise ValueError("JD block segmentation did not preserve the normalized source")
    return blocks


def proposed_cleaner_removals(
    blocks: list[dict[str, Any]], output: dict[str, Any]
) -> tuple[list[dict[str, str]], list[str]]:
    by_id = {block["id"]: block for block in blocks}
    seen: set[str] = set()
    proposals: list[dict[str, str]] = []
    findings: list[str] = []
    for raw in output.get("removals", []):
        block_id = raw.get("blockId")
        classification = raw.get("classification")
        if block_id not in by_id:
            findings.append(f"Ignored unknown cleaner block ID {block_id!r}.")
            continue
        if block_id in seen:
            findings.append(f"Ignored duplicate cleaner block ID {block_id}.")
            continue
        if classification not in _REMOVAL_CLASSES:
            findings.append(f"Ignored invalid cleaner classification for {block_id}.")
            continue
        seen.add(block_id)
        proposals.append({"blockId": block_id, "classification": classification})
    order = {block["id"]: index for index, block in enumerate(blocks)}
    proposals.sort(key=lambda item: order[item["blockId"]])
    if len(proposals) == len(blocks):
        findings.append("Cleaner proposed removing every JD block; retained the complete JD instead.")
        proposals = []
    return proposals, findings


def materialize_cleaning(
    source: str,
    blocks: list[dict[str, Any]],
    proposals: list[dict[str, str]],
    restore_block_ids: list[str],
    findings: list[str] | None = None,
) -> dict[str, Any]:
    """Apply block selections in code. Cleaning can only retain more text, never fail a job."""
    normalized = normalize_source_text(source)
    by_id = {block["id"]: block for block in blocks}
    proposed_by_id = {item["blockId"]: item for item in proposals}
    restored: set[str] = set()
    messages = list(findings or [])
    for block_id in restore_block_ids:
        if block_id not in proposed_by_id:
            messages.append(f"Ignored non-proposed coverage restore ID {block_id!r}.")
            continue
        restored.add(block_id)
    if restored:
        messages.append(f"Coverage review restored {', '.join(sorted(restored))}.")
    removed_ids = set(proposed_by_id) - restored
    retained_blocks = [block for block in blocks if block["id"] not in removed_ids]
    cleaned_text = "".join(block["text"] for block in retained_blocks)
    if not cleaned_text.strip():
        messages.append("Cleaning would have produced an empty JD; retained the complete JD instead.")
        removed_ids.clear()
        retained_blocks = list(blocks)
        cleaned_text = normalized
    removed_spans = [
        {
            "startCodePoint": block["startCodePoint"],
            "endCodePoint": block["endCodePoint"],
            "exactQuote": block["text"],
            "classification": proposed_by_id[block["id"]]["classification"],
        }
        for block in blocks
        if block["id"] in removed_ids
    ]
    if cleaned_text != "".join(block["text"] for block in blocks if block["id"] not in removed_ids):
        raise ValueError("cleaned JD was not reconstructed from retained source blocks")
    return {
        "cleanedText": cleaned_text,
        "removedSpans": removed_spans,
        "retainedBlocks": retained_blocks,
        "coverageAudit": {"complete": True, "findings": messages[:1024]},
        "repairHistory": [],
    }


def aim_evaluator_payload(job: dict[str, Any], retained_blocks: list[dict[str, Any]]) -> dict[str, Any]:
    """Build the sole evaluator source packet; originalJd and cleanedText are intentionally absent."""
    metadata = [
        {"id": "M_COMPANY", "field": "directEmployer", "text": job["company"]},
        {"id": "M_TITLE", "field": "jobTitle", "text": job["title"]},
    ]
    if job.get("location"):
        metadata.append({"id": "M_LOCATION", "field": "listedLocation", "text": job["location"]})
    return {
        "trustedMetadata": metadata,
        "jdBlocks": [{"id": block["id"], "text": block["text"]} for block in retained_blocks],
    }


def _source_refs(job: dict[str, Any], blocks: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    refs = {
        block["id"]: {
            "source": "original_jd",
            "span": {
                "startCodePoint": block["startCodePoint"],
                "endCodePoint": block["endCodePoint"],
                "exactQuote": block["text"],
            },
            "text": block["text"],
        }
        for block in blocks
    }
    refs["M_COMPANY"] = {"source": "trusted_metadata", "span": None, "text": job["company"]}
    refs["M_TITLE"] = {"source": "trusted_metadata", "span": None, "text": job["title"]}
    if job.get("location"):
        refs["M_LOCATION"] = {"source": "trusted_metadata", "span": None, "text": job["location"]}
    return refs


def _valid_evidence_ids(raw: Any, refs: dict[str, dict[str, Any]]) -> list[str]:
    if not isinstance(raw, list):
        return []
    result: list[str] = []
    for value in raw:
        if isinstance(value, str) and value in refs and value not in result:
            result.append(value)
    return result


def _binding(refs: dict[str, dict[str, Any]], evidence_ids: list[str]) -> dict[str, Any]:
    if not evidence_ids:
        return {"source": "not_specified", "span": None}
    ref = refs[evidence_ids[0]]
    return {"source": ref["source"], "span": ref["span"]}


def _answer_with_evidence(
    answer: str, raw_evidence: Any, refs: dict[str, dict[str, Any]], not_specified: set[str]
) -> tuple[str, list[str]]:
    if answer in not_specified:
        return answer, []
    evidence_ids = _valid_evidence_ids(raw_evidence, refs)
    if evidence_ids:
        return answer, evidence_ids
    return "not_specified", []


def _model_hard_stop(
    code: str, answer_record: dict[str, Any], refs: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    answer, evidence_ids = _answer_with_evidence(
        answer_record["answer"], answer_record["evidenceIds"], refs, {"not_specified"}
    )
    state = {"present": "present", "not_specified": "unclear"}[answer]
    rationale = {
        "present": "The JD explicitly establishes this hard-stop condition.",
        "not_specified": "JD does not specify.",
    }[answer]
    return {"code": code, "state": state, "rationale": rationale, "binding": _binding(refs, evidence_ids)}


_HUNTING_PERCENT = re.compile(r"(?P<percent>\d{1,3}(?:\.\d+)?)\s*%")
_HUNTING_MAJORITY = re.compile(
    r"\b(?:majority|most of (?:the )?(?:role|time)|primarily|primary (?:duty|focus|responsibility)|main (?:duty|focus|responsibility))\b",
    re.IGNORECASE,
)


def _hunting_hard_stop(answer_record: dict[str, Any], refs: dict[str, dict[str, Any]]) -> dict[str, Any]:
    answer, evidence_ids = _answer_with_evidence(
        answer_record["answer"], answer_record["evidenceIds"], refs, {"not_specified"}
    )
    if answer == "not_specified":
        state = "unclear"
        rationale = "JD does not specify a personal direct-hunting workload share."
    else:
        text = "\n".join(refs[evidence_id]["text"] for evidence_id in evidence_ids)
        percentages = [float(match.group("percent")) for match in _HUNTING_PERCENT.finditer(text)]
        if any(percent > (100 / 3) for percent in percentages) or _HUNTING_MAJORITY.search(text):
            state = "present"
            rationale = "Deterministic interpretation found a personal direct-hunting share above one-third or an explicit majority burden."
        elif percentages:
            state = "absent"
            rationale = "Deterministic interpretation found the stated personal direct-hunting share at or below one-third."
        else:
            state = "unclear"
            rationale = "The cited text discusses workload but does not deterministically establish the hard-stop threshold."
    return {
        "code": "personal_hunting_over_one_third",
        "state": state,
        "rationale": rationale,
        "binding": _binding(refs, evidence_ids),
    }


def _normalized_employer(value: str) -> str:
    normalized = value.casefold().replace("&", " and ")
    normalized = re.sub(r"[^a-z0-9]+", " ", normalized)
    normalized = re.sub(r"\b(?:incorporated|inc|llc|ltd|corp|corporation|company)\b", " ", normalized)
    return " ".join(normalized.split())


def _employer_hard_stops(company: str, overrides: dict[str, Any]) -> dict[str, dict[str, Any]]:
    normalized = _normalized_employer(company)
    alias_matches: dict[str, bool] = {
        "direct_pepsico_employer": False,
        "direct_att_employer": False,
    }
    for entry in overrides.get("aliases", []):
        code = entry.get("hardStopCode")
        if code not in alias_matches:
            continue
        aliases = entry.get("normalizedAliases", [])
        alias_matches[code] = any(_normalized_employer(str(alias)) == normalized for alias in aliases)

    religious_match = False
    for entry in overrides.get("religiousEmployers", []):
        if isinstance(entry, str):
            candidates = [entry]
        elif isinstance(entry, dict):
            candidates = [entry.get("canonicalEmployer", ""), *entry.get("normalizedAliases", [])]
        else:
            candidates = []
        if any(_normalized_employer(str(candidate)) == normalized for candidate in candidates if candidate):
            religious_match = True
            break

    results: dict[str, dict[str, Any]] = {}
    for code, present in alias_matches.items():
        results[code] = {
            "code": code,
            "state": "present" if present else "absent",
            "rationale": "Direct-employer metadata matches the approved hard-stop alias." if present else "Direct-employer metadata does not match the approved hard-stop alias.",
            "binding": {"source": "trusted_metadata", "span": None},
        }
    results["religious_employer"] = {
        "code": "religious_employer",
        "state": "present" if religious_match else "absent",
        "rationale": "The approved employer override establishes this hard stop." if religious_match else "No approved employer override establishes this hard stop.",
        "binding": {"source": "employer_override", "span": None},
    }
    return results


_MONEY_TOKEN = re.compile(
    r"(?P<prefix>USD|US\$|\$)?\s*(?P<number>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?P<suffix>[kK])?",
    re.IGNORECASE,
)
_VARIABLE_PAY = re.compile(r"\b(?:bonus|commission|incentive|variable|on[- ]target earnings|OTE|equity)\b", re.IGNORECASE)


def _money_values(text: str) -> list[int]:
    values: list[int] = []
    compensation_context = bool(re.search(r"\b(?:pay|salary|compensation|earnings|wage|base|OTE)\b", text, re.IGNORECASE))
    for match in _MONEY_TOKEN.finditer(text):
        if match.end() < len(text) and text[match.end()] == "%":
            continue
        prefix, suffix = match.group("prefix"), match.group("suffix")
        raw = float(match.group("number").replace(",", ""))
        if suffix:
            raw *= 1000
        if not prefix and not suffix and (not compensation_context or raw < 1000):
            continue
        value = int(round(raw))
        if value not in values:
            values.append(value)
    return values


def _compensation_from_answer(
    answer_record: dict[str, Any], refs: dict[str, dict[str, Any]], threshold: int
) -> tuple[dict[str, Any], dict[str, Any]]:
    answer, evidence_ids = _answer_with_evidence(
        answer_record["answer"], answer_record["evidenceIds"], refs, {"not_specified"}
    )
    if answer == "not_specified":
        compensation = {
            "stated": False,
            "source": None,
            "currency": None,
            "period": None,
            "baseMinimum": None,
            "baseMaximum": None,
            "totalMinimum": None,
            "totalMaximum": None,
            "variablePayContext": None,
        }
        hard_stop = {
            "code": "total_comp_below_60000",
            "state": "unclear",
            "rationale": "JD does not specify comparable annual total compensation.",
            "binding": {"source": "not_specified", "span": None},
        }
        return compensation, hard_stop

    text = "\n".join(refs[evidence_id]["text"] for evidence_id in evidence_ids)
    values = _money_values(text)
    lower = min(values) if values else None
    upper = max(values) if values else None
    currency = "USD" if re.search(r"(?:USD|US\$|\$)", text, re.IGNORECASE) else None
    period = None
    if re.search(r"\b(?:annual|annually|per year|yearly|yr)\b", text, re.IGNORECASE):
        period = "annual"
    elif re.search(r"\b(?:hour|hourly|hr)\b", text, re.IGNORECASE):
        period = "hourly"
    elif re.search(r"\b(?:month|monthly)\b", text, re.IGNORECASE):
        period = "monthly"
    elif re.search(r"\b(?:week|weekly)\b", text, re.IGNORECASE):
        period = "weekly"

    variable = bool(_VARIABLE_PAY.search(text))
    total_language = bool(re.search(r"\b(?:total compensation|on[- ]target earnings|OTE)\b", text, re.IGNORECASE))
    base_language = bool(re.search(r"\bbase(?: salary| pay| compensation)?\b", text, re.IGNORECASE))
    generic_salary = bool(re.search(r"\b(?:salary|pay) range\b", text, re.IGNORECASE))
    base_minimum = lower if base_language or generic_salary else None
    base_maximum = upper if base_language or generic_salary else None
    total_minimum = lower if total_language or (generic_salary and not variable and not base_language) else None
    total_maximum = upper if total_language or (generic_salary and not variable and not base_language) else None
    first_ref = refs[evidence_ids[0]]
    compensation = {
        "stated": True,
        "source": first_ref["span"] if first_ref["source"] == "original_jd" else None,
        "currency": currency,
        "period": period,
        "baseMinimum": base_minimum,
        "baseMaximum": base_maximum,
        "totalMinimum": total_minimum,
        "totalMaximum": total_maximum,
        "variablePayContext": text[:10000] if variable else None,
    }

    comparable = currency == "USD" and period == "annual"
    if comparable and total_maximum is not None:
        state = "present" if total_maximum < threshold else "absent"
        rationale = (
            f"Deterministic parsing found annual total compensation entirely below USD {threshold}."
            if state == "present"
            else f"Deterministic parsing found annual total compensation reaching at least USD {threshold}."
        )
    elif comparable and base_maximum is not None and base_maximum >= threshold:
        state = "absent"
        rationale = f"Deterministic parsing found annual base compensation reaching at least USD {threshold}."
    else:
        state = "unclear"
        rationale = "The JD states compensation but does not establish comparable annual total compensation for the hard stop."
    hard_stop = {
        "code": "total_comp_below_60000",
        "state": state,
        "rationale": rationale,
        "binding": _binding(refs, evidence_ids),
    }
    return compensation, hard_stop


def _policy_points(policy: dict[str, Any], category: str, band: str) -> int:
    allowed = {entry["band"]: entry["points"] for entry in policy["rubric"][category]}
    if band not in allowed:
        raise ValueError(f"policy has no {category} band {band}")
    return allowed[band]


def _fit_band(
    category: str,
    answer_record: dict[str, Any],
    refs: dict[str, dict[str, Any]],
    policy: dict[str, Any],
) -> tuple[dict[str, Any], str, list[str]]:
    answer, evidence_ids = _answer_with_evidence(
        answer_record["answer"], answer_record["evidenceIds"], refs, {"not_specified"}
    )
    if answer == "not_specified":
        band = FIT_ANSWER_DEFAULTS[category]
        rationale = "JD does not specify enough information to select a supported fit answer."
    else:
        band = FIT_ANSWER_TO_POLICY_BAND[category][answer]
        rationale = f"Evaluator answered {answer.replace('_', ' ')}."
    return {
        "band": band,
        "points": _policy_points(policy, category, band),
        "rationale": rationale,
        "binding": _binding(refs, evidence_ids),
    }, answer, evidence_ids


_TRAVEL_RANGE = re.compile(r"(?P<minimum>\d{1,3})\s*(?:-|–|—|to)\s*(?P<maximum>\d{1,3})\s*%", re.IGNORECASE)
_TRAVEL_UP_TO = re.compile(r"\bup to\s+(?P<maximum>\d{1,3})\s*%", re.IGNORECASE)
_TRAVEL_AT_LEAST = re.compile(r"\b(?:at least|minimum of)\s+(?P<minimum>\d{1,3})\s*%", re.IGNORECASE)
_TRAVEL_POINT = re.compile(r"(?P<point>\d{1,3})\s*%", re.IGNORECASE)
_TRAVEL_QUALITATIVE = re.compile(r"\b(?:frequent|regular|occasional|periodic|extensive|as[- ]needed)\b", re.IGNORECASE)


def _travel_assessment(
    band_record: dict[str, Any], answer: str, evidence_ids: list[str], refs: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    text = "\n".join(refs[evidence_id]["text"] for evidence_id in evidence_ids)
    kind = "unstated"
    minimum = maximum = None
    qualitative = None
    match = _TRAVEL_RANGE.search(text)
    if match:
        kind = "range"
        minimum, maximum = int(match.group("minimum")), int(match.group("maximum"))
    else:
        match = _TRAVEL_UP_TO.search(text)
        if match:
            kind, maximum = "up_to", int(match.group("maximum"))
        else:
            match = _TRAVEL_AT_LEAST.search(text)
            if match:
                kind, minimum = "at_least", int(match.group("minimum"))
            else:
                match = _TRAVEL_POINT.search(text)
                if match:
                    kind = "point"
                    minimum = maximum = int(match.group("point"))
                elif answer not in {"none", "not_specified"}:
                    kind = "qualitative"
    qualitative_match = _TRAVEL_QUALITATIVE.search(text)
    if qualitative_match:
        qualitative = qualitative_match.group(0)
    first_ref = refs[evidence_ids[0]] if evidence_ids else None
    return {
        "kind": kind,
        "minimumPercent": minimum,
        "maximumPercent": maximum,
        "qualitativeFrequency": qualitative,
        "band": band_record["band"],
        "points": band_record["points"],
        "source": first_ref["span"] if first_ref and first_ref["source"] == "original_jd" else None,
    }


def derive_aim_evaluation(
    output: dict[str, Any],
    job: dict[str, Any],
    retained_blocks: list[dict[str, Any]],
    policy: dict[str, Any],
    employer_overrides: dict[str, Any],
) -> dict[str, Any]:
    """Turn question answers into the complete exchange contract without model math or offsets."""
    refs = _source_refs(job, retained_blocks)
    hard_stops = {
        code: _model_hard_stop(code, output["hardStopAnswers"][code], refs)
        for code in MODEL_HARD_STOP_CODES
        if code != "personal_hunting_over_one_third"
    }
    hard_stops["personal_hunting_over_one_third"] = _hunting_hard_stop(
        output["hardStopAnswers"]["personal_hunting_over_one_third"], refs
    )
    hard_stops.update(_employer_hard_stops(job["company"], employer_overrides))
    compensation, compensation_hard_stop = _compensation_from_answer(
        output["compensationAnswer"], refs, policy["compensationGate"]["annualTotalMinimum"]
    )
    hard_stops["total_comp_below_60000"] = compensation_hard_stop
    ordered_hard_stops = [hard_stops[entry["code"]] for entry in policy["hardStops"]]

    rubric_records: dict[str, dict[str, Any]] = {}
    normalized_answers: dict[str, str] = {}
    normalized_evidence: dict[str, list[str]] = {}
    for category in ("coreWork", "buildingAutonomy", "productIndustry", "travel"):
        record, answer, evidence_ids = _fit_band(category, output["fitAnswers"][category], refs, policy)
        rubric_records[category] = record
        normalized_answers[category] = answer
        normalized_evidence[category] = evidence_ids
    travel = _travel_assessment(
        rubric_records["travel"], normalized_answers["travel"], normalized_evidence["travel"], refs
    )
    present = any(item["state"] == "present" for item in ordered_hard_stops)
    rubric = None if present else rubric_records
    score = None if present else sum(record["points"] for record in rubric_records.values())
    return {
        "hardStops": ordered_hard_stops,
        "decision": "rejected_hard_stop" if present else "survivor",
        "rubric": rubric,
        "travel": travel,
        "compensation": compensation,
        "aimFitScore": score,
    }
