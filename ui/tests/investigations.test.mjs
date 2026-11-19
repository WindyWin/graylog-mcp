import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// The model has no page, store or network in it: it loads in Node as it is.
const output = await mkdtemp(join(tmpdir(), "graylog-admin-inv-"));
const source = await readFile(
    new URL("../src/investigations-model.ts", import.meta.url),
    "utf8",
);
await writeFile(
    join(output, "model.mjs"),
    ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
        },
    }).outputText,
);
const m = await import(pathToFileURL(join(output, "model.mjs")).href);

const ev = (seq, type = "step_finished") => ({
    seq,
    type,
    ref: null,
    ts: 0,
    data: {},
});
const step = (id, check, attempt = "a1", state = "succeeded") => ({
    id,
    check,
    attempt,
    state,
    operation: "search_logs",
    requested: {},
    executed: null,
    evidence: [],
});
const item = (kind, id, data) => ({ kind, id, revision: 1, author: "x", data });
const snap = (
    items,
    steps,
    attempts = [{ id: "a1", n: 1, current: true }],
) => ({ items, steps, attempts });

test("frames: complete frames come out, a partial one stays, comments and unknown lines are ignored", () => {
    const got = m.parseFrames(
        ': keep-alive\n\nid: 3\nevent: event\ndata: {"seq":3}\n\nevent: end\ndata: {"cursor":3}\n\nevent: ev',
    );
    assert.deepEqual(got.frames, [
        { event: "event", id: "3", data: '{"seq":3}' },
        { event: "end", id: null, data: '{"cursor":3}' },
    ]);
    assert.equal(got.rest, "event: ev");
    const more = m.parseFrames(got.rest + "ent\ndata: x\n\n");
    assert.deepEqual(more.frames, [{ event: "event", id: null, data: "x" }]);
    assert.equal(
        m.parseFrames("event: a\r\ndata: 1\r\n\r\n").frames[0].data,
        "1",
    );
});

test("advance: each event once and in order; a missing one is a gap, not a guess", () => {
    assert.deepEqual(
        m.advance(2, [ev(4), ev(3)]).fresh.map((e) => e.seq),
        [3, 4],
    );
    assert.equal(m.advance(2, [ev(4), ev(3)]).cursor, 4);
    const again = m.advance(4, [ev(3), ev(4)]);
    assert.deepEqual(
        [again.fresh.length, again.cursor, again.gap],
        [0, 4, false],
    );
    const gap = m.advance(2, [ev(3), ev(5)]);
    assert.deepEqual(
        [gap.fresh.map((e) => e.seq), gap.cursor, gap.gap],
        [[3], 3, true],
    );
    assert.equal(m.advance(0, [ev(2)]).gap, true);
});

test("backoff doubles to a ceiling", () => {
    assert.deepEqual([0, 1, 2, 3, 9].map(m.backoff), [1, 2, 4, 8, 30]);
});

test("states are in words and the ones that want a person are flagged", () => {
    assert.equal(m.stateWord("awaiting_input"), "Waiting for input");
    assert.equal(m.stateWord("novel"), "novel");
    assert.deepEqual(
        ["running", "awaiting_input", "interrupted", "completed"].map((state) =>
            m.needsAttention({ state }),
        ),
        [false, true, true, false],
    );
});

test("counts say exact apart from shown", () => {
    assert.equal(
        m.countText({ exact_count: 12345, returned: 20, sampled: true }),
        "12,345 matched · 20 shown",
    );
    assert.equal(
        m.countText({ exact_count: 3, returned: 3, sampled: false }),
        "3 matched",
    );
    assert.equal(
        m.countText({ exact_count: null, returned: 7, sampled: false }),
        "7 shown, total not given",
    );
    assert.equal(
        m.countText({ exact_count: null, returned: null, sampled: false }),
        "no count",
    );
});

