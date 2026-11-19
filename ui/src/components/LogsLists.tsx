import { Fragment } from "preact";
import {
    LOG_PAGE,
    LOG_TRACES,
    LOG_WINDOW,
    firstLine,
    fmtMs,
    isMasked,
    type ExplorerMessage,
    type MessagesAnswer,
    type TraceAnswer,
    type TracesAnswer,
} from "../explorer";
import {
    currentWindow,
    narrowTo,
    openRows,
    openTrace,
    toggleRow,
    update,
    view,
} from "../explorer-store";
import { FieldsNote } from "./LogsDashboard";
import { Marks } from "./Marks";
import {
    LevelBadge,
    MessageDetail,
    TraceTimeline,
    rowKey,
} from "./TraceTimeline";
import { num, plural } from "./UI";

const time = (ms: number | null) =>
    ms == null ? "-" : new Date(ms).toLocaleTimeString();
// Enter and Space open a focusable row like a click
const activate = (go: () => void) => (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " "))
        return;
    e.preventDefault();
    go();
};

export function TracesList({ d }: { d: TracesAnswer }) {
    if (!d.fields.trace)
        return <FieldsNote fields={d.fields} needs={["trace"]} />;
    if (!d.traces.length)
        return <div class="allclear">// no trace in this range</div>;
    return (
        <>
            <div class="table-wrap">
                <table class="lg-table">
                    <thead>
                        <tr>
                            <th>Last message</th>
                            <th class="num">Duration</th>
                            <th class="num">Messages</th>
                            <th>Services</th>
                            <th>Worst level</th>
                            <th>First API</th>
                            <th>Trace</th>
                        </tr>
                    </thead>
                    <tbody>
                        {d.traces.map((t) => {
                            const go = () => update({ trace: t.trace });
                            return (
                                <tr
                                    key={t.trace}
                                    class="lg-go"
                                    tabIndex={0}
                                    aria-label={`Trace ${t.trace}, ${plural(t.count, "message")}`}
                                    onClick={go}
                                    onKeyDown={activate(go)}
                                >
                                    <td
                                        class="mono"
                                        title={`from ${t.first_ts == null ? "-" : new Date(t.first_ts).toLocaleString()} to ${t.last_ts == null ? "-" : new Date(t.last_ts).toLocaleString()}`}
                                    >
                                        {time(t.last_ts)}
                                    </td>
                                    <td class="num mono">
                                        {t.duration_ms == null
                                            ? "-"
                                            : fmtMs(t.duration_ms)}
                                    </td>
                                    <td class="num mono">{num(t.count)}</td>
                                    <td>{t.services.join(", ") || "-"}</td>
                                    <td>
                                        <LevelBadge level={t.worst_level} />
                                    </td>
                                    <td class="mono">
                                        {t.first_endpoint || "-"}
                                    </td>
                                    <td class="mono muted truncate lg-id">
                                        {t.trace}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            <div class="cmeta">
                <span>
                    The newest {num(d.traces.length)} traces in the range
                    {d.traces.length >= LOG_TRACES
                        ? "; narrow the range or the query for older ones"
                        : ""}
                </span>
            </div>
        </>
    );
}
export function TraceView({ d }: { d: TraceAnswer }) {
    return (
        <>
            <div class="lg-trace-head">
                <button
                    class="btn sm ghost"
                    type="button"
                    title="Back to the traces (Esc)"
                    onClick={() => update({ trace: null })}
                >
                    ← Traces
                </button>
                <h2 class="mono truncate">{d.trace}</h2>
            </div>
            <TraceTimeline
                trace={d}
                open={openRows.value}
                onToggle={toggleRow}
            />
        </>
    );
}

function Footer({ d, top }: { d: MessagesAnswer; top: () => void }) {
    const shown = d.messages.length,
        end = d.offset + shown,
        more = end < d.total,
        page = (by: number) => {
            update({ offset: Math.max(0, view.value.offset + by * LOG_PAGE) });
            top();
        };
    return (
        <div class="cmeta lg-foot">
            <span>
                Loaded {num(d.offset + (shown ? 1 : 0))}–{num(end)} of{" "}
                {plural(d.total, "message")} in the selected range.
                {d.total > LOG_WINDOW
                    ? ` Only the newest ${num(LOG_WINDOW)} can be paged: to see further, narrow the range or add words to the query.`
                    : ""}
            </span>
            <span class="spacer" />
            <button
                class="btn sm ghost"
                type="button"
                disabled={!d.offset}
                onClick={() => page(-1)}
            >
                ← Newer
            </button>
            <button
                class="btn sm ghost"
                type="button"
                disabled={!(more && end + LOG_PAGE <= LOG_WINDOW)}
                onClick={() => page(1)}
            >
                Older →
            </button>
            <button
                class="btn sm"
                type="button"
                title="Keep the newest half of the range"
                onClick={() => {
                    const w = currentWindow();
                    if (w) narrowTo(new Date((+w[0] + +w[1]) / 2), w[1]);
                }}
            >
                Narrow the range
            </button>
        </div>
    );
}
// "Open trace" on an opened message: the trace's timeline, over an hour either side of the message. Absent when the
// message has no trace id the explorer can look up (none configured, not on the line, or masked by redaction).
function TraceButton({
    m,
    field,
}: {
    m: ExplorerMessage;
    field: string | null;
}) {
    const id = field ? String(m[field] ?? "").trim() : "";
    if (!id || isMasked(id)) return null;
    return (
        <button
            class="btn sm"
            type="button"
            title={`The messages of ${field} ${id}, an hour either side of this one`}
            onClick={() => void openTrace(m, field)}
        >
            Open trace
        </button>
    );
}
export function MessagesTable({
    d,
    top,
}: {
    d: MessagesAnswer;
    top: () => void;
}) {
    if (!d.messages.length)
        return (
            <>
                <div class="allclear">// no message matches in this range</div>
                <Footer d={d} top={top} />
            </>
        );
    const svc = d.fields.service,
        open = openRows.value;
    return (
        <>
            <div class="table-wrap">
                <table class="lg-table lg-msgs">
                    <thead>
                        <tr>
                            <th>Time</th>
                            <th>Level</th>
                            <th>{svc || "source"}</th>
                            <th>Message</th>
                        </tr>
                    </thead>
                    <tbody>
                        {d.messages.map((m, i) => {
                            const key = rowKey(m, i),
                                isOpen = open.has(key),
                                lines = String(m.message ?? "").split(
                                    "\n",
                                ).length,
                                go = () => toggleRow(key);
                            return (
                                <Fragment key={key}>
                                    <tr
                                        class={`lg-go${isOpen ? " open" : ""}`}
                                        tabIndex={0}
                                        aria-expanded={isOpen}
                                        onClick={go}
                                        onKeyDown={activate(go)}
                                    >
                                        <td class="mono">
                                            {String(m.ts || "").slice(11, 23)}
                                        </td>
                                        <td>
                                            <LevelBadge level={m.level} />
                                        </td>
                                        <td class="mono">
                                            {String(
                                                (svc && m[svc]) ||
                                                    m.source ||
                                                    "-",
                                            )}
                                        </td>
                                        <td class="lg-msg">
                                            <Marks
                                                text={firstLine(m.message)}
                                            />
                                            {lines > 1 && (
                                                <>
                                                    {" "}
                                                    <span
                                                        class="badge"
                                                        title="Open the row to see the rest"
                                                    >
                                                        +{lines - 1} lines
                                                    </span>
                                                </>
                                            )}
                                        </td>
                                    </tr>
                                    {isOpen && (
                                        <tr class="lg-det">
                                            <td colSpan={4}>
                                                <MessageDetail
                                                    m={m}
                                                    actions={
                                                        <TraceButton
                                                            m={m}
                                                            field={
                                                                d.fields.trace
                                                            }
                                                        />
                                                    }
                                                />
                                            </td>
                                        </tr>
                                    )}
                                </Fragment>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            <Footer d={d} top={top} />
        </>
    );
}
