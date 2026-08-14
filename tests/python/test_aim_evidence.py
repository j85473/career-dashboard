from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = REPO_ROOT / "scripts"
TESTS = Path(__file__).resolve().parent
for entry in (SCRIPTS, TESTS):
    if str(entry) not in sys.path:
        sys.path.insert(0, str(entry))

from aim_v2_fixtures import make_aim_v2_export  # noqa: E402
from scoring_protocol.aim_evidence import (  # noqa: E402
    assemble_factual_vector,
    parse_plain_factual_output,
    validate_factual_vector,
    validate_worker_response,
)
from scoring_protocol.aim_registry import (  # noqa: E402
    plan_physical_packets,
    stage1_logical_packet,
    stage2_logical_packets,
)


class AimEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.exported, self.authorities = make_aim_v2_export(REPO_ROOT)
        self.job = self.exported["jobs"][0]
        self.source = "This position is temporary. This position is temporary."
        self.metadata = self.job["trustedMetadata"]
        self.packet = plan_physical_packets(
            [stage1_logical_packet(self.authorities)], self.source, self.metadata, 200_000, self.authorities
        )[0]

    def response(self, overrides: dict[str, tuple[str, list[str]]]) -> dict[str, object]:
        answers = []
        for number, question in enumerate(self.packet.ordered_questions, start=1):
            answer, evidence = overrides.get(question["id"], ("unsupported", []))
            answers.append({"number": number, "answer": answer, "supportingText": evidence})
        return {"answers": answers}

    def assemble_stage1_vector(
        self, source: str, value: dict[str, object], packet=None
    ) -> dict[str, object]:
        packet = packet or self.packet
        receipt = {
            "baseOrdinal": 0, "physicalOrdinal": 0, "packetPath": "0",
            "packetManifestHash": packet.packet_manifest_hash, "packetInputHash": "a" * 64,
            "model": "gpt-5.6-terra", "attempts": [], "acceptedAttempt": None,
            "reusedFromPacketManifestHash": packet.packet_manifest_hash,
        }
        return assemble_factual_vector(
            scope="stage1", source=source, metadata=self.metadata, packet_values=[value],
            packet_receipts=[receipt], packet_plan_hash="b" * 64, authorities=self.authorities,
            batch_bindings=self.exported["batch"], disposition="packet_cache_reuse", source_extraction_id=None,
        )

    def test_exact_quotes_bind_every_repeated_occurrence(self) -> None:
        value = validate_worker_response(
            self.response({"S1.Q01": ("yes", ["This position is temporary."])}),
            self.packet, self.source, self.metadata, self.authorities,
        )
        evidence = value["evidenceCatalog"][0]
        self.assertEqual(evidence["occurrences"], [
            {"startCodePoint": 0, "endCodePoint": 27},
            {"startCodePoint": 28, "endCodePoint": 55},
        ])
        self.assertRegex(evidence["evidenceId"], r"^[a-f0-9]{64}$")

    def test_affirmative_paraphrase_and_guard_failure_are_rejected_while_nonaffirmative_evidence_is_discarded(self) -> None:
        missing = self.response({"S1.Q01": ("yes", [])})
        with self.assertRaisesRegex(ValueError, "cardinality"):
            validate_worker_response(missing, self.packet, self.source, self.metadata, self.authorities)
        with self.assertRaisesRegex(ValueError, "exact authorized source"):
            validate_worker_response(
                self.response({"S1.Q01": ("yes", ["This role is temporary."])}),
                self.packet, self.source, self.metadata, self.authorities,
            )
        normalized = validate_worker_response(
            self.response({"S1.Q01": ("unsupported", ["This position is temporary."])}),
            self.packet, self.source, self.metadata, self.authorities,
        )
        self.assertEqual(normalized["evidenceCatalog"], [])
        self.assertEqual(normalized["answers"][0]["evidenceIds"], [])
        source = "The role includes inside sales support."
        packet = plan_physical_packets(
            [stage1_logical_packet(self.authorities)], source, self.metadata, 200_000, self.authorities
        )[0]
        answers = []
        for number, question in enumerate(packet.ordered_questions, start=1):
            answers.append({
                "number": number,
                "answer": "yes" if question["id"] == "S1.Q02" else "unsupported",
                "supportingText": [source] if question["id"] == "S1.Q02" else [],
            })
        with self.assertRaisesRegex(ValueError, "primary or majority"):
            validate_worker_response({"answers": answers}, packet, source, self.metadata, self.authorities)

    def test_quote_length_combined_limit_ellipsis_and_metadata_authority(self) -> None:
        def packet_for(source: str, question_id: str = "S1.Q01"):
            logical = stage1_logical_packet(self.authorities) if question_id.startswith("S1.") else next(
                candidate for candidate in stage2_logical_packets(self.authorities)
                if any(question["id"] == question_id for question in candidate.ordered_questions)
            )
            return next(
                candidate for candidate in plan_physical_packets(
                    [logical], source, self.metadata, 200_000, self.authorities
                )
                if any(question["id"] == question_id for question in candidate.ordered_questions)
            )

        def response_for(packet, question_id: str, answer: str, excerpts: list[str]) -> dict[str, object]:
            return {
                "answers": [
                    {
                        "number": number,
                        "answer": answer if question["id"] == question_id else "unsupported",
                        "supportingText": excerpts if question["id"] == question_id else [],
                    }
                    for number, question in enumerate(packet.ordered_questions, start=1)
                ]
            }

        exact_320 = "x" * 320
        packet = packet_for(exact_320)
        validate_worker_response(
            response_for(packet, "S1.Q01", "yes", [exact_320]),
            packet, exact_320, self.metadata, self.authorities,
        )
        exact_321 = "x" * 321
        packet = packet_for(exact_321)
        with self.assertRaisesRegex(ValueError, "too long"):
            validate_worker_response(
                response_for(packet, "S1.Q01", "yes", [exact_321]),
                packet, exact_321, self.metadata, self.authorities,
            )

        first = "a" * 240
        second = "b" * 240
        source = f"{first}\n{second}"
        packet = packet_for(source)
        validate_worker_response(
            response_for(packet, "S1.Q01", "yes", [first, second]),
            packet, source, self.metadata, self.authorities,
        )
        over = "b" * 241
        source = f"{first}\n{over}"
        packet = packet_for(source)
        with self.assertRaisesRegex(ValueError, "combined limit"):
            validate_worker_response(
                response_for(packet, "S1.Q01", "yes", [first, over]),
                packet, source, self.metadata, self.authorities,
            )

        ellipsis_source = "This position is temporary … and contract."
        packet = packet_for(ellipsis_source)
        validate_worker_response(
            response_for(packet, "S1.Q01", "yes", [ellipsis_source]),
            packet, ellipsis_source, self.metadata, self.authorities,
        )
        with self.assertRaisesRegex(ValueError, "exact authorized source"):
            validate_worker_response(
                response_for(packet, "S1.Q01", "yes", [ellipsis_source.replace("…", "...")]),
                packet, ellipsis_source, self.metadata, self.authorities,
            )

        stage2 = packet_for("Nothing relevant.", "S2.F1.Q1")
        with self.assertRaisesRegex(ValueError, "exact authorized source"):
            validate_worker_response(
                response_for(stage2, "S2.F1.Q1", "yes", [self.metadata["company"]]),
                stage2, "Nothing relevant.", self.metadata, self.authorities,
            )

    def test_plain_stage2_output_is_parsed_and_bound_by_the_script(self) -> None:
        source = "The role manages and grows channel partners."
        question_id = "S2.F1.Q4"
        logical = next(
            packet for packet in stage2_logical_packets(self.authorities)
            if any(question["id"] == question_id for question in packet.ordered_questions)
        )
        packet = plan_physical_packets(
            [logical], source, self.metadata, 200_000, self.authorities
        )[0]
        selected = next(
            number for number, question in enumerate(packet.ordered_questions, start=1)
            if question["id"] == question_id
        )
        lines = []
        for number in range(1, len(packet.ordered_questions) + 1):
            if number == selected:
                lines.append(f'| {number} | **present** | Evidence: "{source}" |')
            else:
                lines.append(f"{number}. not found")
        raw = "\n".join(lines)
        parsed = parse_plain_factual_output(raw, packet, source, self.metadata)
        normalized = validate_worker_response(
            parsed, packet, source, self.metadata, self.authorities
        )
        selected_answer = normalized["answers"][selected - 1]
        self.assertEqual(selected_answer["answer"], "yes")
        self.assertEqual(len(selected_answer["evidenceIds"]), 1)
        self.assertTrue(all(
            answer["answer"] == "unsupported" and answer["evidenceIds"] == []
            for number, answer in enumerate(normalized["answers"], start=1)
            if number != selected
        ))
        reordered = parse_plain_factual_output(
            "\n".join(reversed(lines)), packet, source, self.metadata
        )
        self.assertEqual(reordered["answers"][selected - 1]["answer"], "yes")
        missing = parse_plain_factual_output("\n".join(lines[:-1]), packet, source, self.metadata)
        self.assertEqual(missing["answers"][-1], {
            "number": len(packet.ordered_questions),
            "answer": "unsupported",
            "supportingText": [],
        })

    def test_plain_parser_recovers_cosmetic_evidence_and_never_fails_a_job_for_presentation(self) -> None:
        def packet_for(question_id: str, source: str):
            logical = next(
                packet for packet in stage2_logical_packets(self.authorities)
                if any(question["id"] == question_id for question in packet.ordered_questions)
            )
            return plan_physical_packets(
                [logical], source, self.metadata, 200_000, self.authorities
            )[0]

        def parse_selected(question_id: str, source: str, displayed_evidence: str):
            packet = packet_for(question_id, source)
            selected = next(
                number for number, question in enumerate(packet.ordered_questions, start=1)
                if question["id"] == question_id
            )
            raw = "\n".join(
                f"{number}. present\n{displayed_evidence}" if number == selected
                else f"{number}. not found"
                for number in range(1, len(packet.ordered_questions) + 1)
            )
            parsed = parse_plain_factual_output(raw, packet, source, self.metadata)
            normalized = validate_worker_response(
                parsed,
                packet,
                source,
                self.metadata,
                self.authorities,
                downgrade_invalid_affirmatives=True,
            )
            return parsed["answers"][selected - 1], normalized["answers"][selected - 1], normalized

        shields_source = (
            "The\u00a0Trade Relations National Account Manager is responsible for developing and "
            "executing Limited Distribution Drug (LDD) strategies"
        )
        parsed, answer, _ = parse_selected(
            "S2.F7.Q15",
            shields_source,
            "The Trade Relations National Account Manager is responsible for developing and executing "
            "Limited Distribution Drug (LDD) strategies",
        )
        self.assertEqual(answer["answer"], "yes")
        self.assertEqual(len(parsed["supportingText"]), 1)
        self.assertIn("\u00a0", parsed["supportingText"][0])

        serval_source = (
            "Serval http://serval.com is an AI-native automation platform transforming how enterprises operate."
        )
        parsed, answer, _ = parse_selected(
            "S2.F9.Q40",
            serval_source,
            "“Serval is an AI-native automation platform transforming how enterprises operate.”",
        )
        self.assertEqual(answer["answer"], "yes")
        self.assertEqual(parsed["supportingText"], [
            "is an AI-native automation platform transforming how enterprises operate"
        ])

        power_source = (
            "At the heart of Power Digital is our proprietary technology, nova, which analyzes businesses "
            "through first-party data, simplifying investment planning for marketing and diligence in M&A––"
            "putting marketers in a strategic seat at the table––and providing value in unparalleled ways.\u00a0"
        )
        parsed, answer, normalized = parse_selected(
            "S2.F9.Q8", power_source, f'"{power_source.strip()}"'
        )
        self.assertEqual(answer["answer"], "yes")
        self.assertEqual(len(parsed["supportingText"]), 1)
        self.assertLessEqual(sum(len(text) for text in parsed["supportingText"]), 480)
        self.assertEqual(len(normalized["evidenceCatalog"]), 1)

        parsed, answer, _ = parse_selected(
            "S2.F11.Q1", "Ability to travel up to 30%.", "Ability to travel up to 30"
        )
        self.assertEqual(answer["answer"], "yes")
        self.assertEqual(parsed["supportingText"], ["Ability to travel up to 30%"])

        parsed, answer, normalized = parse_selected(
            "S2.F9.Q2", "Nothing relevant is stated.", "This made-up sentence is not in the JD."
        )
        self.assertEqual(parsed["answer"], "yes")
        self.assertEqual(parsed["supportingText"], [])
        self.assertEqual(answer, {
            "questionId": "S2.F9.Q2", "answer": "unsupported", "evidenceIds": [],
        })
        self.assertEqual(normalized["evidenceCatalog"], [])

    def test_plain_parser_owns_multiline_quote_wrappers_and_excerpt_sizing(self) -> None:
        def packet_for(question_id: str, source: str):
            logical = next(
                packet for packet in stage2_logical_packets(self.authorities)
                if any(question["id"] == question_id for question in packet.ordered_questions)
            )
            return plan_physical_packets(
                [logical], source, self.metadata, 200_000, self.authorities
            )[0]

        def raw_for(packet, selected: int, evidence: str) -> str:
            return "\n".join(
                f"{number}. present\n{evidence}" if number == selected
                else f"{number}. not found"
                for number in range(1, len(packet.ordered_questions) + 1)
            )

        pay_source = "The annual base salary range is: \n$182,000—$319,200 USD"
        pay_packet = packet_for("S2.F10.Q1", pay_source)
        pay_number = next(
            number for number, question in enumerate(pay_packet.ordered_questions, start=1)
            if question["id"] == "S2.F10.Q1"
        )
        pay_raw = raw_for(
            pay_packet, pay_number,
            "“The annual base salary range is:  \n$182,000—$319,200 USD”",
        )
        pay = validate_worker_response(
            parse_plain_factual_output(pay_raw, pay_packet, pay_source, self.metadata),
            pay_packet, pay_source, self.metadata, self.authorities,
        )
        self.assertGreaterEqual(len(pay["answers"][pay_number - 1]["evidenceIds"]), 1)

        long_source = (
            "The Customer Success Manager's main purpose is to act as a first point of contact, "
            "working to resolve questions, escalating complex issues internally, and, most importantly, "
            "onboarding our new customers efficiently and effectively while coordinating launch and deployment "
            "activities with every responsible internal team across the business."
        )
        self.assertGreater(len(long_source), 320)
        long_packet = packet_for("S2.F3.Q12", long_source)
        long_number = next(
            number for number, question in enumerate(long_packet.ordered_questions, start=1)
            if question["id"] == "S2.F3.Q12"
        )
        long_raw = raw_for(long_packet, long_number, f'“{long_source}”')
        long_value = validate_worker_response(
            parse_plain_factual_output(long_raw, long_packet, long_source, self.metadata),
            long_packet, long_source, self.metadata, self.authorities,
        )
        self.assertGreaterEqual(len(long_value["answers"][long_number - 1]["evidenceIds"]), 1)

    def test_assembled_vector_revalidates_scope_source_and_hash(self) -> None:
        value = validate_worker_response(
            self.response({"S1.Q01": ("yes", ["This position is temporary."])}),
            self.packet, self.source, self.metadata, self.authorities,
        )
        vector = self.assemble_stage1_vector(self.source, value)
        self.assertEqual(validate_factual_vector(
            vector, self.source, self.metadata, self.authorities, self.exported["batch"]
        )["factualVectorHash"], vector["factualVectorHash"])
        altered = {**vector, "sourceJdHash": "f" * 64}
        with self.assertRaisesRegex(ValueError, "source hash mismatch"):
            validate_factual_vector(altered, self.source, self.metadata, self.authorities, self.exported["batch"])

    def test_no_and_unsupported_require_no_evidence_and_never_run_positive_guards(self) -> None:
        source = "EverCommerce is a software company."
        packet = plan_physical_packets(
            [stage1_logical_packet(self.authorities)], source, self.metadata, 200_000, self.authorities
        )[0]
        response = {
            "answers": [
                {
                    "number": number,
                    "answer": "no" if question["id"] in {"S1.Q06", "S1.Q07"} else "unsupported",
                    "supportingText": [source] if question["id"] in {"S1.Q06", "S1.Q07"} else [],
                }
                for number, question in enumerate(packet.ordered_questions, start=1)
            ]
        }
        normalized = validate_worker_response(
            response, packet, source, self.metadata, self.authorities,
        )
        self.assertEqual(normalized["evidenceCatalog"], [])
        self.assertTrue(all(answer["evidenceIds"] == [] for answer in normalized["answers"]))

        # Rebuild with the packet used for this source so vector-level validation
        # also exercises the positive-only machine-guard boundary.
        vector = self.assemble_stage1_vector(source, normalized, packet)
        self.assertEqual(validate_factual_vector(
            vector, source, self.metadata, self.authorities, self.exported["batch"]
        )["factualVectorHash"], vector["factualVectorHash"])

    def test_every_declared_machine_guard_family_fails_closed(self) -> None:
        cases = (
            ("S1.Q02", "The role includes inside sales.", "Inside sales is the primary responsibility."),
            ("S1.Q04", "The role includes outbound prospecting.", "Outbound direct prospecting is the primary responsibility."),
            ("S1.Q05", "The role supports retail stores.", "Retail store management is the primary responsibility."),
            ("S1.Q06", "The employer is an insurer.", "The direct employer is an insurance agency."),
            ("S1.Q07", "The employer develops software.", "The direct employer is a religious organization."),
            ("S2.F2.Q12", "Serve customers, partners, and internal teams.", "Manage relationships with implementation partners."),
            ("S2.F3.Q3", "The role uses AI for personalized outreach.", "The role has direct responsibility for outbound prospecting."),
        )

        self.assertEqual(
            set(self.authorities.policy["machineEvidenceGuards"]["questionGuards"]),
            {question_id for question_id, _, _ in cases},
        )

        def packet_for(question_id: str, source: str):
            logical = stage1_logical_packet(self.authorities) if question_id.startswith("S1.") else next(
                packet for packet in stage2_logical_packets(self.authorities)
                if any(question["id"] == question_id for question in packet.ordered_questions)
            )
            return next(
                packet for packet in plan_physical_packets(
                    [logical], source, self.metadata, 200_000, self.authorities
                )
                if any(question["id"] == question_id for question in packet.ordered_questions)
            )

        def guarded_response(packet, question_id: str, quote: str) -> dict[str, object]:
            return {
                "answers": [
                    {
                        "number": number,
                        "answer": "yes" if question["id"] == question_id else "unsupported",
                        "supportingText": [quote] if question["id"] == question_id else [],
                    }
                    for number, question in enumerate(packet.ordered_questions, start=1)
                ]
            }

        for question_id, invalid, valid in cases:
            with self.subTest(question_id=question_id, disposition="invalid"):
                packet = packet_for(question_id, invalid)
                with self.assertRaises(ValueError):
                    validate_worker_response(
                        guarded_response(packet, question_id, invalid),
                        packet, invalid, self.metadata, self.authorities,
                    )
            with self.subTest(question_id=question_id, disposition="valid"):
                packet = packet_for(question_id, valid)
                validate_worker_response(
                    guarded_response(packet, question_id, valid),
                    packet, valid, self.metadata, self.authorities,
                )


if __name__ == "__main__":
    unittest.main()
