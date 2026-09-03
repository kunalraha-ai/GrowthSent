#!/usr/bin/env python3
"""Internal HTTP runner for one fixed regional Container slot.

The Container process remains alive while the slot handles a sequence of
one-WAT child processes. The Durable Object talks only to this loopback HTTP
server, so a job request returns immediately and never holds a Worker request
open while Common Crawl data is processed.
"""

from __future__ import annotations

from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import threading
import time
from typing import Any


HOST = "0.0.0.0"
PORT = 8080
MAX_REQUEST_BYTES = 1_024
MAX_STATUS_ERROR_BYTES = 16_384
ENTRYPOINT = Path("/opt/growthsent/regional_ramp_entry.py")
WORK_DIRECTORY = Path("/work")
TASK_INDEX_RE = re.compile(r"(?:0|[1-9][0-9]*)\Z")


def utc_timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"missing required runtime setting: {name}")
    return value


def non_negative_integer(name: str) -> int:
    raw = required(name)
    if not TASK_INDEX_RE.fullmatch(raw):
        raise RuntimeError(f"{name} must be a non-negative decimal integer")
    return int(raw)


def redacted_text(value: str) -> str:
    result = value
    for name in ("GROWTHSENT_R2_ACCESS_KEY_ID", "GROWTHSENT_R2_SECRET_ACCESS_KEY", "GROWTHSENT_R2_SESSION_TOKEN"):
        secret = os.environ.get(name)
        if secret:
            result = result.replace(secret, "[redacted]")
    return result[:MAX_STATUS_ERROR_BYTES]


def tail(path: Path, maximum: int = MAX_STATUS_ERROR_BYTES) -> str:
    try:
        size = path.stat().st_size
        with path.open("rb") as handle:
            handle.seek(max(0, size - maximum))
            data = handle.read(maximum)
    except OSError:
        return ""
    return redacted_text(data.decode("utf-8", errors="replace"))