test("lease text counts down and says when it ran out", () => {
    const now = Date.parse("2026-11-19T10:00:00Z");
    assert.equal(m.leaseText("2026-11-19T10:09:10Z", now), "10 min left");
    assert.equal(m.leaseText("2026-11-19T09:59:00Z", now), "expired");
    assert.equal(m.leaseText(null, now), "");
});

test("a check sits under its branches, a step without a check is ad hoc", () => {
    const ws = m.workspaceOf(
        snap(
            [
                item("branch", "b1", { question: "q1" }),
                item("branch", "b2", { question: "q2" }),
                item("check", "c1", { purpose: "p", branches: ["b1", "b2"] }),
                item("check", "c2", { purpose: "lone" }),
                item("assessment", "a1", {
                    claim: "c",
                    assessment: "supported",
                    branch: "b1",
                }),
            ],
            [step("s1", "c1"), step("s2", null), step("s3", "gone")],
        ),
    );
    assert.deepEqual(
        ws.branches.map((b) => [b.item.id, b.checks.map((c) => c.item.id)]),
        [
            ["b1", ["c1"]],
            ["b2", ["c1"]],
        ],
    );
    assert.deepEqual(
        ws.branches[0].checks[0].steps.map((s) => s.id),
        ["s1"],
    );
    assert.deepEqual(
        ws.loose.map((c) => c.item.id),
        ["c2"],
    );
    assert.deepEqual(
        ws.adHoc.map((s) => s.id),
        ["s2", "s3"],
    ); // a check that does not exist explains nothing
    assert.deepEqual(
        m.openQuestions(ws).map((b) => b.item.id),
        ["b2"],
    );
});

test("steps are grouped by attempt in the order the attempts began", () => {
    const groups = m.stepsByAttempt(
        snap(
            [],
            [
                step("s1", null, "a2"),
                step("s2", null, "a1"),
                step("s3", null, "a2"),
            ],
            [
                { id: "a1", n: 1 },
                { id: "a2", n: 2 },
            ],
        ),
    );
    assert.deepEqual(
        groups.map((g) => [g.n, g.steps.map((s) => s.id)]),
        [
            [1, ["s2"]],
            [2, ["s1", "s3"]],
        ],
    );
});

test("the query as asked beside the one that ran", () => {
    const e = (requested, executed) => ({ step: { requested, executed } });
    assert.deepEqual(m.queryPair(e({ query: "a" }, { query: "a" })), {
        asked: "a",
        ran: "a",
        differs: false,
    });
    assert.deepEqual(
        m.queryPair(e({ query: "a" }, { effective_query: "(a) AND b" })),
        {
            asked: "a",
            ran: "(a) AND b",
            differs: true,
        },
    );
    assert.deepEqual(m.queryPair({ step: null }), {
        asked: null,
        ran: null,
        differs: false,
    });
});

test("only a search's evidence opens in Logs, with the window that ran", () => {
    const e = (kind, executed) => ({
        kind,
        step: { instance: "main", requested: { query: "x" }, executed },
    });
    assert.deepEqual(
        m.logsViewOf(e("search_logs", { from: "f", to: "t", query: "y" })),
        {
            instance: "main",
            query: "y",
            from: "f",
            to: "t",
            range: undefined,
        },
    );
    assert.equal(m.logsViewOf(e("scan", {})), null);
});

test("the address round-trips and drops trailing parts", () => {
    assert.deepEqual(
        m.selectionPath({ id: null, branch: "b", check: null, evidence: null }),
        [],
    );
    assert.deepEqual(
        m.selectionPath({ id: "i", branch: null, check: null, evidence: null }),
        ["i"],
    );
    assert.deepEqual(
        m.selectionPath({ id: "i", branch: null, check: null, evidence: "e" }),
        ["i", "-", "-", "e"],
    );
    assert.deepEqual(m.selectionOf(["i", "-", "c"]), {
        id: "i",
        branch: null,
        check: "c",
        evidence: null,
    });
    assert.deepEqual(m.selectionOf([]), {
        id: null,
        branch: null,
        check: null,
        evidence: null,
    });
});
