from __future__ import annotations

import re
import unicodedata
from typing import Any, Iterable

from .aim_identity import (
    all_codepoint_occurrences,
    evidence_id,
    evidence_sort_key,
    extraction_identity,
    factual_vector_hash,
    normalize_occurrences,
    source_identity,
    source_jd_hash,
    trusted_metadata_hash,
)
from .aim_registry import AimAuthorities, PhysicalPacket, stage2_logical_packets
from .common import canonical_json, normalize_source_text
from .contracts import validate_schema


_COMBINED_ANSWER_LINE = re.compile(
    r"^\s*(?:[-*]\s*)?(?P<number>\d{1,3})\s*(?:[.)]|:|-)\s*"
    r"(?:\*\*|__)?(?P<answer>present|not(?:[ _-]+)found|yes|no|unsupported)"
    r"(?:\*\*|__)?\s*(?:[:\-–—]\s*)?(?P<remainder>.*)$",
    flags=re.IGNORECASE,
)
_TABLE_ANSWER_LINE = re.compile(
    r"^\s*\|\s*(?P<number>\d{1,3})\s*\|\s*"
    r"(?:\*\*|__)?(?P<answer>present|not(?:[ _-]+)found|yes|no|unsupported)"
    r"(?:\*\*|__)?\s*\|\s*(?P<remainder>.*?)\s*\|\s*$",
    flags=re.IGNORECASE,
)
_NUMBER_ONLY_LINE = re.compile(r"^\s*(?:[-*]\s*)?(?P<number>\d{1,3})\s*(?:[.)]|:)\s*$")
_ANSWER_ONLY_LINE = re.compile(
    r"^\s*(?:\*\*|__)?(?P<answer>present|not(?:[ _-]+)found|yes|no|unsupported)"
    r"(?:\*\*|__)?\s*(?:[:\-–—]\s*)?(?P<remainder>.*)$",
    flags=re.IGNORECASE,
)


def _normalized_model_answer(value: str) -> str:
    return re.sub(r"[ _-]+", " ", value.strip().casefold())


def _candidate_variants(value: str) -> list[str]:
    text = value.strip()
    if not text:
        return []
    values: list[str] = [text]
    without_label = re.sub(
        r"^(?:supporting\s+text|support|evidence|passages?|quotes?)\s*[:\-]\s*",
        "",
        text,
        flags=re.IGNORECASE,
    ).strip()
    if without_label:
        values.append(without_label)
    for block in re.split(r"\n\s*\n", without_label):
        if block.strip():
            values.append(block.strip())
    for line in without_label.splitlines():
        stripped = line.strip()
        if stripped:
            values.append(stripped)
    for match in re.finditer(r"(?:\"([^\"\n]{1,320})\"|“([^”\n]{1,320})”|`([^`\n]{1,320})`)", text):
        values.append(next(group for group in match.groups() if group is not None))

    expanded: list[str] = []
    for candidate in values:
        expanded.append(candidate)
        unmarked = re.sub(r"^\s*(?:[-*]>?|>)\s+", "", candidate).strip()
        unmarked = re.sub(
            r"^(?:supporting\s+text|support|evidence|passages?|quotes?)\s*[:\-]\s*",
            "",
            unmarked,
            flags=re.IGNORECASE,
        ).strip()
        if len(unmarked) >= 2 and (unmarked[0], unmarked[-1]) in {
            ('"', '"'), ("'", "'"), ('“', '”'), ('`', '`'),
        }:
            unmarked = unmarked[1:-1]
        # A model may wrap a multi-line exact passage with one opening mark on
        # the first line and one closing mark on the last. Each individual line
        # is still a usable exact-source candidate after removing that display
        # punctuation.
        unmarked = re.sub(r'^["“”‘’`]+', '', unmarked).strip()
        unmarked = re.sub(r'["“”‘’`]+$', '', unmarked).strip()
        if unmarked:
            expanded.append(unmarked)
    result: list[str] = []
    for candidate in expanded:
        if candidate and candidate not in result:
            result.append(candidate)
    return result