class TaskRunner:
    """Serialises child WAT processes and exposes a secret-free status view."""

    def __init__(self) -> None:
        self.run_id = required("GROWTHSENT_RAMP_ID")
        self.region = required("GROWTHSENT_REGION")
        self.region_index = non_negative_integer("GROWTHSENT_REGION_INDEX")
        self.region_count = non_negative_integer("GROWTHSENT_REGION_COUNT")
        raw_source_index_start = os.environ.get("GROWTHSENT_SOURCE_INDEX_START", "0")
        if not TASK_INDEX_RE.fullmatch(raw_source_index_start):
            raise RuntimeError("GROWTHSENT_SOURCE_INDEX_START must be a non-negative decimal integer")
        self.source_index_start = int(raw_source_index_start)
        self.task_count = non_negative_integer("GROWTHSENT_TASK_COUNT")
        self.hard_timeout_seconds = non_negative_integer("GROWTHSENT_HARD_TIMEOUT_SECONDS")
        if (
            self.region_count < 1
            or self.region_index >= self.region_count
            or self.source_index_start + self.task_count > 100_000
            or self.task_count < 1
            or self.hard_timeout_seconds != 6_600
        ):
            raise RuntimeError("regional runner settings are outside reviewed bounds")
        for name in (
            "GROWTHSENT_R2_ACCOUNT_ID",
            "GROWTHSENT_R2_BUCKET",
            "GROWTHSENT_R2_ACCESS_KEY_ID",
            "GROWTHSENT_R2_SECRET_ACCESS_KEY",
            "GROWTHSENT_R2_SESSION_TOKEN",
            "GROWTHSENT_RELEASE_SHA256",
            "GROWTHSENT_SELECTED_INPUTS_SHA256",
            "GROWTHSENT_CONTAINER_INSTANCE_TYPE",
        ):
            required(name)
        if not ENTRYPOINT.is_file():
            raise RuntimeError(f"task entrypoint is missing: {ENTRYPOINT}")
        WORK_DIRECTORY.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._process: subprocess.Popen[bytes] | None = None
        self._state = "idle"
        self._task_index: int | None = None
        self._started_at: str | None = None
        self._finished_at: str | None = None
        self._exit_code: int | None = None
        self._error: dict[str, str] | None = None

    def _valid_task_index(self, task_index: int) -> bool:
        return (
            self.source_index_start <= task_index < self.source_index_start + self.task_count
            and (task_index - self.source_index_start) % self.region_count == self.region_index
        )

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "state": self._state,
                "task_index": self._task_index,
                "started_at": self._started_at,
                "finished_at": self._finished_at,
                "exit_code": self._exit_code,
                "error": self._error,
            }

    def start(self, task_index: int) -> tuple[int, dict[str, Any]]:
        if not self._valid_task_index(task_index):
            return HTTPStatus.BAD_REQUEST, {"accepted": False, "error": "task index is outside this regional lane"}
        with self._lock:
            if self._state == "running":
                if self._task_index == task_index:
                    return HTTPStatus.ACCEPTED, {"accepted": True, "reconciled": True, "task_index": task_index}
                return HTTPStatus.CONFLICT, {"accepted": False, "error": "fixed slot is already processing another task"}
            if self._state == "succeeded" and self._task_index == task_index:
                return HTTPStatus.OK, {"accepted": True, "reconciled": True, "completed": True, "task_index": task_index}
            self._state = "running"
            self._task_index = task_index
            self._started_at = utc_timestamp()
            self._finished_at = None
            self._exit_code = None
            self._error = None
            thread = threading.Thread(target=self._run, args=(task_index,), name=f"wat-task-{task_index}", daemon=True)
            thread.start()
        return HTTPStatus.ACCEPTED, {"accepted": True, "task_index": task_index}

    def _run(self, task_index: int) -> None:
        environment = dict(os.environ)
        environment["GROWTHSENT_TASK_INDEX"] = str(task_index)
        stdout_path: Path | None = None
        stderr_path: Path | None = None
        exit_code = 1
        error: dict[str, str] | None = None
        try:
            with tempfile.NamedTemporaryFile(prefix="task-stdout-", suffix=".log", dir=WORK_DIRECTORY, delete=False) as stdout_handle:
                stdout_path = Path(stdout_handle.name)
            with tempfile.NamedTemporaryFile(prefix="task-stderr-", suffix=".log", dir=WORK_DIRECTORY, delete=False) as stderr_handle:
                stderr_path = Path(stderr_handle.name)
            command = [
                "/usr/bin/timeout",
                "--foreground",
                "--signal=TERM",
                "--kill-after=60s",
                f"{self.hard_timeout_seconds}s",
                "python",
                str(ENTRYPOINT),
            ]
            with stdout_path.open("wb") as stdout_handle, stderr_path.open("wb") as stderr_handle:
                process = subprocess.Popen(command, env=environment, stdin=subprocess.DEVNULL, stdout=stdout_handle, stderr=stderr_handle)
                with self._lock:
                    self._process = process
                exit_code = process.wait()
            if exit_code != 0:
                diagnostic = tail(stderr_path) or tail(stdout_path) or "regional task process exited without a diagnostic"
                error = {"type": "TaskProcessExit", "message": f"task process exited with code {exit_code}: {diagnostic}"[:MAX_STATUS_ERROR_BYTES]}
        except BaseException as exception:
            error = {"type": type(exception).__name__, "message": redacted_text(str(exception))}
        finally:
            for path in (stdout_path, stderr_path):
                if path is not None:
                    try:
                        path.unlink()
                    except OSError:
                        pass
            with self._lock:
                self._process = None
                self._exit_code = exit_code
                self._finished_at = utc_timestamp()
                self._error = error
                self._state = "succeeded" if error is None and exit_code == 0 else "failed"

    def shutdown(self) -> None:
        with self._lock:
            process = self._process
        if process is not None and process.poll() is None:
            try:
                process.terminate()
            except OSError:
                pass


class RunnerRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    runner: TaskRunner

    def log_message(self, _format: str, *_args: object) -> None:
        # Task requests and their contents must never appear in HTTP access logs.
        return

    def send_json(self, status: int, value: dict[str, Any]) -> None:
        body = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path in ("/ping", "/health"):
            self.send_json(HTTPStatus.OK, {"ok": True})
            return
        if self.path == "/status":
            self.send_json(HTTPStatus.OK, self.runner.status())
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/run-task":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        raw_length = self.headers.get("Content-Length")
        if raw_length is None or not TASK_INDEX_RE.fullmatch(raw_length):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid request length"})
            return
        length = int(raw_length)
        if length < 2 or length > MAX_REQUEST_BYTES:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "request body is outside reviewed bounds"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "request body is not valid JSON"})
            return
        task_index = payload.get("task_index") if isinstance(payload, dict) and set(payload) == {"task_index"} else None
        if not isinstance(task_index, int) or isinstance(task_index, bool):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "task_index must be an integer"})
            return
        status, result = self.runner.start(task_index)
        self.send_json(status, result)


def main() -> int:
    runner = TaskRunner()
    RunnerRequestHandler.runner = runner
    server = ThreadingHTTPServer((HOST, PORT), RunnerRequestHandler)
    server.daemon_threads = True

    def request_shutdown(_signum: int, _frame: object) -> None:
        runner.shutdown()
        threading.Thread(target=server.shutdown, name="runner-shutdown", daemon=True).start()

    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        runner.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
