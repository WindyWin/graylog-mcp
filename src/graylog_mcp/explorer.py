"""The admin page's log explorer: request logs per API, traces and messages, read straight from Graylog.

Not a tool of the model: no output budget and no focus, but every value is redacted and every list capped. Each
number comes from an aggregation over the whole range, never from a sample of messages. The API, status and latency
fields are the instance's settings (``endpoint_fields``, ``status_fields``, ``latency_fields``).
"""

from __future__ import annotations

import asyncio
import weakref
from typing import Any

from graylog_mcp.backends import Graylog
from graylog_mcp.backends.base import COUNT, AggResult, MessageQuery, Metric
from graylog_mcp.setup.detect import NUMERIC_TYPES
from graylog_mcp.timerange import TimeRange, choose_interval, parse_graylog_ts, resolve_range
from graylog_mcp.tools import App, ToolInputError, escape_field, phrase

MAX_LIMIT = 500
MAX_WINDOW = 10_000  # offset + limit: OpenSearch's index.max_result_window by default
MAX_TOP = 100
MAX_TRACE_MESSAGES = 1000
PARALLEL_PER_INSTANCE = 2  # explorer requests at once; the instance's max_concurrency still caps Graylog requests
PERCENTILES = (50, 95, 99)

_gates: weakref.WeakKeyDictionary[Graylog, asyncio.Semaphore] = weakref.WeakKeyDictionary()


class Scope:
    """The instance, query, streams and window of one explorer request, and the fields found in its logs."""

    def __init__(self, app: App, gl: Graylog, query: str, streams: tuple[str, ...], tr: TimeRange, names: set[str]):
        self.app, self.gl, self.query, self.streams, self.tr = app, gl, query or "*", streams, tr
        cfg = gl.cfg

        def first(candidates: tuple[str, ...]) -> str | None:
            return next((f for f in candidates if f in names), None)

        self.service = first(cfg.service_fields)
        self.endpoint = first(cfg.endpoint_fields)
        self.status = first(cfg.status_fields)
        self.latency = first(cfg.latency_fields)
        self.trace = first(cfg.trace_fields)
        status = escape_field(self.status) if self.status else None
        self.business: str | None = cfg.business_error_query or (f"{status}:[400 TO 499]" if status else None)
        self.technical = cfg.technical_error_query or (
            f"{status}:[500 TO 599] OR ({cfg.error_query})" if status else cfg.error_query
        )
        unit = cfg.latency_unit
        if unit == "auto":
            unit = "s" if self.latency == "request_time" or (self.latency or "").endswith("_seconds") else "ms"
        self.latency_scale = 1000 if unit == "s" else 1  # values are shown in ms

    def where(self, *clauses: str | None) -> str:
        parts = [f"({self.query})"] + [f"({c})" for c in clauses if c]
        return " AND ".join(parts)

    def redact(self, field: str | None, value: Any) -> Any:
        return self.app.redact_key(field or "message", value)

    async def aggregate(self, query: str, group_by: list[str], limit: int, metrics: list[Metric]) -> AggResult:
        return await self.gl.aggregate(query, self.tr, self.streams, group_by, limit, metrics)

    def fields(self) -> dict[str, str | None]:
        return {"service": self.service, "endpoint": self.endpoint, "status": self.status, "latency": self.latency,
                "trace": self.trace}  # fmt: skip

    def header(self) -> dict[str, Any]:
        return {"instance": self.gl.cfg.name, "range": self.tr.display(self.gl.cfg.tz), "query": self.query,
                "fields": self.fields()}  # fmt: skip


async def _scope(
    app: App,
    instance: str | None,
    query: str | None,
    streams: str | None,
    range: str | None,
    from_time: str | None,
    to_time: str | None,
) -> Scope:
    gl = app.gl(instance or None)
    try:
        tr = resolve_range(range, from_time, to_time, gl.cfg.tz, default="1h")
    except ValueError as exc:
        raise ToolInputError(str(exc)) from None
    stream_ids = await gl.resolve_streams([s for s in (streams or "").split(",") if s.strip()])
    return Scope(app, gl, (query or "").strip(), stream_ids, tr, await gl.field_names())


