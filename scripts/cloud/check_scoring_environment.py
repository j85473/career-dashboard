#!/usr/bin/env python3
"""Check cloud scoring dependencies; optionally exercise synthetic model workers.

Never reads a job export, creates a batch, or writes to the Dashboard.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from scoring_protocol.aim_registry import load_aim_authorities  # noqa: E402
from scoring_protocol.codex_worker import installed_models, run_worker  # noqa: E402
from scoring_protocol.common import atomic_write_json, load_json, utc_timestamp  # noqa: E402

REQUIRED_FLAGS = (
    "--strict-config", "--ignore-user-config", "--ignore-rules", "--ephemeral",
    "--sandbox", "--disable", "--enable", "--output-last-message", "--json",
)


def worker_requirements(root: Path) -> list[tuple[str, str, bool]]:
    aim = load_aim_authorities(root).runner_protocol
    experience = load_json(root / "data/scoring/experience-runner-protocol-v2.json")
    requirements = [
        (aim["defaultModel"], effort, False) for effort in aim["attemptEfforts"]
    ] + [
        (aim["defaultModel"], aim["stage2Effort"], aim["holisticStage2"]["memoryEnabled"]),
        (experience["defaultModel"], experience["hardGateEffort"], False),
        (experience["defaultModel"], experience["holisticEffort"], False),
    ]
    return list(dict.fromkeys(requirements))


def check_catalog(catalog: dict[str, Any], requirements: list[tuple[str, str, bool]]) -> None:
    for model, effort, _memory in requirements:
        if model not in catalog or effort not in catalog[model].efforts:
            raise RuntimeError(f"Required scoring model is unavailable: {model}/{effort}; no fallback")


def check_writable(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryFile(dir=directory) as handle:
        handle.write(b"cloud-scoring-write-check")
        handle.flush()


def check_dashboard(base_url: str) -> None:
    # urllib uses the environment's configured HTTP(S) proxy for cloud VPN access.
    request = Request(base_url.rstrip("/") + "/api/health", headers={"Accept": "application/json"})
    with urlopen(request, timeout=20) as response:
        health = json.load(response)
    if health.get("ok") is not True:
        raise RuntimeError("Dashboard health check failed; scoring output can still be downloaded")


def check_environment(*, smoke_workers: bool, dashboard_url: str | None, delivery_dir: Path) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    report: dict[str, Any] = {
        "checkedAt": utc_timestamp(), "status": "blocked", "checks": checks,
        "workerInferenceRequested": smoke_workers,
        "workerInferenceVerified": False,
        "dashboardAccessRequested": bool(dashboard_url),
        "dashboardAccessVerified": False,
    }

    def perform(name: str, action: Any) -> Any:
        try:
            value = action()
            checks.append({"check": name, "status": "passed"})
            return value
        except Exception as error:
            # Never echo CLI output or credentials in the portable setup report.
            detail = str(error) if isinstance(error, (RuntimeError, ValueError)) else type(error).__name__
            checks.append({"check": name, "status": "failed", "detail": detail})
            raise

    def command(arguments: list[str]) -> str:
        result = subprocess.run(arguments, cwd=REPO_ROOT, capture_output=True, text=True, timeout=45)
        if result.returncode:
            raise RuntimeError(f"{arguments[0]} command failed; inspect authentication and installed dependencies privately")
        return result.stdout

    try:
        if sys.version_info < (3, 9):
            raise RuntimeError("Python 3.9+ is required")
        def node_check() -> None:
            version = command(["node", "--version"]).strip()
            if not version.startswith("v24."):
                raise RuntimeError("Scoring requires the repository's Node.js 24 runtime")
            command(["node", "--import", "tsx", "-e",
                     "require('./src/lib/aimResultBuilder.ts'); require('./src/lib/scoringExchange.ts')"])
        perform("node-and-result-builder", node_check)
        requirements = perform("scoring-authorities", lambda: worker_requirements(REPO_ROOT))
        report["requiredWorkers"] = [
            {"model": model, "effort": effort, "memoryEnabled": memory}
            for model, effort, memory in requirements
        ]
        output_dir = REPO_ROOT / "data/scoring/results"
        codex_home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser()
        for name, directory in (("results-writable", output_dir), ("delivery-writable", delivery_dir),
                                ("codex-runtime-writable", codex_home)):
            perform(name, lambda directory=directory: check_writable(directory))
        codex = shutil.which("codex")
        if not codex:
            raise RuntimeError("Codex CLI is missing; run the cloud setup script")
        def cli_check() -> None:
            help_text = command([codex, "exec", "--help"])
            if any(flag not in help_text for flag in REQUIRED_FLAGS):
                raise RuntimeError("Installed Codex CLI lacks required worker isolation flags")
        perform("codex-worker-cli", cli_check)
        def models_check() -> None:
            try:
                catalog = installed_models(codex)
            except Exception as error:
                raise RuntimeError("Cannot read Codex model catalog; check cloud CLI authentication privately") from error
            check_catalog(catalog, requirements)
        perform("required-models", models_check)
        if smoke_workers:
            for model, effort, memory in requirements:
                def smoke(model=model, effort=effort, memory=memory) -> None:
                    # Temporary output cannot be mistaken for a job result or resumable batch.
                    with tempfile.TemporaryDirectory(prefix="worker-check-") as temporary:
                        worker = run_worker(
                            phase="environment_check", prompt_version="cloud-environment-check-v1",
                            prompt="Reply with exactly CLOUD_SCORING_OK and no other text. Do not use tools.",
                            schema=None, task_dir=Path(temporary), model=model, effort=effort,
                            timeout_seconds=180, codex_path=codex, maximum_output_bytes=1000,
                            memory_enabled=memory,
                        )
                        if worker.output.strip() != "CLOUD_SCORING_OK":
                            raise RuntimeError("Synthetic worker did not return its expected response")
                perform(f"synthetic-worker:{model}:{effort}:memory={memory}", smoke)
        report["workerInferenceVerified"] = smoke_workers
        if dashboard_url:
            perform("dashboard-health", lambda: check_dashboard(dashboard_url))
            report["dashboardAccessVerified"] = True
        report["status"] = "workers-verified" if smoke_workers else "dependencies-verified"
    except Exception as error:
        report["error"] = str(error) if isinstance(error, (RuntimeError, ValueError)) else type(error).__name__
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--smoke-workers", action="store_true", help="make tiny synthetic model calls; never scores jobs")
    parser.add_argument("--dashboard-url", help="optional read-only check of the M70 through the configured proxy/VPN")
    parser.add_argument("--delivery-dir", type=Path, default=REPO_ROOT / "data/scoring/results/cloud-delivery")
    args = parser.parse_args()
    report = check_environment(smoke_workers=args.smoke_workers, dashboard_url=args.dashboard_url,
                               delivery_dir=args.delivery_dir.expanduser().resolve())
    report_path = REPO_ROOT / "data/scoring/results/cloud-environment-check.json"
    atomic_write_json(report_path, report)
    print(json.dumps({**report, "reportPath": str(report_path)}, indent=2))
    return int(report["status"] == "blocked")


if __name__ == "__main__":
    raise SystemExit(main())
