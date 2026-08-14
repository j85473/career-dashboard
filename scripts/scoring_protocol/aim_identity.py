from __future__ import annotations

import hashlib
from typing import Any, Iterable

from .common import canonical_sha256, normalize_source_text, normalized_text_sha256

AIM_CANONICALIZATION_VERSION = "aim-text-canonicalization-v1"


def source_jd_hash(source: str) -> str:
    return normalized_text_sha256(source)


def normalize_trusted_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    company = normalize_source_text(metadata["company"])
    title = normalize_source_text(metadata["title"])
    location = metadata.get("location")
    location = None if location is None else normalize_source_text(location)
    if not company.strip() or not title.strip():
        raise ValueError("Aim company and title must contain a non-whitespace code point")
    return {"company": company, "title": title, "location": location}


def trusted_metadata_hash(metadata: dict[str, Any]) -> str:
    return canonical_sha256({"kind": "aim_trusted_metadata_v1", **normalize_trusted_metadata(metadata)})


def source_identity(source_hash: str, metadata_hash: str) -> str:
    return canonical_sha256({
        "kind": "aim_source_identity_v1",
        "sourceJdHash": source_hash,
        "trustedMetadataHash": metadata_hash,
    })


def extraction_identity(values: dict[str, Any]) -> str:
    ordered_keys = (
        "sourceIdentity", "questionRegistryVersion", "questionRegistryHash",
        "promptContractVersion", "promptContractHash", "responseContractVersion",
        "responseContractHash", "packetStrategyVersion", "packetStrategyHash",
        "canonicalizationVersion", "anonymizationPolicyVersion",
        "anonymizationPolicyHash", "extractorSemanticVersion",
    )
    return canonical_sha256({"kind": "aim_extraction_identity_v1", **{key: values[key] for key in ordered_keys}})


def model_metadata_projection_hash(fields: dict[str, Any]) -> str:
    return canonical_sha256({"kind": "aim_model_metadata_projection_v1", "fields": fields})


def base_membership_hash(packet_strategy_hash: str, base_ordinal: int, question_ids: Iterable[str]) -> str:
    return canonical_sha256({
        "kind": "aim_base_membership_v1",
        "packetStrategyHash": packet_strategy_hash,
        "baseOrdinal": base_ordinal,
        "sortedQuestionIds": sorted(question_ids),
    })


def packet_manifest_hash(
    base_ordinal: int,
    physical_ordinal: int,
    ordered_question_ids: list[str],
    projection_hash: str,
) -> str:
    return canonical_sha256({
        "kind": "aim_packet_manifest_v1",
        "baseOrdinal": base_ordinal,
        "physicalOrdinal": physical_ordinal,
        "orderedQuestionIds": ordered_question_ids,
        "modelVisibleMetadataProjectionHash": projection_hash,
    })


def packet_plan_hash(manifest_hashes: list[str]) -> str:
    return canonical_sha256({"kind": "aim_packet_plan_v1", "orderedPacketManifestHashes": manifest_hashes})


def packet_checkpoint_key(extraction_id: str, plan_hash: str, manifest_hash: str) -> str:
    return canonical_sha256({
        "kind": "aim_packet_checkpoint_v1",
        "extractionIdentity": extraction_id,
        "packetPlanHash": plan_hash,
        "packetManifestHash": manifest_hash,
    })


def packet_input_hash(
    extraction_id: str,
    manifest_hash: str,
    rendered_input_hash: str,
    rendered_schema_hash: str,
) -> str:
    return canonical_sha256({
        "kind": "aim_packet_input_v1",
        "extractionIdentity": extraction_id,
        "packetManifestHash": manifest_hash,
        "renderedInputHash": rendered_input_hash,
        "renderedResponseSchemaHash": rendered_schema_hash,
    })


def all_codepoint_occurrences(source: str, quote: str) -> list[dict[str, int]]:
    if not quote:
        raise ValueError("Aim evidence quote must be nonempty")
    occurrences: list[dict[str, int]] = []
    start = 0
    while start <= len(source) - len(quote):
        found = source.find(quote, start)
        if found < 0:
            break
        occurrences.append({"startCodePoint": found, "endCodePoint": found + len(quote)})
        start = found + 1
    return occurrences


def normalize_occurrences(occurrences: Iterable[dict[str, int]]) -> list[dict[str, int]]:
    ordered = sorted(
        ({"startCodePoint": item["startCodePoint"], "endCodePoint": item["endCodePoint"]} for item in occurrences),
        key=lambda item: (item["startCodePoint"], item["endCodePoint"]),
    )
    result: list[dict[str, int]] = []
    for item in ordered:
        if not result or item != result[-1]:
            result.append(item)
    return result


def evidence_id(entry: dict[str, Any]) -> str:
    return canonical_sha256({
        "kind": "aim_evidence_v1",
        "source": entry["source"],
        "field": entry.get("field"),
        "exactQuote": entry["exactQuote"],
        "orderedOccurrences": normalize_occurrences(entry["occurrences"]),
    })


def _codepoint_key(value: str) -> tuple[int, ...]:
    return tuple(ord(character) for character in value)


