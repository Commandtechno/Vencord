/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { loadEndpointTemplates, matchKnownEndpoint } from "./endpoints";
import { recordSample } from "./store";

let patched = false;
let origFetch: typeof window.fetch | null = null;
let origOpen: typeof XMLHttpRequest.prototype.open | null = null;
let origSetHeader: typeof XMLHttpRequest.prototype.setRequestHeader | null = null;
let origSend: typeof XMLHttpRequest.prototype.send | null = null;

interface Settings {
    captureQuery: boolean;
    captureRequestBody: boolean;
    captureResponseBody: boolean;
    captureHeaders: boolean;
    logToConsole: boolean;
}

const defaultSettings: Settings = {
    captureQuery: true,
    captureRequestBody: true,
    captureResponseBody: true,
    captureHeaders: true,
    logToConsole: false,
};

let getSettings: () => Settings = () => defaultSettings;

/** Pass a getter (not a snapshot) so toggling settings in the UI takes effect on the next request. */
export function configure(getter: () => Settings): void {
    getSettings = getter;
}

function isApiUrl(url: URL): boolean {
    return /^\/api\//i.test(url.pathname);
}

/** Only collapses segments that are unambiguously identifiers (numeric snowflakes / uuids) - no
 * guessing. Used only as a fallback for paths that don't match any known Constants.Endpoints
 * template (e.g. undocumented or analytics routes). */
function conservativeFallback(pathname: string): string {
    const segments = pathname.split("/").filter(Boolean);
    const templated = segments.map(seg => {
        if (/^\d{15,25}$/.test(seg)) return ":id";
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":uuid";
        return seg;
    });
    return "/" + templated.join("/");
}

interface PathMatch {
    template: string;
    endpointKey: string | null;
}

/** Matches against Discord's real Constants.Endpoints path builders (ground truth) first, and
 * only falls back to conservativeFallback for routes not found there. */
function normalizePath(pathname: string): PathMatch {
    const apiMatch = pathname.match(/^(\/api\/v\d+)(\/.*)$/);
    if (!apiMatch) return { template: conservativeFallback(pathname), endpointKey: null };

    const [, prefix, suffix] = apiMatch;
    const known = matchKnownEndpoint(suffix);
    if (known) return { template: `${prefix}${known.display}`, endpointKey: known.key };

    return { template: `${prefix}${conservativeFallback(suffix)}`, endpointKey: null };
}

function extractHeaders(headers: HeadersInit | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!headers) return out;
    if (headers instanceof Headers) {
        headers.forEach((v, k) => out[k] = v);
    } else if (Array.isArray(headers)) {
        for (const [k, v] of headers) out[k] = v;
    } else {
        Object.assign(out, headers);
    }
    return out;
}

function tryParseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function extractRequestBody(body: BodyInit | null | undefined): unknown {
    if (body == null) return undefined;
    if (typeof body === "string") return tryParseJson(body);
    if (body instanceof FormData) {
        const out: Record<string, string> = {};
        for (const [k, v] of body.entries()) out[k] = v instanceof File ? "file" : "string";
        return out;
    }
    if (body instanceof URLSearchParams) {
        const out: Record<string, string> = {};
        for (const [k] of body.entries()) out[k] = "string";
        return out;
    }
    return undefined;
}

function queryFromUrl(url: URL): Record<string, unknown> | null {
    if (!getSettings().captureQuery) return null;
    const out: Record<string, unknown> = {};
    let any = false;
    url.searchParams.forEach((v, k) => { out[k] = v; any = true; });
    return any ? out : null;
}

function safeRecord(sample: Parameters<typeof recordSample>[0]): void {
    try {
        recordSample(sample);
        if (getSettings().logToConsole) console.debug("[ApiEndpointMapper]", sample.method, sample.pathTemplate, sample.status);
    } catch (e) {
        console.error("[ApiEndpointMapper] failed to record sample", e);
    }
}

