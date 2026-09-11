/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

import { ErrorCodeStats, extractErrorCodes } from "./errorCodes";
import { accumulate, accumulateHeader, HeaderStats, newShapeNode, renderHeaderMap, renderShape, ShapeNode } from "./shape";

const STORAGE_KEY = "ApiEndpointMapper_endpoints";
const MAX_SAMPLE_URLS = 3;

export interface EndpointRecord {
    method: string;
    pathTemplate: string;
    /** Constants.Endpoints key this matched (e.g. "GUILD_MEMBER"), or null if unmatched/guessed. */
    endpointKey: string | null;
    sampleUrls: string[];
    statusCodes: Record<number, number>;
    totalRequests: number;
    firstSeen: number;
    lastSeen: number;
    requestHeaders: Record<string, HeaderStats>;
    responseHeaders: Record<string, HeaderStats>;
    querySeenCount: number;
    requestBodySeenCount: number;
    queryShape: ShapeNode;
    requestBodyShape: ShapeNode;
    /** Keyed by status code, since success and error (4xx/5xx) bodies have unrelated shapes. */
    responseBodyShapesByStatus: Record<number, ShapeNode>;
    /** Discord's own error codes (e.g. 50035, "STRING_LENGTH_IN_RANGE"), found anywhere in error bodies. */
    errorCodes: Record<string, ErrorCodeStats>;
}

export interface Sample {
    method: string;
    pathTemplate: string;
    endpointKey: string | null;
    rawUrl: string;
    status: number;
    reqHeaders: Record<string, string>;
    resHeaders: Record<string, string>;
    query: Record<string, unknown> | null;
    reqBody: unknown;
    resBody: unknown;
}

const records = new Map<string, EndpointRecord>();
let loaded = false;
let loadPromise: Promise<void> | null = null;
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function newRecord(method: string, pathTemplate: string, endpointKey: string | null): EndpointRecord {
    return {
        method,
        pathTemplate,
        endpointKey,
        sampleUrls: [],
        statusCodes: {},
        totalRequests: 0,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        requestHeaders: {},
        responseHeaders: {},
        querySeenCount: 0,
        requestBodySeenCount: 0,
        queryShape: newShapeNode(),
        requestBodyShape: newShapeNode(),
        responseBodyShapesByStatus: {},
        errorCodes: {},
    };
}

export async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    loadPromise ??= (async () => {
        const stored = await DataStore.get<Record<string, EndpointRecord>>(STORAGE_KEY);
        if (stored) {
            for (const [key, rec] of Object.entries(stored)) {
                rec.errorCodes ??= {};
                rec.endpointKey ??= null;
                records.set(key, rec);
            }
        }
        loaded = true;
    })();
    return loadPromise;
}

function scheduleSave(): void {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
        saveTimer = null;
        if (!dirty) return;
        dirty = false;
        try {
            await DataStore.set(STORAGE_KEY, Object.fromEntries(records));
        } catch (e) {
            console.error("[ApiEndpointMapper] failed to save endpoint data", e);
        }
    }, 2000);
}

export async function flush(): Promise<void> {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    if (!dirty) return;
    dirty = false;
    try {
        await DataStore.set(STORAGE_KEY, Object.fromEntries(records));
    } catch (e) {
        console.error("[ApiEndpointMapper] failed to save endpoint data", e);
    }
}

export function recordSample(sample: Sample): void {
    const key = `${sample.method} ${sample.pathTemplate}`;
    let rec = records.get(key);
    if (!rec) {
        rec = newRecord(sample.method, sample.pathTemplate, sample.endpointKey);
        records.set(key, rec);
    }

    rec.totalRequests++;
    rec.lastSeen = Date.now();
    rec.statusCodes[sample.status] = (rec.statusCodes[sample.status] ?? 0) + 1;

    if (rec.sampleUrls.length < MAX_SAMPLE_URLS && !rec.sampleUrls.includes(sample.rawUrl)) {
        rec.sampleUrls.push(sample.rawUrl);
    }

    for (const [name, value] of Object.entries(sample.reqHeaders)) {
        accumulateHeader(rec.requestHeaders, name, value);
    }
    for (const [name, value] of Object.entries(sample.resHeaders)) {
        accumulateHeader(rec.responseHeaders, name, value);
    }

    if (sample.query && Object.keys(sample.query).length > 0) {
        rec.querySeenCount++;
        accumulate(rec.queryShape, sample.query);
    }
    if (sample.reqBody !== undefined) {
        rec.requestBodySeenCount++;
        accumulate(rec.requestBodyShape, sample.reqBody);
    }
    if (sample.resBody !== undefined) {
        let shape = rec.responseBodyShapesByStatus[sample.status];
        if (!shape) shape = rec.responseBodyShapesByStatus[sample.status] = newShapeNode();
        accumulate(shape, sample.resBody);

        if (sample.status >= 400) extractErrorCodes(sample.resBody, rec.errorCodes);
    }

    scheduleSave();
}

export function getStats() {
    let totalRequests = 0;
    let matchedEndpointCount = 0;
    const errorCodes = new Set<string>();
    for (const rec of records.values()) {
        totalRequests += rec.totalRequests;
        if (rec.endpointKey !== null) matchedEndpointCount++;
        for (const code of Object.keys(rec.errorCodes)) errorCodes.add(code);
    }
    return { endpointCount: records.size, matchedEndpointCount, totalRequests, errorCodeCount: errorCodes.size };
}

export function buildExport(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, rec] of [...records.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const responsesByStatus: Record<string, unknown> = {};
        for (const [status, shape] of Object.entries(rec.responseBodyShapesByStatus).sort(([a], [b]) => Number(a) - Number(b))) {
            responsesByStatus[status] = {
                kind: Number(status) >= 400 ? "error" : "success",
                count: rec.statusCodes[Number(status)] ?? 0,
                body: renderShape(shape),
            };
        }

        out[key] = {
            method: rec.method,
            pathTemplate: rec.pathTemplate,
            endpointKey: rec.endpointKey,
            matchedKnownEndpoint: rec.endpointKey !== null,
            sampleUrls: rec.sampleUrls,
            totalRequests: rec.totalRequests,
            statusCodes: rec.statusCodes,
            firstSeen: new Date(rec.firstSeen).toISOString(),
            lastSeen: new Date(rec.lastSeen).toISOString(),
            requestHeaders: renderHeaderMap(rec.requestHeaders, rec.totalRequests),
            responseHeaders: renderHeaderMap(rec.responseHeaders, rec.totalRequests),
            query: rec.querySeenCount > 0 ? renderShape(rec.queryShape) : undefined,
            requestBody: rec.requestBodySeenCount > 0 ? renderShape(rec.requestBodyShape) : undefined,
            responsesByStatus,
            errorCodes: Object.keys(rec.errorCodes).length > 0 ? rec.errorCodes : undefined,
        };
    }
    return out;
}

export async function clearAll(): Promise<void> {
    records.clear();
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    dirty = false;
    await DataStore.del(STORAGE_KEY);
}
