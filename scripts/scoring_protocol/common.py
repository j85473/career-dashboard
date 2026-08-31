from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MAX_EXCHANGE_BYTES = 32 * 1024 * 1024
RUNNER_VERSION = "career-dashboard-python-runner-v1"
PROTOCOL_VERSION = "career-dashboard-scoring-protocol-v1"


def utc_timestamp(value: datetime | None = None) -> str:
    current = value or datetime.now(timezone.utc)
    return current.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def assert_integer_json(value: Any, path: str = "$") -> None:
    if isinstance(value, float):
        raise ValueError(f"{path} must contain integers only")
    if isinstance(value, list):
        for index, item in enumerate(value):
            assert_integer_json(item, f"{path}[{index}]")
    elif isinstance(value, dict):
        for key, item in value.items():
            assert_integer_json(item, f"{path}.{key}")


def canonical_json(value: Any) -> str:
    def assert_finite(item: Any, path: str = "$") -> None:
        if isinstance(item, float) and not math.isfinite(item):
            raise ValueError(f"{path} must not contain a non-finite number")
        if isinstance(item, list):
            for index, child in enumerate(item):
                assert_finite(child, f"{path}[{index}]")
        elif isinstance(item, dict):
            for key, child in item.items():
                assert_finite(child, f"{path}.{key}")

    assert_finite(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def normalize_source_text(value: str) -> str:
    if "\x00" in value:
        raise ValueError("scoring text must not contain NUL")
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeEncodeError as error:
        raise ValueError("scoring text must contain valid Unicode") from error
    return unicodedata.normalize("NFC", value).replace("\r\n", "\n").replace("\r", "\n")


def normalized_text_sha256(value: str) -> str:
    return hashlib.sha256(normalize_source_text(value).encode("utf-8")).hexdigest()


def exact_codepoint_quote(source: str, start: int, end: int, quote: str) -> None:
    normalized = normalize_source_text(source)
    if not isinstance(start, int) or not isinstance(end, int) or start < 0 or end < start or end > len(normalized):
        raise ValueError("code-point span is invalid")
    if normalized[start:end] != quote:
        raise ValueError("exact quote does not match the source code-point span")


def load_json(
    path: Path, *, integers_only: bool = True, maximum_bytes: int = MAX_EXCHANGE_BYTES,
) -> dict[str, Any]:
    if path.stat().st_size > maximum_bytes:
        raise ValueError(f"scoring exchange exceeds {maximum_bytes} bytes")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"{path} is not valid UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise ValueError("scoring exchange root must be an object")
    if integers_only:
        assert_integer_json(value)
    return value


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n"
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def file_sha256(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def verify_byte_identical(source: Path, destination: Path, chunk_size: int = 1024 * 1024) -> dict[str, Any]:
    source_size = source.stat().st_size
    destination_size = destination.stat().st_size
    if source_size != destination_size:
        raise ValueError("copied artifact byte length does not match the validated project result")

    source_digest = hashlib.sha256()
    destination_digest = hashlib.sha256()
    with source.open("rb") as source_handle, destination.open("rb") as destination_handle:
        while True:
            source_chunk = source_handle.read(chunk_size)
            destination_chunk = destination_handle.read(chunk_size)
            if source_chunk != destination_chunk:
                raise ValueError("copied artifact is not byte-identical to the validated project result")
            if not source_chunk:
                break
            source_digest.update(source_chunk)
            destination_digest.update(destination_chunk)

    source_hash = source_digest.hexdigest()
    destination_hash = destination_digest.hexdigest()
    if source_hash != destination_hash:
        raise ValueError("copied artifact SHA-256 does not match the validated project result")
    return {
        "verified": True,
        "byteIdentical": True,
        "bytes": source_size,
        "sha256": source_hash,
        "sourcePath": str(source.resolve()),
        "destinationPath": str(destination.resolve()),
    }


def atomic_copy_file(source: Path, destination: Path) -> dict[str, Any]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent)
    try:
        with source.open("rb") as source_handle, os.fdopen(descriptor, "wb") as destination_handle:
            shutil.copyfileobj(source_handle, destination_handle)
            destination_handle.flush()
            os.fsync(destination_handle.fileno())
        os.replace(temporary, destination)
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise

    try:
        return verify_byte_identical(source, destination)
    except BaseException:
        destination.unlink(missing_ok=True)
        raise


def with_hash(payload: dict[str, Any], field: str = "resultHash") -> dict[str, Any]:
    result = dict(payload)
    result[field] = canonical_sha256(payload)
    return result


def safe_task_component(value: str) -> str:
    if not value or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for character in value):
        raise ValueError("unsafe batch identifier")
    return value
