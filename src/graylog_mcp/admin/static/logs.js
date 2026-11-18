"use strict";
// The Logs page: request logs per API, traces and messages, read from Graylog through /api/explorer/*.
// Loaded before the page's main script, so it only declares: the main script owns the shared helpers ($, esc, api,
// pathOf, navigate, barChart...) and calls initLogs() once they exist.

const LOG_TABS = ["dashboard", "traces", "all"];
const LOG_RANGES = ["15m", "1h", "4h", "24h", "7d"];
const LOG_EVERY = [0, 30, 60, 300];  // seconds; never more often than every 30 s
const LOG_PAGE = 100;
const LOG_TRACES = 50;  // the traces the explorer lists by default
const LOG_WINDOW = 10000;  // offset + limit the explorer serves (OpenSearch's max_result_window)
const LEVELS = ["emerg", "alert", "crit", "error", "warn", "notice", "info", "debug"];
const LOGS = {
  tab: "dashboard", instance: null, q: "", streams: "", range: "1h", from: "", to: "", trace: null, offset: 0,
  data: {}, err: {}, key: {}, seq: 0, inflight: false, updated: null, timer: null,
  open: new Set(), sort: {key: "count", dir: -1}, slow: null, recent: null,
};

// ------------------------------------------------------------------ the address: /logs/<tab>?instance=&q=&streams=&range= | from=&to=[&trace=][&offset=]
function logsPath() {
  const q = logsQuery();
  if (LOGS.tab === "traces" && LOGS.trace) q.set("trace", LOGS.trace);
  if (LOGS.tab === "all" && LOGS.offset) q.set("offset", String(LOGS.offset));
  return pathOf("logs", [LOGS.tab], q);
}
function syncLogsUrl(how = "push") { if (CURRENT === "logs") navigate(logsPath(), how); }
function applyLogsRoute(r) {
  const q = r.query, tab = r.sub[0] || "dashboard";
  LOGS.tab = LOG_TABS.includes(tab) ? tab : "dashboard";
  LOGS.instance = q.get("instance") || null;
  LOGS.q = q.get("q") || ""; LOGS.streams = q.get("streams") || "";
  LOGS.from = q.get("from") || ""; LOGS.to = q.get("to") || "";
  LOGS.range = LOGS.from && LOGS.to ? "" : (q.get("range") || "1h");
  LOGS.trace = LOGS.tab === "traces" ? q.get("trace") : null;
  LOGS.offset = Math.max(0, parseInt(q.get("offset") || "0", 10) || 0);
  LOGS.open.clear();
}
// what every explorer request and the address share
function logsQuery() {
  const q = new URLSearchParams();
  if (LOGS.instance) q.set("instance", LOGS.instance);
  if (LOGS.q) q.set("q", LOGS.q);
  if (LOGS.streams) q.set("streams", LOGS.streams);
  if (LOGS.from && LOGS.to) { q.set("from", LOGS.from); q.set("to", LOGS.to); } else q.set("range", LOGS.range || "1h");
  return q;
}

// ------------------------------------------------------------------ loading
const logsInstance = () => (STATE ? STATE.instances.find((e) => e.name === LOGS.instance) : null);
function logsSlot() { return LOGS.tab === "traces" ? (LOGS.trace ? "trace" : "traces") : LOGS.tab; }
async function loadLogs(refresh = false) {
  clearTimeout(LOGS.timer);
  if (CURRENT !== "logs" || !STATE) return;
  if (!LOGS.instance) LOGS.instance = (CTX_ENV && STATE.instances.some((e) => e.name === CTX_ENV) ? CTX_ENV : (STATE.instances.find((e) => e.default) || STATE.instances[0] || {}).name) || null;
  renderLogsBar();
  const slot = logsSlot();
  if (!logsInstance()) { renderLogs(); return; }
  const q = logsQuery();
  if (slot === "all") { q.set("offset", String(LOGS.offset)); q.set("limit", String(LOG_PAGE)); }
  const path = {dashboard: "dashboard", traces: "traces", trace: `trace/${encodeURIComponent(LOGS.trace || "")}`, all: "messages"}[slot];
  const key = `${path}?${q}`;
  if (!refresh && LOGS.key[slot] === key && LOGS.data[slot]) { renderLogs(); scheduleLogs(); return; }
  if (refresh && LOGS.inflight) return;  // one request at a time: a slow Graylog is not asked again before it answers
  if (!refresh || LOGS.key[slot] !== key) { LOGS.data[slot] = null; LOGS.err[slot] = ""; }
  LOGS.key[slot] = key; LOGS.inflight = true; renderLogs();
  const seq = ++LOGS.seq;
  if (refresh) q.set("refresh", "1");  // the page's own refreshes are not recorded as Activity
  try {
    const got = await api(`/api/explorer/${path}?${q}`);
    if (seq !== LOGS.seq) return;
    LOGS.data[slot] = got; LOGS.err[slot] = ""; LOGS.updated = new Date();
  } catch (e) {
    if (seq !== LOGS.seq) return;
    if (!refresh) LOGS.data[slot] = null;
    LOGS.err[slot] = e.message;
  } finally { if (seq === LOGS.seq) LOGS.inflight = false; }
  renderLogs();
  scheduleLogs();
}
// the next automatic refresh: only on this page, with the browser tab visible and no row open to read
function scheduleLogs() {
  clearTimeout(LOGS.timer);
  const every = +$("lgEvery").value;
  if (!every || CURRENT !== "logs" || document.visibilityState !== "visible" || LOGS.open.size) return;
  LOGS.timer = setTimeout(() => loadLogs(true), Math.max(30, every) * 1000);
}

