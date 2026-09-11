/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

import { accumulate, newShapeNode, renderShape, ShapeNode } from "./shape";

const STORAGE_KEY = "ApiEndpointMapper_gatewayEvents";

export interface GatewayEventRecord {
    type: string;
    totalSeen: number;
    firstSeen: number;
    lastSeen: number;
    /**
     * Shape of the packet's `d` payload. For dispatch events (op 0) this is Discord's decoded
     * event data, keyed by event name (MESSAGE_CREATE, READY, ...). For every other opcode it's
     * keyed "OP_<name>" (OP_HELLO, OP_RECONNECT, ...) so both live side by side in one store -
     * these all come from the same raw gateway packet stream, not from two different sources.
     */
    payloadShape: ShapeNode;
}

const records = new Map<string, GatewayEventRecord>();
let loaded = false;
let loadPromise: Promise<void> | null = null;
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export async function ensureGatewayLoaded(): Promise<void> {
    if (loaded) return;
    loadPromise ??= (async () => {
        const stored = await DataStore.get<Record<string, GatewayEventRecord>>(STORAGE_KEY);
        if (stored) {
            for (const [key, rec] of Object.entries(stored)) records.set(key, rec);
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
            console.error("[ApiEndpointMapper] failed to save gateway event data", e);
        }
    }, 2000);
}

export async function flushGateway(): Promise<void> {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    if (!dirty) return;
    dirty = false;
    try {
        await DataStore.set(STORAGE_KEY, Object.fromEntries(records));
    } catch (e) {
        console.error("[ApiEndpointMapper] failed to save gateway event data", e);
    }
}

export function recordGatewayEvent(type: string, payload: unknown): void {
    let rec = records.get(type);
    if (!rec) {
        rec = { type, totalSeen: 0, firstSeen: Date.now(), lastSeen: Date.now(), payloadShape: newShapeNode() };
        records.set(type, rec);
    }
    rec.totalSeen++;
    rec.lastSeen = Date.now();
    accumulate(rec.payloadShape, payload);
    scheduleSave();
}

export function getGatewayStats() {
    let totalEvents = 0;
    for (const rec of records.values()) totalEvents += rec.totalSeen;
    return { eventTypeCount: records.size, totalEvents };
}

export function buildGatewayExport(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, rec] of [...records.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        out[key] = {
            totalSeen: rec.totalSeen,
            firstSeen: new Date(rec.firstSeen).toISOString(),
            lastSeen: new Date(rec.lastSeen).toISOString(),
            payload: renderShape(rec.payloadShape),
        };
    }
    return out;
}

export async function clearGateway(): Promise<void> {
    records.clear();
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    dirty = false;
    await DataStore.del(STORAGE_KEY);
}

const DISPATCH_STORE_KEY = "ApiEndpointMapper_dispatchEvents";
const OP_STORE_KEY = "ApiEndpointMapper_gatewayOps";
const GATEWAY_RESET_FLAG_KEY = "ApiEndpointMapper_gatewayResetForRawCapture";

/**
 * This plugin's gateway capture has gone through two prior designs: hooking FluxDispatcher
 * (whose action payloads are Discord's own reshaped/enriched data), then briefly splitting
 * dispatch events and opcodes into two DataStore keys, before landing on hooking the raw gateway
 * packet stream directly. Each record's payloadShape is an accumulator - samples from different
 * capture methods get folded into the same counters with no way to tell them apart afterward, so
 * a same-named event (e.g. MESSAGE_CREATE) captured under the old FluxDispatcher path and the
 * current raw-packet path would silently report a shape that's a mix of both. Rather than migrate
 * that unreliable data, this wipes every gateway key (old and short-lived) exactly once so
 * everything reported from here on reflects only the current raw-packet capture. REST endpoint
 * data is untouched. Gated by a flag in DataStore so it only runs once.
 */
export async function resetLegacyGatewayData(): Promise<void> {
    if (await DataStore.get<boolean>(GATEWAY_RESET_FLAG_KEY)) return;

    records.clear();
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    dirty = false;

    await Promise.all([
        DataStore.del(STORAGE_KEY),
        DataStore.del(DISPATCH_STORE_KEY),
        DataStore.del(OP_STORE_KEY),
    ]);
    await DataStore.set(GATEWAY_RESET_FLAG_KEY, true);
}
