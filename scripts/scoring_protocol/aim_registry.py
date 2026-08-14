from __future__ import annotations

import hashlib
import math
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .aim_identity import (
    base_membership_hash,
    exact_file_sha256,
    model_metadata_projection_hash,
    packet_manifest_hash,
    packet_plan_hash,
)
from .common import canonical_json, canonical_sha256, load_json
from .contracts import validate_schema


class ModelContextLimitError(ValueError):
    pass


class InputContractLimitError(ValueError):
    pass


@dataclass(frozen=True)
class AimAuthorities:
    registry: dict[str, Any]
    registry_by_id: dict[str, dict[str, Any]]
    question_registry_hash: str
    policy: dict[str, Any]
    scoring_policy_hash: str
    runner_protocol: dict[str, Any]
    runner_protocol_hash: str
    packet_strategy_hash: str
    anonymization_policy: dict[str, Any]
    anonymization_policy_hash: str
    stage1_prompt_bytes: bytes
    stage2_prompt_bytes: bytes
    prompt_contract_hash: str
    response_schema: dict[str, Any]
    response_contract_hash: str


@dataclass(frozen=True)
class LogicalPacket:
    private_phase: str
    base_ordinal: int
    ordered_questions: tuple[dict[str, Any], ...]
    base_membership_hash: str


@dataclass(frozen=True)
class PhysicalPacket:
    private_phase: str
    base_ordinal: int
    physical_ordinal: int
    packet_path: str
    ordered_questions: tuple[dict[str, Any], ...]
    metadata_projection: dict[str, Any]
    metadata_projection_hash: str
    packet_manifest_hash: str
    rendered_input: str
    response_schema: dict[str, Any]


LABELS = {"company": "Company", "title": "Title", "location": "Location"}


def _file_bytes(repo_root: Path, relative: str) -> bytes:
    return (repo_root / relative).read_bytes()


def load_aim_authorities(repo_root: Path) -> AimAuthorities:
    registry = load_json(repo_root / "data/scoring/aim-question-registry-v2.json")
    policy = load_json(repo_root / "data/scoring/aim-policy-v2.json")
    runner = load_json(repo_root / "data/scoring/runner-protocol-v2.json", integers_only=False)
    anonymization = load_json(repo_root / "data/scoring/aim-anonymization-policy-v1.json")
    response = load_json(repo_root / "data/scoring/schemas/aim-factual-worker-response-v1.schema.json")
    schemas = repo_root / "data/scoring/schemas"
    validate_schema(registry, load_json(schemas / "aim-question-registry-v2.schema.json"))
    validate_schema(policy, load_json(schemas / "aim-policy-v2.schema.json"))
    validate_schema(runner, load_json(schemas / "runner-protocol-v2.schema.json"))
    validate_schema(anonymization, load_json(schemas / "aim-anonymization-policy-v1.schema.json"))
    stage1_prompt_path = "data/scoring/prompts/aim-factual-questions-v1.md"
    stage2_prompt_path = "data/scoring/prompts/aim-stage2-holistic-v1.md"
    stage1_prompt_bytes = _file_bytes(repo_root, stage1_prompt_path)
    stage2_prompt_bytes = _file_bytes(repo_root, stage2_prompt_path)
    prompt_contract_hash = canonical_sha256([
        {"path": stage1_prompt_path, "sha256": exact_file_sha256(stage1_prompt_bytes)},
        {"path": stage2_prompt_path, "sha256": exact_file_sha256(stage2_prompt_bytes)},
    ])
    questions = registry["questions"]
    if len([question for question in questions if question["privatePhase"] == "stage1"]) != 7:
        raise ValueError("Aim registry must contain exactly seven private Stage 1 questions")
    if len([question for question in questions if question["privatePhase"] == "stage2"]) != 342:
        raise ValueError("Aim registry must contain all 339 original Stage 2 questions plus three approved industry distinctions")
    by_id = {question["id"]: question for question in questions}
    if len(by_id) != len(questions):
        raise ValueError("Aim registry contains duplicate stable IDs")
    for question in questions:
        evidence_rule = question["evidenceRule"]
        if (
            evidence_rule["yes"] != {"minimumExactExcerpts": 1, "maximumExactExcerpts": 2}
            or evidence_rule["no"] != {"minimumExactExcerpts": 0, "maximumExactExcerpts": 0}
            or evidence_rule["unsupported"] != {"minimumExactExcerpts": 0, "maximumExactExcerpts": 0}
        ):
            raise ValueError(f"{question['id']} has invalid evidence cardinality")
    result = AimAuthorities(
        registry=registry,
        registry_by_id=by_id,
        question_registry_hash=canonical_sha256(registry),
        policy=policy,
        scoring_policy_hash=canonical_sha256(policy),
        runner_protocol=runner,
        runner_protocol_hash=canonical_sha256(runner),
        packet_strategy_hash=canonical_sha256(runner["packetStrategy"]),
        anonymization_policy=anonymization,
        anonymization_policy_hash=canonical_sha256(anonymization),
        stage1_prompt_bytes=stage1_prompt_bytes,
        stage2_prompt_bytes=stage2_prompt_bytes,
        prompt_contract_hash=prompt_contract_hash,
        response_schema=response,
        response_contract_hash=canonical_sha256(response),
    )
    return result


