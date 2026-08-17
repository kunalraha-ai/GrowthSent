#!/usr/bin/env python3
"""Run one immutable, leased Common Crawl WAT shard for production v2.

This is deliberately a sibling of ``common_crawl_wat_ingest.py``.  It reuses
the proven Pages/Links writers and deterministic part names, while adding the
small control plane needed for a static multi-instance run:

* exactly one verified shard from the explicit 10,000-input v2 base manifest;
* an immutable global base-manifest and shard-plan in S3;
* per-shard control objects; and
* a conditional S3 lease so two normal workers cannot own one shard.

It never discovers Common Crawl paths itself and keeps the v1 1,000-input
per-process ceiling intact.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
import logging
from pathlib import Path
import time
from typing import Any

import common_crawl_v2_manifest as manifest_tools
import common_crawl_wat_ingest as v1


FORMAT_VERSION = 2
MAX_INPUTS_PER_SHARD = v1.MAX_SAFE_INPUTS
PRODUCTION_V2_INPUT_COUNT = 10_000
MIN_LEASE_SECONDS = 300
MAX_LEASE_SECONDS = 7_200


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_timestamp(value: datetime | None = None) -> str:
    return (value or utc_now()).isoformat().replace("+00:00", "Z")


def parse_timestamp(value: object) -> datetime:
    if not isinstance(value, str):
        raise ValueError("lease timestamp must be a string")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("lease timestamp must include a timezone")
    return parsed.astimezone(timezone.utc)


def canonical_json_bytes(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def error_code(error: Exception) -> str | None:
    response = getattr(error, "response", None)
    if not isinstance(response, dict):
        return None
    detail = response.get("Error")
    if not isinstance(detail, dict):
        return None
    code = detail.get("Code")
    return str(code) if code is not None else None


def is_missing_s3_object(error: Exception) -> bool:
    return error_code(error) in {"404", "NoSuchKey", "NotFound"}


def is_precondition_failure(error: Exception) -> bool:
    return error_code(error) in {"PreconditionFailed", "412", "ConditionalRequestConflict"}


def control_key(destination_prefix: str, control_prefix: str, filename: str) -> str:
    return "/".join(
        part.strip("/")
        for part in (destination_prefix, control_prefix, filename)
        if part and part.strip("/")
    )


def canonical_control_prefix(shard_id: int, shard_count: int) -> str:
    width = max(3, len(str(shard_count)))
    return f"control/shards/shard-{shard_id:0{width}d}-of-{shard_count:0{width}d}"


def read_remote_json(client: Any, bucket: str, key: str) -> tuple[dict[str, Any], str | None] | None:
    try:
        response = client.get_object(Bucket=bucket, Key=key)
        with response["Body"] as body:
            value = json.loads(body.read().decode("utf-8"))
        if not isinstance(value, dict):
            raise RuntimeError(f"remote control object is not a JSON object: {key}")
        return value, response.get("ETag")
    except Exception as error:
        if is_missing_s3_object(error):
            return None
        raise


def put_remote_json(
    client: Any,
    bucket: str,
    key: str,
    value: dict[str, Any],
    *,
    if_none_match: bool = False,
    if_match: str | None = None,
) -> str | None:
    arguments: dict[str, Any] = {
        "Bucket": bucket,
        "Key": key,
        "Body": canonical_json_bytes(value),
        "ContentType": "application/json",
    }
    if if_none_match:
        arguments["IfNoneMatch"] = "*"
    if if_match is not None:
        arguments["IfMatch"] = if_match
    response = client.put_object(**arguments)
    return response.get("ETag")


def ensure_remote_immutable_json(client: Any, bucket: str, key: str, expected: dict[str, Any]) -> None:
    """Create a control object once or fail closed if it differs.

    ``IfNoneMatch`` makes concurrent first-shard startup safe.  A loser reads
    and validates the winner instead of overwriting the object.
    """
    existing = read_remote_json(client, bucket, key)
    if existing is not None:
        if existing[0] != expected:
            raise RuntimeError(f"remote immutable control object differs: {key}")
        return
    try:
        put_remote_json(client, bucket, key, expected, if_none_match=True)
    except Exception as error:
        if not is_precondition_failure(error):
            raise
        existing = read_remote_json(client, bucket, key)
        if existing is None or existing[0] != expected:
            raise RuntimeError(f"concurrent immutable control object differs: {key}") from error


@dataclass(frozen=True)
class ShardContext:
    run_id: str
    crawl: str
    shard_id: int
    shard_count: int
    base_inputs_sha256: str
    base_manifest_sha256: str
    shard_inputs_sha256: str
    shard_manifest_sha256: str
    inputs: tuple[str, ...]
    first_input: str
    last_input: str
    control_prefix: str
    base_manifest: dict[str, Any]
    shard_manifest: dict[str, Any]
    shard_plan: dict[str, Any]

    @property
    def input_count(self) -> int:
        return len(self.inputs)

    def static_metadata(self) -> dict[str, Any]:
        return {
            "format_version": FORMAT_VERSION,
            "run_id": self.run_id,
            "crawl": self.crawl,
            "shard_id": self.shard_id,
            "shard_count": self.shard_count,
            "base_inputs_sha256": self.base_inputs_sha256,
            "base_manifest_sha256": self.base_manifest_sha256,
            "shard_inputs_sha256": self.shard_inputs_sha256,
            "shard_manifest_sha256": self.shard_manifest_sha256,
            "shard_input_count": self.input_count,
            "first_input": self.first_input,
            "last_input": self.last_input,
        }


def manifest_document_sha256(value: dict[str, Any]) -> str:
    """Use the v2 manifest's canonical document hash when present."""
    declared = value.get("manifest_sha256")
    if isinstance(declared, str) and len(declared) == 64:
        return declared.lower()
    # The sibling manifest tool always writes ``manifest_sha256``.  This
    # fallback keeps the validation error clear if an older local fixture is
    # accidentally supplied.
    raise ValueError("v2 manifest is missing a canonical manifest_sha256")