def _gate(gl: Graylog) -> asyncio.Semaphore:
    gate = _gates.get(gl)
    if gate is None:
        gate = _gates[gl] = asyncio.Semaphore(PARALLEL_PER_INSTANCE)
    return gate


def _ms(value: Any) -> int | None:
    ts = parse_graylog_ts(value)
    return int(ts.timestamp() * 1000) if ts else None


def _any_of(field: str, values: list[Any]) -> str:
    return f"{escape_field(field)}:({' OR '.join(phrase(v) for v in values)})"


def _counts(result: AggResult) -> dict[Any, int]:
    rows, _ = result.split_missing()
    return {r.keys[0]: int(r.values.get(COUNT.name) or 0) for r in rows}


def _status_class(value: Any) -> str:
    try:
        return f"{int(str(value)) // 100}xx"
    except ValueError:
        return "other"


# --------------------------------------------------------------------------- dashboard


async def dashboard(
    app: App,
    instance: str | None = None,
    query: str | None = None,
    streams: str | None = None,
    range: str | None = "1h",
    from_time: str | None = None,
    to_time: str | None = None,
    top: int = 20,
) -> dict[str, Any]:
    """Messages per application and per status class, a histogram, and the busiest APIs with their errors,
    latency percentiles and slow calls."""
    s = await _scope(app, instance, query, streams, range, from_time, to_time)
    top = max(1, min(int(top), MAX_TOP))
    async with _gate(s.gl):
        total, apps, statuses, histogram, endpoints = await asyncio.gather(
            s.gl.count(s.where(), s.tr, s.streams),
            _apps(s),
            _statuses(s),
            _histogram(s),
            _endpoints(s, top),
        )
    out = s.header()
    out.update(total=total, apps=apps, histogram=histogram, endpoints=endpoints)
    out["status"] = None if statuses is None else {**statuses, "none": max(0, total - sum(statuses.values()))}
    out["slow_ms"] = list(s.gl.cfg.slow_ms)
    out["error_queries"] = {"business": s.business, "technical": s.technical}
    return out


async def _apps(s: Scope) -> list[dict[str, Any]] | None:
    if not s.service:
        return None
    every, business, technical = await asyncio.gather(
        s.aggregate(s.where(), [s.service], 20, [COUNT]),
        s.aggregate(s.where(s.business), [s.service], 20, [COUNT]) if s.business else _nothing(),
        s.aggregate(s.where(s.technical), [s.service], 20, [COUNT]),
    )
    bad, broken = _counts(business) if business else {}, _counts(technical)
    return [
        {"app": s.redact(s.service, key), "count": count, "business_errors": bad.get(key, 0),
         "technical_errors": broken.get(key, 0)}
        for key, count in _counts(every).items()
    ]  # fmt: skip


async def _nothing() -> None:
    return None


async def _statuses(s: Scope) -> dict[str, int] | None:
    if not s.status:
        return None
    out: dict[str, int] = {}
    for value, count in _counts(await s.aggregate(s.where(), [s.status], 100, [COUNT])).items():
        out[_status_class(value)] = out.get(_status_class(value), 0) + count
    return out


async def _histogram(s: Scope) -> dict[str, Any]:
    interval, secs = choose_interval(s.tr)
    every, errors = await asyncio.gather(
        s.gl.histogram(s.where(), s.tr, s.streams, interval),
        s.gl.histogram(s.where(s.technical), s.tr, s.streams, interval),
    )
    bad = {_ms(r.keys[0]): int(r.values.get(COUNT.name) or 0) for r in errors.rows if r.keys}
    buckets = [
        {"t": t, "count": int(r.values.get(COUNT.name) or 0), "errors": bad.get(t, 0)}
        for r in every.rows
        if r.keys and (t := _ms(r.keys[0])) is not None
    ]
    return {"interval_s": secs, "buckets": sorted(buckets, key=lambda b: b["t"])}


