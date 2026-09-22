#!/usr/bin/env python3
"""Async HTTP entrypoint for the Cloudflare Container domain-JSON builder.

The container exposes a tiny HTTP server. A POST to /run starts
`build_domain_json_v1.process_bucket()` in a background thread for the bucket
supplied in the JSON body and immediately returns {status: "started"}. GET
/status returns the current job state. This avoids holding the Durable Object's
fetch open for minutes while a bucket is being processed.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
import urllib.request
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path("/opt/growthsent")
ACCOUNT_ID = "4a30e8ac877d9f65ee9a0ecc5df16146"
BUCKET = "growthsent-data-lake"
SERVING_PREFIX = "production/link-index/v1/serving/cc-main-2026-30-index-compact-20260910145140-16416/serving"
OUTPUT_PREFIX = "production/link-index/v1/domain-json/v1"
PORT = 8080

_jobs: dict[int, dict] = {}
_jobs_lock = threading.Lock()
_current_bucket: int | None = None


class RequestHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[{self.command} {self.path}] {fmt % args}", flush=True)

    def _send_json(self, body: object, status: int = 200) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            self._send_json({"ok": True})
        elif parsed.path == "/status":
            with _jobs_lock:
                if _current_bucket is None:
                    self._send_json({"running": False})
                else:
                    self._send_json({"running": True, "bucket": _current_bucket, **(_jobs.get(_current_bucket, {}))})
        else:
            self._send_json({"error": "not found"}, 404)

    def do_POST(self) -> None:  # noqa: N802
        global _current_bucket
        if self.path != "/run":
            self._send_json({"error": "not found"}, 404)
            return

        body = self._read_json()
        bucket = body.get("bucket")
        if not isinstance(bucket, int) or bucket < 0 or bucket >= 1024:
            self._send_json({"error": f"invalid bucket: {bucket!r}"}, 400)
            return

        with _jobs_lock:
            if _current_bucket is not None and _current_bucket != bucket and not _jobs.get(_current_bucket, {}).get("done"):
                self._send_json({"error": f"already processing bucket {_current_bucket}"}, 409)
                return
            if _jobs.get(bucket, {}).get("done"):
                # Already finished; return a fresh started response so the caller
                # can poll /status and see completion.
                self._send_json({"status": "started", "bucket": bucket, "note": "already complete"})
                return
            _current_bucket = bucket
            if not _jobs.get(bucket, {}).get("started"):
                _jobs[bucket] = {"done": False, "started": True}
                thread = threading.Thread(target=_run_bucket_thread, args=(bucket,), daemon=True)
                thread.start()
        self._send_json({"status": "started", "bucket": bucket})


def _derive_credentials() -> tuple[str, str]:
    token = os.environ.get("GROWTHSENT_R2_DOMAIN_JSON_TOKEN", "").strip()
    if not token:
        raise RuntimeError("missing GROWTHSENT_R2_DOMAIN_JSON_TOKEN")

    request = urllib.request.Request(
        "https://api.cloudflare.com/client/v4/user/tokens/verify",
        headers={"Authorization": f"Bearer {token}"},
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=30) as handle:
        verify_payload = json.loads(handle.read().decode("utf-8"))

    if not verify_payload.get("success"):
        raise RuntimeError("token verification returned success=false")

    access_key_id = verify_payload["result"]["id"]
    secret_access_key = hashlib.sha256(token.encode("utf-8")).hexdigest()
    return access_key_id, secret_access_key


def _run_bucket(bucket: int) -> dict:
    access_key_id, secret_access_key = _derive_credentials()

    os.environ["GROWTHSENT_R2_ACCOUNT_ID"] = ACCOUNT_ID
    os.environ["GROWTHSENT_R2_BUCKET"] = BUCKET
    os.environ["GROWTHSENT_R2_OUTPUT_ACCESS_KEY_ID"] = access_key_id
    os.environ["GROWTHSENT_R2_OUTPUT_SECRET_ACCESS_KEY"] = secret_access_key

    sys.path.insert(0, str(ROOT / "tools"))
    from common_crawl_r2_store import R2Store, R2StoreError  # noqa: E402
    import build_domain_json_v1 as builder  # noqa: E402

    try:
        r2_store = R2Store.from_environment(
            credential_prefix="GROWTHSENT_R2_OUTPUT_",
            allowed_prefixes=[os.environ.get("GROWTHSENT_OUTPUT_PREFIX", OUTPUT_PREFIX)],
        )
    except R2StoreError as exc:
        raise RuntimeError(f"R2 store init failed: {exc}") from exc

    return builder.process_bucket(
        bucket=bucket,
        serving_prefix=os.environ.get("GROWTHSENT_SERVING_PREFIX", SERVING_PREFIX),
        output_prefix=os.environ.get("GROWTHSENT_OUTPUT_PREFIX", OUTPUT_PREFIX),
        work_dir=Path(os.environ.get("GROWTHSENT_WORK_DIR", "/tmp/growthsent")),
        r2_store=r2_store,
        top_n=int(os.environ.get("GROWTHSENT_TOP_N", "100")),
        upload_threads=int(os.environ.get("GROWTHSENT_UPLOAD_THREADS", "64")),
        batch_size=int(os.environ.get("GROWTHSENT_BATCH_SIZE", "2048")),
    )


def _run_bucket_thread(bucket: int) -> None:
    try:
        result = _run_bucket(bucket)
    except Exception as exc:  # noqa: BLE001
        import traceback
        error_trace = traceback.format_exc()
        print(f"ERROR running bucket {bucket}: {exc}\n{error_trace}", file=sys.stderr, flush=True)
        with _jobs_lock:
            _jobs[bucket] = {"done": True, "error": str(exc), "traceback": error_trace}
    else:
        print(f"bucket {bucket} finished: {json.dumps(result, sort_keys=True)}", flush=True)
        with _jobs_lock:
            _jobs[bucket] = {"done": True, "result": result}


def main() -> int:
    print(f"Starting domain-JSON container server on port {PORT}", flush=True)
    with ThreadingHTTPServer(("0.0.0.0", PORT), RequestHandler) as server:
        server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
