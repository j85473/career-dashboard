from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = REPO_ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from scoring_protocol.aim_registry import (  # noqa: E402
    ModelContextLimitError,
    load_aim_authorities,
    plan_physical_packets,
    stage1_logical_packet,
    stage2_logical_packets,
)


class AimRegistryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.authorities = load_aim_authorities(REPO_ROOT)

    def test_exact_counts_hashes_and_stable_private_assignment(self) -> None:
        authorities = self.authorities
        self.assertEqual(authorities.question_registry_hash, "8813d7c352d003953142ede9af7faf31f74d8f56bd4b304db7d299ef8f54d046")
        self.assertEqual(authorities.scoring_policy_hash, "3af1eaf21fd09a70839a9b9c3eecc27c4a07a04759ad453ede081c38eef850cb")
        self.assertEqual(authorities.runner_protocol_hash, "eff9c7c237e978d33f111a8b42b7892725f2584a7597fae4697e8cfcac27988f")
        self.assertEqual(authorities.packet_strategy_hash, "0723425ac01276ed4374c49fd36b1d28c69971c0e3b6d30aa62bc46113022636")
        packets = stage2_logical_packets(authorities)
        self.assertEqual([len(packet.ordered_questions) for packet in packets], [30, 104, 104, 104])
        self.assertEqual(sum(question["parserInput"] == "compensation_fact" for question in packets[0].ordered_questions), 30)
        self.assertTrue(all(
            question["parserInput"] != "compensation_fact"
            for packet in packets[1:]
            for question in packet.ordered_questions
        ))
        self.assertEqual([question["id"] for question in packets[0].ordered_questions[:3]], ["S2.F10.Q23", "S2.F10.Q10", "S2.F10.Q25"])
        self.assertEqual(len({question["id"] for packet in packets for question in packet.ordered_questions}), 342)

    def test_rendering_uses_complete_source_local_numbers_and_no_stable_ids(self) -> None:
        source = "Complete supplied material with tabs\tand NBSP\u00a0preserved."
        metadata = {"company": "Example", "title": "Channel Manager", "location": "Minneapolis, MN"}
        packets = plan_physical_packets(
            [stage1_logical_packet(self.authorities)], source, metadata, 200_000, self.authorities
        )
        self.assertEqual(len(packets), 1)
        rendered = packets[0].rendered_input
        self.assertIn(source, rendered)
        self.assertNotIn("S1.Q", rendered)
        self.assertEqual(sum(1 for line in rendered.splitlines() if line[:1].isdigit() and ". " in line), 7)
        self.assertIn("Use yes only", rendered)
        self.assertIn("Company: Example", rendered)
        self.assertNotIn("career dashboard", rendered.casefold())
        self.assertNotIn("score", rendered.casefold())

    def test_stage2_renders_all_questions_as_plain_present_or_not_found_work(self) -> None:
        source = "No relevant facts are stated."
        metadata = {"company": "Example", "title": "Manager", "location": None}
        packets = plan_physical_packets(
            stage2_logical_packets(self.authorities), source, metadata, 200_000, self.authorities
        )
        self.assertEqual(len(packets), 4)
        self.assertEqual(sum(len(packet.ordered_questions) for packet in packets), 342)
        for packet in packets:
            self.assertIn("Use present", packet.rendered_input)
            self.assertIn("not found", packet.rendered_input)
            self.assertNotIn("JSON", packet.rendered_input)
            self.assertNotIn("schema", packet.rendered_input.casefold())
            self.assertTrue(all(question["id"] not in packet.rendered_input for question in packet.ordered_questions))

    def test_balanced_physical_split_is_depth_first_and_never_truncates_source(self) -> None:
        source = "x" * 13_000
        metadata = {"company": "Example", "title": "Channel Manager", "location": None}
        packets = plan_physical_packets(
            [stage1_logical_packet(self.authorities)], source, metadata, 20_000, self.authorities
        )
        self.assertGreater(len(packets), 1)
        self.assertEqual([packet.packet_path for packet in packets], sorted(
            [packet.packet_path for packet in packets], key=lambda value: value.replace("L", "0").replace("R", "1")
        ))
        self.assertTrue(all(source in packet.rendered_input for packet in packets))
        with self.assertRaises(ModelContextLimitError):
            plan_physical_packets(
                [stage1_logical_packet(self.authorities)], "x" * 40_000, metadata, 20_000, self.authorities
            )


if __name__ == "__main__":
    unittest.main()
