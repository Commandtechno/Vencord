/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface ErrorCodeStats {
    count: number;
    /** A few distinct example messages seen for this code (deduped, capped). */
    messages: string[];
}

const MAX_MESSAGES = 3;

/**
 * Discord error bodies put a numeric/string "code" pretty much anywhere: top-level
 * ({code, message}), or nested per-field in validation errors
 * (errors.username._errors[].{code,message}). Codes are Discord's own fixed error
 * taxonomy (e.g. 50035, "STRING_LENGTH_IN_RANGE") - not user content - so unlike
 * regular response fields we record the actual values here, since that's the whole
 * point: knowing exactly which codes an endpoint can return.
 */
export function extractErrorCodes(value: unknown, out: Record<string, ErrorCodeStats>, depth = 0): void {
    if (depth > 8 || value == null || typeof value !== "object") return;

    if (Array.isArray(value)) {
        for (const v of value) extractErrorCodes(v, out, depth + 1);
        return;
    }

    const obj = value as Record<string, unknown>;
    const { code } = obj;
    if ((typeof code === "number" || typeof code === "string") && code !== "") {
        const key = String(code);
        let stats = out[key];
        if (!stats) stats = out[key] = { count: 0, messages: [] };
        stats.count++;
        const { message } = obj;
        if (typeof message === "string" && message && !stats.messages.includes(message) && stats.messages.length < MAX_MESSAGES) {
            stats.messages.push(message);
        }
    }

    for (const v of Object.values(obj)) extractErrorCodes(v, out, depth + 1);
}
