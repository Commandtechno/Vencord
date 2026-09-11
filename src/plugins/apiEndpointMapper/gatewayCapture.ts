/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { recordGatewayEvent } from "./gatewayStore";

interface Settings {
    enabled: boolean;
    logToConsole: boolean;
}

const defaultSettings: Settings = { enabled: true, logToConsole: false };
let getSettings: () => Settings = () => defaultSettings;

export function configureGateway(getter: () => Settings): void {
    getSettings = getter;
}

let active = false;

export function startGatewayCapturing(): void {
    active = true;
}

export function stopGatewayCapturing(): void {
    active = false;
}

/**
 * Standard Discord Gateway opcodes for server -> client packets. Anything not in this map (a
 * future/undocumented opcode) still gets recorded under a generic "OP_<n>" name rather than
 * being silently dropped - that's the point of hooking below GatewaySocket's own per-opcode
 * handlers instead of wrapping each of them individually.
 */
const OPCODE_NAMES: Record<number, string> = {
    1: "HEARTBEAT",
    7: "RECONNECT",
    9: "INVALID_SESSION",
    10: "HELLO",
    11: "HEARTBEAT_ACK",
};

const DISPATCH_OPCODE = 0;

/**
 * Invoked from a source patch spliced directly into Discord's GatewaySocket, right after it
 * decodes each incoming frame into {op, s, t, d} and before it branches per opcode. This sees
 * every packet the gateway ever sends - including opcodes none of GatewaySocket's own handlers
 * special-case - unlike hooking FluxDispatcher (dispatch-only) or GatewaySocket's individual
 * _handle* methods (only the opcodes it currently knows about). Dispatch events and every other
 * opcode land in the same gatewayStore - they're all the same raw packet stream, just recorded
 * under "OP_<name>" for anything that isn't a dispatch.
 */
export function handleRawPacket(op: number, type: string | null, seq: number | null, data: unknown): void {
    if (!active) return;

    const settings = getSettings();
    if (!settings.enabled) return;

    try {
        const recordType = op === DISPATCH_OPCODE && type ? type : `OP_${OPCODE_NAMES[op] ?? op}`;
        recordGatewayEvent(recordType, data);
        if (settings.logToConsole) console.debug("[ApiEndpointMapper] gateway", recordType, { op, seq });
    } catch (e) {
        console.error("[ApiEndpointMapper] gateway packet handler failed", e);
    }
}