def _comparison_projection(value: str) -> tuple[str, list[int], list[int]]:
    """Build a cosmetic-normalized view while retaining exact source spans.

    The model is not responsible for reproducing display punctuation or exotic
    whitespace perfectly. Matching may therefore ignore case, Unicode display
    forms, and whitespace width, but returned evidence always remains an exact
    slice of the authorized source.
    """
    characters: list[str] = []
    starts: list[int] = []
    ends: list[int] = []
    for index, original in enumerate(value):
        expanded = unicodedata.normalize("NFKC", original).casefold()
        for character in expanded:
            if character.isspace():
                if characters and characters[-1] == " ":
                    ends[-1] = index + 1
                else:
                    characters.append(" ")
                    starts.append(index)
                    ends.append(index + 1)
                continue
            characters.append(character)
            starts.append(index)
            ends.append(index + 1)
    left = 0
    right = len(characters)
    while left < right and characters[left] == " ":
        left += 1
    while right > left and characters[right - 1] == " ":
        right -= 1
    return "".join(characters[left:right]), starts[left:right], ends[left:right]


def _projected_exact_excerpt(candidate: str, authorized_source: str) -> str | None:
    candidate_projection, _, _ = _comparison_projection(candidate)
    source_projection, starts, ends = _comparison_projection(authorized_source)
    if not candidate_projection or not source_projection:
        return None

    def exact_projection(needle: str) -> str | None:
        position = source_projection.find(needle)
        if position < 0:
            return None
        return authorized_source[starts[position]:ends[position + len(needle) - 1]]

    complete = exact_projection(candidate_projection)
    if complete is not None:
        return complete

    # Recover a long exact source span when the model has added or omitted a
    # cosmetic lead-in, such as a URL between a company name and the sentence,
    # while refusing short generic fragments.
    tokens = list(re.finditer(r"[\w]+(?:[-'’][\w]+)*", candidate_projection, re.UNICODE))
    minimum_tokens = 4
    minimum_code_points = 24
    for window_size in range(len(tokens), minimum_tokens - 1, -1):
        for start_index in range(0, len(tokens) - window_size + 1):
            first = tokens[start_index]
            last = tokens[start_index + window_size - 1]
            needle = candidate_projection[first.start():last.end()]
            if len(needle) < minimum_code_points:
                continue
            recovered = exact_projection(needle)
            if recovered is not None:
                return recovered
    return None


def _recover_authorized_excerpt(
    candidate: str,
    question: dict[str, Any],
    source: str,
    metadata: dict[str, Any],
) -> str | None:
    def extend_numeric_travel_suffix(excerpt: str, authorized_source: str) -> str:
        if question["id"] not in {"S2.F11.Q1", "S2.F11.Q2", "S2.F11.Q3"}:
            return excerpt
        start = authorized_source.find(excerpt)
        if start < 0:
            return excerpt
        end = start + len(excerpt)
        suffix = re.match(r"\s*(?:%|percent)(?!\w)", authorized_source[end:], re.IGNORECASE)
        return authorized_source[start:end + suffix.end()] if suffix else excerpt

    try:
        _, _, authorized_source = _evidence_source(candidate, question, source, metadata)
        return extend_numeric_travel_suffix(candidate, authorized_source)
    except ValueError:
        pass
    authorized: list[str] = []
    if "original_jd" in question["allowedSources"]:
        authorized.append(source)
    if "trusted_metadata" in question["allowedSources"]:
        authorized.extend(
            value
            for field in ("company", "title", "location")
            if field in question["allowedMetadataFields"]
            and isinstance((value := metadata.get(field)), str)
        )
    for authorized_source in authorized:
        recovered = _projected_exact_excerpt(candidate, authorized_source)
        if recovered is not None:
            return extend_numeric_travel_suffix(recovered, authorized_source)
    return None


def _evidence_comparison_key(value: str) -> str:
    return _comparison_projection(value)[0]


