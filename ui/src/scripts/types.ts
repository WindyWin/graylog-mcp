// What the admin API (src/graylog_mcp/admin/app.py) returns. Keep these in step with it.

export type Json =
    | string
    | number
    | boolean
    | null
    | Json[]
    | { [key: string]: Json };
export type Fields = Record<string, any>;

export interface Instance {
    name: string;
    invalid?: boolean;
    group: string | null;
    environment: string | null;
    url: string;
    description: string;
    auth: string;
    secret_env: string | null;
    secret_set: boolean;
    secret_source: string | null;
    default: boolean;
    local: boolean;
    fields: Fields;
}

export interface Repo {
    entry: string;
    kind: "url" | "path";
    path?: string;
    exists?: boolean;
    remote?: string | null;
    project_config?: boolean;
    claude_code?: string;
    focus?: Fields | null;
}

export interface Group {
    name: string;
    description: string;
    default_environment: string | null;
    environments: string[];
    repos: Repo[];
}

export interface ClientSpec {
    key: string;
    title: string;
    scopes: string[];
    note: string;
    paths: Record<string, string>;
}

export interface State {
    version: string;
    shared: {
        running: boolean;
        url?: string;
        version?: string;
        commit?: string | null;
    };
    project_dir: string;
    config_path: string;
    exists: boolean;
    error: string | null;
    data: Fields;
    instances: Instance[];
    groups: Group[];
    environments: Record<string, string[]>;
    default_group: string | null;
    secret_envs: { name: string; source: string }[];
    secrets_file: string;
    clients: ClientSpec[];
    packs: string[];
    profiles: Record<string, string>;
    tools: string[];
    tool_templates: Record<string, Fields>;
    quick_tools: string[];
    local_timezone: string;
}

export interface Check {
    name: string;
    status: string;
    detail: string;
    instance?: string;
    fix?: string;
    args?: Fields;
    [more: string]: any;
}

export interface ClaudeStatus {
    cli: boolean;
    registered: boolean;
    user_stale: boolean;
    user_entry: boolean;
    stdio_projects: string[];
    stale_projects: string[];
    stale_files: string[];
    user_local: boolean;
    local_projects: string[];
    missing_projects: string[];
    repos: number;
    command: string;
}

export interface Setup {
    server: {
        running: boolean;
        embedded: boolean;
        version?: string;
        commit?: string | null;
    };
    install: {
        version: string;
        commit: string | null;
        label: string;
        via: string;
    };
    autostart: { kind: string | null; enabled: boolean };
    claude: ClaudeStatus;
    log: string;
    [more: string]: any;
}

export interface Bucket {
    t: number;
    calls: number;
    errors: number;
    misses: number;
}
export interface Totals {
    calls: number;
    errors: number;
    searches: number;
    misses: number;
    hit_rate: number | null;
}
export interface ToolStat {
    tool: string;
    calls: number;
    errors: number;
    misses: number;
    p50_ms: number;
    p95_ms: number;
}

/** One recorded tool call. */
export interface Call {
    ts: number;
    tool: string;
    instance?: string;
    ok: boolean;
    ms?: number;
    results?: number;
    args?: Fields;
    params?: Fields;
    error?: string;
    [more: string]: any;
}

export interface Usage {
    enabled: boolean;
    range_hours: number;
    bucket_hours: number;
    buckets: Bucket[];
    tools: ToolStat[];
    totals: Totals;
    previous: Totals;
    misses: Call[];
    recent: Call[];
}

export interface LogStatsEnv {
    name: string;
    total: number;
    errors: number;
    error_query: string;
    buckets: [string, number][];
    error_buckets: [string, number][];
    error?: string;
}
export interface LogStats {
    range: string;
    bucket_hours: number;
    environments: LogStatsEnv[];
}

export interface LearnedRule {
    key: string;
    instance: string;
    kind: string;
    weight: number;
    auto: boolean;
    used?: number;
    offered?: number;
    [more: string]: any;
}
export interface Learned {
    enabled: boolean;
    auto_weight: number;
    auto_min_uses: number;
    rules: LearnedRule[];
}

export interface ScopeInfo {
    scope: string;
    label: string;
}
export interface ScopeData {
    scope: string;
    keys: string[];
    values: Fields;
    effective: Fields;
    scopes: ScopeInfo[];
    from?: Record<string, string>; // added by the page: where each key's inherited value comes from
}

export interface ClientSnippet {
    path: string;
    snippet: string;
}
export type ClientData = { [client: string]: any } & {
    shared: { running: boolean; [more: string]: any };
    "claude-code-command": string;
};

export interface RunResult {
    result: Json;
    chars: number;
    approx_tokens: number;
    ms: number;
}
export interface TestResult {
    ok: boolean;
    error?: string;
    fix?: string;
    version?: string;
    message_api?: string;
    aggregation_api?: string;
    streams?: number;
    messages_24h?: number;
    [more: string]: any;
}
export interface RawConfig {
    text: string;
    path: string;
}

// /api/breakdown: one environment by service, level and error type
export interface TopValue {
    value: string | number;
    count: number;
    pct: number | null;
}
export interface ErrorGroup {
    value: string;
    count: number;
    first: string | null;
    last: string | null;
    sample?: { message?: string; source?: string } | null;
}
export interface Breakdown {
    instance: string;
    range: string;
    error?: string;
    error_query?: string;
    service_field?: string;
    total?: number;
    services?: (TopValue & { errors: number })[];
    levels?: TopValue[];
    errors_total?: number;
    error_field?: string | null;
    error_groups?: ErrorGroup[];
}
// one line of search_logs with dedup_lines=false
export interface LogLine {
    ts: string;
    level?: number | string;
    message?: string;
    source?: string;
    ref: string;
    [field: string]: unknown;
}

export interface LogsView {
    instance: string;
    title: string;
    query: string;
    range?: string;
    from?: string;
    to?: string;
    when?: string;
    errorQuery?: string;
    errorsOnly?: boolean;
    column?: string;
}
