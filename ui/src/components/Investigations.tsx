import { useEffect } from "preact/hooks";
import { currentPage, instances } from "../store";
import { openInLogs } from "../explorer-store";
import { pathOf } from "../router";
import {
    STATES,
    chooseBranch,
    chooseCheck,
    chooseEvidence,
    close,
    downloadExport,
    invEnabled,
    invError,
    invEvidence,
    invFilter,
    invList,
    invLive,
    invSel,
    invSnap,
    loadInvestigations,
    loadSnapshot,
    open,
    setInvFilter,
    startStream,
    stopStream,
} from "../investigations";
import {
    OUTCOME_WORD,
    STATE_CLASS,
    STEP_CLASS,
    STEP_WORD,
    blockedBranches,
    bodyText,
    countText,
    leaseText,
    logsViewOf,
    needsAttention,
    openQuestions,
    queryPair,
    stateWord,
    stepsByAttempt,
    windowText,
    workspaceOf,
    type CheckView,
} from "../investigations-model";
import type { InvEvidence, InvSnapshot, InvStep } from "../scripts/types";
import { Findings } from "./InvestigationFindings";
import { Page, Refresh, Skeleton } from "./UI";

const when = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString([], { hour12: false }) : "";
const LIVE_WORD = {
    live: "Live",
    connecting: "Connecting…",
    off: "Reconnecting",
    idle: "",
} as const;
// arrow keys move between the buttons of one list
function listKeys(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const all = [
        ...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
            "button.inv-pick",
        ),
    ];
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next = all[at + (e.key === "ArrowDown" ? 1 : -1)];
    if (next) {
        e.preventDefault();
        next.focus();
    }
}
function Badge({ cls, children }: { cls?: string; children: string }) {
    return <span class={`badge ${cls ?? ""}`}>{children}</span>;
}

