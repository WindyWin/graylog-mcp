import { token } from "./store";
export { token } from "./store";

export function initToken() {
    const params = new URLSearchParams(location.hash.slice(1));
    token.value = params.get("token") || "";
    try {
        token.value ||= sessionStorage.getItem("gm-token") || "";
        if (params.has("token"))
            sessionStorage.setItem("gm-token", token.value);
    } catch {
        /* storage blocked */
    }
    if (params.has("token")) history.replaceState(null, "", location.pathname);
}
export function base() {
    return location.pathname.replace(/\/[^/]*$/, "");
}
export async function api<T = Record<string, unknown>>(
    path: string,
    method = "GET",
    body?: unknown,
): Promise<T> {
    const res = await fetch(base() + path, {
        method,
        headers: {
            "X-Admin-Token": token.value,
            "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data as T;
}
export const errorText = (e: unknown) =>
    e instanceof Error ? e.message : String(e);
export const storage = {
    get(key: string) {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    },
    set(key: string, value: string | null) {
        try {
            if (value === null) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
        } catch {
            /* storage blocked */
        }
    },
};
