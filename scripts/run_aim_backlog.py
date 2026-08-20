#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path

from scoring_protocol.aim_backlog import DashboardClient, exit_summary, run_backlog
from scoring_protocol.cli import project_output_dir, repo_root


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Resumably process the Dashboard Aim queue without manual JSON downloads or uploads",
    )
    parser.add_argument("--dashboard-url", required=True, help="Dashboard origin, for example http://100.80.154.113:3000")
    parser.add_argument("--run-id", default=None, help="resume an existing run ID under the output directory")
    parser.add_argument("--max-jobs", type=int, default=None, help="bounded snapshot target; default is the observed Aim queue count")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=project_output_dir(),
        help="canonical ignored scoring result/checkpoint/backlog-run directory",
    )
    parser.add_argument(
        "--delivery-dir",
        type=Path,
        default=Path.home() / "Desktop",
        help="directory for automatically verified upload copies (default: Desktop)",
    )
    parser.add_argument("--model", default=None, help="exact installed Codex model identifier; never falls back")
    parser.add_argument("--effort", choices=("medium",), default=None, help="governed Aim runner entrypoint")
    parser.add_argument(
        "--interactive-apply",
        action="store_true",
        help="after each exact preview, require a typed batch-bound confirmation and then continue",
    )
    parser.add_argument(
        "--auto-apply",
        action="store_true",
        help="import exact valid previews automatically; stop if none apply or safe failures reach half the batch",
    )
    arguments = parser.parse_args()
    if arguments.max_jobs is not None and arguments.max_jobs < 1:
        parser.error("--max-jobs must be at least 1")
    if arguments.interactive_apply and arguments.auto_apply:
        parser.error("--interactive-apply and --auto-apply are mutually exclusive")

    state_path, state = run_backlog(
        client=DashboardClient(arguments.dashboard_url),
        repo_root=repo_root(),
        output_dir=arguments.output_dir.expanduser().resolve(),
        delivery_dir=arguments.delivery_dir.expanduser().resolve(),
        run_id=arguments.run_id,
        max_jobs=arguments.max_jobs,
        interactive_apply=arguments.interactive_apply,
        auto_apply=arguments.auto_apply,
        model=arguments.model,
        effort=arguments.effort,
    )
    print(exit_summary(state_path, state))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
