import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { api, errorText } from "../api";
import {
    activityTab,
    attempt,
    currentEnv,
    currentPage,
    envHealth,
    filters,
    instances,
    learned,
    loadDashboard,
    loadErrors,
    loadLearned,
    openEnvByName,
    rerun,
    toast,
    usage,
    state,
} from "../store";
import type { Call, LearnedRule, Usage } from "../scripts/types";
import { revealRows } from "../scripts/motion";
import { Chart } from "./Charts";
import { callWhat } from "./Overview";
import {
    AsyncButton,
    ContextChip,
    Icon,
    JsonText,
    Page,
    Panel,
    Range,
    Refresh,
    Segment,
    Skeleton,
    Tabs,
    num,
    whenShort,
} from "./UI";
const fmtMs = (ms: number) =>
    ms >= 10000 ? `${Math.round(ms / 1000)}s` : `${num(ms)}ms`;
const bucketIndex = (c: Call, u: Usage) =>
    u.buckets.length
        ? Math.floor((c.ts - u.buckets[0].t) / (u.bucket_hours * 3600))
        : -1;
const bucketLabel = (t: number, step: number) =>
    step >= 6
        ? new Date(t * 1000).toLocaleString([], {
              weekday: "short",
              hour: "2-digit",
              minute: "2-digit",
          })
        : new Date(t * 1000).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
          });
