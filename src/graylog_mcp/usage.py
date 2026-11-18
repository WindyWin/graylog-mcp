"""What the model asks of graylog-mcp: one record per tool call, for the admin page's charts.

Records go to the usage store (``usage_store``) next to the server's other state (``~/.config/graylog-mcp``).
Queries and ids are redacted before they are written and nothing leaves the machine. ``GRAYLOG_MCP_USAGE=off``
turns it off.
"""

from __future__ import annotations

import contextlib
import re
import statistics
import time
from collections import defaultdict
from collections.abc import Callable
from typing import Any

from graylog_mcp.client import SpanLog
from graylog_mcp.operations import search_names
from graylog_mcp.redact import Redactor
from graylog_mcp.usage_store import enabled, previews, store

# arguments worth seeing again (redacted): what was searched for
ARG_KEYS = ("query", "trace_id", "field", "ref", "group_by", "contains")
# what shaped the result, kept apart from "args": the admin page replays those as a tool call
PARAM_KEYS = ("range", "from_time", "to_time", "fields", "limit", "offset")
PREVIEW_CHARS = 2000


def results_of(result: Any) -> int | None:
    """How many things a tool found: its total or count, else the length of its main list."""
    if not isinstance(result, dict):
        return None
    for key in ("total", "count"):
        value = result.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            return value
    for key in ("messages", "timeline", "groups", "values", "findings", "streams", "fields"):
        value = result.get(key)
        if isinstance(value, list):
            return len(value)
    return None


def _redactor(app: Any) -> Callable[[str], str]:
    # without an App (its config is broken) the core rules still apply
    return (app.redactor if app is not None else Redactor()).text


def _call(tool: str, app: Any, kwargs: dict[str, Any], identity: dict[str, Any] | None) -> dict[str, Any]:
    """What both records of a call carry: who called, which tool, on which instance, asking for what."""
    redact = _redactor(app)
    instance = kwargs.get("instance")
    if app is not None:
        with contextlib.suppress(Exception):  # an alias or a group becomes the instance it names
            instance = app.config.instance(instance or None).name
    entry: dict[str, Any] = {"ts": round(time.time(), 3), **(identity or {}), "tool": tool, "instance": instance}
    args: dict[str, str] = {}
    for key in ARG_KEYS:
        value = kwargs.get(key)
        if value not in (None, ""):
            args[key] = redact(str(value))[:300]
    params: dict[str, str] = {}
    for key in PARAM_KEYS:
        value = kwargs.get(key)
        if value not in (None, "", 0):
            params[key] = redact(str(value))[:100]
    if args:
        entry["args"] = args
    if params:
        entry["params"] = params
    from graylog_mcp.shared import current_repo

    if repo := current_repo.get():
        entry["repo"] = re.split(r"[\\/]", repo.rstrip("\\/"))[-1]  # a Windows folder from a client on Windows
    return entry


def track_start(tool: str, app: Any, kwargs: dict[str, Any], identity: dict[str, Any]) -> None:
    """Record that a call began, before it runs: a call that never ends still shows (running, or interrupted
    once its process is gone). Never raises."""
    if not enabled():
        return
    with contextlib.suppress(Exception):
        write({"event": "started", **_call(tool, app, kwargs, identity)})


def _spans(spans: SpanLog, redact: Callable[[str], str]) -> list[dict[str, Any]]:
    out = []
    for span in spans.items:
        span = dict(span)
        span["path"] = redact(str(span.get("path", "")))[:200]
        if "query" in span:
            span["query"] = redact(str(span["query"]))[:300]
        out.append(span)
    return out