// ------------------------------------------------------------------ list
function InvList() {
    const list = invList.value,
        f = invFilter.value;
    const names = [...new Set(instances.value.map((e) => e.name))];
    return (
        <>
            <div class="inv-filters">
                <label>
                    State
                    <select
                        value={f.state}
                        onChange={(e) =>
                            setInvFilter({ state: e.currentTarget.value })
                        }
                    >
                        {STATES.map((s) => (
                            <option value={s}>
                                {s === "all" ? "Any state" : stateWord(s)}
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    Environment
                    <select
                        value={f.instance}
                        onChange={(e) =>
                            setInvFilter({ instance: e.currentTarget.value })
                        }
                    >
                        <option value="">Any environment</option>
                        {names.map((n) => (
                            <option value={n}>{n}</option>
                        ))}
                    </select>
                </label>
            </div>
            {!list ? (
                <Skeleton />
            ) : !list.length ? (
                <div class="empty">
                    <h3>
                        {f.state !== "all" || f.instance
                            ? "No investigation matches"
                            : "No investigation yet"}
                    </h3>
                    <div>
                        An investigation starts from a connected agent: it calls{" "}
                        <code>investigation</code> with{" "}
                        <code>action="start"</code>, and what it checks and
                        concludes appears here. Nothing on this page starts one.
                    </div>
                </div>
            ) : (
                <ul class="inv-list" onKeyDown={listKeys}>
                    {list.map((i) => (
                        <li>
                            <button
                                class="inv-pick inv-row"
                                onClick={() => void open(i.id)}
                            >
                                <span class="inv-row-main">
                                    <b>{i.title}</b>
                                    <span class="inv-q">{i.question}</span>
                                </span>
                                <span class="inv-row-meta">
                                    <Badge cls={STATE_CLASS[i.state]}>
                                        {stateWord(i.state)}
                                    </Badge>
                                    {needsAttention(i) && (
                                        <Badge cls="warn">
                                            Needs attention
                                        </Badge>
                                    )}
                                    <span class="mono">{i.label}</span>
                                    <span>{i.instance}</span>
                                    <span>{windowText(i.scope)}</span>
                                    <span>Updated {when(i.updated)}</span>
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </>
    );
}

// ------------------------------------------------------------------ workspace
function Head({ snap }: { snap: InvSnapshot }) {
    const attempt = snap.attempts.find((a) => a.current),
        lease = leaseText(snap.lease_expires);
    return (
        <header class="inv-head">
            <div class="inv-title">
                <button class="btn sm ghost" onClick={() => void close()}>
                    ← All investigations
                </button>
                <h2>
                    {snap.title} <span class="mono">{snap.label}</span>
                </h2>
                <p class="inv-question">{snap.question}</p>
                <div class="inv-actions">
                    <button
                        class="btn sm"
                        onClick={() => void downloadExport(snap)}
                    >
                        Export Markdown
                    </button>
                    {snap.follows && (
                        <button
                            class="btn sm ghost"
                            onClick={() => void open(snap.follows!)}
                        >
                            Follows up an earlier investigation
                        </button>
                    )}
                    {snap.followed_by?.map((l) => (
                        <button
                            class="btn sm ghost"
                            onClick={() => void open(l)}
                        >
                            Followed up by {l}
                        </button>
                    ))}
                </div>
            </div>
            <dl class="inv-facts">
                <div>
                    <dt>State</dt>
                    <dd>
                        <Badge cls={STATE_CLASS[snap.state]}>
                            {stateWord(snap.state)}
                        </Badge>
                        {snap.outcome && (
                            <Badge cls="ok">
                                {OUTCOME_WORD[snap.outcome] ?? snap.outcome}
                            </Badge>
                        )}
                    </dd>
                </div>
                <div>
                    <dt>Environment</dt>
                    <dd>{snap.instance}</dd>
                </div>
                <div>
                    <dt>Window</dt>
                    <dd>
                        {windowText(snap.scope)}
                        {snap.scope_revisions.length > 1 &&
                            ` (revision ${snap.scope.rev})`}
                    </dd>
                </div>
                <div>
                    <dt>Query</dt>
                    <dd class="mono">{snap.scope.query || "*"}</dd>
                </div>
                {attempt && (
                    <div>
                        <dt>Attempt</dt>
                        <dd>
                            {attempt.n}
                            {lease && snap.state === "running" && (
                                <span> · agent lease {lease}</span>
                            )}
                        </dd>
                    </div>
                )}
                <div>
                    <dt>Stream</dt>
                    <dd>{LIVE_WORD[invLive.value] || "Not connected"}</dd>
                </div>
            </dl>
        </header>
    );
}
function StepLine({ s }: { s: InvStep }) {
    const sel = invSel.value;
    return (
        <li class="inv-step">
            <Badge cls={STEP_CLASS[s.state]}>
                {STEP_WORD[s.state] ?? s.state}
            </Badge>
            <span class="mono">{s.operation}</span>
            <span class="inv-q">{String(s.requested.query ?? "")}</span>
            {s.error && <span class="inv-err">{s.error}</span>}
            {s.evidence.map((e) => (
                <button
                    class={`btn sm ${sel.evidence === e ? "primary" : "ghost"}`}
                    aria-pressed={sel.evidence === e}
                    onClick={() => void chooseEvidence(e)}
                >
                    Evidence
                </button>
            ))}
        </li>
    );
}
function Overview({ snap }: { snap: InvSnapshot }) {
    const ws = workspaceOf(snap),
        sel = invSel.value,
        still = openQuestions(ws);
    return (
        <nav class="inv-pane inv-overview" aria-label="Branches">
            <h3>Branches</h3>
            {!ws.branches.length ? (
                <p class="inv-muted">
                    The agent has not recorded a branch yet.
                </p>
            ) : (
                <ul onKeyDown={listKeys}>
                    {ws.branches.map((b) => (
                        <li>
                            <button
                                class={`inv-pick${sel.branch === b.item.id ? " on" : ""}`}
                                aria-current={sel.branch === b.item.id}
                                onClick={() => void chooseBranch(b.item.id)}
                            >
                                <b>{bodyText(b.item, "question")}</b>
                                <span class="inv-muted">
                                    {b.checks.length} check
                                    {b.checks.length === 1 ? "" : "s"}
                                    {blockedBranches(snap).has(b.item.id) &&
                                        " · waiting for your answer"}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {!!ws.branches.length && (
                <p class="inv-muted">
                    {still.length
                        ? `${still.length} of ${ws.branches.length} without an assessment`
                        : "Every branch has an assessment"}
                </p>
            )}
            {!!ws.adHoc.length && (
                <>
                    <h3>Ad hoc steps</h3>
                    <p class="inv-muted">
                        Run without a check: no reason was recorded for them.
                    </p>
                    <ul>
                        {ws.adHoc.map((s) => (
                            <StepLine s={s} />
                        ))}
                    </ul>
                </>
            )}
            {!!ws.hypotheses.length && (
                <>
                    <h3>Hypotheses</h3>
                    <ul>
                        {ws.hypotheses.map((h) => (
                            <li>{bodyText(h, "statement")}</li>
                        ))}
                    </ul>
                </>
            )}
        </nav>
    );
}
function CheckCard({ c }: { c: CheckView }) {
    const d = c.item.data,
        sel = invSel.value;
    return (
        <section
            class={`inv-check${sel.check === c.item.id ? " on" : ""}`}
            aria-label={`Check ${c.item.id}`}
        >
            <h4>
                <button
                    class="inv-link"
                    onClick={() => void chooseCheck(c.item.id)}
                >
                    {bodyText(c.item, "purpose")}
                </button>
            </h4>
            {typeof d.expected === "string" && (
                <p>
                    <b>Would show:</b> {d.expected}
                </p>
            )}
            {c.steps.length ? (
                <ul>
                    {c.steps.map((s) => (
                        <StepLine s={s} />
                    ))}
                </ul>
            ) : (
                <p class="inv-muted">Not run yet.</p>
            )}
        </section>
    );
}
function BranchPane({ snap }: { snap: InvSnapshot }) {
    const ws = workspaceOf(snap),
        sel = invSel.value,
        branch = ws.branches.find((b) => b.item.id === sel.branch);
    const groups = stepsByAttempt(snap);
    const dividers = groups.length > 1;
    return (
        <section class="inv-pane inv-branch" aria-label="Selected branch">
            {branch ? (
                <>
                    <h3>{bodyText(branch.item, "question")}</h3>
                    {Array.isArray(branch.item.data.alternatives) && (
                        <p class="inv-muted">
                            Alternatives:{" "}
                            {(branch.item.data.alternatives as string[]).join(
                                "; ",
                            )}
                        </p>
                    )}
                    {branch.checks.map((c) => (
                        <CheckCard c={c} />
                    ))}
                    {!branch.checks.length && (
                        <p class="inv-muted">
                            No check recorded for this branch.
                        </p>
                    )}
                </>
            ) : (
                <>
                    <h3>Everything recorded</h3>
                    <Findings snap={snap} />
                    {ws.loose.map((c) => (
                        <CheckCard c={c} />
                    ))}
                    <h4>Steps in order</h4>
                    {groups.map((g) => (
                        <>
                            {dividers && (
                                <div class="inv-resume" role="separator">
                                    Attempt {g.n}
                                    {g.n > 1 ? " — resumed" : ""}
                                </div>
                            )}
                            <ul>
                                {g.steps.map((s) => (
                                    <StepLine s={s} />
                                ))}
                            </ul>
                        </>
                    ))}
                    {!snap.steps.length && (
                        <p class="inv-muted">No step has run yet.</p>
                    )}
                    {!!snap.reports.length && (
                        <>
                            <h4>Report</h4>
                            {snap.reports.map((r) => (
                                <p class="inv-report">
                                    {String(r.summary ?? r.report ?? "")}
                                </p>
                            ))}
                        </>
                    )}
                </>
            )}
        </section>
    );
}
function Pairs({
    title,
    data,
}: {
    title: string;
    data: Record<string, unknown> | null;
}) {
    const rows = Object.entries(data ?? {}).filter(
        ([, v]) => v !== null && v !== "" && typeof v !== "object",
    );
    return (
        <>
            <h4>{title}</h4>
            {rows.length ? (
                <dl class="inv-pairs">
                    {rows.map(([k, v]) => (
                        <div>
                            <dt>{k}</dt>
                            <dd class="mono">{String(v)}</dd>
                        </div>
                    ))}
                </dl>
            ) : (
                <p class="inv-muted">Nothing recorded.</p>
            )}
        </>
    );
}
function EvidencePane({ snap }: { snap: InvSnapshot }) {
    const e: InvEvidence | null = invEvidence.value,
        sel = invSel.value;
    if (!sel.evidence)
        return (
            <aside class="inv-pane inv-evidence" aria-label="Evidence">
                <h3>Evidence</h3>
                <p class="inv-muted">
                    Choose a step's evidence to see the query as asked and as
                    run, the counts and what was cut.
                </p>
                <ul onKeyDown={listKeys}>
                    {snap.evidence.map((r) => (
                        <li>
                            <button
                                class="inv-pick"
                                onClick={() => void chooseEvidence(r.id)}
                            >
                                <b class="mono">{r.kind}</b>
                                <span class="inv-muted">{countText(r)}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            </aside>
        );
    if (!e || e.id !== sel.evidence)
        return (
            <aside class="inv-pane inv-evidence" aria-label="Evidence">
                <Skeleton />
            </aside>
        );
    const pair = queryPair(e),
        logs = logsViewOf(e),
        step = e.step;
    return (
        <aside class="inv-pane inv-evidence" aria-label="Evidence">
            <button
                class="btn sm ghost"
                onClick={() => void chooseEvidence(null)}
            >
                ← All evidence
            </button>
            <h3>
                <span class="mono">{e.kind}</span> · {countText(e)}
            </h3>
            <div class="inv-badges">
                {e.sampled && <Badge cls="warn">Sampled</Badge>}
                {e.truncated && <Badge cls="warn">Cut to fit</Badge>}
                {step?.fenced_out && (
                    <Badge cls="fail">Arrived after takeover</Badge>
                )}
                {step && (
                    <Badge cls={STEP_CLASS[step.state]}>
                        {STEP_WORD[step.state] ?? step.state}
                    </Badge>
                )}
            </div>
            <h4>Query</h4>
            <p>
                As asked: <code>{pair.asked ?? "—"}</code>
            </p>
            <p>
                {pair.differs ? "As run (different): " : "As run: "}
                <code>{pair.ran ?? "—"}</code>
            </p>
            <p class="inv-muted">
                {step?.instance} · window of scope revision {e.scope_rev}
            </p>
            {!!e.coverage.length && (
                <>
                    <h4>Coverage</h4>
                    <ul>
                        {e.coverage.map((c) => (
                            <li>{c}</li>
                        ))}
                    </ul>
                </>
            )}
            <Pairs title="Executed" data={step?.executed ?? null} />
            {e.excerpts_expired ? (
                <p class="inv-muted">
                    Excerpts expired: the summary and counts are kept.
                </p>
            ) : (
                !!e.excerpts.length && (
                    <>
                        <h4>Excerpts ({e.excerpts.length})</h4>
                        <ol class="inv-excerpts">
                            {e.excerpts.map((x) => (
                                <li>
                                    {Object.entries(x).map(([k, v]) => (
                                        <span>
                                            <i>{k}</i> {String(v)}{" "}
                                        </span>
                                    ))}
                                </li>
                            ))}
                        </ol>
                    </>
                )
            )}
            {!!e.refs.length && (
                <p class="inv-muted">
                    {e.refs.length} message reference
                    {e.refs.length === 1 ? "" : "s"} kept.
                </p>
            )}
            <div class="inv-actions">
                {logs && (
                    <button
                        class="btn sm"
                        onClick={() => void openInLogs(logs)}
                    >
                        Open in Logs
                    </button>
                )}
                {step && (
                    <a
                        class="btn sm ghost"
                        href={pathOf("activity", ["calls"])}
                    >
                        Activity calls
                    </a>
                )}
            </div>
        </aside>
    );
}
function Workspace({ snap }: { snap: InvSnapshot }) {
    return (
        <div class="inv-workspace">
            <Head snap={snap} />
            {snap.truncated && (
                <p class="inv-muted">
                    This view is cut to fit: the oldest steps are left out.
                </p>
            )}
            <div class="inv-panes">
                <Overview snap={snap} />
                <BranchPane snap={snap} />
                <EvidencePane snap={snap} />
            </div>
        </div>
    );
}

export function Investigations() {
    const active = currentPage.value === "investigations",
        sel = invSel.value,
        snap = invSnap.value;
    useEffect(() => {
        if (!active) {
            stopStream();
            return;
        }
        void loadInvestigations();
        const id = invSel.value.id;
        if (id && invLive.value === "idle") {
            void loadSnapshot(id);
            startStream(id);
        }
        return () => stopStream();
    }, [active]);
    return (
        <Page
            id="investigations"
            tools={
                <>
                    {sel.id && LIVE_WORD[invLive.value] && (
                        <span class="badge">{LIVE_WORD[invLive.value]}</span>
                    )}
                    <Refresh
                        run={() =>
                            sel.id ? loadSnapshot(sel.id) : loadInvestigations()
                        }
                    />
                </>
            }
        >
            {invError.value && (
                <div class="inline-msg" role="alert">
                    {invError.value}
                </div>
            )}
            {!invEnabled.value ? (
                <div class="empty">
                    <h3>Investigations are off</h3>
                    <div>
                        <code>GRAYLOG_MCP_INVESTIGATIONS=off</code> is set for
                        this server. Remove it and restart to keep
                        investigations.
                    </div>
                </div>
            ) : !sel.id ? (
                <InvList />
            ) : snap ? (
                <Workspace snap={snap} />
            ) : (
                <Skeleton />
            )}
        </Page>
    );
}