function bucketSpan(u: Usage, i: number) {
    if (!u.buckets[i]) return "";
    const a = new Date(u.buckets[i].t * 1000),
        b = new Date((u.buckets[i].t + u.bucket_hours * 3600) * 1000),
        hm = (d: Date) =>
            `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return `${a.toLocaleDateString([], { weekday: "short" })} ${hm(a)}–${hm(b)}`;
}
function matches(c: Call, u: Usage) {
    const f = filters.value,
        bi = bucketIndex(c, u);
    if (bi < 0 || bi >= u.buckets.length) return false;
    if (currentEnv.value && c.instance !== currentEnv.value) return false;
    if (f.tool && c.tool !== f.tool) return false;
    if (f.status === "error" && c.ok) return false;
    if (f.status === "nothing" && !(c.ok && c.results === 0)) return false;
    if (f.bucket !== null && bi !== f.bucket) return false;
    return (
        !f.q ||
        `${c.tool} ${c.instance || ""} ${JSON.stringify(c.args || {})} ${JSON.stringify(c.params || {})} ${c.error || ""}`
            .toLowerCase()
            .includes(f.q)
    );
}
function play(c: Call) {
    toast(
        `Playground pre-filled: ${c.tool}${c.instance ? ` on ${c.instance}` : ""}`,
        "info",
    );
    return rerun(c);
}
function CallRow({
    c,
    index,
    on,
    refs,
}: {
    c: Call;
    index: number;
    on: boolean;
    refs: Map<number, HTMLDivElement>;
}) {
    const [open, setOpen] = useState(false),
        [copied, setCopied] = useState(false),
        timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => {
        if (!on) setOpen(false);
    }, [on]);
    useEffect(() => () => clearTimeout(timer.current), []);
    const w = callWhat(c),
        a = c.args || {},
        p = c.params || {},
        ask =
            (w !== "-" ? w : p.range ? `last ${p.range}` : "-") +
            (a.group_by && w !== a.group_by ? ` · by ${a.group_by}` : ""),
        miss = c.ok && c.results === 0,
        env = instances.value.find((e) => e.name === c.instance);
    const kv: [string, ComponentChildren][] = [
        ["when", new Date(c.ts * 1000).toLocaleString()],
        ["instance", c.instance || "-"],
    ];
    if (c.repo) kv.push(["repository", c.repo]);
    kv.push(["duration", `${num(c.ms)} ms`]);
    if (c.ok) {
        kv.push([
            "size",
            `${num(c.chars)} chars${c.truncated ? " · cut to the size budget" : ""}`,
        ]);
        if (c.requests !== undefined) kv.push(["requests", String(c.requests)]);
        if (c.returned !== undefined && c.results !== undefined)
            kv.push(["returned", `${num(c.returned)} of ${num(c.results)}`]);
    } else kv.push(["outcome", `error · ${c.error || "unknown"}`]);
    const copy = async () => {
        try {
            const entry = {
                ts: new Date(c.ts * 1000).toISOString(),
                tool: c.tool,
                instance: c.instance,
                ms: c.ms,
                ok: c.ok,
                ...(c.error ? { error: c.error } : {}),
                results: c.results,
                chars: c.chars,
                args: c.args,
                params: c.params,
                requests: c.requests,
                returned: c.returned,
                truncated: !!c.truncated,
            };
            await navigator.clipboard.writeText(JSON.stringify(entry, null, 2));
            setCopied(true);
            timer.current = setTimeout(() => setCopied(false), 1400);
        } catch {
            toast("The browser blocked copying", "fail");
        }
    };
    return (
        <div
            class={`crow${on ? "" : " off"}${open ? " open" : ""}`}
            role="listitem"
            inert={!on}
        >
            <div class="clip">
                <div
                    class="chead"
                    ref={(el) => {
                        if (el) refs.set(index, el);
                        else refs.delete(index);
                    }}
                    tabIndex={0}
                    role="button"
                    aria-expanded={open}
                    aria-controls={`cd${index}`}
                    onClick={() => setOpen(!open)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setOpen(!open);
                        }
                    }}
                >
                    <span
                        class="ct"
                        title={new Date(c.ts * 1000).toLocaleString()}
                    >
                        {whenShort(c.ts)}
                    </span>
                    <span class="ctool">{c.tool}</span>
                    <span class="cenv">{c.instance || ""}</span>
                    <span class="cwhat" title={ask}>
                        {ask}
                    </span>
                    <span class="cst">
                        {!c.ok && <span class="badge fail">✕ error</span>}
                        {miss && <span class="badge warn">found nothing</span>}
                        {c.rewritten && (
                            <span
                                class="badge"
                                title="A safe or learned fix ran instead of the query as written"
                            >
                                fixed
                            </span>
                        )}
                        {c.truncated && (
                            <span
                                class="badge"
                                title="The result was cut to the size budget"
                            >
                                cut
                            </span>
                        )}
                    </span>
                    <span class="cms">{fmtMs(c.ms || 0)}</span>
                    <span class={`cn${miss ? " zero" : ""}`}>
                        {c.ok && c.results !== undefined ? num(c.results) : "-"}
                    </span>
                </div>
                <div class="cdet" id={`cd${index}`} inert={!open}>
                    <div>
                        <div class="dwrap">
                            <dl class="kv">
                                {kv.map(([k, v]) => (
                                    <>
                                        <dt>{k}</dt>
                                        <dd>{v}</dd>
                                    </>
                                ))}
                            </dl>
                            <div class="blocks">
                                <div>
                                    <div class="glabel">arguments</div>
                                    <pre class="json">
                                        <JsonText value={c.args} />
                                    </pre>
                                </div>
                                <div>
                                    <div class="glabel">parameters</div>
                                    <pre class="json">
                                        <JsonText value={c.params} />
                                    </pre>
                                </div>
                            </div>
                            <div class="dact">
                                <button
                                    class="btn primary"
                                    onClick={() => play(c)}
                                >
                                    Open in Playground{" "}
                                    <span class="kbd">P</span>
                                </button>
                                <button class="btn" onClick={copy}>
                                    {copied ? "Copied ✓" : "Copy as JSON"}
                                </button>
                                {!c.ok &&
                                    env?.local &&
                                    envHealth(env).cls === "fail" && (
                                        <button
                                            class="btn"
                                            onClick={() =>
                                                openEnvByName(env.name)
                                            }
                                        >
                                            Edit{" "}
                                            {env.group
                                                ? `${env.group}/${env.environment}`
                                                : env.name}
                                        </button>
                                    )}
                                {c.rewritten && (
                                    <span class="note">
                                        A safe or learned fix ran instead of the
                                        query as written.
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
const KIND_TEXT: Record<string, string> = {
    field: "field name",
    level: "level form",
    case: "letter case",
    prefix: "prefix wildcard",
    focus: "outside focus",
};
function LearnedRow({ r }: { r: LearnedRule }) {
    const [armed, setArmed] = useState(false),
        [gone, setGone] = useState(false),
        timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(timer.current), []);
    const forget = async () => {
        if (!armed) {
            setArmed(true);
            timer.current = setTimeout(() => setArmed(false), 3000);
            return;
        }
        setGone(true);
        try {
            await api("/api/learned/forget", "POST", { key: r.key });
            toast("Forgotten. It is suggested again from scratch.");
            await new Promise((resolve) => setTimeout(resolve, 340));
            if (learned.value)
                learned.value = {
                    ...learned.value,
                    rules: learned.value.rules.filter((x) => x.key !== r.key),
                };
            void loadLearned();
        } catch (e) {
            setGone(false);
            toast(errorText(e), "fail");
        }
    };
    const change =
        r.kind === "field"
            ? `${r.from} → ${r.to}`
            : r.kind === "case"
              ? `${r.from}: ${r.to} case`
              : r.kind === "level"
                ? `${r.from}: as a ${r.to}`
                : r.kind === "prefix"
                  ? "word → word*"
                  : "every stream";
    return (
        <div class={`lwrap${gone ? " gone" : ""}`} inert={gone}>
            <div>
                <div class="trow lrn">
                    <span>{r.instance}</span>
                    <span>{KIND_TEXT[r.kind] || r.kind}</span>
                    <span>{change}</span>
                    <span class="num">
                        {num(r.used)} / {num(r.offered)}
                    </span>
                    <span class="wbar">
                        <span class="track">
                            <i
                                style={{
                                    width: `${Math.round(r.weight * 100)}%`,
                                }}
                            />
                        </span>
                        <span>{r.weight.toFixed(2)}</span>
                    </span>
                    <span>
                        <span class={`badge ${r.auto ? "ok" : ""}`}>
                            {r.auto ? "automatically" : "as a suggestion"}
                        </span>
                    </span>
                    <span class="num">
                        <AsyncButton
                            class={`btn sm ${armed ? "danger-solid" : "ghost"}`}
                            run={forget}
                        >
                            {armed ? "Sure?" : "Forget"}
                        </AsyncButton>
                    </span>
                </div>
            </div>
        </div>
    );
}
export function Activity() {
    const u = usage.value,
        f = filters.value,
        tab = activityTab.value,
        l = learned.value,
        rules = (l?.rules || []).filter(
            (r) => !currentEnv.value || r.instance === currentEnv.value,
        ),
        refs = useRef(new Map<number, HTMLDivElement>()),
        list = useRef<HTMLDivElement>(null),
        shown = u ? u.recent.filter((c) => matches(c, u)).length : 0;
    const set = (patch: Partial<typeof f>) => {
        filters.value = { ...filters.value, ...patch };
    };
    useEffect(() => {
        if (currentPage.value === "activity" && state.value) void loadLearned();
    }, [currentPage.value, !!state.value]);
    useEffect(() => {
        if (u) {
            const bucket =
                f.bucket !== null && f.bucket < u.buckets.length
                    ? f.bucket
                    : null;
            set({
                bucket,
                tool: u.tools.some((t) => t.tool === f.tool) ? f.tool : "",
            });
        }
    }, [u]);
    useLayoutEffect(() => {
        if (list.current && u)
            revealRows([...list.current.querySelectorAll(".crow:not(.off)")]);
    }, [u]);
    useEffect(() => {
        const key = (e: KeyboardEvent) => {
            if (
                e.defaultPrevented ||
                currentPage.value !== "activity" ||
                activityTab.value !== "calls" ||
                e.ctrlKey ||
                e.metaKey ||
                e.altKey ||
                (e.target as HTMLElement).closest(
                    "input,textarea,select,[contenteditable]",
                ) ||
                document.querySelector("dialog[open]") ||
                !usage.value
            )
                return;
            const entries = usage.value.recent
                    .map((c, i) => ({ c, i, el: refs.current.get(i) }))
                    .filter((o) => o.el && matches(o.c, usage.value!)),
                cur = entries.findIndex((o) => o.el === document.activeElement),
                k = e.key.toLowerCase();
            if (k === "j" || k === "k") {
                e.preventDefault();
                const next =
                    cur < 0
                        ? k === "j"
                            ? 0
                            : entries.length - 1
                        : Math.max(
                              0,
                              Math.min(
                                  entries.length - 1,
                                  cur + (k === "j" ? 1 : -1),
                              ),
                          );
                entries[next]?.el?.focus();
                entries[next]?.el?.scrollIntoView({ block: "nearest" });
            } else if (k === "p") {
                e.preventDefault();
                if (cur >= 0) void play(entries[cur].c);
                else toast("Select a call first with J / K", "info");
            }
        };
        document.addEventListener("keydown", key);
        return () => document.removeEventListener("keydown", key);
    }, []);
    const pick = (i: number) =>
        set({ bucket: filters.value.bucket === i ? null : i });
    const max = Math.max(1, ...(u?.tools || []).map((t) => t.calls)),
        kept = u?.recent.length || 0;
    return (
        <Page
            id="activity"
            tools={
                <>
                    <ContextChip id="actCtx" />
                    <Range />
                    <Refresh
                        id="actRefresh"
                        run={() =>
                            Promise.all([loadDashboard(), loadLearned()])
                        }
                    />
                </>
            }
        >
            <div id="usageOff">
                {u && !u.enabled && (
                    <div class="banner info">
                        <Icon name="info" />
                        <div class="text">
                            Recording is off: <code>GRAYLOG_MCP_USAGE=off</code>{" "}
                            is set for the server. Remove it to see activity
                            again.
                        </div>
                    </div>
                )}
            </div>
            <section class="card" aria-labelledby="actChartTitle">
                <div class="card-head">
                    <h2 id="actChartTitle">Calls</h2>
                    <span class="muted small mono" id="callsSub">
                        {u &&
                            `${num(u.totals.calls)} calls · ${num(u.totals.misses)} found nothing · ${num(u.totals.errors)} errors · per ${u.bucket_hours === 1 ? "hour" : `${u.bucket_hours} hours`}${currentEnv.value ? " · every environment" : ""}`}
                    </span>
                    <span class="spacer" />
                    <span class="muted small">
                        click a bar to filter the list
                    </span>
                </div>
                {!u ? (
                    <div id="callsChart">
                        {loadErrors.value.usage ? (
                            <div class="inline-msg">
                                Could not load the calls:{" "}
                                {loadErrors.value.usage}. Press Refresh to try
                                again.
                            </div>
                        ) : (
                            <Skeleton />
                        )}
                    </div>
                ) : !u.totals.calls ? (
                    <div id="callsChart">
                        <div class="inline-msg">
                            {u.enabled
                                ? "No tool calls in this range yet. They show up here as soon as Claude uses graylog."
                                : "Nothing is recorded."}
                        </div>
                    </div>
                ) : (
                    <Chart
                        id="callsChart"
                        labels={u.buckets.map((b) =>
                            bucketLabel(b.t, u.bucket_hours),
                        )}
                        name="Tool calls"
                        height={220}
                        series={[
                            {
                                name: "Found something",
                                values: u.buckets.map(
                                    (b) => b.calls - b.misses - b.errors,
                                ),
                                color: "var(--chart-ink)",
                            },
                            {
                                name: "Found nothing",
                                values: u.buckets.map((b) => b.misses),
                                color: "var(--chart-warn)",
                            },
                            {
                                name: "Error",
                                values: u.buckets.map((b) => b.errors),
                                color: "var(--color-error)",
                            },
                        ]}
                        selected={f.bucket}
                        pick={pick}
                    />
                )}
            </section>
            <Tabs
                id="actTabs"
                label="Activity views"
                value={tab}
                onChange={(t) => {
                    activityTab.value = t;
                }}
                options={[
                    [
                        "calls",
                        <>
                            Calls
                            <span class="n" id="nCalls">
                                {shown}
                            </span>
                        </>,
                    ],
                    [
                        "tools",
                        <>
                            By tool
                            <span class="n" id="nTools">
                                {u?.tools.length || ""}
                            </span>
                        </>,
                    ],
                    [
                        "learned",
                        <>
                            Learned
                            <span class="n" id="nLearned">
                                {l ? rules.length : ""}
                            </span>
                        </>,
                    ],
                ]}
            />
            <Panel tabs="actTabs" id="calls" value={tab}>
                <div class="fbar">
                    <label class="search">
                        <Icon name="search" />
                        <input
                            id="aq"
                            type="search"
                            placeholder="Filter by query, trace id, field…"
                            autoComplete="off"
                            aria-label="Filter calls"
                            value={f.q}
                            onInput={(e) =>
                                set({ q: e.currentTarget.value.toLowerCase() })
                            }
                        />
                    </label>
                    <select
                        class="sel auto-width"
                        id="atool"
                        aria-label="Tool"
                        value={f.tool}
                        onChange={(e) => set({ tool: e.currentTarget.value })}
                    >
                        <option value="">Every tool</option>
                        {u?.tools.map((t) => (
                            <option value={t.tool}>{t.tool}</option>
                        ))}
                    </select>
                    <Segment
                        id="astat"
                        label="Outcome"
                        options={[
                            ["all", "All"],
                            ["nothing", "Found nothing"],
                            ["error", "Errors"],
                        ]}
                        value={f.status}
                        onChange={(status) => set({ status })}
                    />
                    <span
                        class="ctxchip"
                        id="abkt"
                        hidden={f.bucket === null || !u}
                    >
                        <span>
                            {f.bucket !== null && u
                                ? `when: ${bucketSpan(u, f.bucket)}`
                                : ""}
                        </span>
                        <button
                            aria-label="Clear the hour filter"
                            onClick={() => set({ bucket: null })}
                        >
                            ✕
                        </button>
                    </span>
                    <button
                        class="btn sm ghost"
                        id="aclear"
                        hidden={
                            !(
                                f.q ||
                                f.tool ||
                                f.status !== "all" ||
                                f.bucket !== null
                            )
                        }
                        onClick={() => {
                            filters.value = {
                                q: "",
                                tool: "",
                                status: "all",
                                bucket: null,
                            };
                        }}
                    >
                        Clear filters
                    </button>
                </div>
                <div class="cmeta">
                    <span id="acount" aria-live="polite">
                        {u &&
                            `Showing ${num(shown)} of ${num(kept)} kept calls${u.totals.calls > kept ? ` · ${num(u.totals.calls)} in this range, the latest ${kept} are kept` : ""}`}
                    </span>
                    <span class="spacer" />
                    <span class="keyhint">
                        <span class="kbd">J</span> <span class="kbd">K</span>{" "}
                        move · <span class="kbd">Enter</span> open ·{" "}
                        <span class="kbd">P</span> Playground
                    </span>
                </div>
                <div class="chdr" aria-hidden="true">
                    <span>When</span>
                    <span>Tool</span>
                    <span>Environment</span>
                    <span>Asked for</span>
                    <span />
                    <span>Time</span>
                    <span>Found</span>
                </div>
                <div
                    id="alist"
                    role="list"
                    aria-label="Recent calls"
                    ref={list}
                >
                    {u?.recent.map((c, i) => (
                        <CallRow
                            key={`${c.ts}:${c.tool}:${i}`}
                            c={c}
                            index={i}
                            on={matches(c, u)}
                            refs={refs.current}
                        />
                    ))}
                </div>
                <div class="allclear" id="aempty" hidden={shown > 0}>
                    {!kept
                        ? "// no calls recorded in this range yet"
                        : u &&
                            f.bucket !== null &&
                            !u.recent.some(
                                (c) => bucketIndex(c, u) === f.bucket,
                            )
                          ? `// no details kept for ${bucketSpan(u, f.bucket)}: the list keeps only the latest ${kept} calls`
                          : "// no call matches these filters"}
                </div>
            </Panel>
            <Panel tabs="actTabs" id="tools" value={tab}>
                <div id="toolTable">
                    {u?.tools.length ? (
                        <>
                            <div class="cmeta">
                                <span>
                                    counts cover every call in the range
                                    {currentEnv.value
                                        ? ", in every environment"
                                        : ""}{" "}
                                    · click a tool to list its calls
                                </span>
                            </div>
                            <div class="trow head" aria-hidden="true">
                                <span>Tool</span>
                                <span class="bar-cell" />
                                <span class="num">Calls</span>
                                <span class="num">Found nothing</span>
                                <span class="num">Errors</span>
                                <span class="num lat">Median</span>
                                <span class="num lat">p95</span>
                            </div>
                            {u.tools.map((t) => (
                                <div
                                    class="trow go"
                                    role="button"
                                    tabIndex={0}
                                    aria-label={`${t.tool}: ${t.calls} calls. Show them in the list.`}
                                    onClick={() => {
                                        set({ tool: t.tool });
                                        activityTab.value = "calls";
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            set({ tool: t.tool });
                                            activityTab.value = "calls";
                                        }
                                    }}
                                >
                                    <span class="tn">{t.tool}</span>
                                    <span class="bar-cell">
                                        <span class="track">
                                            <span
                                                class="fill"
                                                style={{
                                                    transform: `scaleX(${t.calls / max})`,
                                                }}
                                            >
                                                <i
                                                    style={{
                                                        flex: Math.max(
                                                            0,
                                                            t.calls -
                                                                t.misses -
                                                                t.errors,
                                                        ),
                                                    }}
                                                />
                                                <i
                                                    class="m"
                                                    style={{ flex: t.misses }}
                                                />
                                                <i
                                                    class="e"
                                                    style={{ flex: t.errors }}
                                                />
                                            </span>
                                        </span>
                                    </span>
                                    <span class="num">{num(t.calls)}</span>
                                    <span
                                        class={`num${t.misses ? " warn" : ""}`}
                                    >
                                        {num(t.misses)}
                                    </span>
                                    <span
                                        class={`num${t.errors ? " bad" : ""}`}
                                    >
                                        {num(t.errors)}
                                    </span>
                                    <span class="num lat">
                                        {t.p50_ms ? fmtMs(t.p50_ms) : "-"}
                                    </span>
                                    <span class="num lat">
                                        {t.p95_ms ? fmtMs(t.p95_ms) : "-"}
                                    </span>
                                </div>
                            ))}
                        </>
                    ) : (
                        <div class="allclear">
                            // no tool called in this range yet
                        </div>
                    )}
                </div>
            </Panel>
            <Panel tabs="actTabs" id="learned" value={tab}>
                <div class="cmeta">
                    <span id="learnSub">
                        {l
                            ? l.enabled
                                ? `a fix used ${l.auto_min_uses}+ times with weight ≥ ${l.auto_weight} applies by itself`
                                : "learning is off (GRAYLOG_MCP_LEARN=off)"
                            : ""}
                    </span>
                </div>
                <div id="learnList">
                    {loadErrors.value.learned ? (
                        <div class="inline-msg">{loadErrors.value.learned}</div>
                    ) : !l ? (
                        <Skeleton />
                    ) : !rules.length ? (
                        <div class="allclear">
                            // nothing learned
                            {currentEnv.value
                                ? ` on ${currentEnv.value}`
                                : ""}{" "}
                            yet: the fixes the model uses after a search finds
                            nothing show up here
                        </div>
                    ) : (
                        <>
                            <div class="trow lrn head" aria-hidden="true">
                                <span>Environment</span>
                                <span>Fix</span>
                                <span>Change</span>
                                <span class="num">Used / offered</span>
                                <span>Weight</span>
                                <span>Applied</span>
                                <span />
                            </div>
                            {rules.map((r) => (
                                <LearnedRow key={r.key} r={r} />
                            ))}
                        </>
                    )}
                </div>
            </Panel>
        </Page>
    );
}