def track(
    tool: str,
    app: Any,
    kwargs: dict[str, Any],
    result: Any,
    error: str | None,
    started: float,
    chars: int,
    requests: int = 0,
    *,
    identity: dict[str, Any] | None = None,
    status: str | None = None,
    spans: SpanLog | None = None,
    text: str = "",
) -> None:
    """Record one tool call; never raises (usage must not break a call). With ``identity`` (from
    ``recording``) this is the end of a call whose start was recorded, joined with it by ``call_id``."""
    if not enabled():
        return
    with contextlib.suppress(Exception):
        redact = _redactor(app)
        ok = error is None if status is None else status == "ok"
        entry = _call(tool, app, kwargs, identity)
        entry.update(ms=int((time.monotonic() - started) * 1000), ok=ok, chars=chars)
        if status is not None:
            entry["status"] = status
        found = results_of(result) if error is None else None
        if found is not None:
            entry["results"] = found
        if requests:
            entry["requests"] = requests
        if isinstance(result, dict):
            returned = result.get("returned")
            if not isinstance(returned, int) and isinstance(result.get("messages"), list):
                returned = len(result["messages"])
            if isinstance(returned, int):
                entry["returned"] = returned  # lines in this answer; "results" is what the query matched
            if result.get("truncated"):
                entry["truncated"] = True
        if isinstance(result, dict) and result.get("rewritten"):
            entry["rewritten"] = True  # a safe or learned fix ran instead of the query as written
        if isinstance(result, dict) and result.get("suggestions"):
            entry["suggested"] = len(result["suggestions"])
        if error:
            entry["error"] = redact(error)[:300]
        if spans is not None:
            entry["spans"] = _spans(spans, redact)
            if spans.dropped:
                entry["spans_dropped"] = spans.dropped
        if text and ok and previews():
            # redacted whole, then cut: dumps() does not redact, and a cut could split a value the rules would catch
            entry["preview"] = redact(text)[:PREVIEW_CHARS]
            if len(text) > PREVIEW_CHARS:
                entry["preview_truncated"] = True
        write({"event": "finished", **entry} if identity is not None else entry)


def write(entry: dict[str, Any]) -> None:
    store().append(entry)


def read(since: float) -> list[dict[str, Any]]:
    return store().read(since)


def is_miss(entry: dict[str, Any]) -> bool:
    return entry.get("ok", False) and entry.get("tool") in search_names() and entry.get("results") == 0


def _pct(values: list[int], q: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round(q * (len(ordered) - 1)))]


def summarize(hours: int = 24, bucket_hours: int = 1, now: float | None = None) -> dict[str, Any]:
    """Calls per bucket, per tool (count, errors, empty results, latency), searches that found nothing, and the
    same totals for the period before (for the change shown next to each number)."""
    now = time.time() if now is None else now
    span, step = hours * 3600, bucket_hours * 3600
    end = (int(now) // step + 1) * step  # buckets end with the current one
    start = end - span
    # what the model asked: not the admin's Playground runs, nor calls still running
    entries = [
        e for e in read(start - span) if e.get("source", "mcp") == "mcp" and e.get("status") != "running"
    ]  # fmt: skip
    # several processes append (one per stdio session): order by time, not by position in the file
    current = sorted((e for e in entries if e["ts"] >= start), key=lambda e: e["ts"])
    previous = [e for e in entries if e["ts"] < start]

    buckets = [{"t": t, "calls": 0, "errors": 0, "misses": 0} for t in range(start, end, step)]
    per_tool: dict[str, dict[str, Any]] = defaultdict(lambda: {"calls": 0, "errors": 0, "misses": 0, "ms": []})
    for e in current:
        b = buckets[min(len(buckets) - 1, int(e["ts"] - start) // step)]
        t = per_tool[str(e.get("tool"))]
        b["calls"] += 1
        t["calls"] += 1
        t["ms"].append(int(e.get("ms") or 0))
        if not e.get("ok", False):
            b["errors"] += 1
            t["errors"] += 1
        if is_miss(e):
            b["misses"] += 1
            t["misses"] += 1
    tools = [
        {"tool": name, "calls": t["calls"], "errors": t["errors"], "misses": t["misses"],
         "p50_ms": int(statistics.median(t["ms"])) if t["ms"] else 0, "p95_ms": _pct(t["ms"], 0.95)}
        for name, t in per_tool.items()
    ]  # fmt: skip
    tools.sort(key=lambda t: (-t["calls"], t["tool"]))

    def totals(items: list[dict[str, Any]]) -> dict[str, Any]:
        searches = [e for e in items if e.get("tool") in search_names() and e.get("ok")]
        misses = sum(1 for e in searches if is_miss(e))
        return {
            "calls": len(items),
            "errors": sum(1 for e in items if not e.get("ok", False)),
            "searches": len(searches),
            "misses": misses,
            "hit_rate": round(100 * (len(searches) - misses) / len(searches)) if searches else None,
        }

    return {
        "enabled": enabled(),
        "range_hours": hours,
        "bucket_hours": bucket_hours,
        "buckets": buckets,
        "tools": tools,
        "totals": totals(current),
        "previous": totals(previous),
        "misses": [e for e in reversed(current) if is_miss(e)][:25],
        "recent": list(reversed(current))[:200],
    }