// ------------------------------------------------------------------ the bar above the tabs
function renderLogsBar() {
  const insts = STATE ? STATE.instances : [];
  const known = insts.some((e) => e.name === LOGS.instance);
  $("lgEnv").innerHTML = (known || !LOGS.instance ? "" : `<option value="${esc(LOGS.instance)}">${esc(LOGS.instance)} (not in this config)</option>`)
    + insts.map((e) => `<option value="${esc(e.name)}">${esc(label(e))}</option>`).join("");
  $("lgEnv").value = LOGS.instance || "";
  if (document.activeElement !== $("lgQ")) $("lgQ").value = LOGS.q;
  if (document.activeElement !== $("lgStreams")) $("lgStreams").value = LOGS.streams;
  const custom = !!(LOGS.from && LOGS.to);
  $("lgRange").value = custom ? "custom" : (LOG_RANGES.includes(LOGS.range) ? LOGS.range : "1h");
  $("lgCustom").hidden = !custom;
  if (custom) { $("lgFrom").value = localInput(LOGS.from); $("lgTo").value = localInput(LOGS.to); }
  renderFavs();
  const inst = logsInstance(), url = inst && graylogSearchUrl(inst);
  $("lgGraylog").hidden = !url; if (url) $("lgGraylog").href = url;
}
// <input type="datetime-local"> holds local time without a zone
function localInput(iso) {
  const d = new Date(iso); if (isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
// the range the last answer covered, as instants (the server shows it in the instance's zone)
function logsWindow() {
  const d = LOGS.data[logsSlot()];
  const parse = (s) => new Date(String(s).replace(" ", "T"));
  if (d && d.range) { const f = parse(d.range.from), t = parse(d.range.to); if (!isNaN(f) && !isNaN(t)) return [f, t]; }
  if (LOGS.from && LOGS.to) return [new Date(LOGS.from), new Date(LOGS.to)];
  return null;
}
function graylogSearchUrl(inst) {
  const w = logsWindow(); if (!w || !inst.url) return "";
  const base = String(inst.url).replace(/\/+$/, "").replace(/\/api$/, "");
  const q = new URLSearchParams({q: LOGS.q || "", rangetype: "absolute", from: w[0].toISOString(), to: w[1].toISOString()});
  return `${base}/search?${q}`;
}
function submitLogs() {
  LOGS.instance = $("lgEnv").value || null;
  LOGS.q = $("lgQ").value.trim(); LOGS.streams = $("lgStreams").value.trim();
  const r = $("lgRange").value;
  if (r === "custom") {
    const f = new Date($("lgFrom").value), t = new Date($("lgTo").value);
    if (isNaN(f) || isNaN(t) || f >= t) { toast("Pick a start before the end", "fail"); return; }
    Object.assign(LOGS, {from: f.toISOString(), to: t.toISOString(), range: ""});
  } else Object.assign(LOGS, {from: "", to: "", range: r});
  LOGS.offset = 0; LOGS.trace = null; LOGS.open.clear();
  syncLogsUrl("push"); loadLogs();
}
// narrow the query: an extra clause ANDed to it, for a click on a status, an API or an application
function logsDrill(clause, tab) {
  LOGS.q = LOGS.q && LOGS.q !== "*" ? `(${LOGS.q}) AND ${clause}` : clause;
  if (tab) LOGS.tab = tab;
  LOGS.offset = 0; LOGS.trace = null; LOGS.open.clear();
  syncLogsUrl("push"); loadLogs();
}
function logsNarrow(from, to) {
  Object.assign(LOGS, {from: from.toISOString(), to: to.toISOString(), range: "", offset: 0});
  syncLogsUrl("push"); loadLogs();
}
const fmtSpan = (s) => (s < 60 ? `${s} s` : s < 3600 ? `${+(s / 60).toFixed(1)} min` : s < 86400 ? `${+(s / 3600).toFixed(1)} h` : `${+(s / 86400).toFixed(1)} d`);
const fmtLimit = (ms) => (ms >= 1000 ? fmtSpan(ms / 1000) : `${ms} ms`);
const phraseOf = (v) => `"${String(v).replace(/["\\]/g, "\\$&")}"`;
const fieldOf = (f) => String(f).replace(/([+\-!(){}[\]^"~*?:\\/ ]|&&|\|\|)/g, "\\$1");

// ------------------------------------------------------------------ favourites (this browser) and the agent's recent searches
const FAV_KEY = "gm-logs-favs";
function favs() { try { return JSON.parse(gmStore.get(FAV_KEY) || "[]"); } catch (e) { return []; } }
const viewKey = (v) => JSON.stringify([v.instance || "", v.q || "", v.streams || "", v.range || "", v.from || "", v.to || ""]);
const currentView = () => ({instance: LOGS.instance, q: LOGS.q, streams: LOGS.streams, range: LOGS.range, from: LOGS.from, to: LOGS.to, tab: LOGS.tab});
function renderFavs() {
  const list = favs(), cur = viewKey(currentView()), saved = list.some((f) => viewKey(f) === cur);
  $("lgFav").innerHTML = `<option value="">Favourites${list.length ? ` (${list.length})` : ""}</option>${list.map((f, i) => `<option value="${i}">${esc(f.name)}</option>`).join("")}`;
  $("lgFavSave").textContent = saved ? "★ Saved" : "☆ Save view";
  $("lgFavSave").setAttribute("aria-pressed", String(saved));
  $("lgFavSave").title = saved ? "Remove this view from the favourites" : "Keep this view in this browser's favourites";
}
function toggleFav() {
  const list = favs(), cur = viewKey(currentView()), i = list.findIndex((f) => viewKey(f) === cur);
  if (i >= 0) list.splice(i, 1);
  else {
    const name = `${LOGS.q || "every log"} · ${LOGS.range || "fixed range"}${LOGS.instance ? ` · ${LOGS.instance}` : ""}`;
    list.unshift({...currentView(), name: name.slice(0, 80)});
  }
  gmStore.set(FAV_KEY, JSON.stringify(list.slice(0, 30)));
  renderFavs();
}
function openView(v) {
  Object.assign(LOGS, {instance: v.instance || LOGS.instance, q: v.q || "", streams: v.streams || "", range: v.range || "", from: v.from || "", to: v.to || "",
    tab: LOG_TABS.includes(v.tab) ? v.tab : LOGS.tab, trace: v.trace || null, offset: 0});
  if (!(LOGS.from && LOGS.to) && !LOGS.range) LOGS.range = "1h";
  LOGS.open.clear(); syncLogsUrl("push"); loadLogs();
}
const AGENT_TOOLS = ["search_logs", "aggregate", "log_histogram", "error_summary", "compare_periods", "root_cause", "trace_request", "scan"];
async function loadRecent() {
  if (LOGS.recent) return;
  try {
    const u = USAGE || await api("/api/usage?range=24h&source=mcp");
    const seen = new Set();
    LOGS.recent = (u.recent || []).filter((c) => AGENT_TOOLS.includes(c.tool) && c.args && (c.args.query || c.args.trace_id)).map((c) => {
      const a = c.args, v = {instance: c.instance || a.instance || null, q: a.query && a.query !== "*" ? a.query : "", streams: Array.isArray(a.streams) ? a.streams.join(",") : "",
        range: a.range || "", from: a.from_time || "", to: a.to_time || "", tab: a.trace_id ? "traces" : "all", trace: a.trace_id || null};
      if (!(v.from && v.to)) { v.from = ""; v.to = ""; v.range = v.range || "1h"; }
      v.name = `${c.tool}: ${a.trace_id || v.q}`.slice(0, 80);
      return v;
    }).filter((v) => { const k = viewKey(v) + (v.trace || ""); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 12);
  } catch (e) { LOGS.recent = []; }
  $("lgRecent").innerHTML = `<option value="">Recent from the agent${LOGS.recent.length ? ` (${LOGS.recent.length})` : ""}</option>${LOGS.recent.map((v, i) => `<option value="${i}">${esc(v.name)}</option>`).join("")}`;
}

// ------------------------------------------------------------------ the tabs
function renderLogs() {
  if (CURRENT !== "logs") return;
  showLogTab(LOGS.tab, false);
  const slot = logsSlot(), d = LOGS.data[slot], err = LOGS.err[slot];
  const el = $(`lgtab-${LOGS.tab}`);
  $("lgUpdated").textContent = LOGS.updated ? `Updated ${LOGS.updated.toLocaleTimeString()}${LOGS.inflight ? " · loading…" : ""}` : LOGS.inflight ? "loading…" : "";
  const inst = logsInstance(), url = inst && graylogSearchUrl(inst);
  $("lgGraylog").hidden = !url; if (url) $("lgGraylog").href = url;
  if (!STATE) { el.innerHTML = '<div class="skeleton"></div>'; return; }
  if (!inst) {
    el.innerHTML = LOGS.instance
      ? `<div class="banner warn">${ICON.warn}<div class="text">Environment <code>${esc(LOGS.instance)}</code> is not in this admin page's config (${esc(STATE.config_path || "")}). Pick an environment above, or open the admin page of the config that has it.</div></div>`
      : `<div class="inline-msg">No environment yet. <button class="linkbtn" type="button" data-action="add-env">Add one</button> to read its logs.</div>`;
    return;
  }
  if (err && !d) { el.innerHTML = `<div class="banner fail">${ICON.fail}<div class="text">${esc(err)}</div></div>`; return; }
  if (!d) { el.innerHTML = '<div class="skeleton"></div>'; return; }
  const stale = err ? `<div class="inline-msg">The last refresh failed: ${esc(err)}. Showing the previous answer.</div>` : "";
  if (slot === "dashboard") el.innerHTML = stale + dashboardHtml(d);
  else if (slot === "traces") el.innerHTML = stale + tracesHtml(d);
  else if (slot === "trace") el.innerHTML = stale + traceViewHtml(d);
  else el.innerHTML = stale + messagesHtml(d);
  if (slot === "dashboard") drawLogsHistogram(d);
}
const msgCount = (n) => plural(n, "message");
function fieldsNote(d, needs) {
  const missing = needs.filter((f) => !d.fields[f]);
  if (!missing.length) return "";
  const key = {service: "service_fields", endpoint: "endpoint_fields", status: "status_fields", latency: "latency_fields", trace: "trace_fields"};
  return `<div class="inline-msg">No ${missing.map((f) => `${f} field`).join(", ")} found in these logs. Set ${missing.map((f) => `<code>${key[f]}</code>`).join(", ")} on <button class="linkbtn" type="button" data-goto="fields">Log fields</button>.</div>`;
}

// ---- dashboard
const STATUS_PARTS = [
  ["2xx", "var(--chart-ink)", "[200 TO 299]"], ["3xx", "var(--chart-mid)", "[300 TO 399]"], ["4xx", "var(--chart-warn)", "[400 TO 499]"],
  ["5xx", "var(--color-error)", "[500 TO 599]"], ["1xx", "var(--chart-mid)", "[100 TO 199]"], ["other", "var(--chart-error-soft)", null], ["none", "var(--color-paper-3)", null],
];
function dashboardHtml(d) {
  const apps = d.apps ? `<div class="hbars">${d.apps.map((a) => {
    const errs = a.business_errors + a.technical_errors, mx = Math.max(...d.apps.map((x) => x.count), 1);
    return `<div class="hb" title="${esc(`${a.count} messages, ${a.business_errors} business errors, ${a.technical_errors} technical errors`)}">
      <button type="button" class="linkbtn mono truncate" data-app="${esc(a.app)}">${esc(a.app)}</button>
      <span class="track"><span style="width:${Math.max(2, a.count / mx * 100).toFixed(0)}%"></span>${errs ? `<i class="err" style="width:${Math.max(1, errs / mx * 100).toFixed(1)}%"></i>` : ""}</span>
      <span class="v">${num(a.count)}${errs ? ` <b class="bad">${num(errs)}</b>` : ""}</span></div>`;
  }).join("")}</div>` : fieldsNote(d, ["service"]);
  const st = d.status, total = st ? Object.values(st).reduce((a, b) => a + b, 0) : 0;
  const status = st ? (total ? `${donutHtml(STATUS_PARTS.filter(([k]) => st[k]).map(([k, color]) => ({name: k, value: st[k], color})), total, "messages")}
    <div class="seg lgpick" role="group" aria-label="Show one status class">${STATUS_PARTS.filter(([k, , r]) => st[k] && r).map(([k]) => `<button type="button" data-status="${k}">${k}</button>`).join("")}</div>`
    : '<div class="inline-msg">No message in this range.</div>') : fieldsNote(d, ["status"]);
  return `${fieldsNote(d, ["endpoint", "latency"].filter((f) => !d.fields[f] && d.fields.service))}
    <section class="card"><div class="card-head"><h2>Messages</h2><span class="muted small mono">${msgCount(d.total)} · per ${fmtSpan(d.histogram.interval_s)} · errors are technical errors</span><span class="spacer"></span><span class="muted small">click a bar to narrow the range to it</span></div>
      <div id="lgHist"></div></section>
    <div class="dgrid even">
      <section class="card"><div class="card-head"><h2>Applications</h2><span class="muted small">messages, <b class="bad">errors</b> · click one to read its logs</span></div>${apps}</section>
      <section class="card"><div class="card-head"><h2>Status</h2><span class="muted small">${d.fields.status ? `<code>${esc(d.fields.status)}</code> · click a class to keep only it` : ""}</span></div>${status}</section>
    </div>
    <section class="card"><div class="card-head"><h2>By API</h2><span class="muted small">${d.fields.endpoint ? `<code>${esc(d.fields.endpoint)}</code> · click a column to sort, an API or a count to read its logs` : ""}</span><span class="spacer"></span>
      ${d.endpoints && d.fields.latency ? `<label class="check small" for="lgSlow">Slow from</label><select class="sel auto-width" id="lgSlow">${d.slow_ms.map((t) => `<option value="${t}"${String(t) === String(LOGS.slow ?? d.slow_ms[1] ?? d.slow_ms[0]) ? " selected" : ""}>${fmtLimit(t)}</option>`).join("")}</select>` : ""}</div>
      ${d.endpoints ? endpointsHtml(d) : fieldsNote(d, ["endpoint"])}
      <p class="muted small">Business errors: <code>${esc(d.error_queries.business || "not set")}</code> · technical errors: <code>${esc(d.error_queries.technical || "not set")}</code></p></section>`;
}
function drawLogsHistogram(d) {
  const el = $("lgHist"); if (!el || !el.offsetParent) return;
  const w = logsWindow(), step = d.histogram.interval_s * 1000, have = new Map(d.histogram.buckets.map((b) => [b.t, b]));
  const buckets = [];
  if (w) for (let t = Math.floor(w[0] / step) * step; t < +w[1]; t += step) buckets.push(have.get(t) || {t, count: 0, errors: 0});
  else buckets.push(...d.histogram.buckets);
  if (buckets.length > 400) { buckets.length = 0; buckets.push(...d.histogram.buckets); }  // sparse fill only for a sane number of bars
  barChart(el, buckets.map((b) => bucketLabel(b.t / 1000, step >= 6 * 3600000 ? 6 : 1)), [
    {name: "Messages", values: buckets.map((b) => Math.max(0, b.count - b.errors)), color: "var(--chart-ink)"},
    {name: "Technical errors", values: buckets.map((b) => b.errors), color: "var(--color-error)"},
  ], {name: "Messages over time", height: 200, select: {index: null, pick: (i) => { const b = buckets[i]; if (b) logsNarrow(new Date(b.t), new Date(b.t + step)); }}});
}
// only functions in here: this runs before the main script has defined num, fmtMs...
const EP_COLS = [
  ["endpoint", "API", (r) => r.endpoint],
  ["count", "Calls", (r) => r.count, (v) => num(v)],
  ["business_errors", "Business errors", (r) => r.business_errors ?? -1, (v) => (v < 0 ? "-" : num(v))],
  ["technical_errors", "Technical errors", (r) => r.technical_errors, (v) => num(v)],
  ["error_pct", "% errors", (r) => r.error_pct ?? 0, (v) => `${v}%`],
  ["p50", "p50", (r) => latencyOf(r, "p50"), (v) => (v < 0 ? "-" : fmtMs(v))],
  ["p95", "p95", (r) => latencyOf(r, "p95"), (v) => (v < 0 ? "-" : fmtMs(v))],
  ["p99", "p99", (r) => latencyOf(r, "p99"), (v) => (v < 0 ? "-" : fmtMs(v))],
  ["slow", "Slow", (r) => (r.slow || {})[String(LOGS.slow)] ?? -1, (v) => (v < 0 ? "-" : num(v))],
  ["last_ts", "Last", (r) => r.last_ts || 0, (v) => (v ? timeAgo(v / 1000) : "-")],
];
const latencyOf = (r, p) => (r.latency_ms && r.latency_ms[p] != null ? Math.round(r.latency_ms[p]) : -1);
function endpointsHtml(d) {
  const e = d.endpoints;
  if (LOGS.slow == null || !d.slow_ms.map(String).includes(String(LOGS.slow))) LOGS.slow = d.slow_ms[1] ?? d.slow_ms[0];
  if (!e.rows.length) return '<div class="allclear">// no message with an API in this range</div>';
  const cols = EP_COLS.filter(([k]) => d.fields.latency || !["p50", "p95", "p99", "slow"].includes(k));
  const col = cols.find((c) => c[0] === LOGS.sort.key) || cols[1];
  const rows = [...e.rows].sort((a, b) => { const x = col[2](a), y = col[2](b); return (typeof x === "string" ? x.localeCompare(y) : x - y) * LOGS.sort.dir || b.count - a.count; });
  const sortOf = (k) => (k === col[0] ? (LOGS.sort.dir < 0 ? "descending" : "ascending") : "none");
  const drill = {count: null, business_errors: d.error_queries.business, technical_errors: d.error_queries.technical};
  return `<div class="table-wrap"><table class="ttable"><thead><tr>${cols.map(([k, h], i) => `<th aria-sort="${sortOf(k)}"${i ? ' class="num"' : ""}><button type="button" class="sorth" data-sort="${k}">${esc(h)}${k === "slow" ? ` ≥ ${fmtLimit(LOGS.slow)}` : ""}<span aria-hidden="true">${k === col[0] ? (LOGS.sort.dir < 0 ? " ↓" : " ↑") : ""}</span></button></th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${cols.map(([k, , val, fmt], i) => {
      const v = val(r);
      if (!i) return `<td><button type="button" class="linkbtn" data-api="${esc(r.endpoint)}" title="Read the logs of ${esc(r.endpoint)}">${esc(r.endpoint)}</button></td>`;
      const cls = (k === "technical_errors" || k === "error_pct") && v > 0 ? " bad" : (k === "business_errors" || k === "slow") && v > 0 ? " warn" : "";
      const shown = fmt(v), link = k in drill && v > 0 && (k === "count" || drill[k]);
      return `<td class="num${cls}"${k === "last_ts" && v ? ` title="${esc(new Date(v).toLocaleString())}"` : ""}>${link ? `<button type="button" class="linkbtn" data-api="${esc(r.endpoint)}" data-errs="${k}">${shown}</button>` : shown}</td>`;
    }).join("")}</tr>`).join("")}</tbody></table></div>
    <div class="cmeta"><span>Top ${num(e.rows.length)} APIs by calls · ${num(e.covered)} of ${msgCount(d.total)}${e.more ? " · more APIs are not shown" : ""}${e.without_field ? ` · ${num(e.without_field)} without an API` : ""}</span></div>`;
}

// ---- traces
const levelName = (l) => (typeof l === "number" && LEVELS[l] ? LEVELS[l] : l == null ? "-" : String(l));
const levelBadge = (l) => `<span class="badge${typeof l === "number" ? (l <= 3 ? " fail" : l === 4 ? " warn" : "") : ""}">${esc(levelName(l))}</span>`;
function tracesHtml(d) {
  if (!d.fields.trace) return fieldsNote(d, ["trace"]);
  if (!d.traces.length) return '<div class="allclear">// no trace in this range</div>';
  return `<div class="table-wrap"><table class="convtable"><thead><tr><th>Last message</th><th class="num">Duration</th><th class="num">Messages</th><th>Services</th><th>Worst level</th><th>First API</th><th>Trace</th></tr></thead>
    <tbody>${d.traces.map((t) => `<tr class="go" tabindex="0" data-trace="${esc(t.trace)}" aria-label="${esc(`Trace ${t.trace}, ${msgCount(t.count)}`)}">
      <td class="mono" title="${esc(`from ${new Date(t.first_ts).toLocaleString()} to ${new Date(t.last_ts).toLocaleString()}`)}">${esc(new Date(t.last_ts).toLocaleTimeString())}</td><td class="num mono">${t.duration_ms == null ? "-" : fmtDur(t.duration_ms / 1000)}</td>
      <td class="num mono">${num(t.count)}</td><td>${esc((t.services || []).join(", ") || "-")}</td><td>${levelBadge(t.worst_level)}</td>
      <td class="mono">${esc(t.first_endpoint || "-")}</td><td class="mono muted truncate" style="max-width:14rem">${esc(t.trace)}</td></tr>`).join("")}</tbody></table></div>
    <div class="cmeta"><span>The newest ${num(d.traces.length)} traces in the range${d.traces.length >= LOG_TRACES ? "; narrow the range or the query for older ones" : ""}</span></div>`;
}
function traceViewHtml(d) {
  return `<div class="dhead"><button class="btn sm ghost" type="button" data-back>← Traces</button><h2 class="mono truncate">${esc(d.trace)}</h2></div>${traceTimelineHtml(d, LOGS.open)}`;
}
// One trace's messages in time order, a row per message with its place on the trace's span. Takes the answer of
// /api/explorer/trace/<id> and the keys of the rows to show open, so other screens can show a request the same way.
function traceTimelineHtml(d, open = new Set()) {
  if (!d.messages || !d.messages.length) return '<div class="allclear">// no message of this trace in the range</div>';
  const span = Math.max(1, d.duration_ms || 0), services = [...new Set(d.messages.map((m) => m.service || "-"))];
  const head = `<div class="cmeta"><span>${msgCount(d.total)}${d.shown < d.total ? `, the first ${num(d.shown)} shown` : ""}${d.duration_ms == null ? "" : ` · ${fmtDur(d.duration_ms / 1000)}`} ·${plural(services.length, "service")}: ${esc(services.join(", "))}</span></div>`;
  return head + `<div class="tline">${d.messages.map((m, i) => {
    const key = m.ref || `i${i}`, isOpen = open.has(key), left = 100 * (m.offset_ms || 0) / span, bad = typeof m.level === "number" && m.level <= 3;
    return `<div class="tcall${isOpen ? " open" : ""}" tabindex="0" role="button" aria-expanded="${isOpen}" data-key="${esc(key)}">
      <div class="tc-head lgt"><span class="mono muted num">+${fmtDur((m.offset_ms || 0) / 1000)}</span><span class="ctool truncate">${esc(m.service || "-")}</span><span class="cwhat">${esc(firstLine(m.message))}</span>
        <span class="cst">${levelBadge(m.level)}</span><span class="tbar"><span class="${bad ? "bad" : ""}" style="left:${Math.min(99.4, left).toFixed(2)}%;width:0.6%"></span></span></div>
      ${isOpen ? `<div class="tc-det">${messageDetailHtml(m)}</div>` : ""}</div>`;
  }).join("")}</div>`;
}

// ---- every message
const firstLine = (s) => String(s ?? "").split("\n", 1)[0];
function messageDetailHtml(m) {
  const text = String(m.full_message || m.message || ""), lines = text.split("\n");
  const rest = {...m}; delete rest.full_message;
  const stack = lines.length > 1 ? `<details class="lgstack"><summary>${esc(lines[0])} <span class="muted">· ${plural(lines.length - 1, "more line")}</span></summary><pre class="json">${markMasks(esc(lines.slice(1).join("\n")))}</pre></details>` : "";
  return `<div class="lgwrap">${stack}<div class="tree">${treeHtml(rest, null, 0)}</div></div>`;
}
function messagesHtml(d) {
  if (!d.messages.length) return `<div class="allclear">// no message matches in this range</div>${logsFooter(d)}`;
  const svc = d.fields.service;
  return `<div class="table-wrap"><table class="convtable lgmsgs"><thead><tr><th>Time</th><th>Level</th><th>${esc(svc || "source")}</th><th>Message</th></tr></thead><tbody>${d.messages.map((m, i) => {
    const key = m.ref || `i${i}`, isOpen = LOGS.open.has(key), lines = String(m.message ?? "").split("\n").length;
    return `<tr class="go${isOpen ? " open" : ""}" tabindex="0" data-key="${esc(key)}" aria-expanded="${isOpen}"><td class="mono">${esc(String(m.ts || "").slice(11, 23))}</td><td>${levelBadge(m.level)}</td>
      <td class="mono">${esc((svc && m[svc]) || m.source || "-")}</td><td class="lgmsg">${markMasks(esc(firstLine(m.message)))}${lines > 1 ? ` <span class="badge" title="Open the row to see the rest">+${lines - 1} lines</span>` : ""}</td></tr>
      ${isOpen ? `<tr class="lgdet"><td colspan="4">${messageDetailHtml(m)}</td></tr>` : ""}`;
  }).join("")}</tbody></table></div>${logsFooter(d)}`;
}
function logsFooter(d) {
  const shown = d.messages.length, end = d.offset + shown, more = end < d.total, capped = d.total > LOG_WINDOW;
  return `<div class="cmeta lgfoot"><span>Loaded ${num(d.offset + (shown ? 1 : 0))}–${num(end)} of ${msgCount(d.total)} in the selected range.${capped ? ` Only the newest ${num(LOG_WINDOW)} can be paged: to see further, narrow the range or add words to the query.` : ""}</span><span class="spacer"></span>
    <button class="btn sm ghost" type="button" data-pg="-1"${d.offset ? "" : " disabled"}>← Newer</button>
    <button class="btn sm ghost" type="button" data-pg="1"${more && end + LOG_PAGE <= LOG_WINDOW ? "" : " disabled"}>Older →</button>
    <button class="btn sm" type="button" data-narrow title="Keep the newest half of the range">Narrow the range</button></div>`;
}

// ------------------------------------------------------------------ events
let showLogTab = null;
function setLogTab(t, focus = false) {
  LOGS.tab = LOG_TABS.includes(t) ? t : "dashboard";
  if (LOGS.tab !== "traces") LOGS.trace = null;
  LOGS.open.clear();
  showLogTab(LOGS.tab, focus); syncLogsUrl("push"); loadLogs();
}
function toggleLogRow(key) {
  if (LOGS.open.has(key)) LOGS.open.delete(key); else LOGS.open.add(key);
  renderLogs(); scheduleLogs();  // an open row pauses the refresh, so it does not move under the reader
  document.querySelector(`#page-logs-body [data-key="${CSS.escape(key)}"]`)?.focus();
}
function initLogs() {
  showLogTab = tabList("lgTabs", LOG_TABS, (t, focus) => setLogTab(t, focus), "lgtab-");
  $("lgRange").innerHTML = LOG_RANGES.map((r) => `<option value="${r}">last ${r}</option>`).join("") + '<option value="custom">from … to …</option>';
  $("lgEvery").innerHTML = LOG_EVERY.map((s) => `<option value="${s}">${s ? `every ${s < 60 ? `${s} s` : `${s / 60} min`}` : "Auto refresh off"}</option>`).join("");
  const every = gmStore.get("gm-logs-every");
  $("lgEvery").value = every && LOG_EVERY.includes(+every) ? every : "0";
  $("lgEvery").addEventListener("change", (e) => { gmStore.set("gm-logs-every", e.target.value); scheduleLogs(); });
  $("lgRange").addEventListener("change", (e) => {
    $("lgCustom").hidden = e.target.value !== "custom";
    if (e.target.value === "custom") {
      const w = logsWindow() || [new Date(Date.now() - 3600000), new Date()];
      $("lgFrom").value = localInput(w[0].toISOString()); $("lgTo").value = localInput(w[1].toISOString()); $("lgFrom").focus();
    } else submitLogs();
  });
  $("lgForm").addEventListener("submit", (e) => { e.preventDefault(); submitLogs(); });
  $("lgEnv").addEventListener("change", submitLogs);
  $("lgRefresh").addEventListener("click", (e) => busy(e.currentTarget, () => loadLogs(true)));
  $("lgFavSave").addEventListener("click", toggleFav);
  $("lgFav").addEventListener("change", (e) => { const v = favs()[+e.target.value]; e.target.value = ""; if (v && e.target.selectedIndex >= 0) openView(v); });
  $("lgRecent").addEventListener("focus", loadRecent);
  $("lgRecent").addEventListener("pointerdown", loadRecent);
  $("lgRecent").addEventListener("change", (e) => { const v = (LOGS.recent || [])[+e.target.value]; e.target.value = ""; if (v) openView(v); });
  const body = $("page-logs-body");
  body.addEventListener("click", (e) => {
    const t = e.target;
    const s = t.closest("[data-status]"); if (s) { const p = STATUS_PARTS.find(([k]) => k === s.dataset.status), f = LOGS.data.dashboard?.fields.status; if (p && f) logsDrill(`${fieldOf(f)}:${p[2]}`); return; }
    const app = t.closest("[data-app]"); if (app) { const f = LOGS.data.dashboard?.fields.service; if (f) logsDrill(`${fieldOf(f)}:${phraseOf(app.dataset.app)}`, "all"); return; }
    const a = t.closest("[data-api]");
    if (a) {
      const d = LOGS.data.dashboard, f = d?.fields.endpoint; if (!f) return;
      const extra = {business_errors: d.error_queries.business, technical_errors: d.error_queries.technical}[a.dataset.errs];
      logsDrill(`${fieldOf(f)}:${phraseOf(a.dataset.api)}${extra ? ` AND (${extra})` : ""}`, "all"); return;
    }
    const so = t.closest("[data-sort]");
    if (so) {
      const k = so.dataset.sort;
      if (LOGS.sort.key === k) LOGS.sort.dir = -LOGS.sort.dir; else Object.assign(LOGS.sort, {key: k, dir: k === "endpoint" ? 1 : -1});
      renderLogs(); $("page-logs-body").querySelector(`[data-sort="${k}"]`)?.focus(); return;
    }
    const tr = t.closest("[data-trace]"); if (tr) { LOGS.trace = tr.dataset.trace; LOGS.open.clear(); syncLogsUrl("push"); loadLogs(); return; }
    if (t.closest("[data-back]")) { LOGS.trace = null; LOGS.open.clear(); syncLogsUrl("push"); loadLogs(); return; }
    const pg = t.closest("[data-pg]");
    if (pg) { LOGS.offset = Math.max(0, LOGS.offset + (+pg.dataset.pg) * LOG_PAGE); LOGS.open.clear(); syncLogsUrl("push"); loadLogs(); body.scrollIntoView({block: "start"}); return; }
    if (t.closest("[data-narrow]")) { const w = logsWindow(); if (w) logsNarrow(new Date((+w[0] + +w[1]) / 2), w[1]); return; }
    if (t.closest(".tc-det, .lgdet")) return;  // selecting text in an open row does not close it
    const row = t.closest("[data-key]"); if (row) toggleLogRow(row.dataset.key);
  });
  body.addEventListener("change", (e) => { if (e.target.id === "lgSlow") { LOGS.slow = +e.target.value; renderLogs(); } });
  body.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tr = e.target.closest("tr[data-trace]"); if (tr && e.target === tr) { e.preventDefault(); tr.click(); return; }
    if (e.target.matches("[data-key]")) { e.preventDefault(); toggleLogRow(e.target.dataset.key); }
  });
  onKey((e, k) => { if (k === "escape" && LOGS.trace) { e.preventDefault(); LOGS.trace = null; syncLogsUrl("push"); loadLogs(); } }, () => CURRENT === "logs");
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") scheduleLogs(); else clearTimeout(LOGS.timer); });
  window.addEventListener("resize", () => { if (CURRENT === "logs" && LOGS.tab === "dashboard" && LOGS.data.dashboard) drawLogsHistogram(LOGS.data.dashboard); });
}
