/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import definePlugin, { OptionType } from "@utils/types";
import { saveFile } from "@utils/web";
import { Toasts, useEffect, useState } from "@webpack/common";

import { configureGateway, handleRawPacket, startGatewayCapturing, stopGatewayCapturing } from "./gatewayCapture";
import { buildGatewayExport, clearGateway, ensureGatewayLoaded, flushGateway, getGatewayStats, resetLegacyGatewayData } from "./gatewayStore";
import { configure, startCapturing, stopCapturing } from "./network";
import { buildExport, clearAll, ensureLoaded, flush, getStats } from "./store";

function toast(message: string, type: string = Toasts.Type.SUCCESS) {
    Toasts.show({ message, id: Toasts.genId(), type });
}

async function doExport() {
    await Promise.all([ensureLoaded(), ensureGatewayLoaded()]);
    await Promise.all([flush(), flushGateway()]);

    const { endpointCount } = getStats();
    const { eventTypeCount } = getGatewayStats();
    if (endpointCount === 0 && eventTypeCount === 0) {
        toast("Nothing captured yet — browse around Discord first.", Toasts.Type.FAILURE);
        return;
    }

    const json = JSON.stringify({
        restEndpoints: buildExport(),
        gatewayEvents: buildGatewayExport(),
    }, null, 2);
    const file = new File([json], `api-endpoint-map-${Date.now()}.json`, { type: "application/json" });
    saveFile(file);
    toast(`Exported ${endpointCount} REST endpoints and ${eventTypeCount} gateway event types.`);
}

async function doClear() {
    await Promise.all([clearAll(), clearGateway()]);
    toast("Cleared all captured API and gateway data.");
}

function StatsAndActions() {
    const [stats, setStats] = useState({ endpointCount: 0, matchedEndpointCount: 0, totalRequests: 0, errorCodeCount: 0 });
    const [gatewayStats, setGatewayStats] = useState({ eventTypeCount: 0, totalEvents: 0 });

    useEffect(() => {
        let cancelled = false;
        const refresh = () => {
            if (cancelled) return;
            setStats(getStats());
            setGatewayStats(getGatewayStats());
        };
        Promise.all([ensureLoaded(), ensureGatewayLoaded()]).then(refresh);
        const interval = setInterval(refresh, 2000);
        return () => { cancelled = true; clearInterval(interval); };
    }, []);

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5em" }}>
            <div>
                REST: <strong>{stats.endpointCount}</strong> endpoints ({stats.matchedEndpointCount} matched to a known Discord endpoint)
                {" "}across <strong>{stats.totalRequests}</strong> requests, <strong>{stats.errorCodeCount}</strong> distinct error codes.
            </div>
            <div>
                Gateway: <strong>{gatewayStats.eventTypeCount}</strong> event types across <strong>{gatewayStats.totalEvents}</strong> packets.
            </div>
            <div style={{ display: "flex", gap: "0.5em" }}>
                <Button onClick={doExport}>Export JSON</Button>
                <Button variant="dangerPrimary" onClick={doClear}>Clear captured data</Button>
            </div>
        </div>
    );
}

const settings = definePluginSettings({
    stats: {
        type: OptionType.COMPONENT,
        component: StatsAndActions,
    },
    captureQuery: {
        type: OptionType.BOOLEAN,
        description: "Record query string parameter shapes",
        default: true,
    },
    captureRequestBody: {
        type: OptionType.BOOLEAN,
        description: "Record request body field shapes",
        default: true,
    },
    captureResponseBody: {
        type: OptionType.BOOLEAN,
        description: "Record response body field shapes",
        default: true,
    },
    captureHeaders: {
        type: OptionType.BOOLEAN,
        description: "Record which request/response header names are present (never their values)",
        default: true,
    },
    logToConsole: {
        type: OptionType.BOOLEAN,
        description: "Log every captured request to the console (debug)",
        default: false,
    },
    captureGatewayEvents: {
        type: OptionType.BOOLEAN,
        description: "Record gateway (WebSocket real-time) event shapes, e.g. MESSAGE_CREATE, TYPING_START, PRESENCE_UPDATE, plus non-dispatch opcodes like HELLO/RECONNECT/INVALID_SESSION. Captured straight from GatewaySocket's own decoded packets, before any opcode-specific handling.",
        default: true,
    },
    logGatewayToConsole: {
        type: OptionType.BOOLEAN,
        description: "Log every captured gateway event to the console (debug)",
        default: false,
    },
});

export default definePlugin({
    name: "ApiEndpointMapper",
    description: "Passively maps every Discord API endpoint and gateway event the client uses: URL templates, event types, status/error codes, and inferred field shapes (nullable/optional aware). Captures literal values only for short, low-cardinality enum-like fields (e.g. status codes) - tokens, secrets, IDs, and free-text fields are never captured, only their type.",
    authors: [{ name: "you", id: 0n }],
    settings,

    // Splices a call into GatewaySocket right after it decodes each incoming frame into
    // {op, s, t, d} and before it branches per opcode - see gatewayCapture.ts for why this sits
    // below FluxDispatcher and below GatewaySocket's own per-opcode handlers.
    patches: [
        {
            find: "GatewaySocket.onMessage",
            replacement: {
                match: /\{op:(\i),s:(\i),t:(\i),d:(\i)\}=\i\.unpack\(\i\);/,
                replace: "$&$self.recordRawPacket($1,$3,$2,$4);"
            }
        }
    ],

    recordRawPacket(op: number, type: string | null, seq: number | null, data: unknown) {
        handleRawPacket(op, type, seq, data);
    },

    async start() {
        try {
            await ensureLoaded();
        } catch (e) {
            console.error("[ApiEndpointMapper] failed to load stored REST data", e);
        }

        try {
            // Must run before ensureGatewayLoaded() - it wipes stale/mixed-shape gateway data,
            // so nothing stale gets loaded into memory first.
            await resetLegacyGatewayData();
        } catch (e) {
            console.error("[ApiEndpointMapper] gateway data reset failed", e);
        }

        try {
            await ensureGatewayLoaded();
        } catch (e) {
            console.error("[ApiEndpointMapper] failed to load stored gateway data", e);
        }

        // Capturing must start regardless of the above - a load/reset/REST-setup failure
        // shouldn't also mean silently recording nothing for the rest of the session.
        configure(() => settings.store);
        configureGateway(() => ({
            enabled: settings.store.captureGatewayEvents,
            logToConsole: settings.store.logGatewayToConsole,
        }));
        try {
            await startCapturing();
        } catch (e) {
            console.error("[ApiEndpointMapper] failed to start REST capturing", e);
        }
        startGatewayCapturing();
    },

    async stop() {
        stopCapturing();
        stopGatewayCapturing();
        await Promise.all([flush(), flushGateway()]);
    },
});