function handleFetch(input: RequestInfo | URL, init: RequestInit | undefined, response: Response): void {
    const settings = getSettings();
    let rawUrl: string;
    let method: string;
    let reqHeaders: Record<string, string> = {};
    let reqBodySource: BodyInit | null | undefined;

    if (input instanceof Request) {
        rawUrl = input.url;
        method = (init?.method ?? input.method ?? "GET").toUpperCase();
        reqHeaders = settings.captureHeaders ? extractHeaders(init?.headers ?? input.headers) : {};
        reqBodySource = init?.body;
    } else {
        rawUrl = input instanceof URL ? input.href : input;
        method = (init?.method ?? "GET").toUpperCase();
        reqHeaders = settings.captureHeaders ? extractHeaders(init?.headers) : {};
        reqBodySource = init?.body;
    }

    let url: URL;
    try {
        url = new URL(rawUrl, location.href);
    } catch {
        return;
    }
    if (!isApiUrl(url)) return;

    const { template: pathTemplate, endpointKey } = normalizePath(url.pathname);
    const { status } = response;
    const resHeaders: Record<string, string> = {};
    if (settings.captureHeaders) response.headers.forEach((v, k) => resHeaders[k] = v);
    const contentType = response.headers.get("content-type") ?? "";
    const query = queryFromUrl(url);
    const reqBody = settings.captureRequestBody ? extractRequestBody(reqBodySource) : undefined;

    const finish = (resBody: unknown) => {
        safeRecord({
            method, pathTemplate, endpointKey, rawUrl: url.pathname, status,
            reqHeaders, resHeaders, query, reqBody, resBody,
        });
    };

    if (settings.captureResponseBody && contentType.includes("json")) {
        response.clone().json().then(finish).catch(() => finish(undefined));
    } else {
        finish(undefined);
    }
}

function patchFetch(): void {
    origFetch = window.fetch;
    window.fetch = function (this: Window, input: RequestInfo | URL, init?: RequestInit) {
        const promise = origFetch!.call(this, input as any, init as any);
        promise.then(
            response => { try { handleFetch(input, init, response.clone()); } catch (e) { console.error("[ApiEndpointMapper]", e); } },
            () => { /* network error, nothing to record */ }
        );
        return promise;
    };
}

interface XhrMeta {
    method: string;
    url: string;
    headers: Record<string, string>;
}

const xhrMeta = new WeakMap<XMLHttpRequest, XhrMeta>();

function patchXhr(): void {
    origOpen = XMLHttpRequest.prototype.open;
    origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: any[]) {
        xhrMeta.set(this, { method: method.toUpperCase(), url: String(url), headers: {} });
        return origOpen!.apply(this, [method, url, ...rest] as any);
    } as typeof XMLHttpRequest.prototype.open;

    XMLHttpRequest.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
        const meta = xhrMeta.get(this);
        if (meta) meta.headers[name] = value;
        return origSetHeader!.call(this, name, value);
    };

    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: any) {
        const meta = xhrMeta.get(this);
        if (meta) {
            let url: URL | null = null;
            try {
                url = new URL(meta.url, location.href);
            } catch { /* ignore */ }

            if (url && isApiUrl(url)) {
                const capturedUrl = url;
                this.addEventListener("loadend", () => {
                    try {
                        const settings = getSettings();
                        const { template: pathTemplate, endpointKey } = normalizePath(capturedUrl.pathname);
                        const resHeaders: Record<string, string> = {};
                        if (settings.captureHeaders) {
                            const raw = this.getAllResponseHeaders();
                            raw.trim().split(/[\r\n]+/).forEach(line => {
                                const idx = line.indexOf(":");
                                if (idx === -1) return;
                                resHeaders[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                            });
                        }
                        const contentType = this.getResponseHeader("content-type") ?? "";
                        let resBody: unknown;
                        if (settings.captureResponseBody && contentType.includes("json") && this.responseText) {
                            resBody = tryParseJson(this.responseText);
                        }
                        safeRecord({
                            method: meta.method,
                            pathTemplate,
                            endpointKey,
                            rawUrl: capturedUrl.pathname,
                            status: this.status,
                            reqHeaders: settings.captureHeaders ? meta.headers : {},
                            resHeaders,
                            query: queryFromUrl(capturedUrl),
                            reqBody: settings.captureRequestBody ? extractRequestBody(body) : undefined,
                            resBody,
                        });
                    } catch (e) {
                        console.error("[ApiEndpointMapper]", e);
                    }
                });
            }
        }
        return origSend!.call(this, body);
    };
}

export async function startCapturing(): Promise<void> {
    await loadEndpointTemplates();
    if (patched) return;
    patched = true;
    patchFetch();
    patchXhr();
}

export function stopCapturing(): void {
    if (!patched) return;
    patched = false;
    if (origFetch) window.fetch = origFetch;
    if (origOpen) XMLHttpRequest.prototype.open = origOpen;
    if (origSetHeader) XMLHttpRequest.prototype.setRequestHeader = origSetHeader;
    if (origSend) XMLHttpRequest.prototype.send = origSend;
}