def _supporting_text_from_block(
    block: str,
    question: dict[str, Any],
    source: str,
    metadata: dict[str, Any],
) -> list[str]:
    matches: list[str] = []
    comparison_keys: list[str] = []
    for candidate in _candidate_variants(block):
        recovered = _recover_authorized_excerpt(candidate, question, source, metadata)
        if recovered is None:
            continue
        maximum_excerpt = question["evidenceRule"]["maximumExcerptCodePoints"]
        maximum_total = question["evidenceRule"]["maximumTotalExcerptCodePoints"]
        maximum_count = question["evidenceRule"]["yes"]["maximumExactExcerpts"]
        bounded = [recovered]
        if len(recovered) > maximum_excerpt:
            # Only split a passage after proving the complete model-selected
            # passage is exact source text. This prevents an inexact paraphrase
            # from passing merely because it contains a few generic exact words.
            if maximum_count >= 2:
                window = min(maximum_excerpt, maximum_total // 2)
                first = recovered[:window]
                last = recovered[-window:]
                if " " in first:
                    first = first.rsplit(" ", 1)[0]
                if " " in last:
                    last = last.split(" ", 1)[1]
                bounded = [first.strip(), last.strip()]
            else:
                bounded = [recovered[:min(maximum_excerpt, maximum_total)].strip()]
        for exact in bounded:
            if not exact or len(exact) > maximum_excerpt:
                continue
            key = _evidence_comparison_key(exact)
            if any(key == selected or key in selected or selected in key for selected in comparison_keys):
                continue
            remaining = maximum_total - sum(len(selected) for selected in matches)
            if remaining <= 0:
                break
            if len(exact) > remaining:
                exact = exact[:remaining]
                if " " in exact:
                    exact = exact.rsplit(" ", 1)[0]
                exact = exact.strip()
                key = _evidence_comparison_key(exact)
            if not exact or len(exact) > maximum_excerpt:
                continue
            matches.append(exact)
            comparison_keys.append(key)
            if len(matches) == maximum_count:
                break
        if len(matches) == maximum_count:
            break
    return matches


def parse_plain_factual_output(
    raw_output: str,
    packet: PhysicalPacket,
    source: str,
    metadata: dict[str, Any],
) -> dict[str, Any]:
    """Parse ordinary numbered model text into the controller's private shape.

    The model never receives the private response schema. Stage 2's model words
    are normalized here: ``present`` becomes the internal affirmative ``yes``
    and ``not found`` becomes the internal evidence-silent ``unsupported``.
    """
    if not isinstance(raw_output, str) or not raw_output.strip():
        raise ValueError("factual output is empty")
    lines = raw_output.splitlines()
    records: list[dict[str, Any]] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        match = _TABLE_ANSWER_LINE.match(line) or _COMBINED_ANSWER_LINE.match(line)
        answer_line = index
        if match is None:
            number_only = _NUMBER_ONLY_LINE.match(line)
            if number_only is not None:
                probe = index + 1
                while probe < len(lines) and not lines[probe].strip():
                    probe += 1
                answer_only = _ANSWER_ONLY_LINE.match(lines[probe]) if probe < len(lines) else None
                if answer_only is not None:
                    match = answer_only
                    answer_line = probe
                    number = int(number_only.group("number"))
                else:
                    index += 1
                    continue
            else:
                index += 1
                continue
        if match is not None:
            if _NUMBER_ONLY_LINE.match(line) is None:
                number = int(match.group("number"))
            records.append({
                "number": number,
                "answer": _normalized_model_answer(match.group("answer")),
                "remainder": match.group("remainder").strip(),
                "headerLine": index,
                "answerLine": answer_line,
            })
            index = answer_line + 1

    # Capture each answer's following evidence in the order the model emitted
    # it. Missing, duplicated, or extra display rows are presentation issues:
    # the controller keeps the last recognizable row for an expected number
    # and supplies an evidence-silent answer for any omitted number.
    for offset, record in enumerate(records):
        next_header = records[offset + 1]["headerLine"] if offset + 1 < len(records) else len(lines)
        evidence_lines = lines[record["answerLine"] + 1:next_header]
        block_parts = [record["remainder"], "\n".join(evidence_lines).strip()]
        record["evidenceBlock"] = "\n".join(part for part in block_parts if part).strip()
    stage2 = packet.private_phase == "stage2"
    expected_numbers = list(range(1, len(packet.ordered_questions) + 1))
    numbered = {
        record["number"]: record
        for record in records
        if record["number"] in expected_numbers
    }
    records = [
        numbered.get(number, {
            "number": number,
            "answer": "not found" if stage2 else "unsupported",
            "evidenceBlock": "",
        })
        for number in expected_numbers
    ]

    allowed = {"present", "not found"} if stage2 else {"yes", "no", "unsupported"}
    answers: list[dict[str, Any]] = []
    for record, question in zip(records, packet.ordered_questions):
        if record["answer"] not in allowed:
            raise ValueError(
                f"question {record['number']} uses an answer outside the plain vocabulary"
            )
        evidence_block = record["evidenceBlock"]
        affirmative = record["answer"] in {"yes", "present"}
        supporting_text = _supporting_text_from_block(
            evidence_block, question, source, metadata
        ) if affirmative else []
        internal_answer = (
            "yes" if record["answer"] == "present"
            else "unsupported" if record["answer"] == "not found"
            else record["answer"]
        )
        answers.append({
            "number": record["number"],
            "answer": internal_answer,
            "supportingText": supporting_text,
        })
    return {"answers": answers}


def _includes_any(text: str, values: Iterable[str]) -> bool:
    lowered = text.casefold()
    return any(value.casefold() in lowered for value in values)


def _evidence_source(
    quote: str,
    question: dict[str, Any],
    source: str,
    metadata: dict[str, Any],
) -> tuple[str, str | None, str]:
    if "original_jd" in question["allowedSources"] and quote in source:
        return "original_jd", None, source
    if "trusted_metadata" in question["allowedSources"]:
        for field in ("company", "title", "location"):
            value = metadata.get(field)
            if field in question["allowedMetadataFields"] and isinstance(value, str) and quote in value:
                return "trusted_metadata", field, value
    raise ValueError(f"{question['id']} supporting text is not exact authorized source text")


def _assert_machine_guard(
    question: dict[str, Any],
    entries: list[dict[str, Any]],
    authorities: AimAuthorities,
) -> None:
    if not entries:
        return
    guards = authorities.policy["machineEvidenceGuards"]
    guard = guards["questionGuards"].get(question["id"])
    if not guard:
        return
    kind = guard["kind"]
    texts = [entry["exactQuote"].casefold() for entry in entries]
    combined = "\n".join(texts)
    if kind == "primary_activity_same_scope":
        same = any(
            _includes_any(text, guards["primaryOrMajorityPhrases"])
            and _includes_any(text, guard["activityLexemes"])
            for text in texts
        )
        heading = (
            len(entries) == 2
            and _includes_any(texts[0], guards["governingHeadingPhrases"])
            and _includes_any(texts[1], guard["activityLexemes"])
            and entries[0]["source"] == entries[1]["source"]
            and entries[0].get("field") == entries[1].get("field")
            and entries[0]["occurrences"][0]["endCodePoint"] <= entries[1]["occurrences"][0]["startCodePoint"]
        )
        if not same and not heading:
            raise ValueError(f"{question['id']} lacks the primary or majority evidence guard")
    elif kind == "named_required_location_same_scope":
        if not _includes_any(combined, guard["requirementLexemes"]):
            raise ValueError(f"{question['id']} lacks a required-location expression")
        original = " ".join(entry["exactQuote"] for entry in entries)
        named_after_preposition = re.search(
            r"\b(?:in|to|at|within)\s+(?:the\s+)?(?:[A-Z][^\W\d_]*(?:[ .-]+[A-Z][^\W\d_]*){0,3}|[A-Z]{2})(?:\b|,)",
            original,
            flags=re.UNICODE,
        )
        named_broad = re.search(
            r"\b(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia|united states|canada)\b",
            original,
            flags=re.IGNORECASE | re.UNICODE,
        )
        if not named_after_preposition and not named_broad:
            raise ValueError(f"{question['id']} lacks a named location")
    elif kind == "closed_direct_employer_lexeme":
        lexemes = guard.get("employerLexemes")
        if not lexemes and question["id"] == "S1.Q06":
            lexemes = authorities.policy["stage1"]["localInsuranceAgencyPolicy"]["directEmployerLexemes"]
        if lexemes and not _includes_any(combined, lexemes):
            raise ValueError(f"{question['id']} lacks a direct-employer expression")
    elif kind == "same_scope_lexeme":
        if not any(_includes_any(text, guard["requiredLexemes"]) for text in texts):
            raise ValueError(f"{question['id']} lacks its responsibility expression")
    elif kind == "partnership_management_same_scope":
        if not any(
            _includes_any(text, guard["actionLexemes"])
            and _includes_any(text, guard["partnerLexemes"])
            for text in texts
        ):
            raise ValueError(f"{question['id']} lacks partner-management responsibility")
    elif kind == "linked_cross_lifecycle":
        if not _includes_any(combined, guard["preSaleLexemes"]) or not _includes_any(combined, guard["postSaleLexemes"]):
            raise ValueError(f"{question['id']} lacks both lifecycle sides")
    elif kind == "accountability_same_scope":
        if not any(_includes_any(text, guards["accountabilityLexemes"]) for text in texts):
            raise ValueError(f"{question['id']} lacks accountability language")
    elif kind == "metric_reporting_same_scope":
        if not any(
            re.search(r"\b(?:report|reporting|performance)\b", text)
            and re.search(r"\b(?:defined\s+metrics?|metrics?|kpis?|targets?|quotas?|revenue|pipeline|conversion|retention|renewals?)\b", text)
            for text in texts
        ):
            raise ValueError(f"{question['id']} lacks metric-reporting language tied to a defined metric")
    elif kind == "prescribed_or_mature_with_limited_change":
        if not re.search(r"\b(?:prescribed|standardized|mature|established)\b", combined) or not re.search(
            r"\b(?:limited|little|no)\b.{0,80}\b(?:authority|change|modify|redesign)\b", combined
        ):
            raise ValueError(f"{question['id']} lacks a process limitation expression")
    elif kind == "final_or_approval_authority":
        if not _includes_any(combined, guards["finalAuthorityLexemes"]):
            raise ValueError(f"{question['id']} lacks final authority language")
    elif kind == "parsed_compensation_value_inside_evidence":
        if not re.search(r"(?<![\w.])(?:USD\s*|US\$\s*|\$\s*)?\d+(?:,\d{3})*(?:\.\d{1,2})?\s*[kK]?(?![\w])", combined, re.IGNORECASE):
            raise ValueError(f"{question['id']} lacks a compensation value")
    elif kind == "parsed_travel_value_inside_evidence":
        if not re.search(r"\b\d{1,3}\s*(?:%|percent)(?!\w)", combined, re.IGNORECASE):
            raise ValueError(f"{question['id']} lacks a travel percentage")
    elif kind == "travel_qualitative_same_scope":
        if not re.search(r"\btravels?(?:ing)?\b|\btravel\b", combined, re.IGNORECASE) or not _includes_any(
            combined, authorities.policy["travel"]["qualitativeLexemes"].keys()
        ):
            raise ValueError(f"{question['id']} lacks travel plus a configured qualitative term")
    elif kind == "travel_named_scope_same_scope":
        named: dict[str, tuple[str, ...]] = {
            "S2.TR.Q05": ("local", "territory"),
            "S2.TR.Q06": ("regional", "multistate", "multi-state"),
            "S2.TR.Q07": ("national", "united states", "u.s."),
            "S2.TR.Q08": ("canada", "north america", "north american"),
            "S2.TR.Q09": ("international", "global"),
            "S2.TR.Q10": ("customer", "partner", "in-person", "in person"),
            "S2.TR.Q11": ("customer-site", "partner-site", "external meeting", "presentation", "business review", "implementation", "deployment", "training", "technical"),
            "S2.TR.Q12": ("field-based", "remote", "home-based", "overnight", "air travel", "driving"),
            "S2.TR.Q13": ("conference", "trade show", "event", "internal meeting", "team gathering"),
        }
        has_named_scope = _includes_any(combined, named.get(question["id"], ()))
        if question["id"] == "S2.TR.Q10":
            has_named_scope = (
                _includes_any(combined, ("recurring", "regular"))
                and _includes_any(combined, ("customer", "partner"))
            )
        if not re.search(r"\btravel(?:s|ing|led|ling)?\b", combined, re.IGNORECASE) or not has_named_scope:
            raise ValueError(f"{question['id']} lacks travel plus its named scope")
    elif kind == "exact_geographic_modifier":
        named = {
            "S2.SC.Q04": ("multi-country", "international", "multi-region"),
            "S2.SC.Q05": ("global",),
            "S2.SC.Q08": ("global",),
            "S2.LI.Q13": ("multiple geographic regions", "multi-region", "across regions"),
            "S2.LI.Q14": ("global",),
        }
        if not _includes_any(combined, named.get(question["id"], ())):
            raise ValueError(f"{question['id']} lacks its exact geographic modifier")
    else:
        raise ValueError(f"{question['id']} uses unsupported machine guard {kind}")


def validate_worker_response(
    response: dict[str, Any],
    packet: PhysicalPacket,
    source: str,
    metadata: dict[str, Any],
    authorities: AimAuthorities,
    *,
    downgrade_invalid_affirmatives: bool = False,
) -> dict[str, Any]:
    validate_schema(response, packet.response_schema)
    expected_numbers = list(range(1, len(packet.ordered_questions) + 1))
    if [answer.get("number") for answer in response.get("answers", [])] != expected_numbers:
        raise ValueError("factual response does not preserve exact local-number membership and order")
    catalog: dict[str, dict[str, Any]] = {}
    answers: list[dict[str, Any]] = []
    for question, answer in zip(packet.ordered_questions, response["answers"]):
        answer_value = answer["answer"]
        # Only an affirmative answer can establish a scoreable fact or a Stage 1
        # dismissal. Evidence attached to no/unsupported is neither needed nor
        # authoritative, so discard it instead of asking the worker to prove an
        # absence or failing an otherwise safe answer.
        texts = answer["supportingText"] if answer_value == "yes" else []
        entries: list[dict[str, Any]] = []
        try:
            if len(texts) != len(set(texts)):
                raise ValueError(f"{question['id']} repeats supporting text")
            rule = question["evidenceRule"][answer_value]
            if len(texts) < rule["minimumExactExcerpts"] or len(texts) > rule["maximumExactExcerpts"]:
                raise ValueError(f"{question['id']} has invalid evidence cardinality")
            if sum(len(text) for text in texts) > question["evidenceRule"]["maximumTotalExcerptCodePoints"]:
                raise ValueError(f"{question['id']} evidence exceeds its combined limit")
            for quote in texts:
                if quote != normalize_source_text(quote):
                    raise ValueError(f"{question['id']} evidence is not canonical text")
                if len(quote) > question["evidenceRule"]["maximumExcerptCodePoints"]:
                    raise ValueError(f"{question['id']} evidence quote is too long")
                source_kind, field, authorized_source = _evidence_source(quote, question, source, metadata)
                occurrences = all_codepoint_occurrences(authorized_source, quote)
                entry = {
                    "evidenceId": "",
                    "source": source_kind,
                    "field": field,
                    "exactQuote": quote,
                    "occurrences": occurrences,
                }
                entry["evidenceId"] = evidence_id(entry)
                entries.append(entry)
            if answer_value == "yes":
                _assert_machine_guard(question, entries, authorities)
        except ValueError:
            if not downgrade_invalid_affirmatives or answer_value != "yes":
                raise
            answer_value = "unsupported"
            entries = []
        for entry in entries:
            catalog[entry["evidenceId"]] = entry
        answers.append({
            "questionId": question["id"],
            "answer": answer_value,
            "evidenceIds": [entry["evidenceId"] for entry in entries],
        })
    return {"answers": answers, "evidenceCatalog": sorted(catalog.values(), key=evidence_sort_key)}


def expected_question_ids(scope: str, authorities: AimAuthorities) -> list[str]:
    if scope == "stage1":
        return [question["id"] for question in authorities.registry["questions"] if question["privatePhase"] == "stage1"]
    if scope == "complete":
        return [question["id"] for question in authorities.registry["questions"]]
    if scope != "compensation_preflight":
        raise ValueError(f"unknown Aim factual-vector scope {scope}")
    early_count = len(authorities.runner_protocol["packetStrategy"]["stage2"]["earlyBaseOrdinals"])
    early_ids = {
        question["id"]
        for packet in stage2_logical_packets(authorities)[:early_count]
        for question in packet.ordered_questions
    }
    return [
        question["id"]
        for question in authorities.registry["questions"]
        if question["privatePhase"] == "stage1" or question["id"] in early_ids
    ]


def declared_conflict_question_ids(
    vector: dict[str, Any], authorities: AimAuthorities
) -> tuple[str, ...]:
    """Return the stable IDs participating in a declared cross-question conflict.

    This is intentionally closed over the policy authority. It does not invent a
    generic semantic-conflict classifier or synthesize a missing positive answer.
    """
    yes_ids = {
        answer["questionId"]
        for answer in vector.get("answers", [])
        if answer.get("answer") == "yes"
    }
    involved: set[str] = set()
    for closure in authorities.policy["preferenceScoring"]["crossQuestionClosures"]:
        antecedent = closure["if"]
        if antecedent not in yes_ids:
            continue
        closed = True
        closure_ids = {antecedent}
        for requirement in closure["thenAll"]:
            if isinstance(requirement, str):
                closure_ids.add(requirement)
                closed = closed and requirement in yes_ids
            else:
                alternatives = set(requirement["any"])
                closure_ids.update(alternatives)
                closed = closed and bool(alternatives & yes_ids)
        if not closed:
            involved.update(closure_ids)
    return tuple(sorted(involved))


def assemble_factual_vector(
    *,
    scope: str,
    source: str,
    metadata: dict[str, Any],
    packet_values: Iterable[dict[str, Any]],
    packet_receipts: list[dict[str, Any]],
    packet_plan_hash: str | None,
    authorities: AimAuthorities,
    batch_bindings: dict[str, Any],
    disposition: str,
    source_extraction_id: str | None,
) -> dict[str, Any]:
    answer_by_id: dict[str, dict[str, Any]] = {}
    catalog_by_id: dict[str, dict[str, Any]] = {}
    for packet in packet_values:
        for answer in packet["answers"]:
            if answer["questionId"] in answer_by_id:
                raise ValueError(f"duplicate factual answer {answer['questionId']}")
            answer_by_id[answer["questionId"]] = answer
        for entry in packet["evidenceCatalog"]:
            existing = catalog_by_id.get(entry["evidenceId"])
            if existing is not None and canonical_json(existing) != canonical_json(entry):
                raise ValueError("same Aim evidence ID has divergent content")
            catalog_by_id[entry["evidenceId"]] = entry
    ordered_catalog = sorted(catalog_by_id.values(), key=evidence_sort_key)
    catalog_order = {entry["evidenceId"]: index for index, entry in enumerate(ordered_catalog)}
    ids = expected_question_ids(scope, authorities)
    if set(answer_by_id) != set(ids):
        missing = sorted(set(ids) - set(answer_by_id))
        extra = sorted(set(answer_by_id) - set(ids))
        raise ValueError(f"Aim factual scope membership mismatch; missing={missing[:3]} extra={extra[:3]}")
    ordered_answers = []
    for question_id in ids:
        answer = dict(answer_by_id[question_id])
        answer["evidenceIds"] = sorted(answer["evidenceIds"], key=catalog_order.__getitem__)
        ordered_answers.append(answer)
    source_hash = source_jd_hash(source)
    metadata_hash = trusted_metadata_hash(metadata)
    source_id = source_identity(source_hash, metadata_hash)
    extraction_id = extraction_identity({
        "sourceIdentity": source_id,
        "questionRegistryVersion": batch_bindings["questionRegistryVersion"],
        "questionRegistryHash": batch_bindings["questionRegistryHash"],
        "promptContractVersion": batch_bindings["promptContractVersion"],
        "promptContractHash": batch_bindings["promptContractHash"],
        "responseContractVersion": batch_bindings["responseContractVersion"],
        "responseContractHash": batch_bindings["responseContractHash"],
        "packetStrategyVersion": batch_bindings["packetStrategyVersion"],
        "packetStrategyHash": batch_bindings["packetStrategyHash"],
        "canonicalizationVersion": batch_bindings["canonicalizationVersion"],
        "anonymizationPolicyVersion": batch_bindings["anonymizationPolicyVersion"],
        "anonymizationPolicyHash": batch_bindings["anonymizationPolicyHash"],
        "extractorSemanticVersion": batch_bindings["extractorSemanticVersion"],
    })
    vector = {
        "schemaVersion": "career-dashboard-aim-factual-vector-v1",
        "scope": scope,
        "sourceJdHash": source_hash,
        "trustedMetadataHash": metadata_hash,
        "sourceIdentity": source_id,
        "questionRegistryVersion": batch_bindings["questionRegistryVersion"],
        "questionRegistryHash": batch_bindings["questionRegistryHash"],
        "promptContractVersion": batch_bindings["promptContractVersion"],
        "promptContractHash": batch_bindings["promptContractHash"],
        "responseContractVersion": batch_bindings["responseContractVersion"],
        "responseContractHash": batch_bindings["responseContractHash"],
        "runnerProtocolVersion": batch_bindings["runnerProtocolVersion"],
        "runnerProtocolHash": batch_bindings["runnerProtocolHash"],
        "packetStrategyVersion": batch_bindings["packetStrategyVersion"],
        "packetStrategyHash": batch_bindings["packetStrategyHash"],
        "canonicalizationVersion": batch_bindings["canonicalizationVersion"],
        "anonymizationPolicyVersion": batch_bindings["anonymizationPolicyVersion"],
        "anonymizationPolicyHash": batch_bindings["anonymizationPolicyHash"],
        "extractorSemanticVersion": batch_bindings["extractorSemanticVersion"],
        "extractionIdentity": extraction_id,
        "answers": ordered_answers,
        "evidenceCatalog": ordered_catalog,
        "factualVectorHash": "",
        "provenance": {
            "disposition": disposition,
            "sourceExtractionId": source_extraction_id,
            "packetPlanHash": packet_plan_hash,
            "packets": packet_receipts,
        },
    }
    vector["factualVectorHash"] = factual_vector_hash(vector)
    return vector


def validate_factual_vector(
    vector: dict[str, Any],
    source: str,
    metadata: dict[str, Any],
    authorities: AimAuthorities,
    batch_bindings: dict[str, Any],
) -> dict[str, Any]:
    if vector.get("schemaVersion") != "career-dashboard-aim-factual-vector-v1":
        raise ValueError("unsupported Aim factual-vector schema")
    expected_ids = expected_question_ids(vector.get("scope", ""), authorities)
    if [answer.get("questionId") for answer in vector.get("answers", [])] != expected_ids:
        raise ValueError("Aim factual-vector membership/order mismatch")
    if vector.get("sourceJdHash") != source_jd_hash(source):
        raise ValueError("Aim factual-vector source hash mismatch")
    metadata_hash = trusted_metadata_hash(metadata)
    if vector.get("trustedMetadataHash") != metadata_hash:
        raise ValueError("Aim factual-vector metadata hash mismatch")
    source_id = source_identity(vector["sourceJdHash"], metadata_hash)
    if vector.get("sourceIdentity") != source_id:
        raise ValueError("Aim factual-vector source identity mismatch")
    # Runner protocol/version remains immutable provenance on an accepted vector,
    # but a pure execution/preflight change is not an extraction invalidator. A
    # semantic runner change must instead increment extractorSemanticVersion.
    for key in (
        "questionRegistryVersion", "questionRegistryHash", "promptContractVersion", "promptContractHash",
        "responseContractVersion", "responseContractHash", "packetStrategyVersion", "packetStrategyHash",
        "canonicalizationVersion",
        "anonymizationPolicyVersion", "anonymizationPolicyHash", "extractorSemanticVersion",
    ):
        if vector.get(key) != batch_bindings.get(key):
            raise ValueError(f"Aim factual-vector {key} mismatch")
    expected_extraction = extraction_identity({
        "sourceIdentity": source_id,
        **{key: vector[key] for key in (
            "questionRegistryVersion", "questionRegistryHash", "promptContractVersion", "promptContractHash",
            "responseContractVersion", "responseContractHash", "packetStrategyVersion", "packetStrategyHash",
            "canonicalizationVersion", "anonymizationPolicyVersion", "anonymizationPolicyHash", "extractorSemanticVersion",
        )},
    })
    if vector.get("extractionIdentity") != expected_extraction:
        raise ValueError("Aim factual-vector extraction identity mismatch")
    catalog = vector.get("evidenceCatalog", [])
    if catalog != sorted(catalog, key=evidence_sort_key):
        raise ValueError("Aim factual-vector evidence catalog order mismatch")
    by_id: dict[str, dict[str, Any]] = {}
    for entry in catalog:
        if entry["source"] == "original_jd":
            authorized_source = source
            if entry.get("field") is not None:
                raise ValueError("original-JD evidence has a metadata field")
        else:
            field = entry.get("field")
            authorized_source = metadata.get(field)
            if field not in ("company", "title", "location") or not isinstance(authorized_source, str):
                raise ValueError("trusted-metadata evidence has an invalid field")
        expected_occurrences = all_codepoint_occurrences(authorized_source, entry["exactQuote"])
        if normalize_occurrences(entry["occurrences"]) != expected_occurrences:
            raise ValueError("Aim factual-vector evidence occurrence mismatch")
        if entry["evidenceId"] != evidence_id(entry) or entry["evidenceId"] in by_id:
            raise ValueError("Aim factual-vector evidence identity mismatch")
        by_id[entry["evidenceId"]] = entry
    referenced: set[str] = set()
    for answer in vector["answers"]:
        question = authorities.registry_by_id[answer["questionId"]]
        rule = question["evidenceRule"][answer["answer"]]
        if not rule["minimumExactExcerpts"] <= len(answer["evidenceIds"]) <= rule["maximumExactExcerpts"]:
            raise ValueError("Aim factual-vector answer cardinality mismatch")
        entries = []
        for item in answer["evidenceIds"]:
            entry = by_id.get(item)
            if entry is None:
                raise ValueError("Aim factual-vector references unknown evidence")
            if entry["source"] not in question["allowedSources"]:
                raise ValueError("Aim factual-vector uses an unauthorized evidence source")
            if entry["source"] == "trusted_metadata" and entry["field"] not in question["allowedMetadataFields"]:
                raise ValueError("Aim factual-vector uses an unauthorized metadata field")
            referenced.add(item)
            entries.append(entry)
        if answer["answer"] == "yes":
            _assert_machine_guard(question, entries, authorities)
    if referenced != set(by_id):
        raise ValueError("Aim factual-vector evidence catalog has unreferenced entries")
    if sum(len(entry["exactQuote"]) for entry in catalog) > authorities.runner_protocol["limits"]["maximumUniqueEvidenceCodePointsPerJob"]:
        raise ValueError("Aim factual-vector unique evidence exceeds its contract limit")
    if vector.get("factualVectorHash") != factual_vector_hash(vector):
        raise ValueError("Aim factual-vector hash mismatch")
    return vector