def validate_export_authority_bindings(batch: dict[str, Any], authorities: AimAuthorities) -> None:
    expected = {
        "questionRegistryVersion": authorities.registry["questionRegistryVersion"],
        "questionRegistryHash": authorities.question_registry_hash,
        "scoringPolicyVersion": authorities.policy["policyVersion"],
        "scoringPolicyHash": authorities.scoring_policy_hash,
        "resultBuilderSemanticVersion": authorities.policy["resultBuilderSemanticVersion"],
        "runnerProtocolVersion": authorities.runner_protocol["runnerProtocolVersion"],
        "runnerProtocolHash": authorities.runner_protocol_hash,
        "packetStrategyVersion": authorities.runner_protocol["packetStrategy"]["packetStrategyVersion"],
        "packetStrategyHash": authorities.packet_strategy_hash,
        "promptContractVersion": "aim-stage1-factual-stage2-holistic-v1",
        "promptContractHash": authorities.prompt_contract_hash,
        "responseContractVersion": authorities.response_schema["schemaVersion"],
        "responseContractHash": authorities.response_contract_hash,
        "canonicalizationVersion": "aim-text-canonicalization-v1",
        "anonymizationPolicyVersion": authorities.anonymization_policy["anonymizationPolicyVersion"],
        "anonymizationPolicyHash": authorities.anonymization_policy_hash,
        "extractorSemanticVersion": authorities.runner_protocol["extractorSemanticVersion"],
    }
    for key, value in expected.items():
        if batch.get(key) != value:
            raise ValueError(f"Aim export {key} does not match the repository authority")


def response_schema_for_count(authorities: AimAuthorities, count: int) -> dict[str, Any]:
    if count < 1 or count > authorities.runner_protocol["limits"]["maximumQuestionsPerBasePacket"]:
        raise ValueError("physical factual unit has an invalid question count")
    schema = deepcopy(authorities.response_schema)
    for key in ("$schema", "$id", "schemaVersion"):
        schema.pop(key, None)
    schema["properties"]["answers"]["minItems"] = count
    schema["properties"]["answers"]["maxItems"] = count
    return schema


def metadata_projection(questions: Iterable[dict[str, Any]], metadata: dict[str, Any]) -> dict[str, Any]:
    fields = {field for question in questions for field in question["allowedMetadataFields"]}
    return {
        field: metadata[field]
        for field in ("company", "title", "location")
        if field in fields and metadata.get(field) is not None
    }


