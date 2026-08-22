#!/usr/bin/env python3
"""Inject one scoped R2 temporary credential into one child process only.

The GCP Batch job carries only a Secret Manager *resource name*.  This helper
retrieves that version using the VM service account, validates the short-lived
R2 credential document, and supplies it only in the child's environment.  It
never prints credential values or writes them to disk.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from typing import Any, Mapping


class GcpSecretRuntimeError(RuntimeError):
    """Secret delivery is absent, malformed, or unsafe to use."""


def _required_string(document: Mapping[str, Any], name: str) -> str:
    value = document.get(name)
    if not isinstance(value, str) or not value:
        raise GcpSecretRuntimeError(f"R2 temporary credential is missing {name}")
    return value


def parse_r2_temporary_credential(payload: bytes) -> dict[str, str]:
    """Validate the small JSON document stored in one Secret Manager version."""

    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GcpSecretRuntimeError("R2 temporary credential secret is not valid JSON") from error
    if not isinstance(value, Mapping):
        raise GcpSecretRuntimeError("R2 temporary credential secret must be a JSON object")
    result = {
        "account_id": _required_string(value, "account_id"),
        "bucket": _required_string(value, "bucket"),
        "access_key_id": _required_string(value, "access_key_id"),
        "secret_access_key": _required_string(value, "secret_access_key"),
    }
    session_token = value.get("session_token")
    if session_token is not None:
        if not isinstance(session_token, str) or not session_token:
            raise GcpSecretRuntimeError("R2 temporary credential session_token is invalid")
        result["session_token"] = session_token
    return result


def fetch_secret(secret_version: str, *, client: Any | None = None) -> bytes:
    if not isinstance(secret_version, str) or not secret_version.startswith("projects/") or "/versions/" not in secret_version:
        raise GcpSecretRuntimeError("Secret Manager version must be a fully qualified projects/.../versions/... name")
    if client is None:
        try:
            from google.cloud import secretmanager
        except ImportError as error:
            raise GcpSecretRuntimeError("google-cloud-secret-manager is required in the GCP runtime image") from error
        client = secretmanager.SecretManagerServiceClient()
    try:
        response = client.access_secret_version(request={"name": secret_version})
        return bytes(response.payload.data)
    except Exception as error:
        raise GcpSecretRuntimeError("Secret Manager credential retrieval failed") from error


def credential_environment(document: Mapping[str, str], *, prefix: str) -> dict[str, str]:
    if not prefix.endswith("_"):
        raise GcpSecretRuntimeError("credential environment prefix must end with an underscore")
    environment = {
        "GROWTHSENT_R2_ACCOUNT_ID": document["account_id"],
        "GROWTHSENT_R2_BUCKET": document["bucket"],
        f"{prefix}ACCESS_KEY_ID": document["access_key_id"],
        f"{prefix}SECRET_ACCESS_KEY": document["secret_access_key"],
    }
    if "session_token" in document:
        environment[f"{prefix}SESSION_TOKEN"] = document["session_token"]
    return environment


def child_environment(
    base: Mapping[str, str],
    credentials: list[tuple[str, Mapping[str, str]]],
) -> dict[str, str]:
    environment = dict(base)
    for prefix, document in credentials:
        values = credential_environment(document, prefix=prefix)
        for name, value in values.items():
            prior = environment.get(name)
            if prior is not None and prior != value:
                raise GcpSecretRuntimeError(f"refusing to replace pre-existing R2 runtime setting: {name}")
            environment[name] = value
    return environment


def run_child(command: list[str], credentials: list[tuple[str, Mapping[str, str]]]) -> int:
    if not command or not all(isinstance(part, str) and part for part in command):
        raise GcpSecretRuntimeError("a non-empty child command is required")
    return subprocess.run(command, env=child_environment(os.environ, credentials), check=False).returncode


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--r2-secret-version", required=True)
    parser.add_argument("--r2-credential-prefix", default="GROWTHSENT_R2_")
    parser.add_argument("--additional-r2-secret-version")
    parser.add_argument("--additional-r2-credential-prefix")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    credentials = [
        (args.r2_credential_prefix, parse_r2_temporary_credential(fetch_secret(args.r2_secret_version))),
    ]
    if bool(args.additional_r2_secret_version) != bool(args.additional_r2_credential_prefix):
        parser.error("the additional R2 secret version and prefix must be supplied together")
    if args.additional_r2_secret_version:
        credentials.append(
            (
                str(args.additional_r2_credential_prefix),
                parse_r2_temporary_credential(fetch_secret(args.additional_r2_secret_version)),
            )
        )
    return run_child(command, credentials)


if __name__ == "__main__":
    raise SystemExit(main())