async def _endpoints(s: Scope, top: int) -> dict[str, Any] | None:
    if not s.endpoint:
        return None
    metrics = [COUNT, Metric("max", "timestamp")]
    if s.latency:
        metrics += [Metric("percentile", s.latency, p) for p in PERCENTILES]
    busiest = await s.aggregate(s.where(), [s.endpoint], top + 1, metrics)
    rows, without = busiest.split_missing()
    more, rows = len(rows) > top, rows[:top]
    if not rows:
        return {"rows": [], "more": False, "without_field": without}
    # the errors and slow calls of these APIs exactly: a top N of errors alone could name other APIs
    names = [r.keys[0] for r in rows]
    shown = _any_of(s.endpoint, names)
    slow = [(t, f"{escape_field(s.latency)}:>={t / s.latency_scale:g}") for t in s.gl.cfg.slow_ms] if s.latency else []
    queries = [s.business, s.technical, *(clause for _, clause in slow)]
    found = await asyncio.gather(*(
        s.aggregate(s.where(clause, shown), [s.endpoint], len(names), [COUNT]) if clause else _nothing()
        for clause in queries
    ))  # fmt: skip
    business, technical, *slow_counts = [_counts(r) if r else {} for r in found]
    out = []
    for r in rows:
        key, count = r.keys[0], int(r.values.get(COUNT.name) or 0)
        errors = business.get(key, 0) + technical.get(key, 0)
        item: dict[str, Any] = {
            "endpoint": s.redact(s.endpoint, key),
            "count": count,
            "business_errors": business.get(key, 0) if s.business else None,
            "technical_errors": technical.get(key, 0),
            "error_pct": round(100 * errors / count, 1) if count else None,
            "last_ts": _ms(r.values.get("max(timestamp)")),
        }
        if s.latency:
            item["latency_ms"] = {
                f"p{p}": _scaled(r.values.get(Metric("percentile", s.latency, p).name), s.latency_scale)
                for p in PERCENTILES
            }
            item["slow"] = {str(t): counts.get(key, 0) for (t, _), counts in zip(slow, slow_counts, strict=True)}
        out.append(item)
    return {"rows": out, "more": more, "covered": sum(i["count"] for i in out), "without_field": without}


def _scaled(value: Any, scale: int) -> float | None:
    return round(float(value) * scale, 1) if isinstance(value, int | float) else None


# --------------------------------------------------------------------------- messages