def render_factual_input(
    source: str,
    questions: Iterable[dict[str, Any]],
    projection: dict[str, Any],
    authorities: AimAuthorities,
) -> str:
    question_list = list(questions)
    phases = {question["privatePhase"] for question in question_list}
    if len(phases) != 1:
        raise ValueError("one factual unit cannot mix private phases")
    if phases == {"stage1"}:
        answer_instructions = [
            "Use yes only when the supplied material explicitly establishes the complete proposition. Use no when the supplied material explicitly establishes that the proposition is false. Use unsupported when the supplied material does not provide enough information to decide.",
            "For every yes, copy one or two exact contiguous passages that establish the complete proposition. For no or unsupported, provide no passage. Only yes carries an evidence burden.",
            "For the Minneapolis–St. Paul residence question, answer yes when the supplied material requires residence in a named place outside that metro, including a different state. Answer no when the allowed residence area includes the Minneapolis–St. Paul metro. Answer unsupported when residence eligibility is not stated clearly enough to decide.",
        ]
    else:
        answer_instructions = [
            "Use present when the supplied material directly states or describes the fact in the question. Equivalent ordinary wording counts; the supplied material does not need to repeat the question's vocabulary.",
            "Use not found when the supplied material does not state or describe that fact. Not found does not assert the opposite and requires no supporting passage.",
            "For every present answer, copy one or two exact contiguous passages that establish the fact. Put the passage or passages after that numbered answer. Copy characters exactly.",
        ]
    parts = [
        authorities.stage1_prompt_bytes.decode("utf-8"),
        "",
        *answer_instructions,
        "",
        "<supplied-material>",
        source,
        "</supplied-material>",
    ]
    if projection:
        parts.extend(["", "<details>"])
        for field in ("company", "title", "location"):
            if field in projection:
                parts.append(f"{LABELS[field]}: {projection[field]}")
        parts.append("</details>")
    parts.extend(["", "<questions>"])
    parts.extend(f"{index}. {question['wording']}" for index, question in enumerate(question_list, start=1))
    parts.append("</questions>")
    return "\n".join(parts)


def _assignment_digest(registry_version: str, question_id: str) -> str:
    return canonical_sha256({
        "kind": "aim_stage2_packetizer_v4",
        "questionRegistryVersion": registry_version,
        "questionId": question_id,
    })


def _ordered_logical_packet(
    phase: str,
    base_ordinal: int,
    members: list[dict[str, Any]],
    authorities: AimAuthorities,
) -> LogicalPacket:
    membership_hash = base_membership_hash(
        authorities.packet_strategy_hash,
        base_ordinal,
        [question["id"] for question in members],
    )
    ordered = sorted(members, key=lambda question: (
        canonical_sha256({
            "kind": "aim_packet_order_v1",
            "baseMembershipHash": membership_hash,
            "questionId": question["id"],
        }),
        question["id"],
    ))
    return LogicalPacket(phase, base_ordinal, tuple(ordered), membership_hash)


def stage1_logical_packet(authorities: AimAuthorities) -> LogicalPacket:
    questions = [question for question in authorities.registry["questions"] if question["privatePhase"] == "stage1"]
    return _ordered_logical_packet("stage1", 0, questions, authorities)


def stage2_logical_packets(authorities: AimAuthorities) -> list[LogicalPacket]:
    questions = [question for question in authorities.registry["questions"] if question["privatePhase"] == "stage2"]
    registry_version = authorities.registry["questionRegistryVersion"]
    compensation = sorted(
        (question for question in questions if question["parserInput"] == "compensation_fact"),
        key=lambda question: (_assignment_digest(registry_version, question["id"]), question["id"]),
    )
    remaining = sorted(
        (question for question in questions if question["parserInput"] != "compensation_fact"),
        key=lambda question: (_assignment_digest(registry_version, question["id"]), question["id"]),
    )
    maximum = authorities.runner_protocol["packetStrategy"]["stage2"]["maximumQuestionsPerBasePacket"]
    groups = [compensation]
    groups.extend(
        remaining[start:start + maximum]
        for start in range(0, len(remaining), maximum)
    )
    expected_counts = authorities.runner_protocol["packetStrategy"]["stage2"]["basePacketQuestionCounts"]
    if [len(group) for group in groups] != expected_counts:
        raise ValueError("Aim Stage 2 packet assignment does not match its declared 342-question plan")
    if sorted(question["id"] for group in groups for question in group) != sorted(question["id"] for question in questions):
        raise ValueError("Aim Stage 2 packet assignment is not exact membership")
    return [_ordered_logical_packet("stage2", ordinal, group, authorities) for ordinal, group in enumerate(groups)]


