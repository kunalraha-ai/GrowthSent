#!/usr/bin/env python3
"""One-WAT runner for a regional, bounded standard-1 Container ramp.

The scheduler deliberately scopes an R2 temporary credential to a regional
run prefix rather than attempting to install one credential per WAT.  Each
task still writes only to its own immutable child prefix; the broader regional
scope is the smallest practical credential boundary for a 1,000-WAT run.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import shutil
import time as clock
from bisect import bisect_left
from typing import Any, Callable, Mapping

import common_crawl_gcp_r2_25k_contract as contract
import common_crawl_http_source as http_source
import common_crawl_r2_store as r2
import common_crawl_semantic_contract_v2 as semantic
import common_crawl_wat_ingest_gcp_25k as raw


RAMP_ROOT = "production/common-crawl/cloudflare-r2-regional-ramps/v1"
INPUT_KIND = "growthsent-cloudflare-r2-standard1-regional-inputs-v1"
TASK_INPUT_KIND = "growthsent-cloudflare-r2-standard1-regional-task-input-v1"
TASK_SUMMARY_KIND = "growthsent-cloudflare-r2-standard1-regional-task-summary-v1"
TASK_COMPLETION_KIND = "growthsent-cloudflare-r2-standard1-regional-task-completed-v1"
WAT_COMPLETION_KIND = "growthsent-cloudflare-r2-standard1-regional-wat-completed-v1"
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
RUN_ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")
# The reviewed profiles use immutable lane identities rather than discovering
# work dynamically.  The future 100K self-recovery profile adds numbered
# lanes across six well-provisioned placement groups.  ME, OC, and AFR remain
# absent because Containers documents them as limited-capacity when exclusive.
REGION_RE = re.compile(r"(?:APAC|ENAM|WNAM|EEUR|WEUR|SAM)(?:-(?:[AB]|0[1-9]|[1-9][0-9]))?\Z")


class RegionalRampError(RuntimeError):
    """The regional standard-1 ramp cannot safely continue."""


class RecoverablePartialTaskPrefixError(RegionalRampError):
    """A task needs a fresh immutable recovery prefix, not an overwrite."""


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def task_number(index: int, count: int) -> int:
    if not isinstance(index, int) or isinstance(index, bool) or not isinstance(count, int) or isinstance(count, bool) or not 0 <= index < count:
        raise RegionalRampError("task index is outside the locked regional input contract")
    return index + 1


def _required_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise RegionalRampError(f"regional input contract {label} must be non-empty text")
    return value


def _required_digest(value: Any, label: str) -> str:
    value = _required_text(value, label)
    if not SHA256_RE.fullmatch(value):
        raise RegionalRampError(f"regional input contract {label} must be a lowercase SHA-256")
    return value


def _required_non_negative_int(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise RegionalRampError(f"regional input contract {label} must be a non-negative integer")
    return value


def ramp_prefix(run_id: str) -> str:
    if not RUN_ID_RE.fullmatch(run_id):
        raise RegionalRampError("run ID must be a short lowercase slug")
    return r2.normalize_key(RAMP_ROOT, run_id)


def region_prefix(run_id: str, region: str) -> str:
    if not REGION_RE.fullmatch(region):
        raise RegionalRampError("region must be a reviewed placement region or a reviewed lane")
    return r2.normalize_key(ramp_prefix(run_id), f"region={region.lower()}")


def task_prefix(run_id: str, region: str, task_index: int, task_count: int) -> str:
    return task_prefix_for_output_prefix(region_prefix(run_id, region), task_index, task_count)


def task_prefix_for_output_prefix(output_prefix: str, task_index: int, task_count: int) -> str:
    """Build a task key below an explicitly scoped immutable lane prefix."""

    return r2.normalize_key(r2.normalize_prefix(output_prefix), "tasks", f"task-{task_number(task_index, task_count):04d}")


def _artifact_key(prefix: str, dataset: str, source: str) -> str:
    if dataset not in {"pages", "links", "metrics"}:
        raise RegionalRampError("unsupported task artifact dataset")
    extension = "json" if dataset == "metrics" else "parquet"
    return r2.normalize_key(prefix, f"crawl={contract.CRAWL}", f"dataset={dataset}", f"part-{contract.part_suffix(source)}.{extension}")


def _wat_completion_key(prefix: str, source: str) -> str:
    return r2.normalize_key(prefix, "control", "wats", f"part-{contract.part_suffix(source)}", "WAT-COMPLETED.json")


def load_inputs(path: Path, *, expected_sha256: str) -> dict[str, Any]:
    if not SHA256_RE.fullmatch(expected_sha256):
        raise RegionalRampError("configured selected-input manifest SHA-256 is invalid")
    if not path.is_file():
        raise RegionalRampError("selected-input manifest is missing")
    if sha256_file(path) != expected_sha256:
        raise RegionalRampError("selected-input manifest differs from the reviewed bundle copy")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RegionalRampError("selected-input manifest is not valid UTF-8 JSON") from error
    if not isinstance(document, dict) or document.get("kind") != INPUT_KIND:
        raise RegionalRampError("selected-input manifest kind is invalid")
    if document.get("crawl") != contract.CRAWL:
        raise RegionalRampError("selected-input manifest crawl differs from the approved contract")
    inputs = document.get("inputs")
    input_count = _required_non_negative_int(document.get("input_count"), "input_count")
    source_indexes = document.get("source_indexes")
    sparse = source_indexes is not None
    if not isinstance(inputs, list) or input_count == 0:
        raise RegionalRampError("selected-input manifest inputs do not match input_count")
    if sparse:
        if not isinstance(source_indexes, list) or len(source_indexes) != len(inputs) or not source_indexes:
            raise RegionalRampError("sparse selected-input manifest indexes do not match its inputs")
        if any(not isinstance(index, int) or isinstance(index, bool) or index < 0 or index >= input_count for index in source_indexes):
            raise RegionalRampError("sparse selected-input manifest contains an out-of-range source index")
        if source_indexes != sorted(set(source_indexes)):
            raise RegionalRampError("sparse selected-input manifest source indexes must be sorted and unique")
    elif len(inputs) != input_count:
        raise RegionalRampError("selected-input manifest inputs do not match input_count")
    _required_digest(document.get("source_manifest_sha256"), "source_manifest_sha256")
    _required_digest(document.get("selected_inputs_sha256"), "selected_inputs_sha256")
    canonical_inputs = canonical_json(inputs)
    if hashlib.sha256(canonical_inputs).hexdigest() != document["selected_inputs_sha256"]:
        raise RegionalRampError("selected-input manifest canonical input digest is invalid")
    seen: set[str] = set()
    for index, item in enumerate(inputs):
        if not isinstance(item, Mapping):
            raise RegionalRampError(f"selected input {index} is not an object")
        source_key = http_source.validate_common_crawl_key(_required_text(item.get("source_key"), f"input {index} source_key"), crawl=contract.CRAWL)
        suffix = _required_text(item.get("deterministic_suffix"), f"input {index} deterministic_suffix")
        if suffix != contract.part_suffix(source_key):
            raise RegionalRampError(f"selected input {index} deterministic suffix does not match its source key")
        if source_key in seen:
            raise RegionalRampError("selected-input manifest contains duplicate source keys")
        seen.add(source_key)
    return document


def selected_input(inputs_document: Mapping[str, Any], *, task_index: int) -> dict[str, str]:
    inputs = inputs_document.get("inputs")
    if not isinstance(inputs, list):
        raise RegionalRampError("selected-input manifest inputs are unavailable")
    input_count = _required_non_negative_int(inputs_document.get("input_count"), "input_count")
    task_number(task_index, input_count)
    source_indexes = inputs_document.get("source_indexes")
    if source_indexes is None:
        value = inputs[task_index]
    else:
        if not isinstance(source_indexes, list):
            raise RegionalRampError("sparse selected-input manifest source indexes are unavailable")
        position = bisect_left(source_indexes, task_index)
        if position >= len(source_indexes) or source_indexes[position] != task_index:
            raise RegionalRampError("task is outside this sparse regional input contract")
        value = inputs[position]
    if not isinstance(value, Mapping):
        raise RegionalRampError("selected input is malformed")
    return {
        "source_key": http_source.validate_common_crawl_key(_required_text(value.get("source_key"), "source_key"), crawl=contract.CRAWL),
        "deterministic_suffix": _required_text(value.get("deterministic_suffix"), "deterministic_suffix"),
    }


def _remove_local_artifacts(output_dir: Path, source: str) -> None:
    for _dataset, path, _content_type in raw.artifact_paths(output_dir, source):
        path.unlink(missing_ok=True)


def _semantic_observation(*, source_key: str, report: Mapping[str, Any], output_dir: Path) -> dict[str, Any]:
    paths = {dataset: path for dataset, path, _content_type in raw.artifact_paths(output_dir, source_key)}
    try:
        digests = semantic.artifact_semantic_digests(pages_path=paths["pages"], links_path=paths["links"])
    except semantic.SemanticContractError as error:
        raise RegionalRampError(f"semantic v2 digest calculation failed: {error}") from error
    counts = {
        "pages_count": digests.pages_count,
        "links_count": digests.links_count,
        "malformed_count": report.get("malformed_records"),
    }
    if not isinstance(counts["malformed_count"], int) or isinstance(counts["malformed_count"], bool) or counts["malformed_count"] < 0:
        raise RegionalRampError("parser report has an invalid malformed_records count")
    if report.get("pages_emitted") != counts["pages_count"] or report.get("links_emitted") != counts["links_count"]:
        raise RegionalRampError("parser report and emitted artifacts disagree on record counts")
    return {
        "contract": semantic.CONTRACT_ID,
        **counts,
        "canonical_pages_digest": digests.canonical_pages_digest,
        "canonical_pages_digest_algorithm": semantic.manifest_contract()["dataset_digest"],
        "canonical_links_digest": digests.canonical_links_digest,
        "canonical_links_digest_algorithm": semantic.manifest_contract()["dataset_digest"],
        "canonical_record_digest": digests.canonical_record_digest,
        "canonical_record_digest_algorithm": semantic.manifest_contract()["record_digest"],
        "target_host_bucket_digest": digests.target_host_bucket_digest,
        "target_host_bucket_digest_algorithm": semantic.manifest_contract()["target_host_bucket_digest"],
        "comparison": "observed-only; selected 1,000-WAT scale contract has no public-source semantic baseline",
    }


def _verify_existing_completion(store: r2.R2Store, *, prefix: str, run_id: str, region: str, task_index: int, source_key: str, selected_inputs_sha256: str) -> dict[str, Any] | None:
    existing = store.read_json(r2.normalize_key(prefix, "TASK-COMPLETED.json"))
    if existing is None:
        return None
    completion, _etag = existing
    required = {
        "run_id": run_id,
        "region": region,
        "task_index": task_index,
        "source_key": source_key,
        "selected_inputs_sha256": selected_inputs_sha256,
    }
    if any(completion.get(key) != value for key, value in required.items()):
        raise RegionalRampError("existing task completion marker conflicts with this regional run identity")
    artifacts = completion.get("artifacts")
    if not isinstance(artifacts, list) or len(artifacts) != 3:
        raise RegionalRampError("existing task completion marker lacks the Pages/Links/Metrics artifact contract")
    for artifact in artifacts:
        if not isinstance(artifact, Mapping) or not isinstance(artifact.get("key"), str) or not isinstance(artifact.get("bytes"), int) or not isinstance(artifact.get("sha256"), str):
            raise RegionalRampError("existing task completion artifact contract is malformed")
        if not store.verify(artifact["key"], bytes_count=artifact["bytes"], sha256=artifact["sha256"]):
            raise RegionalRampError("existing task completion refers to missing or conflicting immutable output")
    return completion


def _prepare_task_input(
    store: r2.R2Store,
    *,
    prefix: str,
    task_input: Mapping[str, Any],
) -> dict[str, Any]:
    """Create or safely resume the immutable first task object.

    A Container can be restarted after publishing the task input manifest but
    before it writes any payload. That single-object state is safe to resume:
    the manifest is identity-bound and ``upload_immutable_json`` re-verifies
    it. Any other pre-completion object is deliberately quarantined instead of
    being overwritten or mixed with a new execution attempt.
    """

    input_key = r2.normalize_key(prefix, "TASK-INPUT-MANIFEST.json")
    existing_keys = store.list_keys(prefix)
    if existing_keys:
        existing_input = store.read_json(input_key)
        if existing_input is None:
            raise RecoverablePartialTaskPrefixError(
                "partial immutable task prefix requires isolated recovery: TASK-INPUT-MANIFEST.json is missing"
            )
        input_document, _etag = existing_input
        if input_document != dict(task_input):
            raise RegionalRampError("existing task input manifest conflicts with this regional run identity")
        if set(existing_keys) != {input_key}:
            raise RecoverablePartialTaskPrefixError(
                "partial immutable task prefix requires isolated recovery: payload objects exist before TASK-COMPLETED.json"
            )
    return store.upload_immutable_json(input_key, task_input)


def run_task(
    *,
    run_id: str,
    region: str,
    task_index: int,
    inputs_path: Path,
    selected_inputs_sha256: str,
    output_dir: Path,
    release_sha256: str,
    store: r2.R2Store,
    r2_output_prefix: str | None = None,
    runtime_metadata: Callable[[], Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Process exactly one source key from the locked selected-input contract."""

    if not SHA256_RE.fullmatch(release_sha256):
        raise RegionalRampError("release SHA-256 must be lowercase hex")
    inputs = load_inputs(inputs_path, expected_sha256=selected_inputs_sha256)
    input_count = _required_non_negative_int(inputs.get("input_count"), "input_count")
    source = selected_input(inputs, task_index=task_index)
    # Older regional profiles derive their output prefix from the run ID. The
    # final 89K campaign uses `lane=...` prefixes instead, so its exact prefix
    # is an explicit, non-secret runtime setting. In both cases the temporary
    # credential must be scoped to precisely that one lane.
    region_output_prefix = region_prefix(run_id, region) if r2_output_prefix is None else r2.normalize_key(r2_output_prefix)
    prefix = task_prefix_for_output_prefix(region_output_prefix, task_index, input_count)
    expected_allowed_prefix = r2.normalize_prefix(region_output_prefix)
    if tuple(store.allowed_prefixes) != (expected_allowed_prefix,):
        raise RegionalRampError("regional task credential/store must be restricted to exactly its regional run prefix")

    existing = _verify_existing_completion(
        store,
        prefix=prefix,
        run_id=run_id,
        region=region,
        task_index=task_index,
        source_key=source["source_key"],
        selected_inputs_sha256=selected_inputs_sha256,
    )
    if existing is not None:
        return {"completed": True, "reused": True, **existing}
    task_input = {
        "format_version": 1,
        "kind": TASK_INPUT_KIND,
        "run_id": run_id,
        "region": region,
        "task_index": task_index,
        "task_number": task_number(task_index, input_count),
        "crawl": contract.CRAWL,
        "selected_inputs_sha256": selected_inputs_sha256,
        "source_manifest_sha256": inputs["source_manifest_sha256"],
        "input_count": 1,
        "inputs": [source],
        "release_sha256": release_sha256,
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    input_result = _prepare_task_input(store, prefix=prefix, task_input=task_input)
    started_at = r2.utc_timestamp()
    started = clock.monotonic()
    artifacts: list[dict[str, Any]] = []
    try:
        report = raw._write_one(
            source["source_key"],
            output_dir,
            source_reader=http_source.CommonCrawlHttpSource(crawl=contract.CRAWL, max_attempts=http_source.DEFAULT_MAX_ATTEMPTS),
            batch_size=50_000,
            artifact_key=lambda dataset, source_key: _artifact_key(prefix, dataset, source_key),
            run_id=f"cloudflare-r2-standard1-regional-ramp-{run_id}-task-{task_number(task_index, input_count):04d}",
            source_max_attempts=http_source.DEFAULT_MAX_ATTEMPTS,
        )
        observation = _semantic_observation(source_key=source["source_key"], report=report, output_dir=output_dir)
        report.update({
            "regional_ramp": {"run_id": run_id, "region": region, "task_index": task_index, "task_number": task_number(task_index, input_count)},
            "semantic_observation": observation,
            "release_sha256": release_sha256,
        })
        local_paths = {dataset: path for dataset, path, _content_type in raw.artifact_paths(output_dir, source["source_key"])}
        for dataset in ("pages", "links"):
            result = store.upload_immutable_file(_artifact_key(prefix, dataset, source["source_key"]), local_paths[dataset], content_type="application/vnd.apache.parquet")
            artifacts.append({"dataset": dataset, **result})
        artifacts.append({"dataset": "metrics", **store.upload_immutable_json(_artifact_key(prefix, "metrics", source["source_key"]), report)})
        for artifact in artifacts:
            if not store.verify(str(artifact["key"]), bytes_count=int(artifact["bytes"]), sha256=str(artifact["sha256"])):
                raise RegionalRampError("task immutable artifact failed post-upload verification")
        wat_completion = {
            "format_version": 1,
            "kind": WAT_COMPLETION_KIND,
            "run_id": run_id,
            "region": region,
            "task_index": task_index,
            "task_number": task_number(task_index, input_count),
            "source_key": source["source_key"],
            "deterministic_suffix": source["deterministic_suffix"],
            "source_transport": report["source_transport"],
            "processing_runtime_seconds": report.get("runtime_seconds"),
            "semantic_observation": observation,
            "artifacts": artifacts,
            "release_sha256": release_sha256,
        }
        store.upload_immutable_json(_wat_completion_key(prefix, source["source_key"]), wat_completion)
    finally:
        _remove_local_artifacts(output_dir, source["source_key"])
        shutil.rmtree(output_dir, ignore_errors=True)

    aggregate = {
        "source_bytes": int(report.get("source_transport", {}).get("downloaded_bytes") or 0),
        "source_retries": int(report.get("source_transport", {}).get("retries") or 0),
        "pages_count": observation["pages_count"],
        "links_count": observation["links_count"],
        "malformed_count": observation["malformed_count"],
        "r2_payload_bytes": sum(int(artifact["bytes"]) for artifact in artifacts),
    }
    summary = {
        "format_version": 1,
        "kind": TASK_SUMMARY_KIND,
        "run_id": run_id,
        "region": region,
        "task_index": task_index,
        "task_number": task_number(task_index, input_count),
        "crawl": contract.CRAWL,
        "selected_inputs_sha256": selected_inputs_sha256,
        "source_manifest_sha256": inputs["source_manifest_sha256"],
        "release_sha256": release_sha256,
        "started_at": started_at,
        "finished_at": r2.utc_timestamp(),
        "wall_seconds": round(clock.monotonic() - started, 3),
        "input_count": 1,
        "source_key": source["source_key"],
        "semantic_observation": observation,
        "aggregate": aggregate,
        "artifacts": artifacts,
        "input_manifest": input_result,
        "container_runtime": dict(runtime_metadata()) if runtime_metadata is not None else None,
    }
    summary_result = store.upload_immutable_json(r2.normalize_key(prefix, "TASK-SUMMARY.json"), summary)
    completion = {
        "format_version": 1,
        "kind": TASK_COMPLETION_KIND,
        "run_id": run_id,
        "region": region,
        "task_index": task_index,
        "task_number": task_number(task_index, input_count),
        "crawl": contract.CRAWL,
        "source_key": source["source_key"],
        "deterministic_suffix": source["deterministic_suffix"],
        "selected_inputs_sha256": selected_inputs_sha256,
        "source_manifest_sha256": inputs["source_manifest_sha256"],
        "release_sha256": release_sha256,
        "input_count": 1,
        "semantic_observation": observation,
        "aggregate": aggregate,
        "artifacts": artifacts,
        "summary": summary_result,
        "container_runtime": summary["container_runtime"],
    }
    completion_result = store.upload_immutable_json(r2.normalize_key(prefix, "TASK-COMPLETED.json"), completion)
    return {"completed": True, "reused": False, "completion": completion_result, **completion}
