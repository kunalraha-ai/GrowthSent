#!/usr/bin/env python3
"""Promote the proven v1 first-1,000 outputs into production-v2 shard 0.

This is deliberately a one-purpose migration tool, not another ingestion
runner.  It is locked to the reviewed CC-MAIN-2026-30 first-10,000 v2 run and
to shard 0.  It never reads a WAT, parses Parquet, deletes an object, or writes
to the v1 prefix.

The default local mode validates only the immutable v2 manifests and produces
the exact 3,000-object promotion plan.  ``--verify`` reads S3 but makes no
changes.  ``--apply`` is the only write mode and uses S3 server-side copies
after all source and destination validation succeeds.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import io
import json
from pathlib import Path
import sys
from typing import Any, Iterable, Mapping, Protocol

import common_crawl_v2_manifest as manifests


BUCKET = "growthsent-data-552648196041-us-east-1-an"
REGION = "us-east-1"
CRAWL = "CC-MAIN-2026-30"
RUN_ID = "cc-main-2026-30-first-10000"
SHARD_ID = 0
SHARD_COUNT = 10
EXPECTED_SHARD_INPUT_COUNT = 1_000
EXPECTED_ARTIFACT_COUNT = 3_000

V1_SOURCE_PREFIX = "production/common-crawl/wat-pages-links/v1/cc-main-2026-30-first-1000/"
V2_DESTINATION_PREFIX = "production/common-crawl/wat-pages-links/v2/cc-main-2026-30-first-10000/"
V1_MANIFEST_KEY = f"{V1_SOURCE_PREFIX}control/input-manifest.json"

EXPECTED_BASE_INPUTS_SHA256 = "85b9d82fc11ef051c9a2e6424a22dbe865f9d4ba59df949f13b482c88e6f7226"
EXPECTED_BASE_MANIFEST_SHA256 = "721f3b726f4283cee4321487584ad3577c7468f1df5f2a1b5fa054f983cf00d0"
EXPECTED_SHARD_INPUTS_SHA256 = "6ce2c0c06612de9d8816d6075a25b15929209504f346305dae8ee9ced03b3b7a"
EXPECTED_SHARD_MANIFEST_SHA256 = "e5bc5cd74e4c1414fdbd1e30a0dfd91f229d1e6643009a824419e2742338cb48"
EXPECTED_SHARD_PLAN_SHA256 = "6939f2accb14d17f42e5c2ecc2e6c5b0ce3f405fd6b0474f75435e614d6ae54a"

DATASET_EXTENSIONS = {
    "pages": ".parquet",
    "links": ".parquet",
    "metrics": ".json",
}
PROMOTION_METADATA_VERSION = "v1-to-v2-shard0-1"


class PromotionError(RuntimeError):
    """A fail-closed promotion validation error."""


class S3Client(Protocol):
    def get_paginator(self, operation_name: str) -> Any: ...

    def get_object(self, **kwargs: Any) -> Mapping[str, Any]: ...

    def head_object(self, **kwargs: Any) -> Mapping[str, Any]: ...

    def copy_object(self, **kwargs: Any) -> Mapping[str, Any]: ...


@dataclass(frozen=True)
class PromotionContext:
    base_manifest: Mapping[str, Any]
    shard_manifest: Mapping[str, Any]
    shard_plan: Mapping[str, Any]
    inputs: tuple[str, ...]
    suffix_to_input: Mapping[str, str]


@dataclass(frozen=True)
class Artifact:
    dataset: str
    suffix: str
    input_path: str
    source_key: str
    destination_key: str


@dataclass(frozen=True)
class ObjectDescription:
    key: str
    size: int
    etag: str | None
    checksum_sha256: str | None
    metadata: Mapping[str, str]
    content_type: str | None
    server_side_encryption: str | None
    cache_control: str | None
    content_disposition: str | None
    content_encoding: str | None
    content_language: str | None
    expires: Any | None


@dataclass(frozen=True)
class PromotionAction:
    artifact: Artifact
    source: ObjectDescription
    destination: ObjectDescription | None
    action: str


@dataclass(frozen=True)
class PromotionPlan:
    context: PromotionContext
    actions: tuple[PromotionAction, ...]

    @property
    def copy_count(self) -> int:
        return sum(action.action == "copy" for action in self.actions)

    @property
    def already_verified_count(self) -> int:
        return sum(action.action == "already-verified" for action in self.actions)


def repository_root() -> Path:
    return Path(__file__).resolve().parents[1]


def default_manifest_paths() -> tuple[Path, Path, Path]:
    root = repository_root() / "deployment" / "common-crawl-production-v2" / "manifests" / RUN_ID
    return (
        root / "base-manifest.json",
        root / "shards" / "shard-00000-of-00010.json",
        root / "shards" / "shard-plan.json",
    )


def s3_error_code(error: Exception) -> str | None:
    response = getattr(error, "response", None)
    if not isinstance(response, Mapping):
        return None
    detail = response.get("Error")
    if not isinstance(detail, Mapping):
        return None
    code = detail.get("Code")
    return str(code) if code is not None else None


def is_missing_object(error: Exception) -> bool:
    return s3_error_code(error) in {"404", "NoSuchKey", "NotFound"}


def artifact_key(prefix: str, dataset: str, suffix: str) -> str:
    extension = DATASET_EXTENSIONS[dataset]
    return f"{prefix}crawl={CRAWL}/dataset={dataset}/part-{suffix}{extension}"


def stripped_etag(value: str | None) -> str | None:
    return value.strip('"') if isinstance(value, str) else None


def metadata_value(value: str | None) -> str:
    return value or ""


def load_locked_context(base_path: Path, shard_path: Path, shard_plan_path: Path) -> PromotionContext:
    """Load only the one reviewed v2 run and its immutable shard 0."""

    base = manifests.load_base_manifest(base_path, expected_input_count=10_000)
    shard = manifests.load_shard_manifest(
        shard_path,
        base,
        expected_input_count=10_000,
        max_inputs_per_shard=EXPECTED_SHARD_INPUT_COUNT,
    )
    plan = manifests.load_shard_plan(
        shard_plan_path,
        base,
        expected_input_count=10_000,
        max_inputs_per_shard=EXPECTED_SHARD_INPUT_COUNT,
    )
    expected = {
        "base.run_id": (base["run_id"], RUN_ID),
        "base.crawl": (base["crawl"], CRAWL),
        "base.inputs_sha256": (base["inputs_sha256"], EXPECTED_BASE_INPUTS_SHA256),
        "base.manifest_sha256": (base["manifest_sha256"], EXPECTED_BASE_MANIFEST_SHA256),
        "shard.shard_id": (shard["shard_id"], SHARD_ID),
        "shard.shard_count": (shard["shard_count"], SHARD_COUNT),
        "shard.input_count": (shard["input_count"], EXPECTED_SHARD_INPUT_COUNT),
        "shard.inputs_sha256": (shard["inputs_sha256"], EXPECTED_SHARD_INPUTS_SHA256),
        "shard.manifest_sha256": (shard["manifest_sha256"], EXPECTED_SHARD_MANIFEST_SHA256),
        "shard-plan.plan_sha256": (plan["plan_sha256"], EXPECTED_SHARD_PLAN_SHA256),
    }
    mismatches = [name for name, (actual, wanted) in expected.items() if actual != wanted]
    if mismatches:
        raise PromotionError(f"locked v2 promotion context mismatch: {', '.join(mismatches)}")
    if tuple(base["inputs"][:EXPECTED_SHARD_INPUT_COUNT]) != tuple(shard["inputs"]):
        raise PromotionError("shard 0 is not the ordered first 1,000 inputs of the locked v2 base manifest")
    plan_entry = next(
        (entry for entry in plan["shards"] if entry.get("shard_id") == SHARD_ID),
        None,
    )
    expected_plan_entry = {
        "input_count": shard["input_count"],
        "inputs_sha256": shard["inputs_sha256"],
        "shard_manifest_sha256": shard["manifest_sha256"],
        "first_input": shard["first_input"],
        "last_input": shard["last_input"],
    }
    if not isinstance(plan_entry, Mapping) or any(
        plan_entry.get(name) != value for name, value in expected_plan_entry.items()
    ):
        raise PromotionError("locked shard 0 does not match its immutable shard-plan entry")
    if len(set(shard["inputs"])) != EXPECTED_SHARD_INPUT_COUNT:
        raise PromotionError("locked shard 0 contains duplicate input paths")

    suffix_to_input: dict[str, str] = {}
    for input_path in shard["inputs"]:
        suffix = manifests.input_key(input_path)
        if suffix in suffix_to_input:
            raise PromotionError("locked shard 0 has a deterministic artifact suffix collision")
        suffix_to_input[suffix] = input_path
    return PromotionContext(base, shard, plan, tuple(shard["inputs"]), suffix_to_input)


def expected_artifacts(context: PromotionContext) -> tuple[Artifact, ...]:
    artifacts = []
    for dataset in DATASET_EXTENSIONS:
        for suffix, input_path in sorted(context.suffix_to_input.items()):
            artifacts.append(Artifact(
                dataset=dataset,
                suffix=suffix,
                input_path=input_path,
                source_key=artifact_key(V1_SOURCE_PREFIX, dataset, suffix),
                destination_key=artifact_key(V2_DESTINATION_PREFIX, dataset, suffix),
            ))
    if len(artifacts) != EXPECTED_ARTIFACT_COUNT:
        raise PromotionError("promotion artifact plan does not contain exactly 3,000 objects")
    return tuple(artifacts)


def read_json_object(client: S3Client, key: str) -> Mapping[str, Any]:
    response = client.get_object(Bucket=BUCKET, Key=key)
    body = response.get("Body")
    if body is None:
        raise PromotionError(f"S3 JSON object has no body: {key}")
    if isinstance(body, str):
        raw = body.encode("utf-8")
    else:
        try:
            raw = body.read()
        finally:
            close = getattr(body, "close", None)
            if callable(close):
                close()
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PromotionError(f"invalid JSON object: {key}") from error
    if not isinstance(value, Mapping):
        raise PromotionError(f"JSON object must be an object: {key}")
    return value


def validate_v1_manifest(client: S3Client, context: PromotionContext) -> None:
    manifest = read_json_object(client, V1_MANIFEST_KEY)
    expected = {
        "crawl": CRAWL,
        "format_version": 1,
        "input_count": EXPECTED_SHARD_INPUT_COUNT,
        "inputs_sha256": EXPECTED_SHARD_INPUTS_SHA256,
    }
    mismatches = [name for name, value in expected.items() if manifest.get(name) != value]
    if mismatches:
        raise PromotionError(f"immutable v1 manifest mismatch: {', '.join(mismatches)}")
    inputs = manifest.get("inputs")
    if not isinstance(inputs, list) or tuple(inputs) != context.inputs:
        raise PromotionError("immutable v1 manifest inputs do not exactly match locked v2 shard 0")


def list_dataset_objects(client: S3Client, dataset: str, prefix: str) -> dict[str, Mapping[str, Any]]:
    expected_extension = DATASET_EXTENSIONS[dataset]
    dataset_prefix = f"{prefix}crawl={CRAWL}/dataset={dataset}/"
    paginator = client.get_paginator("list_objects_v2")
    found: dict[str, Mapping[str, Any]] = {}
    for page in paginator.paginate(Bucket=BUCKET, Prefix=dataset_prefix):
        for item in page.get("Contents", []):
            key = item.get("Key")
            if not isinstance(key, str) or not key.startswith(dataset_prefix):
                raise PromotionError(f"unexpected {dataset} listing entry")
            name = key[len(dataset_prefix):]
            if not name.startswith("part-") or not name.endswith(expected_extension):
                raise PromotionError(f"unexpected {dataset} artifact: {key}")
            suffix = name[len("part-"):-len(expected_extension)]
            if len(suffix) != 16 or any(char not in "0123456789abcdef" for char in suffix):
                raise PromotionError(f"invalid deterministic suffix in {dataset} artifact: {key}")
            if suffix in found:
                raise PromotionError(f"duplicate deterministic suffix in {dataset}: {suffix}")
            found[suffix] = item
    return found


def validate_source_artifacts(client: S3Client, context: PromotionContext) -> dict[str, ObjectDescription]:
    expected_suffixes = set(context.suffix_to_input)
    source: dict[str, ObjectDescription] = {}
    for dataset in DATASET_EXTENSIONS:
        listed = list_dataset_objects(client, dataset, V1_SOURCE_PREFIX)
        actual_suffixes = set(listed)
        missing = expected_suffixes - actual_suffixes
        unexpected = actual_suffixes - expected_suffixes
        if missing or unexpected:
            raise PromotionError(
                f"v1 {dataset} artifacts differ from locked shard 0: "
                f"missing={len(missing)} unexpected={len(unexpected)}"
            )
        for suffix in sorted(expected_suffixes):
            key = artifact_key(V1_SOURCE_PREFIX, dataset, suffix)
            source[key] = describe_object(client, key)

    for suffix, input_path in context.suffix_to_input.items():
        key = artifact_key(V1_SOURCE_PREFIX, "metrics", suffix)
        metric = read_json_object(client, key)
        if metric.get("input") != input_path:
            raise PromotionError(f"v1 metric input does not match locked shard 0: {key}")
        failures = metric.get("failures")
        if not isinstance(failures, list) or failures:
            raise PromotionError(f"v1 metric is not a successful completed input: {key}")
    if len(source) != EXPECTED_ARTIFACT_COUNT:
        raise PromotionError("v1 source verification did not produce exactly 3,000 artifacts")
    return source


def describe_object(client: S3Client, key: str) -> ObjectDescription:
    response = client.head_object(Bucket=BUCKET, Key=key, ChecksumMode="ENABLED")
    metadata = response.get("Metadata") or {}
    if not isinstance(metadata, Mapping):
        raise PromotionError(f"S3 object metadata is invalid: {key}")
    return ObjectDescription(
        key=key,
        size=int(response.get("ContentLength") or 0),
        etag=response.get("ETag") if isinstance(response.get("ETag"), str) else None,
        checksum_sha256=(
            response.get("ChecksumSHA256") if isinstance(response.get("ChecksumSHA256"), str) else None
        ),
        metadata={str(name).lower(): str(value) for name, value in metadata.items()},
        content_type=response.get("ContentType") if isinstance(response.get("ContentType"), str) else None,
        server_side_encryption=(
            response.get("ServerSideEncryption") if isinstance(response.get("ServerSideEncryption"), str) else None
        ),
        cache_control=response.get("CacheControl") if isinstance(response.get("CacheControl"), str) else None,
        content_disposition=(
            response.get("ContentDisposition") if isinstance(response.get("ContentDisposition"), str) else None
        ),
        content_encoding=(
            response.get("ContentEncoding") if isinstance(response.get("ContentEncoding"), str) else None
        ),
        content_language=(
            response.get("ContentLanguage") if isinstance(response.get("ContentLanguage"), str) else None
        ),
        expires=response.get("Expires"),
    )


def try_describe_object(client: S3Client, key: str) -> ObjectDescription | None:
    try:
        return describe_object(client, key)
    except Exception as error:
        if is_missing_object(error):
            return None
        raise


def source_metadata_for_copy(source: ObjectDescription) -> dict[str, str]:
    metadata = dict(source.metadata)
    additions = {
        "growthsent-promotion-version": PROMOTION_METADATA_VERSION,
        "growthsent-promotion-source-key": source.key,
        "growthsent-promotion-source-etag": metadata_value(stripped_etag(source.etag)),
        "growthsent-promotion-source-size": str(source.size),
        "growthsent-promotion-source-checksum-sha256": metadata_value(source.checksum_sha256),
    }
    for name, value in additions.items():
        existing = metadata.get(name)
        if existing is not None and existing != value:
            raise PromotionError(f"source metadata conflicts with reserved promotion metadata: {source.key}")
        metadata[name] = value
    encoded_size = sum(len(name.encode("utf-8")) + len(value.encode("utf-8")) for name, value in metadata.items())
    if encoded_size > 2_000:
        raise PromotionError(f"source metadata is too large to preserve safely during copy: {source.key}")
    return metadata


def metadata_proves_prior_copy(source: ObjectDescription, destination: ObjectDescription) -> bool:
    expected = source_metadata_for_copy(source)
    return all(destination.metadata.get(name) == value for name, value in expected.items())


def is_plain_etag(value: str | None) -> bool:
    normalized = stripped_etag(value)
    return normalized is not None and "-" not in normalized


def destination_matches_source(source: ObjectDescription, destination: ObjectDescription) -> bool:
    """Decide whether an existing v2 object is provably safe to retain.

    Multipart ETags are deliberately not treated as a content checksum.  They
    must have a matching SHA-256 checksum or the provenance metadata written
    by this exact promotion tool.
    """

    if source.size != destination.size or source.content_type != destination.content_type:
        return False
    copied_by_this_tool = metadata_proves_prior_copy(source, destination)
    expected_metadata = source_metadata_for_copy(source) if copied_by_this_tool else source.metadata
    if dict(destination.metadata) != dict(expected_metadata):
        return False
    if source.checksum_sha256 is not None:
        return source.checksum_sha256 == destination.checksum_sha256
    if copied_by_this_tool:
        return True
    return (
        is_plain_etag(source.etag)
        and is_plain_etag(destination.etag)
        and stripped_etag(source.etag) == stripped_etag(destination.etag)
    )


def assert_destination_contains_only_expected(client: S3Client, artifacts: Iterable[Artifact]) -> None:
    expected_keys = {artifact.destination_key for artifact in artifacts}
    paginator = client.get_paginator("list_objects_v2")
    unexpected: list[str] = []
    for page in paginator.paginate(Bucket=BUCKET, Prefix=V2_DESTINATION_PREFIX):
        for item in page.get("Contents", []):
            key = item.get("Key")
            if not isinstance(key, str) or key not in expected_keys:
                unexpected.append(str(key))
                if len(unexpected) >= 5:
                    break
        if unexpected:
            break
    if unexpected:
        raise PromotionError(f"v2 destination contains unexpected data: {', '.join(unexpected)}")


def build_promotion_plan(client: S3Client, context: PromotionContext) -> PromotionPlan:
    """Read and validate both sides, without writing any S3 object."""

    artifacts = expected_artifacts(context)
    validate_v1_manifest(client, context)
    source_by_key = validate_source_artifacts(client, context)
    assert_destination_contains_only_expected(client, artifacts)
    actions: list[PromotionAction] = []
    for artifact in artifacts:
        source = source_by_key[artifact.source_key]
        destination = try_describe_object(client, artifact.destination_key)
        if destination is None:
            action = "copy"
        elif destination_matches_source(source, destination):
            action = "already-verified"
        else:
            raise PromotionError(f"conflicting pre-existing v2 object: {artifact.destination_key}")
        actions.append(PromotionAction(artifact, source, destination, action))
    if len(actions) != EXPECTED_ARTIFACT_COUNT:
        raise PromotionError("promotion plan does not contain exactly 3,000 actions")
    return PromotionPlan(context, tuple(actions))


def copy_headers(source: ObjectDescription) -> dict[str, Any]:
    headers: dict[str, Any] = {
        "MetadataDirective": "REPLACE",
        "Metadata": source_metadata_for_copy(source),
        "ChecksumAlgorithm": "SHA256",
    }
    for parameter, value in {
        "ContentType": source.content_type,
        "CacheControl": source.cache_control,
        "ContentDisposition": source.content_disposition,
        "ContentEncoding": source.content_encoding,
        "ContentLanguage": source.content_language,
        "Expires": source.expires,
    }.items():
        if value is not None:
            headers[parameter] = value
    return headers


def verify_copied_destination(
    source: ObjectDescription,
    destination: ObjectDescription,
    copy_response: Mapping[str, Any],
) -> None:
    if source.size != destination.size:
        raise PromotionError(f"copied object size mismatch: {destination.key}")
    if source.content_type != destination.content_type:
        raise PromotionError(f"copied object content-type mismatch: {destination.key}")
    if not metadata_proves_prior_copy(source, destination):
        raise PromotionError(f"copied object provenance metadata mismatch: {destination.key}")
    if destination.checksum_sha256 is None:
        raise PromotionError(f"copied object is missing requested SHA-256 checksum: {destination.key}")
    if source.checksum_sha256 and source.checksum_sha256 != destination.checksum_sha256:
        raise PromotionError(f"copied object SHA-256 mismatch: {destination.key}")
    copied = copy_response.get("CopyObjectResult")
    copied_etag = copied.get("ETag") if isinstance(copied, Mapping) else None
    if isinstance(copied_etag, str) and copied_etag != destination.etag:
        raise PromotionError(f"copied object ETag mismatch after copy: {destination.key}")


def apply_promotion(client: S3Client, plan: PromotionPlan) -> PromotionPlan:
    """Perform only the validated server-side copies, then verify all targets."""

    assert_destination_contains_only_expected(client, (action.artifact for action in plan.actions))
    completed_actions: list[PromotionAction] = []
    for action in plan.actions:
        existing = try_describe_object(client, action.artifact.destination_key)
        if existing is not None:
            if not destination_matches_source(action.source, existing):
                raise PromotionError(f"conflicting v2 object appeared before copy: {existing.key}")
            completed_actions.append(PromotionAction(action.artifact, action.source, existing, "already-verified"))
            continue
        if action.source.etag is None:
            raise PromotionError(f"source object has no ETag for copy precondition: {action.source.key}")
        response = client.copy_object(
            Bucket=BUCKET,
            Key=action.artifact.destination_key,
            CopySource={"Bucket": BUCKET, "Key": action.source.key},
            CopySourceIfMatch=action.source.etag,
            **copy_headers(action.source),
        )
        destination = describe_object(client, action.artifact.destination_key)
        verify_copied_destination(action.source, destination, response)
        completed_actions.append(PromotionAction(action.artifact, action.source, destination, "copied"))
    assert_destination_contains_only_expected(client, (action.artifact for action in plan.actions))
    final_actions = tuple(completed_actions)
    if len(final_actions) != EXPECTED_ARTIFACT_COUNT:
        raise PromotionError("promotion did not complete exactly 3,000 artifacts")
    return PromotionPlan(plan.context, final_actions)


def plan_report(plan: PromotionPlan, *, mode: str) -> dict[str, Any]:
    copied = sum(action.action == "copied" for action in plan.actions)
    copy_candidates = sum(action.action in {"copy", "copied"} for action in plan.actions)
    already = sum(action.action == "already-verified" for action in plan.actions)
    return {
        "mode": mode,
        "bucket": BUCKET,
        "source_prefix": V1_SOURCE_PREFIX,
        "destination_prefix": V2_DESTINATION_PREFIX,
        "run_id": RUN_ID,
        "shard_id": SHARD_ID,
        "shard_count": SHARD_COUNT,
        "shard_input_count": EXPECTED_SHARD_INPUT_COUNT,
        "expected_artifact_count": EXPECTED_ARTIFACT_COUNT,
        "copy_candidates": copy_candidates,
        "already_verified": already,
        "copied": copied,
        "v1_inputs_sha256": EXPECTED_SHARD_INPUTS_SHA256,
        "v2_base_manifest_sha256": EXPECTED_BASE_MANIFEST_SHA256,
        "v2_shard_manifest_sha256": EXPECTED_SHARD_MANIFEST_SHA256,
        "v2_shard_plan_sha256": EXPECTED_SHARD_PLAN_SHA256,
    }


def create_s3_client() -> S3Client:
    # Imports remain here so --validate-local works without AWS dependencies or
    # credentials.  The reviewed v2 requirements pin boto3/botocore for SSM use.
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        region_name=REGION,
        config=Config(
            retries={"total_max_attempts": 2, "mode": "adaptive"},
            connect_timeout=5,
            read_timeout=30,
            max_pool_connections=8,
        ),
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    default_base, default_shard, default_plan = default_manifest_paths()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-manifest", type=Path, default=default_base)
    parser.add_argument("--shard-manifest", type=Path, default=default_shard)
    parser.add_argument("--shard-plan", type=Path, default=default_plan)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--validate-local", action="store_true", help="Validate only local immutable v2 manifests")
    modes.add_argument("--verify", action="store_true", help="Read and verify S3 only; never write")
    modes.add_argument("--apply", action="store_true", help="Perform the verified server-side promotion copies")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        context = load_locked_context(args.base_manifest, args.shard_manifest, args.shard_plan)
        if args.validate_local:
            artifacts = expected_artifacts(context)
            print(json.dumps({
                "mode": "validate-local",
                "bucket": BUCKET,
                "source_prefix": V1_SOURCE_PREFIX,
                "destination_prefix": V2_DESTINATION_PREFIX,
                "run_id": RUN_ID,
                "shard_id": SHARD_ID,
                "expected_artifact_count": len(artifacts),
                "source_writes": 0,
                "destination_writes": 0,
            }, indent=2, sort_keys=True))
            return 0
        client = create_s3_client()
        plan = build_promotion_plan(client, context)
        if args.verify:
            print(json.dumps(plan_report(plan, mode="verify"), indent=2, sort_keys=True))
            return 0
        applied = apply_promotion(client, plan)
        print(json.dumps(plan_report(applied, mode="apply"), indent=2, sort_keys=True))
        return 0
    except PromotionError as error:
        print(f"promotion validation failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
