#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from scoring_protocol.cli import project_output_dir, repo_root
from scoring_protocol.run_bundle import finalize_experience_bundle


def main() -> int:
    parser = argparse.ArgumentParser(description="Finalize a manually audited Experience scoring run")
    parser.add_argument("draft", type=Path)
    parser.add_argument("review", type=Path)
    parser.add_argument("--output-dir", type=Path, default=project_output_dir())
    parser.add_argument("--delivery-dir", type=Path, default=Path.home() / "Desktop")
    arguments = parser.parse_args()
    result = finalize_experience_bundle(
        draft_path=arguments.draft.expanduser().resolve(),
        review_path=arguments.review.expanduser().resolve(),
        output_dir=arguments.output_dir.expanduser().resolve(),
        delivery_dir=arguments.delivery_dir.expanduser().resolve(),
        repo_root=repo_root(),
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
