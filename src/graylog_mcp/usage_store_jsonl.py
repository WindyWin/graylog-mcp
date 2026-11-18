"""Usage records as JSON lines: one file per process and UTC day, so two writers never share a file.

    usage/live/<day>/<pid>-<start>.jsonl   what one process recorded that day
    usage/days/<day>.jsonl                 a day imported from the old usage.jsonl
    usage/compact.lock                     held by the one process doing housekeeping

A call is written twice, ``{"event": "started", "call_id": ...}`` before it runs and ``{"event": "finished", ...}``
after, and read back as one record. A call that never finished is ``running`` while its process lives, else
``interrupted``.
"""

from __future__ import annotations

import contextlib
import json
import os
import threading
import time
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from graylog_mcp.usage_store import enabled

DETAIL = ("preview", "spans")
LOCK_STALE_SECONDS = 600  # a lock older than this was left by a process that died while holding it
RETRY_SECONDS = 60  # after a failed write (read-only folder, full disk), how long before trying again


def _day(ts: float) -> str:
    return datetime.fromtimestamp(ts, UTC).strftime("%Y-%m-%d")


class JsonlStore:
    def __init__(self, root: Path, legacy: Path | None = None):
        self.root = root
        self.legacy = legacy  # the single usage.jsonl of earlier versions, imported on first use
        self._lock = threading.Lock()
        self._failed_at: float | None = None
        self._process: tuple[int, str] | None = None

    # ------------------------------------------------------------------ writing

    def _file_name(self) -> str:
        pid = os.getpid()
        if self._process is None or self._process[0] != pid:  # a forked child gets a file of its own
            self._process = (pid, f"{pid}-{int(time.time())}.jsonl")
        return self._process[1]

    def append(self, entry: dict[str, Any]) -> None:
        if not enabled():
            return
        if self._failed_at is not None and time.monotonic() - self._failed_at < RETRY_SECONDS:
            return
        with contextlib.suppress(Exception):
            line = json.dumps(entry, ensure_ascii=False, default=str) + "\n"
            target = self.root / "live" / _day(float(entry.get("ts") or time.time())) / self._file_name()
            with self._lock:
                try:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with target.open("a", encoding="utf-8") as fh:
                        fh.write(line)
                    self._failed_at = None
                except OSError:
                    self._failed_at = time.monotonic()

    # ------------------------------------------------------------------ reading

    def read(self, since: float, until: float | None = None, detail: bool = False) -> list[dict[str, Any]]:
        if not enabled():
            return []
        if self._legacy_waiting():
            self.compact(time.time())
        first, last = _day(since), _day(until) if until is not None else None
        rows: list[tuple[dict[str, Any], int | None]] = []
        for path, pid in self._files():
            day = path.parent.name if pid is not None else path.stem
            if day < first or (last is not None and day > last):
                continue
            rows.extend((row, pid) for row in _lines(path))
        out = [
            e for e in _join(rows)
            if isinstance(e.get("ts"), (int, float)) and e["ts"] >= since and (until is None or e["ts"] <= until)
        ]  # fmt: skip
        out.sort(key=lambda e: e["ts"])  # several processes, several files: order by time, not by position
        if not detail:
            out = [{k: v for k, v in e.items() if k not in DETAIL} for e in out]
        return out

    def calls_of(self, conversation: str, since: float, until: float) -> list[dict[str, Any]]:
        return [e for e in self.read(since, until, detail=True) if e.get("conversation") == conversation]

    def _files(self) -> Iterator[tuple[Path, int | None]]:
        """Every record file, with the pid that wrote it (None for an imported day)."""
        with contextlib.suppress(OSError):
            for path in sorted((self.root / "days").glob("*.jsonl")):
                yield path, None
        with contextlib.suppress(OSError):
            for path in sorted((self.root / "live").glob("*/*.jsonl")):
                pid = path.stem.split("-", 1)[0]
                yield path, int(pid) if pid.isdigit() else 0

    # ------------------------------------------------------------------ housekeeping

    def compact(self, now: float) -> None:
        if not enabled():
            return
        with self._exclusive() as held:
            if held:
                with contextlib.suppress(OSError):
                    self._import_legacy()

    @contextlib.contextmanager
    def _exclusive(self) -> Iterator[bool]:
        """Hold ``compact.lock`` for the block; yields False when another process holds it."""
        lock = self.root / "compact.lock"
        fd = None
        with contextlib.suppress(OSError):
            self.root.mkdir(parents=True, exist_ok=True)
            for _ in range(2):
                try:
                    fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                    break
                except FileExistsError:
                    if time.time() - lock.stat().st_mtime < LOCK_STALE_SECONDS:
                        break
                    lock.unlink()
        if fd is None:
            yield False
            return
        try:
            os.close(fd)
            yield True
        finally:
            with contextlib.suppress(OSError):
                lock.unlink()

    def _legacy_paths(self) -> tuple[Path, Path, Path] | None:
        if self.legacy is None:
            return None
        name = self.legacy.name
        return self.legacy, self.legacy.with_name(name + ".importing"), self.legacy.with_name(name + ".imported")

    def _legacy_waiting(self) -> bool:
        paths = self._legacy_paths()
        return paths is not None and (paths[0].exists() or paths[1].exists())

    def _import_legacy(self) -> None:
        """Move the old usage.jsonl aside, then split it into days. Checked on every run: a server of an earlier
        version still running creates the file again."""
        paths = self._legacy_paths()
        if paths is None:
            return
        legacy, importing, imported = paths
        for _ in range(2):  # an import a crash interrupted, then the file written since
            if not importing.exists():
                if not legacy.exists():
                    return
                os.replace(legacy, importing)
            by_day: dict[str, list[str]] = {}
            for row in _lines(importing):
                if isinstance(row.get("ts"), (int, float)):
                    by_day.setdefault(_day(row["ts"]), []).append(json.dumps(row, ensure_ascii=False) + "\n")
            (self.root / "days").mkdir(parents=True, exist_ok=True)
            for day, lines in by_day.items():
                # appended, not merged: a crash between here and the rename below would import these lines twice
                with (self.root / "days" / f"{day}.jsonl").open("a", encoding="utf-8") as fh:
                    fh.writelines(lines)
            os.replace(importing, imported)


def _lines(path: Path) -> Iterator[dict[str, Any]]:
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return
    for line in raw.splitlines():
        with contextlib.suppress(ValueError):
            row = json.loads(line)
            if isinstance(row, dict):
                yield row


def _join(rows: list[tuple[dict[str, Any], int | None]]) -> list[dict[str, Any]]:
    """One record per call: a ``started`` line completed by its ``finished`` line."""
    from graylog_mcp.setup.service import pid_alive

    out: list[dict[str, Any]] = []
    calls: dict[Any, tuple[dict[str, Any], int | None]] = {}
    finished: set[Any] = set()
    for row, pid in rows:
        event = row.pop("event", None)
        if event is None:
            out.append(row)
            continue
        key = row.get("call_id")
        if key not in calls:
            calls[key] = ({}, pid)
            out.append(calls[key][0])
        call = calls[key][0]
        if event == "finished":
            call.update(row)
            finished.add(key)
        else:
            for k, v in row.items():
                call.setdefault(k, v)
    alive: dict[int | None, bool] = {}
    for key, (call, pid) in calls.items():
        if key in finished:
            continue
        if pid not in alive:
            alive[pid] = bool(pid) and pid_alive(pid)  # type: ignore[arg-type]
        if alive[pid]:
            call["status"] = "running"
        else:
            call["status"], call["ok"] = "interrupted", False
    return out
