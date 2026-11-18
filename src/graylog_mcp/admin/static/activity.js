"use strict";
// The Activity page's Dashboard and Conversations tabs, and the links between its tabs.
// Loaded before the page's main script, so it only declares: the main script owns the shared helpers ($, esc, api,
// showPage...) and calls what is here once they exist.

// ------------------------------------------------------------------ conversations and links
const utcDay = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
// the server groups the calls of earlier versions, which have no conversation, by day (usage_conversations)
const conversationOf = (c) => c.conversation || `legacy-${utcDay(c.ts)}`;
const convShort = (id) => (id === "playground" || id.startsWith("legacy-") ? id : id.slice(0, 6));
const convHref = (id, query) => pathOf("activity", ["conversations", id], query);
function callHref(c) {
  const q = new URLSearchParams();
  if (c.call_id) q.set("call", c.call_id); else q.set("at", String(Math.round(c.ts * 1000)));
  return convHref(conversationOf(c), q);
}
const STATUS_CLASS = {ok: "ok", running: "info", cancelled: "warn", interrupted: "warn", refused: "fail", error: "fail"};
const STATUS_WHY = {
  running: "still running", cancelled: "the client stopped waiting for it", interrupted: "its server stopped before it ended",
  refused: "refused before it ran", error: "failed",
};
const statusOf = (c) => c.status || (c.ok ? "ok" : "error");
const statusBadge = (s) => `<span class="badge ${STATUS_CLASS[s] || "fail"}" title="${esc(STATUS_WHY[s] || "")}">${esc(s)}</span>`;
function fmtDur(s) {
  s = Math.max(0, s);
  return s < 1 ? `${Math.round(s * 1000)}ms` : s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.round(s / 60 % 60)}m`;
}
const toolAbbr = (t) => String(t).split("_").map((w) => w[0] || "").join("").slice(0, 3);

// ------------------------------------------------------------------ dashboard
function donutHtml(parts, total) {
  const r = 42, c = 2 * Math.PI * r;
  let at = 0;
  const arcs = parts.filter((p) => p.value > 0).map((p) => {
    const len = c * p.value / total, arc = `<circle r="${r}" cx="60" cy="60" fill="none" stroke="${p.color}" stroke-width="16"
      stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-at).toFixed(2)}" transform="rotate(-90 60 60)"/>`;
    at += len; return arc;
  }).join("");
  const label = parts.map((p) => `${p.value} ${p.name.toLowerCase()}`).join(", ");
  return `<div class="donut"><svg viewBox="0 0 120 120" width="132" height="132" role="img" aria-label="${esc(`${total} calls: ${label}`)}">
    <circle r="${r}" cx="60" cy="60" fill="none" stroke="var(--color-paper-3)" stroke-width="16"/>${arcs}
    <text x="60" y="58" text-anchor="middle" class="dn">${esc(short(total))}</text><text x="60" y="74" text-anchor="middle" class="dl">calls</text></svg>
    <ul class="dlegend">${parts.map((p) => `<li><i style="background:${p.color}"></i><span>${esc(p.name)}</span><b>${num(p.value)}</b><span class="muted">${total ? Math.round(100 * p.value / total) : 0}%</span></li>`).join("")}</ul></div>`;
}
function renderActDashboard(u) {
  const t = u.totals, found = Math.max(0, t.calls - t.misses - t.errors);
  $("actDonut").innerHTML = t.calls ? donutHtml([
    {name: "Found something", value: found, color: "var(--chart-ink)"},
    {name: "Found nothing", value: t.misses, color: "var(--chart-warn)"},
    {name: "Error", value: t.errors, color: "var(--color-error)"},
  ], t.calls) : '<div class="inline-msg">No call in this range yet.</div>';
  hbars($("actEnvs"), (u.instances || []).map((i) => ({label: i.instance || "(default)", value: i.calls,
    title: `${i.calls} calls, ${i.misses} found nothing, ${i.errors} errors`})), "No call in this range yet.");
  renderToolTable(u);
}