def context_from_args(args: argparse.Namespace) -> ShardContext:
    # The expected base count is a fixed production-v2 safety contract. A
    # caller cannot reuse this runner for the earlier unlaunched 100,000-path
    # experiment or any broader Common Crawl selection.
    base_manifest = manifest_tools.load_base_manifest(
        args.base_manifest, expected_input_count=args.expected_base_input_count
    )
    manifest_tools.validate_base_manifest(base_manifest, expected_input_count=args.expected_base_input_count)
    shard_manifest = manifest_tools.load_shard_manifest(
        args.shard_manifest, base_manifest, expected_input_count=args.expected_base_input_count
    )
    manifest_tools.validate_shard_manifest(
        shard_manifest, base_manifest, expected_input_count=args.expected_base_input_count
    )
    shard_plan = manifest_tools.load_shard_plan(
        args.shard_plan, base_manifest, expected_input_count=args.expected_base_input_count
    )

    base_inputs_sha256 = str(base_manifest["inputs_sha256"]).lower()
    base_manifest_sha256 = manifest_document_sha256(base_manifest)
    shard_inputs_sha256 = str(shard_manifest["inputs_sha256"]).lower()
    shard_manifest_sha256 = manifest_document_sha256(shard_manifest)
    expected_control_prefix = canonical_control_prefix(shard_manifest["shard_id"], shard_manifest["shard_count"])
    expected_values: dict[str, Any] = {
        "run_id": base_manifest["run_id"],
        "shard_id": shard_manifest["shard_id"],
        "shard_count": shard_manifest["shard_count"],
        "base_manifest_sha256": base_manifest_sha256,
        "shard_manifest_sha256": shard_manifest_sha256,
        "control_prefix": expected_control_prefix,
    }
    for name, expected in expected_values.items():
        actual = getattr(args, name)
        if actual != expected:
            raise ValueError(f"--{name.replace('_', '-')} does not match the locked shard manifest")
    if args.base_inputs_sha256.lower() != base_inputs_sha256:
        raise ValueError("--base-inputs-sha256 does not match the locked base manifest")
    if args.shard_inputs_sha256.lower() != shard_inputs_sha256:
        raise ValueError("--shard-inputs-sha256 does not match the locked shard manifest")
    inputs = tuple(shard_manifest["inputs"])
    if args.max_inputs != len(inputs):
        raise ValueError("--max-inputs must exactly equal the locked shard input count")
    if len(inputs) > MAX_INPUTS_PER_SHARD:
        raise ValueError(f"locked shard exceeds the {MAX_INPUTS_PER_SHARD}-input per-worker safety ceiling")
    if args.expected_inputs_sha256.lower() != shard_inputs_sha256:
        raise ValueError("--expected-inputs-sha256 must equal the locked shard input hash")
    unexpected = next(
        (source for source in base_manifest["inputs"] if not source.startswith(args.require_source_prefix)), None
    )
    if unexpected is not None:
        raise ValueError("locked base manifest contains an input outside --require-source-prefix")
    if shard_plan["shard_count"] != shard_manifest["shard_count"]:
        raise ValueError("shard plan count does not match shard manifest")
    plan_entry = next(
        (entry for entry in shard_plan["shards"] if isinstance(entry, dict) and entry.get("shard_id") == shard_manifest["shard_id"]),
        None,
    )
    if plan_entry is None:
        raise ValueError("shard plan does not contain this shard")
    for key, expected in {
        "shard_manifest_sha256": shard_manifest_sha256,
        "inputs_sha256": shard_inputs_sha256,
        "input_count": len(inputs),
        "first_input": shard_manifest["first_input"],
        "last_input": shard_manifest["last_input"],
    }.items():
        if plan_entry.get(key) != expected:
            raise ValueError(f"shard plan entry does not match locked shard field: {key}")
    return ShardContext(
        run_id=base_manifest["run_id"],
        crawl=base_manifest["crawl"],
        shard_id=shard_manifest["shard_id"],
        shard_count=shard_manifest["shard_count"],
        base_inputs_sha256=base_inputs_sha256,
        base_manifest_sha256=base_manifest_sha256,
        shard_inputs_sha256=shard_inputs_sha256,
        shard_manifest_sha256=shard_manifest_sha256,
        inputs=inputs,
        first_input=shard_manifest["first_input"],
        last_input=shard_manifest["last_input"],
        control_prefix=expected_control_prefix,
        base_manifest=base_manifest,
        shard_manifest=shard_manifest,
        shard_plan=shard_plan,
    )