async def messages(
    app: App,
    instance: str | None = None,
    query: str | None = None,
    streams: str | None = None,
    range: str | None = "1h",
    from_time: str | None = None,
    to_time: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """The newest messages, every field redacted, with the number matching for "showing N of M"."""
    s = await _scope(app, instance, query, streams, range, from_time, to_time)
    limit, offset = max(1, min(int(limit), MAX_LIMIT)), int(offset)
    if offset < 0 or offset + limit > MAX_WINDOW:
        raise ToolInputError(f"offset + limit can be at most {MAX_WINDOW}; narrow the range or the query instead")
    async with _gate(s.gl):
        mq = MessageQuery(query=s.where(), timerange=s.tr, streams=s.streams, limit=limit, offset=offset)
        page = await s.gl.search(mq)
        total = page.total if page.total is not None else await s.gl.count(s.where(), s.tr, s.streams)
    shaper = app.shaper(s.gl)
    out = s.header()
    out.update(total=total, offset=offset, limit=limit)
    out["messages"] = [shaper.message(m.fields, m.index, m.id, select=["*"]) for m in page.messages]
    return out


# --------------------------------------------------------------------------- traces


async def traces(
    app: App,
    instance: str | None = None,
    query: str | None = None,
    streams: str | None = None,
    range: str | None = "1h",
    from_time: str | None = None,
    to_time: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    """The newest traces: messages, duration (first to last message), worst level, services and first API."""
    s = await _scope(app, instance, query, streams, range, from_time, to_time)
    out = s.header()
    if not s.trace:
        out.update(traces=[], hint=f"none of the trace fields {list(s.gl.cfg.trace_fields)} is in these logs")
        return out
    limit = max(1, min(int(limit), MAX_LIMIT))
    level = "level" if "level" in await s.gl.field_names() and await _numeric(s.gl, "level") else None
    metrics = [COUNT, Metric("min", "timestamp"), Metric("max", "timestamp", sort="desc")]
    if level:
        metrics.append(Metric("min", level))  # syslog: the lower, the worse
    async with _gate(s.gl):
        newest = await s.aggregate(s.where(), [s.trace], limit, metrics)
        rows = [r for r in newest.rows if r.keys and r.keys[0] is not None]
        ids = [r.keys[0] for r in rows]
        within = _any_of(s.trace, ids) if ids else None
        services, endpoints = await asyncio.gather(
            s.aggregate(s.where(within), [s.trace, s.service], max(len(ids), 20), [COUNT])
            if s.service and ids else _nothing(),
            s.aggregate(s.where(within), [s.trace, s.endpoint], max(len(ids), 20), [COUNT, Metric("min", "timestamp")])
            if s.endpoint and ids else _nothing(),
        )  # fmt: skip
    per_service: dict[Any, list[Any]] = {}
    for r in services.rows if services else []:
        if None not in r.keys:
            per_service.setdefault(r.keys[0], []).append(s.redact(s.service, r.keys[1]))
    first_api: dict[Any, tuple[int, Any]] = {}
    for r in endpoints.rows if endpoints else []:
        at = _ms(r.values.get("min(timestamp)"))
        if None not in r.keys and at is not None and (r.keys[0] not in first_api or at < first_api[r.keys[0]][0]):
            first_api[r.keys[0]] = (at, r.keys[1])
    found = []
    for r in rows:
        start, end = _ms(r.values.get("min(timestamp)")), _ms(r.values.get("max(timestamp)"))
        key = r.keys[0]
        found.append({
            "trace": s.redact(s.trace, key),
            "count": int(r.values.get(COUNT.name) or 0),
            "first_ts": start,
            "last_ts": end,
            "duration_ms": end - start if start is not None and end is not None else None,
            "worst_level": r.values.get(f"min({level})") if level else None,
            "services": per_service.get(key, []),
            "first_endpoint": s.redact(s.endpoint, first_api[key][1]) if key in first_api else None,
        })  # fmt: skip
    out["traces"] = found
    return out


async def _numeric(gl: Graylog, field: str) -> bool:
    kind = next((f.get("type") for f in await gl.fields() if f.get("name") == field), None)
    return kind is None or str(kind) in NUMERIC_TYPES


async def trace(
    app: App,
    trace_id: str,
    instance: str | None = None,
    streams: str | None = None,
    range: str | None = "24h",
    from_time: str | None = None,
    to_time: str | None = None,
) -> dict[str, Any]:
    """Every message of one trace, oldest first, with its offset from the first and its service."""
    trace_id = (trace_id or "").strip()
    if not trace_id:
        raise ToolInputError("a trace id is required")
    s = await _scope(app, instance, None, streams, range, from_time, to_time)
    fields = [f for f in s.gl.cfg.trace_fields if f in await s.gl.field_names()] or list(s.gl.cfg.trace_fields)
    query = " OR ".join(f"{escape_field(f)}:{phrase(trace_id)}" for f in fields)
    async with _gate(s.gl):
        mq = MessageQuery(query=query, timerange=s.tr, streams=s.streams, sort_order="asc", limit=MAX_TRACE_MESSAGES)
        page = await s.gl.search(mq)
        total = page.total if page.total is not None else await s.gl.count(query, s.tr, s.streams)
    shaper = app.shaper(s.gl)
    times = [_ms(m.fields.get("timestamp")) for m in page.messages]
    start = next((t for t in times if t is not None), None)
    end = next((t for t in reversed(times) if t is not None), None)
    timeline = []
    for m, t in zip(page.messages, times, strict=True):
        service = next((m.fields[f] for f in s.gl.cfg.service_fields if m.fields.get(f) not in (None, "")), None)
        timeline.append({
            "offset_ms": t - start if t is not None and start is not None else None,
            "service": s.redact(s.service, service),
            **shaper.message(m.fields, m.index, m.id, select=["*"]),
        })  # fmt: skip
    out = s.header()
    out.update(trace=s.redact(s.trace, trace_id), total=total, shown=len(timeline), messages=timeline)
    out["duration_ms"] = end - start if start is not None and end is not None else None
    return out