// the columns of the tool table: [key, heading, value of a row, how to show it]. Only functions here: this runs before
// the main script has defined its helpers (num, fmtMs...).
const count = (v) => num(v);
const TOOL_COLS = [
  ["tool", "Tool", (t) => t.tool],
  ["calls", "Calls", (t) => t.calls, count],
  ["misses", "Found nothing", (t) => t.misses, count],
  ["errors", "Errors", (t) => t.errors, count],
  ["err_pct", "% errors", (t) => (t.calls ? t.errors / t.calls : 0), (v) => `${Math.round(100 * v)}%`],
  ["truncated", "Cut", (t) => t.truncated || 0, count],
  ["p50_ms", "Median", (t) => t.p50_ms, (v) => (v ? fmtMs(v) : "-")],
  ["p95_ms", "p95", (t) => t.p95_ms, (v) => (v ? fmtMs(v) : "-")],
  ["slow", "Slow", (t) => (t.slow || {})[$("slowMs").value] || 0, count],
  ["last_ts", "Last", (t) => t.last_ts || 0, (v) => (v ? timeAgo(v) : "-")],
];
const TOOL_SORT = {key: "errors", dir: -1};  // the failing tools first
function renderToolTable(u) {
  const el = $("toolTable");
  if (!u.tools.length) { el.innerHTML = '<div class="allclear">// no tool called in this range yet</div>'; return; }
  const col = TOOL_COLS.find((c) => c[0] === TOOL_SORT.key) || TOOL_COLS[3];
  const rows = [...u.tools].sort((a, b) => {
    const x = col[2](a), y = col[2](b);
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * TOOL_SORT.dir || b.calls - a.calls;
  });
  const sortOf = (k) => (k === TOOL_SORT.key ? (TOOL_SORT.dir < 0 ? "descending" : "ascending") : "none");
  el.innerHTML = `<div class="table-wrap"><table class="ttable"><thead><tr>${TOOL_COLS.map(([k, h], i) => `<th aria-sort="${sortOf(k)}"${i ? ' class="num"' : ""}>
    <button type="button" class="sorth" data-sort="${k}">${esc(h)}${k === "slow" ? ` ≥ ${esc($("slowMs").selectedOptions[0].text)}` : ""}<span aria-hidden="true">${k === TOOL_SORT.key ? (TOOL_SORT.dir < 0 ? " ↓" : " ↑") : ""}</span></button></th>`).join("")}</tr></thead>
    <tbody>${rows.map((t) => `<tr>${TOOL_COLS.map(([k, , val, fmt], i) => {
      const v = val(t), bad = (k === "errors" || k === "err_pct") && v > 0, warn = (k === "misses" || k === "slow" || k === "truncated") && v > 0;
      return i ? `<td class="num${bad ? " bad" : warn ? " warn" : ""}"${k === "last_ts" && v ? ` title="${esc(new Date(v * 1000).toLocaleString())}"` : ""}>${fmt(v)}</td>`
        : `<td><button type="button" class="linkbtn tn" data-tool="${esc(t.tool)}" title="List the calls of ${esc(t.tool)}">${esc(t.tool)}</button></td>`;
    }).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function initActivityDashboard() {
  $("toolTable").addEventListener("click", (e) => {
    const s = e.target.closest("[data-sort]");
    if (s) {
      const k = s.dataset.sort;
      if (TOOL_SORT.key === k) TOOL_SORT.dir = -TOOL_SORT.dir; else Object.assign(TOOL_SORT, {key: k, dir: k === "tool" ? 1 : -1});
      if (USAGE) renderToolTable(USAGE);
      $("toolTable").querySelector(`[data-sort="${k}"]`)?.focus();
      return;
    }
    const b = e.target.closest("[data-tool]"); if (b) listCallsOf(b.dataset.tool);
  });
  $("slowMs").addEventListener("change", () => { if (USAGE) renderToolTable(USAGE); });
}
function listCallsOf(tool) { CALL_F.tool = tool; setTab("calls"); renderActivity(); }

// ------------------------------------------------------------------ conversations: the list
const CONV = {range: "7d", q: "", status: "all", id: null, turn: null, call: null, at: null,
  list: null, listKey: null, listErr: "", detail: null, detailErr: "", timer: null, open: new Set()};
const convSource = () => (CALL_F.playground ? "all" : "mcp");
async function loadConversations(force = false) {
  const q = new URLSearchParams({range: CONV.range, source: convSource()});
  if (CONV.q) q.set("q", CONV.q);
  if (CTX_ENV) q.set("instance", CTX_ENV);
  const key = q.toString();
  if (!force && CONV.listKey === key && CONV.list) { renderConversations(); return; }
  CONV.list = null; CONV.listErr = ""; CONV.listKey = key; renderConversations();
  try { const got = await api(`/api/conversations?${key}`); if (CONV.listKey === key) CONV.list = got; }
  catch (e) { if (CONV.listKey === key) CONV.listErr = e.message; }
  renderConversations();
}
function turnMatches(t) {
  return CONV.status === "all" || (CONV.status === "error" ? t.errors > 0 : CONV.status === "nothing" ? t.misses > 0 : t.running > 0);
}
function toolsHtml(tools) {
  const shown = tools.slice(0, 14);
  return `<span class="tchips">${shown.map((t) => `<abbr class="tchip" title="${esc(t)}">${esc(toolAbbr(t))}</abbr>`).join("")}${tools.length > shown.length ? `<span class="muted">+${tools.length - shown.length}</span>` : ""}</span>`;
}
function turnRowHtml(t, i) {
  const cold = t.tier === "cold", flags = [];
  if (t.running) flags.push(statusBadge("running"));
  if (t.errors) flags.push(`<span class="badge fail">${num(t.errors)} ${t.errors === 1 ? "error" : "errors"}</span>`);
  if (t.misses) flags.push(`<span class="badge warn">${num(t.misses)} found nothing</span>`);
  if (t.truncated) flags.push(`<span class="badge" title="Results cut to the size budget">${num(t.truncated)} cut</span>`);
  if (cold) flags.push('<span class="badge" title="Only a summary of these calls is kept">summary</span>');
  else if (t.tier === "summary") flags.push('<span class="badge" title="Previews and requests are no longer kept for this turn">no detail</span>');
  return `<tr class="go" tabindex="0" data-i="${i}" aria-label="${esc(`${convShort(t.conversation)}, ${new Date(t.last_ts * 1000).toLocaleString()}, ${plural(t.calls, "call")}`)}">
    <td class="mono" title="${esc(new Date(t.first_ts * 1000).toLocaleString())}">${cold ? esc(new Date(t.last_ts * 1000).toLocaleDateString()) : whenShort(t.first_ts)}</td>
    <td class="num mono">${cold ? "-" : fmtDur(t.last_ts - t.first_ts)}</td>
    <td class="mono"><span class="cid">${esc(convShort(t.conversation))}</span></td>
    <td>${esc(t.repo || "-")}</td><td>${esc((t.instances || []).join(", ") || "-")}</td><td>${esc(t.client || "-")}</td>
    <td class="num mono">${t.agents ? num(t.agents) : "-"}</td><td class="num mono">${num(t.calls)}</td>
    <td><span class="flags">${flags.join("")}</span></td><td>${toolsHtml(t.tools || [])}</td></tr>`;
}
let CONV_ROWS = [];
function renderConversations() {
  const list = $("clist"), L = CONV.list;
  $("cq").value !== CONV.q && document.activeElement !== $("cq") && ($("cq").value = CONV.q);
  $("crange").value = CONV.range;
  document.querySelectorAll("#cstat button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.st === CONV.status)));
  if (!L) { list.innerHTML = CONV.listErr ? `<div class="inline-msg">Could not load the conversations: ${esc(CONV.listErr)}.</div>` : '<div class="skeleton"></div>'; $("ccount").textContent = ""; return; }
  CONV_ROWS = L.turns.filter(turnMatches);
  $("nConvs").textContent = L.total;
  $("ccount").textContent = `Showing ${num(CONV_ROWS.length)} of ${num(L.total)} turns${L.total > L.turns.length ? ` · the latest ${L.turns.length} are listed` : ""}`;
  if (!CONV_ROWS.length) {
    list.innerHTML = `<div class="allclear">${!L.enabled ? "// recording is off" : L.turns.length ? "// no turn matches these filters" : "// no conversation in this range yet"}</div>`;
    return;
  }
  list.innerHTML = `<div class="table-wrap"><table class="convtable"><thead><tr><th>When</th><th class="num">Took</th><th>Conversation</th><th>Repository</th><th>Environment</th><th>Client</th>
    <th class="num">Agents</th><th class="num">Calls</th><th>Outcome</th><th>Tools</th></tr></thead><tbody>${CONV_ROWS.map(turnRowHtml).join("")}</tbody></table></div>`;
}
function openTurnRow(row) {
  const t = CONV_ROWS[+row.dataset.i]; if (!t) return;
  openConversation(t.conversation, t.turn, null, null);
}
function moveTurn(d) {
  const rows = [...document.querySelectorAll(CONV.id ? "#convDetail .tcall" : "#clist tr.go")]; if (!rows.length) return;
  const cur = rows.indexOf(document.activeElement);
  const n = cur < 0 ? (d > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, cur + d));
  rows[n].focus(); rows[n].scrollIntoView({block: "nearest"});
}

// ------------------------------------------------------------------ conversations: one of them
function openConversation(id, turn, call, at, how = "push") {
  Object.assign(CONV, {id, turn, call, at, detail: null, detailErr: "", reveal: !!(call || at)});
  CONV.open = new Set(call || at ? [call || `at:${at}`] : []);
  ACT_TAB = "conversations";
  syncActivityUrl(how);
  renderActivityTab();  // shows the tab and loads the conversation
}
function closeConversation(how = "push") {
  Object.assign(CONV, {id: null, turn: null, call: null, at: null, detail: null});
  clearTimeout(CONV.timer);
  syncActivityUrl(how);
  renderConversationView();
  loadConversations();
}
async function loadConversationDetail() {
  clearTimeout(CONV.timer);
  const id = CONV.id; if (!id) return;
  try {
    const got = await api(`/api/conversations/${encodeURIComponent(id)}${CONV.turn ? `?turn=${encodeURIComponent(CONV.turn)}` : ""}`);
    if (CONV.id !== id) return;
    CONV.detail = got; CONV.detailErr = "";
  } catch (e) { if (CONV.id !== id) return; CONV.detail = null; CONV.detailErr = e.message; }
  renderConversationDetail();
  if (CONV.reveal) {  // opened from a link to one call: show it, once (not again on each refresh)
    CONV.reveal = false;
    const row = document.querySelector("#convDetail .tcall.open");
    if (row) { row.scrollIntoView({block: "center"}); row.focus({preventScroll: true}); }
  }
  scheduleConversationRefresh();
}
// a turn with a call still running is read again every 5 seconds, while this tab is on screen
function scheduleConversationRefresh() {
  clearTimeout(CONV.timer);
  const running = CONV.detail && CONV.detail.turns.some((t) => t.running);
  if (running && document.visibilityState === "visible" && CURRENT === "activity" && ACT_TAB === "conversations" && CONV.id) {
    CONV.timer = setTimeout(() => loadConversationDetail(), 5000);
  }
}
function renderConversationView() {
  $("convList").hidden = !!CONV.id; $("convDetail").hidden = !CONV.id;
  if (CONV.id) renderConversationDetail(); else renderConversations();
}
const callKey = (c) => c.call_id || `at:${Math.round(c.ts * 1000)}`;
function agentName(c, types) {
  if (!c.agent) return "main agent";
  return `${types[c.agent] || "subagent"} · ${c.agent.slice(0, 6)}`;
}
function renderConversationDetail() {
  const el = $("convDetail"), d = CONV.detail, id = CONV.id;
  const head = `<div class="dhead"><button class="btn sm ghost" type="button" data-back>← Conversations</button>
    <h2 class="mono">${esc(convShort(id))}${CONV.turn ? '<span class="muted small"> · one turn</span>' : ""}</h2><span class="spacer"></span>
    ${CONV.turn ? '<button class="btn sm ghost" type="button" data-whole>Whole conversation</button>' : ""}
    <button class="btn sm" type="button" data-export${d ? "" : " disabled"}>Download JSON</button></div>`;
  if (!d) { el.innerHTML = head + (CONV.detailErr ? `<div class="inline-msg">${esc(CONV.detailErr)}</div>` : '<div class="skeleton"></div>'); return; }
  const now = Date.now() / 1000;
  const turns = d.turns.map((t, k) => turnHtml(t, k, now)).join("");
  const cold = d.cold ? `<section class="card"><div class="card-head"><h2>Older turns, as a summary</h2></div>
    <p class="muted small">Calls older than ${d.detail_days} days are folded into one line per conversation: ${plural(d.cold.calls, "call")}, ${plural(d.cold.errors, "error")},
    ${d.cold.misses} found nothing, from ${esc(new Date(d.cold.first_ts * 1000).toLocaleString())} to ${esc(new Date(d.cold.last_ts * 1000).toLocaleString())}.</p>
    ${toolsHtml(d.cold.tools || [])}</section>` : "";
  el.innerHTML = head + (turns || cold ? turns + cold : '<div class="allclear">// nothing of this conversation is kept</div>');
}
function turnHtml(t, k, now) {
  const start = t.first_ts, end = Math.max(t.last_ts, t.running ? now : 0), span = Math.max(0.001, end - start);
  const types = {}; t.calls.forEach((c) => { if (c.agent && c.agent_type) types[c.agent] = c.agent_type; });
  const groups = new Map();
  for (const c of t.calls) { const g = agentName(c, types); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); }
  const byAgent = groups.size > 1 || t.calls.some((c) => c.agent);
  const rows = [...groups].map(([name, calls]) => (byAgent ? `<div class="agent glabel">${esc(name)}</div>` : "") + calls.map((c) => callRowHtml(c, start, span, now)).join("")).join("");
  const meta = [whenShort(start), fmtDur(t.last_ts - start), plural(t.calls.length, "call"), t.repo, (t.instances || []).join(", "), t.client].filter(Boolean);
  return `<section class="card turn"><div class="card-head"><h2>Turn ${k + 1}</h2><span class="muted small mono">${esc(meta.join(" · "))}</span><span class="spacer"></span>
    ${t.tier === "summary" ? '<span class="badge" title="Previews and requests are no longer kept">requests summed up</span>' : ""}
    ${CONV.turn ? "" : `<a class="small" href="${esc(convHref(t.conversation, new URLSearchParams({turn: t.turn})))}" data-turnlink="${esc(t.turn)}">Link to this turn</a>`}</div>
    <div class="tline">${rows}</div></section>`;
}
function callRowHtml(c, start, span, now) {
  const s = statusOf(c), ends = s === "running" ? now : c.ts + (c.ms || 0) / 1000;
  const left = 100 * (c.ts - start) / span, width = Math.max(0.4, 100 * (ends - c.ts) / span), key = callKey(c), open = CONV.open.has(key);
  return `<div class="tcall${open ? " open" : ""}" tabindex="0" role="button" aria-expanded="${open}" data-key="${esc(key)}">
    <div class="tc-head"><span class="mono muted">${c.seq ?? ""}</span><span class="ctool">${esc(c.tool)}</span><span class="cwhat" title="${esc(askText(c))}">${esc(askText(c))}</span>
      <span class="cst">${statusBadge(s)}${isMissCall(c) ? '<span class="badge warn">found nothing</span>' : ""}${c.truncated ? '<span class="badge">cut</span>' : ""}</span>
      <span class="tbar"><span class="${s === "running" ? "run" : s === "ok" ? "" : "bad"}" style="left:${left.toFixed(2)}%;width:${Math.min(width, 100 - left).toFixed(2)}%"></span></span>
      <span class="mono muted num">${s === "running" ? `${fmtDur(now - c.ts)}…` : c.ms == null ? "-" : fmtMs(c.ms)}</span></div>
    ${open ? callDetailHtml(c, s) : ""}</div>`;
}
function spansHtml(c) {
  if (Array.isArray(c.spans) && c.spans.length) {
    const total = Math.max(1, c.ms || 0, ...c.spans.map((x) => (x.start_ms || 0) + (x.ms || 0)));
    return `<div class="wfall">${c.spans.map((x) => {
      const l = 100 * (x.start_ms || 0) / total, w = Math.max(0.5, 100 * (x.ms || 0) / total), wait = x.ms ? Math.min(100, 100 * (x.wait_ms || 0) / x.ms) : 0;
      const ok = typeof x.status === "number" && x.status < 400;
      return `<div class="wrow"><span class="mono truncate" title="${esc(`${x.method || ""} ${x.path || ""}${x.query ? `\n${x.query}` : ""}`)}">${esc(x.method || "")} ${esc(x.path || "")}</span>
        <span class="wbar"><span class="${ok ? "" : "bad"}" style="left:${l.toFixed(2)}%;width:${Math.min(w, 100 - l).toFixed(2)}%"><i style="width:${wait.toFixed(1)}%" title="waited ${x.wait_ms || 0} ms for a free connection"></i></span></span>
        <span class="mono small ${ok ? "muted" : "bad"}">${esc(x.status ?? "-")}</span><span class="mono small muted num">${fmtMs(x.ms || 0)}${x.attempts > 1 ? ` · ${x.attempts} tries` : ""}</span></div>`;
    }).join("")}${c.spans_dropped ? `<div class="muted small">${plural(c.spans_dropped, "more request")} not kept</div>` : ""}</div>`;
  }
  const m = c.span_summary;
  if (m) return `<dl class="kv"><dt>requests</dt><dd>${num(m.n)}${m.failed ? `, ${num(m.failed)} failed` : ""}</dd><dt>time in requests</dt><dd>${fmtMs(m.total_ms)}${m.wait_ms ? ` (${fmtMs(m.wait_ms)} waiting)` : ""}</dd>
    ${m.slowest ? `<dt>slowest</dt><dd>${esc(m.slowest.path || "")} · ${fmtMs(m.slowest.ms)}</dd>` : ""}</dl><p class="muted small">Only a summary of the requests is kept for this day.</p>`;
  return c.requests ? `<p class="muted small">${plural(c.requests, "request")} sent; their detail is not kept.</p>` : '<p class="muted small">No request to Graylog.</p>';
}
function previewHtml(c) {
  if (!c.preview) return c.status === "ok" || c.ok ? '<p class="muted small">The result is not kept (only for the last days, and not with GRAYLOG_MCP_USAGE=calls).</p>' : "";
  let tree = null;
  try { tree = treeHtml(JSON.parse(c.preview), null, 0); } catch (e) { /* cut at 2,000 characters: shown as text */ }
  return `<div class="glabel">what the model received${c.preview_truncated ? " · first 2,000 characters" : ""}</div>
    ${tree ? `<div class="tree">${tree}</div>` : `<pre class="json">${markMasks(esc(c.preview))}</pre>`}`;
}
function callDetailHtml(c, s) {
  const kv = [["started", new Date(c.ts * 1000).toLocaleString()], ["environment", c.instance || "-"], ["status", `${s}${STATUS_WHY[s] ? ` · ${STATUS_WHY[s]}` : ""}`]];
  if (c.error) kv.push(["error", c.error]);
  if (c.chars !== undefined) kv.push(["model received", `${num(c.chars)} chars${c.truncated ? " · cut to the size budget" : ""}`]);
  if (c.agent) kv.push(["agent", `${c.agent_type || "subagent"} ${c.agent}`]);
  if (c.client) kv.push(["client", c.client]);
  return `<div class="tc-det"><div class="dwrap"><dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    <div class="blocks"><div><div class="glabel">arguments</div><pre class="json">${jsonHtml(c.args)}</pre></div>
      <div><div class="glabel">requests to Graylog</div>${spansHtml(c)}</div><div>${previewHtml(c)}</div></div>
    <div class="dact"><button class="btn primary" type="button" data-play>Open in Playground</button></div></div></div>`;
}
function findCall(key) {
  for (const t of (CONV.detail ? CONV.detail.turns : [])) for (const c of t.calls) if (callKey(c) === key) return c;
  return null;
}
async function exportConversation(btn) {
  // the token goes in a header, so the file is fetched here and handed to the browser as a download
  await busy(btn, async () => {
    const q = CONV.turn ? `?turn=${encodeURIComponent(CONV.turn)}` : "";
    const res = await fetch(`${BASE}/api/conversations/${encodeURIComponent(CONV.id)}/export${q}`, {headers: {"X-Admin-Token": TOKEN}});
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const name = (/filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "") || [])[1] || "conversation.json";
    const a = Object.assign(document.createElement("a"), {href: URL.createObjectURL(await res.blob()), download: name});
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}
function initConversations() {
  let typing = null;
  $("cq").addEventListener("input", (e) => {
    clearTimeout(typing);
    typing = setTimeout(() => { CONV.q = e.target.value.trim(); syncActivityUrl("replace"); loadConversations(); }, 300);
  });
  $("crange").addEventListener("change", (e) => { CONV.range = e.target.value; syncActivityUrl("push"); loadConversations(); });
  $("cstat").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { CONV.status = b.dataset.st; syncActivityUrl("replace"); renderConversations(); } });
  $("clist").addEventListener("click", (e) => { const r = e.target.closest("tr.go"); if (r) openTurnRow(r); });
  $("clist").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("tr.go")) { e.preventDefault(); openTurnRow(e.target); } });
  $("convDetail").addEventListener("click", (e) => {
    if (e.target.closest("[data-back]")) return closeConversation();
    if (e.target.closest("[data-whole]")) return openConversation(CONV.id, null, null, null);
    const ex = e.target.closest("[data-export]"); if (ex) return exportConversation(ex);
    const tl = e.target.closest("[data-turnlink]"); if (tl) { e.preventDefault(); return openConversation(CONV.id, tl.dataset.turnlink, null, null); }
    const row = e.target.closest(".tcall"); if (!row) return;
    if (e.target.closest("[data-play]")) { const c = findCall(row.dataset.key); if (c) playCall(c); return; }
    if (e.target.closest(".tc-det")) return;  // selecting text in the detail does not close it
    toggleCall(row);
  });
  $("convDetail").addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches(".tcall")) { e.preventDefault(); toggleCall(e.target); }
  });
  onKey((e, k) => {
    if (k === "j") { e.preventDefault(); moveTurn(1); } else if (k === "k") { e.preventDefault(); moveTurn(-1); }
    else if (k === "escape" && CONV.id) { e.preventDefault(); closeConversation(); }
  }, () => CURRENT === "activity" && ACT_TAB === "conversations");
  document.addEventListener("envchange", () => { if (CURRENT === "activity" && ACT_TAB === "conversations" && !CONV.id) loadConversations(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") scheduleConversationRefresh(); else clearTimeout(CONV.timer); });
}
function toggleCall(row) {
  const key = row.dataset.key;
  if (CONV.open.has(key)) CONV.open.delete(key); else CONV.open.add(key);
  renderConversationDetail();
  document.querySelector(`#convDetail .tcall[data-key="${CSS.escape(key)}"]`)?.focus();
}