def evidence_sort_key(entry: dict[str, Any]) -> tuple[Any, ...]:
    if entry["source"] == "original_jd":
        first = entry["occurrences"][0]
        return (0, first["startCodePoint"], first["endCodePoint"], _codepoint_key(entry["exactQuote"]), entry["evidenceId"])
    field_order = {"company": 0, "title": 1, "location": 2}
    return (1, field_order.get(entry.get("field"), 99), _codepoint_key(entry["exactQuote"]), entry["evidenceId"])


def factual_vector_hash(vector: dict[str, Any]) -> str:
    return canonical_sha256({
        "kind": "aim_factual_vector_v1",
        "scope": vector["scope"],
        "sourceIdentity": vector["sourceIdentity"],
        "trustedMetadataHash": vector["trustedMetadataHash"],
        "questionRegistryHash": vector["questionRegistryHash"],
        "promptContractHash": vector["promptContractHash"],
        "responseContractHash": vector["responseContractHash"],
        "packetStrategyHash": vector["packetStrategyHash"],
        "canonicalizationVersion": vector["canonicalizationVersion"],
        "anonymizationPolicyVersion": vector["anonymizationPolicyVersion"],
        "anonymizationPolicyHash": vector["anonymizationPolicyHash"],
        "extractorSemanticVersion": vector["extractorSemanticVersion"],
        "orderedAnswers": vector["answers"],
        "sourceOrderedEvidenceCatalog": vector["evidenceCatalog"],
    })


def local_policy_facts_hash(source_id: str, metadata_hash: str, trigger_codes: list[str]) -> str:
    return canonical_sha256({
        "kind": "aim_local_policy_facts_v1",
        "sourceIdentity": source_id,
        "trustedMetadataHash": metadata_hash,
        "orderedLocalTriggerCodes": trigger_codes,
    })


def local_policy_scoring_identity(facts_hash: str, policy_version: str, policy_hash: str, builder_version: str) -> str:
    return canonical_sha256({
        "kind": "aim_local_policy_scoring_identity_v1",
        "localPolicyFactsHash": facts_hash,
        "scoringPolicyVersion": policy_version,
        "scoringPolicyHash": policy_hash,
        "resultBuilderSemanticVersion": builder_version,
    })


def scoring_identity(vector_hash: str, metadata_hash: str, policy_version: str, policy_hash: str, builder_version: str) -> str:
    return canonical_sha256({
        "kind": "aim_scoring_identity_v1",
        "factualVectorHash": vector_hash,
        "trustedMetadataHash": metadata_hash,
        "scoringPolicyVersion": policy_version,
        "scoringPolicyHash": policy_hash,
        "resultBuilderSemanticVersion": builder_version,
    })


def semantic_result_projection(result: dict[str, Any]) -> dict[str, Any]:
    projected = {key: value for key, value in result.items()}
    vector = projected.get("factualVector")
    if isinstance(vector, dict):
        projected["factualVector"] = {
            key: value for key, value in vector.items()
            if key not in ("provenance", "runnerProtocolVersion", "runnerProtocolHash")
        }
    return projected


def semantic_result_hash(result: dict[str, Any], extraction_id: str | None) -> str:
    return canonical_sha256({
        "kind": "aim_semantic_result_v1",
        "resultVariant": result["variant"],
        "extractionIdentity": extraction_id,
        "scoringIdentity": result["scoringIdentity"],
        "deterministicResult": semantic_result_projection(result),
    })


def result_item_hash(item_without_hash: dict[str, Any]) -> str:
    return canonical_sha256({"kind": "aim_result_item_v2", "itemWithoutResultHash": item_without_hash})


def result_envelope_hash(envelope_without_hash: dict[str, Any]) -> str:
    return canonical_sha256({"kind": "aim_result_envelope_v2", "envelopeWithoutResultHash": envelope_without_hash})


def extraction_failure_resolution_identity(input_hash: str, extraction_id: str, runner_hash: str) -> str:
    return canonical_sha256({
        "kind": "aim_extraction_failure_resolution_v1",
        "inputHash": input_hash,
        "extractionIdentity": extraction_id,
        "runnerProtocolHash": runner_hash,
    })


def builder_failure_resolution_identity(
    input_hash: str, extraction_id: str, policy_hash: str, builder_version: str, runner_hash: str
) -> str:
    return canonical_sha256({
        "kind": "aim_builder_failure_resolution_v1",
        "inputHash": input_hash,
        "extractionIdentity": extraction_id,
        "scoringPolicyHash": policy_hash,
        "resultBuilderSemanticVersion": builder_version,
        "runnerProtocolHash": runner_hash,
    })


def failure_retry_series_key(job_id: str, resolution_identity: str, code: str) -> str:
    return canonical_sha256({
        "kind": "aim_failure_retry_series_v1",
        "jobId": job_id,
        "failureResolutionIdentity": resolution_identity,
        "failureCode": code,
    })


def failure_suppression_key(retry_series_key: str, permanence: str) -> str:
    return canonical_sha256({
        "kind": "aim_safe_failure_suppression_v1",
        "retrySeriesKey": retry_series_key,
        "permanence": permanence,
    })


def exact_file_sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