@dataclass
class ShardLease:
    client: Any
    bucket: str
    key: str
    context: ShardContext
    owner_id: str
    lease_seconds: int
    etag: str | None
    last_refreshed_at: datetime

    def payload(self, state: str, *, now: datetime | None = None) -> dict[str, Any]:
        current = now or utc_now()
        payload = self.context.static_metadata()
        payload.update({
            "state": state,
            "owner_id": self.owner_id,
            "lease_seconds": self.lease_seconds,
            "updated_at": utc_timestamp(current),
            "expires_at": utc_timestamp(current + timedelta(seconds=self.lease_seconds)) if state == "running" else None,
        })
        return payload

    def refresh(self, *, now: datetime | None = None) -> None:
        current = now or utc_now()
        if self.etag is None:
            raise RuntimeError("cannot refresh an S3 shard lease without an ETag")
        try:
            self.etag = put_remote_json(
                self.client, self.bucket, self.key, self.payload("running", now=current), if_match=self.etag
            )
        except Exception as error:
            if is_precondition_failure(error):
                raise RuntimeError("lost ownership of the shard lease") from error
            raise
        self.last_refreshed_at = current

    def maybe_refresh(self) -> None:
        if utc_now() - self.last_refreshed_at >= timedelta(seconds=max(60, self.lease_seconds // 3)):
            self.refresh()

    def finalize(self, state: str) -> None:
        if state not in {"completed", "failed", "stopped"} or self.etag is None:
            return
        try:
            self.etag = put_remote_json(self.client, self.bucket, self.key, self.payload(state), if_match=self.etag)
        except Exception as error:
            if is_precondition_failure(error):
                logging.warning("shard lease changed before final lifecycle update")
                return
            raise


def _lease_matches_context(lease: dict[str, Any], context: ShardContext) -> bool:
    return all(lease.get(key) == value for key, value in context.static_metadata().items())


def acquire_shard_lease(
    client: Any,
    bucket: str,
    key: str,
    context: ShardContext,
    owner_id: str,
    lease_seconds: int,
    *,
    now: datetime | None = None,
    allow_expired_takeover: bool = False,
) -> ShardLease:
    """Atomically claim one shard or fail if another live owner holds it."""
    current = now or utc_now()
    for _ in range(3):
        existing = read_remote_json(client, bucket, key)
        provisional = ShardLease(client, bucket, key, context, owner_id, lease_seconds, None, current)
        if existing is None:
            try:
                provisional.etag = put_remote_json(client, bucket, key, provisional.payload("running", now=current), if_none_match=True)
                return provisional
            except Exception as error:
                if is_precondition_failure(error):
                    continue
                raise
        lease, etag = existing
        if not _lease_matches_context(lease, context):
            raise RuntimeError("existing shard lease belongs to a different immutable shard assignment")
        state = lease.get("state")
        if state == "running":
            expires_at = parse_timestamp(lease.get("expires_at"))
            if expires_at > current:
                raise RuntimeError("shard is already owned by another active worker")
            if not allow_expired_takeover:
                raise RuntimeError(
                    "shard has an expired running lease; explicitly confirm the prior worker is stopped before takeover"
                )
        if etag is None:
            raise RuntimeError("remote shard lease has no ETag for fenced recovery")
        try:
            provisional.etag = put_remote_json(
                client, bucket, key, provisional.payload("running", now=current), if_match=etag
            )
            return provisional
        except Exception as error:
            if is_precondition_failure(error):
                continue
            raise
    raise RuntimeError("could not acquire the shard lease due to concurrent ownership changes")


def write_local_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(canonical_json_bytes(value))
    temporary.replace(path)


def lifecycle_payload(context: ShardContext, event: str, owner_id: str, exit_code: int | None = None) -> dict[str, Any]:
    value = context.static_metadata()
    value.update({
        "event": event,
        "lease_owner": owner_id,
        "updated_at": utc_timestamp(),
        "exit_code": exit_code,
    })
    return value


def augment_control_payload(context: ShardContext, payload: dict[str, Any]) -> dict[str, Any]:
    value = context.static_metadata()
    value.update(payload)
    return value


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-manifest", required=True, type=Path)
    parser.add_argument("--shard-manifest", required=True, type=Path)
    parser.add_argument("--shard-plan", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--shard-id", required=True, type=int)
    parser.add_argument("--shard-count", required=True, type=int)
    parser.add_argument("--expected-base-input-count", required=True, type=int)
    parser.add_argument("--base-inputs-sha256", required=True)
    parser.add_argument("--base-manifest-sha256", required=True)
    parser.add_argument("--shard-inputs-sha256", required=True)
    parser.add_argument("--shard-manifest-sha256", required=True)
    parser.add_argument("--control-prefix", required=True)
    parser.add_argument("--shard-lease-owner", required=True)
    parser.add_argument("--shard-lease-seconds", type=int, default=3_600)
    parser.add_argument(
        "--allow-expired-lease-takeover",
        action="store_true",
        help="Recovery-only: permit takeover of an expired lease after the prior worker is confirmed stopped",
    )
    parser.add_argument("--max-inputs", type=int, required=True)
    parser.add_argument("--expected-inputs-sha256", required=True)
    parser.add_argument("--require-source-prefix", required=True)
    parser.add_argument("--workers", type=int, choices=(1, 2, 4, 8), default=4)
    parser.add_argument("--files-per-batch", type=int, default=16)
    parser.add_argument("--batch-size", type=int, default=50_000)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--source-bucket", default="commoncrawl")
    parser.add_argument("--source-url-base", default="https://data.commoncrawl.org/")
    parser.add_argument("--signed-source", action="store_true")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--upload", action="store_true")
    parser.add_argument("--remove-uploaded-local", action="store_true")
    parser.add_argument("--destination", required=True)
    args = parser.parse_args(argv)
    if args.max_inputs < 1 or args.max_inputs > MAX_INPUTS_PER_SHARD:
        parser.error(f"--max-inputs must be between 1 and {MAX_INPUTS_PER_SHARD}")
    if args.expected_base_input_count != PRODUCTION_V2_INPUT_COUNT:
        parser.error(f"--expected-base-input-count must be exactly {PRODUCTION_V2_INPUT_COUNT:,}")
    if args.batch_size < 1 or args.files_per_batch < 1:
        parser.error("--batch-size and --files-per-batch must be positive")
    if not args.upload:
        parser.error("production-v2 shards require --upload")
    if not args.remove_uploaded_local:
        parser.error("production-v2 shards require --remove-uploaded-local")
    if not MIN_LEASE_SECONDS <= args.shard_lease_seconds <= MAX_LEASE_SECONDS:
        parser.error(f"--shard-lease-seconds must be between {MIN_LEASE_SECONDS} and {MAX_LEASE_SECONDS}")
    if not args.shard_lease_owner.strip() or len(args.shard_lease_owner) > 256:
        parser.error("--shard-lease-owner must be a non-empty identifier of at most 256 characters")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        context = context_from_args(args)
        v1.validate_input_scope(list(context.inputs), args.max_inputs, args.require_source_prefix)
    except (ValueError, KeyError) as error:
        raise SystemExit(f"error: {error}") from error
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    bucket, destination_prefix = v1.parse_s3_destination(args.destination)
    local_control_dir = args.output_dir / context.control_prefix
    local_manifest_path = local_control_dir / "input-manifest.json"
    local_progress_path = local_control_dir / "run-progress.json"
    local_summary_path = local_control_dir / "run-summary.json"
    local_lifecycle_path = local_control_dir / "lifecycle.json"
    shard_control_manifest = augment_control_payload(context, {"inputs": list(context.inputs)})
    write_local_json(local_manifest_path, shard_control_manifest)

    client = v1.s3_client()
    ensure_remote_immutable_json(client, bucket, control_key(destination_prefix, "control", "base-manifest.json"), context.base_manifest)
    ensure_remote_immutable_json(client, bucket, control_key(destination_prefix, "control", "shard-plan.json"), context.shard_plan)
    ensure_remote_immutable_json(
        client, bucket, control_key(destination_prefix, context.control_prefix, "input-manifest.json"), shard_control_manifest
    )
    lease_key = control_key(destination_prefix, context.control_prefix, "lease.json")
    lease = acquire_shard_lease(
        client,
        bucket,
        lease_key,
        context,
        args.shard_lease_owner,
        args.shard_lease_seconds,
        allow_expired_takeover=args.allow_expired_lease_takeover,
    )
    started = time.monotonic()
    attempt_started = started
    attempt_reports: list[dict[str, Any]] = []
    summaries_by_source: dict[str, dict[str, Any]] = {}

    def publish_lifecycle(event: str, exit_code: int | None = None) -> None:
        payload = lifecycle_payload(context, event, args.shard_lease_owner, exit_code)
        write_local_json(local_lifecycle_path, payload)
        put_remote_json(client, bucket, control_key(destination_prefix, context.control_prefix, "lifecycle.json"), payload)

    def checkpoint(event: str, publish: bool) -> dict[str, Any]:
        lease.maybe_refresh()
        snapshot = augment_control_payload(
            context,
            v1.progress_snapshot(context.crawl, context.input_count, remote_recovered, attempt_reports,
                                 time.monotonic() - attempt_started, event),
        )
        logging.info("v2 progress %s", json.dumps(snapshot, sort_keys=True))
        if publish:
            write_local_json(local_progress_path, snapshot)
            put_remote_json(client, bucket, control_key(destination_prefix, context.control_prefix, "run-progress.json"), snapshot)
        return snapshot

    try:
        publish_lifecycle("starting")
        pending = list(context.inputs)
        if args.resume:
            pending = []
            for source in context.inputs:
                saved = v1.remote_report(context.crawl, source, bucket, destination_prefix)
                if saved is None:
                    pending.append(source)
                else:
                    summaries_by_source[source] = saved
                    logging.info("v2 resume: remote completed part exists for %s", source)
        remote_recovered = len(summaries_by_source)
        publish_lifecycle("running")
        checkpoint("started", publish=True)

        def report_completed(_: str, report: dict[str, Any]) -> None:
            attempt_reports.append(report)
            checkpoint("input_finished", publish=False)

        for batch in v1.chunks(pending, args.files_per_batch):
            reports = v1.ingest_many(
                context.crawl, batch, args.output_dir, args.batch_size, args.resume, args.source_bucket, args.workers,
                not args.signed_source, args.source_url_base, report_completed,
            )
            for source, report in zip(batch, reports):
                summaries_by_source[source] = report
                if not report["failures"]:
                    # Do not begin an unconditional deterministic-part upload
                    # after this worker has lost (or failed to renew) its
                    # fenced shard lease.  This closes the long-batch window
                    # between worker completion callbacks and publication.
                    lease.maybe_refresh()
                    v1.upload_artifacts(args.output_dir, context.crawl, source, bucket, destination_prefix)
                    v1.remove_local_artifacts(args.output_dir, context.crawl, source)
            checkpoint("batch_published", publish=True)

        summaries = [summaries_by_source[source] for source in context.inputs]
        for metric in summaries:
            if metric["failures"]:
                logging.error("failed input %s: %s", metric["input"], "; ".join(metric["failures"]))
        aggregate = v1.aggregate_metrics(summaries, time.monotonic() - started)
        final_progress = checkpoint("finished", publish=True)
        run_summary = augment_control_payload(context, {
            "aggregate": aggregate,
            "progress": final_progress,
            "workers": args.workers,
            "effective_workers": min(args.workers, len(context.inputs)),
            "inputs": summaries,
        })
        write_local_json(local_summary_path, run_summary)
        put_remote_json(client, bucket, control_key(destination_prefix, context.control_prefix, "run-summary.json"), run_summary)
        exit_code = 1 if aggregate["failed_inputs"] else 0
        publish_lifecycle("completed" if exit_code == 0 else "failed", exit_code)
        lease.finalize("completed" if exit_code == 0 else "failed")
        print(json.dumps(run_summary, indent=2, sort_keys=True))
        return exit_code
    except BaseException as error:
        state = "stopped" if isinstance(error, (KeyboardInterrupt, SystemExit)) else "failed"
        try:
            publish_lifecycle(state, 143 if state == "stopped" else 1)
            lease.finalize(state)
        except Exception:
            logging.exception("could not persist terminal shard lifecycle")
        raise


if __name__ == "__main__":
    raise SystemExit(main())
