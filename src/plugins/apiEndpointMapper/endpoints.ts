/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Constants } from "@webpack/common";

/**
 * Discord's client already ships the exact path-building functions it uses for every REST
 * endpoint (Constants.Endpoints, e.g. MESSAGES: channelId => `/channels/${channelId}/messages`).
 * Rather than guessing which URL segments are parameters via regex heuristics, we call each of
 * those functions with unique sentinel values, see exactly which segments they templated, and
 * match observed request paths against the resulting real templates. Endpoints not found in this
 * map (e.g. undocumented/analytics routes) fall back to a conservative, non-guessing normalizer
 * that only ever collapses unambiguous numeric snowflakes.
 */
export interface EndpointTemplate {
    key: string;
    display: string;
    regex: RegExp;
}

let templates: EndpointTemplate[] | null = null;
let loadPromise: Promise<void> | null = null;

function sentinel(i: number): string {
    return `XENDPOINTMAPPERSENTINEL${i}X`;
}

function extractParamNames(fn: (...args: any[]) => any): string[] {
    const match = fn.toString().match(/^\s*(?:async\s*)?(?:function\s*[^(]*)?\(([^)]*)\)/);
    if (!match) return [];
    return match[1]
        .split(",")
        .map(s => s.trim().split(/[=:]/)[0].trim())
        .filter(s => /^[A-Za-z_$][\w$]*$/.test(s));
}

function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTemplate(key: string, raw: unknown): EndpointTemplate | null {
    if (typeof raw === "string") {
        if (!raw.startsWith("/")) return null;
        return { key, display: raw, regex: new RegExp(`^${escapeRegExp(raw)}$`) };
    }

    if (typeof raw !== "function") return null;
    const fn = raw as (...args: any[]) => any;

    const arity = fn.length;
    const sentinels = Array.from({ length: arity }, (_, i) => sentinel(i));
    const paramNames = extractParamNames(fn);

    let result: unknown;
    try {
        result = fn(...sentinels);
    } catch {
        return null;
    }
    if (typeof result !== "string" || !result.startsWith("/")) return null;

    let display = result;
    let pattern = "";
    let lastIndex = 0;
    const sentinelRe = /XENDPOINTMAPPERSENTINEL(\d+)X/g;
    let m: RegExpExecArray | null;
    while ((m = sentinelRe.exec(result))) {
        pattern += escapeRegExp(result.slice(lastIndex, m.index));
        pattern += "([^/]+)";
        const idx = Number(m[1]);
        const name = paramNames[idx] && paramNames[idx].length > 1 ? paramNames[idx] : `param${idx}`;
        display = display.replace(m[0], `:${name}`);
        lastIndex = sentinelRe.lastIndex;
    }
    pattern += escapeRegExp(result.slice(lastIndex));

    // A function that produced no sentinels in its output isn't a real per-resource path builder.
    if (lastIndex === 0 && arity > 0) return null;

    return { key, display, regex: new RegExp(`^${pattern}$`) };
}

function build(): EndpointTemplate[] {
    const endpoints = Constants?.Endpoints;
    if (!endpoints || typeof endpoints !== "object") return [];

    const out: EndpointTemplate[] = [];
    for (const [key, value] of Object.entries(endpoints)) {
        const tpl = buildTemplate(key, value);
        if (tpl) out.push(tpl);
    }
    return out;
}

export async function loadEndpointTemplates(): Promise<void> {
    if (templates) return;
    loadPromise ??= (async () => {
        try {
            templates = build();
        } catch (e) {
            console.error("[ApiEndpointMapper] failed to build endpoint templates", e);
            templates = [];
        }
    })();
    return loadPromise;
}

export function matchKnownEndpoint(apiSuffix: string): { key: string; display: string; } | null {
    if (!templates) return null;
    for (const tpl of templates) {
        if (tpl.regex.test(apiSuffix)) return { key: tpl.key, display: tpl.display };
    }
    return null;
}

export function getTemplateCount(): number {
    return templates?.length ?? 0;
}