def worst_case_response_bytes(count: int, authorities: AimAuthorities) -> int:
    # The model emits ordinary text, not JSON. Bound the largest allowed answer
    # as a local number, the affirmative word, two maximum-length passages, and
    # separators. The authority uses Unicode's four-byte UTF-8 maximum and the
    # declared maximum quote count/length rather than assuming every byte is a
    # separate model token.
    limits = authorities.runner_protocol["limits"]
    settings = authorities.runner_protocol["contextPreflight"]
    return count * (
        32
        + limits["maximumEvidenceQuotesPerAnswer"]
        * limits["maximumEvidenceQuoteCodePoints"]
        * settings["utf8BytesPerWorstCaseQuotedCodePoint"]
    )


def _fits_context(rendered: str, question_count: int, context_window: int, authorities: AimAuthorities) -> bool:
    settings = authorities.runner_protocol["contextPreflight"]
    rendered_bytes = len(rendered.encode("utf-8"))
    output_bytes = worst_case_response_bytes(question_count, authorities)
    if output_bytes > settings["maximumSerializedOutputUtf8Bytes"]:
        return False
    bytes_per_token = settings["conservativeUtf8BytesPerToken"]
    rendered_tokens = math.ceil(rendered_bytes / bytes_per_token)
    output_tokens = math.ceil(output_bytes / bytes_per_token)
    return (
        rendered_tokens <= math.floor(settings["maximumInputFraction"] * context_window)
        and rendered_tokens + output_tokens <= context_window - settings["contextSafetyReserveTokens"]
    )


def plan_physical_packets(
    logical_packets: Iterable[LogicalPacket],
    source: str,
    metadata: dict[str, Any],
    context_window: int,
    authorities: AimAuthorities,
    start_physical_ordinal: int = 0,
) -> list[PhysicalPacket]:
    if not isinstance(context_window, int) or isinstance(context_window, bool) or context_window <= 0:
        raise ModelContextLimitError("selected model context window is unavailable")
    leaves: list[tuple[LogicalPacket, str, tuple[dict[str, Any], ...], dict[str, Any], str, dict[str, Any]]] = []

    def split(logical: LogicalPacket, suffix: str, questions: tuple[dict[str, Any], ...]) -> None:
        projection = metadata_projection(questions, metadata)
        rendered = render_factual_input(source, questions, projection, authorities)
        schema = response_schema_for_count(authorities, len(questions))
        if _fits_context(rendered, len(questions), context_window, authorities):
            leaves.append((logical, suffix, questions, projection, rendered, schema))
            return
        if len(questions) == 1:
            raise ModelContextLimitError("complete supplied material plus one factual question exceeds the selected model context")
        middle = len(questions) // 2
        split(logical, suffix + "L", questions[:middle])
        split(logical, suffix + "R", questions[middle:])

    for logical in logical_packets:
        split(logical, "", logical.ordered_questions)
    result: list[PhysicalPacket] = []
    for offset, (logical, suffix, questions, projection, rendered, schema) in enumerate(leaves):
        physical_ordinal = start_physical_ordinal + offset
        projection_hash = model_metadata_projection_hash(projection)
        manifest_hash = packet_manifest_hash(
            logical.base_ordinal,
            physical_ordinal,
            [question["id"] for question in questions],
            projection_hash,
        )
        result.append(PhysicalPacket(
            private_phase=logical.private_phase,
            base_ordinal=logical.base_ordinal,
            physical_ordinal=physical_ordinal,
            packet_path=f"{logical.base_ordinal}{suffix}",
            ordered_questions=questions,
            metadata_projection=projection,
            metadata_projection_hash=projection_hash,
            packet_manifest_hash=manifest_hash,
            rendered_input=rendered,
            response_schema=schema,
        ))
    return result


def physical_plan_hash(packets: Iterable[PhysicalPacket]) -> str:
    return packet_plan_hash([packet.packet_manifest_hash for packet in packets])


def rendered_packet_sha256(packet: PhysicalPacket) -> str:
    return hashlib.sha256(packet.rendered_input.encode("utf-8")).hexdigest()
