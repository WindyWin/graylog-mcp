import { signal, computed } from "@preact/signals";
import type { State, Setup, Check, ScopeInfo } from "./scripts/types";

// Creating state is safe without a DOM. Browser initialization belongs to mount effects.
export const token = signal("");
export const state = signal<State | null>(null);
export const setup = signal<Setup | null>(null);
export const checks = signal<Check[] | null>(null);
export const currentEnv = signal<string | null>(null);
export const range = signal("24h");
export const currentPage = signal("home");
export const scopes = signal<ScopeInfo[]>([
    { scope: "global", label: "All environments (global defaults)" },
]);
export const instances = computed(() => state.value?.instances ?? []);
export const context = computed(
    () => instances.value.find((e) => e.name === currentEnv.value) ?? null,
);

import { api, errorText, storage } from "./api";
import type {
    Usage,
    LogStats,
    Instance,
    Fields,
    TestResult,
    Learned,
    Breakdown,
    LogsView,
} from "./scripts/types";
export const usage = signal<Usage | null>(null);
export const stats = signal<LogStats | null>(null);
export const statsAt = signal(0);
export const learned = signal<Learned | null>(null);
export const breakdown = signal<Breakdown | null>(null);
export const breakdownPick = signal<string | null>(null);
export const breakdownRefresh = signal(0);
export const breakdownTarget = computed(
    () =>
        instances.value.find((e) => e.name === currentEnv.value)?.name ||
        instances.value.find((e) => e.name === breakdownPick.value)?.name ||
        (instances.value.find((e) => e.default) || instances.value[0])?.name ||
        null,
);
export const logsView = signal<LogsView | null>(null);
export const logsRevision = signal(0);
export const loadErrors = signal<Record<string, string>>({});
export const banner = signal("");
export const settingsOpen = signal(false);
export const paletteOpen = signal(false);
export const envPickerOpen = signal(false);
export const palette = signal("slate");
export const mode = signal("system");
export const theme = signal("light");
export const density = signal("comfortable");
export const envEditor = signal<{
    entry: Instance | null;
    group?: string;
} | null>(null);
export const envTests = signal<
    Record<string, TestResult & { at?: number; busy?: boolean }>
>({});
export const fieldsScope = signal("global");
export const scopeChosen = signal(false);
export const playground = signal<{
    tool: string;
    instance?: string;
    args?: Fields;
} | null>(null);
export const detectRequest = signal(0);
export const filters = signal<{
    q: string;
    tool: string;
    status: string;
    bucket: number | null;
}>({ q: "", tool: "", status: "all", bucket: null });
export const activityTab = signal("calls");
export interface Dirty {
    what: string;
    save: () => unknown;
    discard: () => void;
}
export const dirty = signal<Dirty | null>(null);
export interface Confirmation {
    title: string;
    text: string;
    okLabel: string;
    danger: boolean;
    resolve: (ok: boolean) => void;
}
export const confirmation = signal<Confirmation | null>(null);
export function confirmBox(
    title: string,
    text: string,
    okLabel = "Confirm",
    danger = false,
): Promise<boolean> {
    confirmation.value?.resolve(false);
    return new Promise((resolve) => {
        confirmation.value = { title, text, okLabel, danger, resolve };
    });
}
export function resolveConfirm(ok: boolean) {
    const c = confirmation.value;
    confirmation.value = null;
    c?.resolve(ok);
}
export const notifications = signal<
    { id: number; message: string; kind: string }[]
>([]);
let toastId = 0;
export function toast(message: string, kind = "ok") {
    notifications.value = [
        ...notifications.value,
        { id: ++toastId, message, kind },
    ];
}
export async function attempt(fn: () => unknown) {
    try {
        return await fn();
    } catch (e) {
        toast(errorText(e), "fail");
    }
}
export const pages = {
    home: ["Overview", "Your Graylog environments and how the model uses them"],
    activity: [
        "Activity",
        "Every tool call the model made: what it asked, what it found, how long it took",
    ],
    envs: [
        "Environments",
        "Graylog per environment, grouped by system, and the repositories each system serves",
    ],
    fields: [
        "Log fields",
        "Field names, queries and connection options; detected from your logs or set by hand",
    ],
    redaction: [
        "Redaction",
        "What is masked before any log line reaches the model",
    ],
    playground: [
        "Playground",
        "Run the exact tools the model uses, with the same redaction and limits",
    ],
    connect: [
        "Connect",
        "Claude Code, Claude Desktop, Cursor or VS Code: how the client starts the server",
    ],
    config: ["Config file", "The TOML file behind every other page"],
} as const;
export type PageName = keyof typeof pages;
export const pageTitle = computed(
    () => pages[currentPage.value as PageName]?.[0] ?? "Overview",
);
export const failing = computed(
    () => instances.value.filter((e) => envHealth(e).cls === "fail").length,
);
export function label(e: Instance) {
    return e.group ? `${e.group}/${e.environment}` : e.name;
}
export function envHealth(e: Instance) {
    if (!checks.value)
        return {
            cls: "busy",
            text: loadErrors.value.doctor
                ? `the check failed: ${loadErrors.value.doctor}`
                : "checking…",
            problems: [],
        };
    const mine = checks.value.filter((c) => c.instance === e.name),
        problems = mine.filter(
            (c) => c.status === "fail" || c.status === "warn",
        );
    return {
        cls: mine.some((c) => c.status === "fail")
            ? "fail"
            : problems.length
              ? "warn"
              : mine.length
                ? "ok"
                : "",
        text:
            (mine.find((c) => c.name === "connection") || mine[0])?.detail ||
            "",
        problems,
    };
}
export function byGroup(envs: Instance[]) {
    const groups: Record<string, Instance[]> = {};
    for (const e of envs) (groups[e.group || ""] ||= []).push(e);
    return Object.entries(groups).sort(([a], [b]) =>
        (a || "~").localeCompare(b || "~"),
    );
}
export function setEnv(name: string | null) {
    currentEnv.value = name;
    storage.set("gm-env", name);
}
export async function navigate(name: string): Promise<boolean> {
    const aliases: Record<string, string> = {
        overview: "home",
        groups: "envs",
        settings: "fields",
        clients: "connect",
    };
    name = aliases[name] || name;
    if (!(name in pages)) name = "home";
    if (name !== currentPage.value && dirty.value) {
        if (
            !(await confirmBox(
                "Leave without saving?",
                `Your changes to ${dirty.value.what} are not saved.`,
                "Discard changes",
                true,
            ))
        ) {
            history.replaceState(null, "", `#${currentPage.value}`);
            return false;
        }
        const d = dirty.value;
        dirty.value = null;
        d.discard();
    }
    currentPage.value = name;
    history.replaceState(null, "", `#${name}`);
    return true;
}
export function openEnv(e: Instance | null, group?: string) {
    if (e && !e.local) {
        toast(
            "This environment comes from the shared config file; edit it there.",
            "info",
        );
        return;
    }
    envEditor.value = { entry: e, group };
}
export function openEnvByName(name: string) {
    const e = instances.value.find((e) => e.name === name);
    if (e) openEnv(e);
}
export async function loadState() {
    state.value = await api<State>("/api/state");
    if (
        currentEnv.value &&
        !instances.value.some((e) => e.name === currentEnv.value)
    )
        setEnv(null);
    try {
        scopes.value = (
            await api<{ scopes: ScopeInfo[] }>("/api/scope?scope=global")
        ).scopes;
    } catch {
        /* invalid config remains editable */
    }
}
export function setLoadError(key: string, e?: unknown) {
    loadErrors.value = {
        ...loadErrors.value,
        [key]: e === undefined ? "" : errorText(e),
    };
}
export async function loadSetup(check = false) {
    try {
        setup.value = await api<Setup>(`/api/setup${check ? "?check=1" : ""}`);
        setLoadError("setup");
    } catch (e) {
        setLoadError("setup", e);
    }
}
export async function runDoctor() {
    try {
        checks.value = (await api<{ checks: Check[] }>("/api/doctor")).checks;
        setLoadError("doctor");
    } catch (e) {
        setLoadError("doctor", e);
        toast(errorText(e), "fail");
    }
}
let dashboardSeq = 0;
export async function loadDashboard() {
    const seq = ++dashboardSeq,
        r = range.value;
    usage.value = null;
    stats.value = null;
    setLoadError("usage");
    setLoadError("stats");
    await Promise.all([
        api<Usage>(`/api/usage?range=${r}`)
            .then((v) => {
                if (seq === dashboardSeq) usage.value = v;
            })
            .catch((e) => {
                if (seq === dashboardSeq) {
                    setLoadError("usage", e);
                    toast(errorText(e), "fail");
                }
            }),
        ...(instances.value.length
            ? [
                  api<LogStats>(`/api/logstats?range=${r}`)
                      .then((v) => {
                          if (seq === dashboardSeq) {
                              stats.value = v;
                              statsAt.value = Date.now();
                          }
                      })
                      .catch((e) => {
                          if (seq === dashboardSeq) setLoadError("stats", e);
                      }),
              ]
            : []),
    ]);
}
export async function loadLearned() {
    try {
        learned.value = await api<Learned>("/api/learned");
        setLoadError("learned");
    } catch (e) {
        setLoadError("learned", e);
    }
}
export async function rerun(c: import("./scripts/types").Call) {
    if (!(await navigate("playground"))) return;
    playground.value = {
        tool: c.tool,
        instance: c.instance,
        args: {
            ...(state.value?.tool_templates[c.tool] || {}),
            ...c.args,
            ...c.params,
        },
    };
}
export async function openProblems() {
    if (await navigate("activity")) {
        filters.value = { q: "", tool: "", status: "nothing", bucket: null };
        activityTab.value = "calls";
    }
}
export function initStore() {
    currentEnv.value = storage.get("gm-env");
    const d = document.documentElement.dataset;
    palette.value = d.palette || "slate";
    mode.value = d.mode || "system";
    theme.value = d.theme || "light";
    density.value = d.density || "comfortable";
    const aliases: Record<string, string> = {
        overview: "home",
        groups: "envs",
        settings: "fields",
        clients: "connect",
    };
    const start = aliases[location.hash.slice(1)] || location.hash.slice(1);
    currentPage.value = start in pages ? start : "home";
}
