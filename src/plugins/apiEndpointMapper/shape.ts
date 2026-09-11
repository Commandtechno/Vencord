/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * A ShapeNode is an accumulator, not a single sample. Every JSON value ever observed at a given
 * position (a response body, a field within it, an array element, ...) gets folded into the same
 * node via accumulate(). That's what lets us notice "this field is a string most of the time but
 * was null once" (nullable) or "this field is missing on some responses" (optional) without ever
 * retaining the actual values.
 */
export interface ShapeNode {
    totalSamples: number;
    primitiveTypes: Record<string, number>;
    arrayItem?: ShapeNode;
    arrayEmptyCount?: number;
    objectFields?: Record<string, { shape: ShapeNode; count: number; }>;
    objectSampleCount?: number;
    /**
     * Counts of which exact set of fields showed up together on a given object sample (e.g.
     * "avatar,bot,id,username" -> 12), keyed by the sorted field list. objectFields alone only
     * says each field is independently optional - this says which optional fields tend to be
     * present or absent as a group, which is what actually matters when deciding what a handler
     * can rely on being there.
     */
    fieldSetCounts?: Record<string, number>;
    /** Set once fieldSetCounts hits MAX_FIELD_SETS - there are more distinct combinations than shown. */
    fieldSetOverflow?: boolean;
    /**
     * Distinct literal values seen for a string/number field, e.g. status: "online" (40), "idle"
     * (10), "dnd" (2). Only populated for fields that look like real enums - see
     * recordEnumValue()/looksEnumLike() - and discarded entirely (not partially shown) once more
     * than MAX_ENUM_VALUES distinct values turn up, since that means it isn't a bounded enum.
     */
    enumValues?: Record<string, number>;
    /** Set once enumValues is discarded for exceeding MAX_ENUM_VALUES. */
    enumOverflow?: boolean;
}

const MAX_FIELD_SETS = 16;
const MAX_ENUM_VALUES = 24;
const MAX_ENUM_VALUE_LENGTH = 40;

/** Field-name patterns whose values are never captured, regardless of what they look like. */
const SENSITIVE_FIELD_NAME_RE = /token|secret|passw(or)?d|auth(?:orization)?|cookie|session[_-]?id|api[_-]?key|private[_-]?key|credential|\bmfa\b|backup[_-]?code|\btotp\b|webhook|fingerprint|ip[_-]?address|\bemail\b|\bphone\b/i;

/**
 * Only string/number values that plausibly *are* an enum literal get captured - short, low
 * cardinality, and not shaped like an opaque identifier or secret. IDs, JWTs, base64 blobs,
 * emails, and free text all fail this and only ever contribute to the type/count stats above.
 */
function looksEnumLike(value: string): boolean {
    if (value.length === 0 || value.length > MAX_ENUM_VALUE_LENGTH) return false;
    if (/^\d{7,}$/.test(value)) return false; // snowflake/large-numeric-id-like
    if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(value)) return false; // jwt-like
    if (/^[A-Za-z0-9+/_-]{20,}={0,2}$/.test(value)) return false; // base64-like blob
    if (value.includes("@") && value.includes(".")) return false; // email-like
    return true;
}

function recordEnumValue(node: ShapeNode, fieldName: string | undefined, value: string | number, kind: "string" | "number"): void {
    if (isSensitiveFieldName(fieldName)) return;
    if (kind === "string" && !looksEnumLike(value as string)) return;
    if (node.enumOverflow) return;

    node.enumValues ??= {};
    const key = String(value);
    if (node.enumValues[key] !== undefined) {
        node.enumValues[key]++;
        return;
    }
    if (Object.keys(node.enumValues).length >= MAX_ENUM_VALUES) {
        // Not actually a bounded enum - drop what was collected rather than show a partial,
        // possibly-misleading sample of values.
        node.enumOverflow = true;
        delete node.enumValues;
        return;
    }
    node.enumValues[key] = 1;
}

function isSensitiveFieldName(fieldName: string | undefined): boolean {
    return !!fieldName && SENSITIVE_FIELD_NAME_RE.test(fieldName);
}

/**
 * Records the fixed "null"/"undefined" tokens into enumValues. Unlike recordEnumValue(), this
 * always runs - null/undefined carry no user data, so neither the sensitive-field-name nor the
 * looks-enum-like check applies - but it still respects an already-overflowed node so a field
 * with too many real values doesn't get a partial "null (5)" left behind on its own.
 */
function recordLiteralToken(node: ShapeNode, token: "null" | "undefined"): void {
    if (node.enumOverflow) return;
    node.enumValues ??= {};
    node.enumValues[token] = (node.enumValues[token] ?? 0) + 1;
}

function recordFieldSet(node: ShapeNode, keys: string[]): void {
    // A single possible field set says nothing beyond what objectFields already conveys.
    if (keys.length === 0) return;

    const signature = [...keys].sort().join(",");
    node.fieldSetCounts ??= {};
    if (node.fieldSetCounts[signature] !== undefined) {
        node.fieldSetCounts[signature]++;
        return;
    }
    if (Object.keys(node.fieldSetCounts).length >= MAX_FIELD_SETS) {
        node.fieldSetOverflow = true;
        return;
    }
    node.fieldSetCounts[signature] = 1;
}

export function newShapeNode(): ShapeNode {
    return { totalSamples: 0, primitiveTypes: {} };
}

/**
 * Some values fed in (e.g. raw Flux gateway actions) aren't plain JSON - they can be class
 * instances with back-references or otherwise deeply/self-nested structures. Without a limit,
 * accumulate() would recurse forever on a cycle, or build a ShapeNode tree so deep that the
 * browser's structured-clone step in IndexedDB's put() overflows the call stack later on.
 */
const MAX_SHAPE_DEPTH = 12;

export function accumulate(node: ShapeNode, value: unknown, seen: Set<object> = new Set(), depth = 0, fieldName?: string): void {
    node.totalSamples++;

    if (value === null || value === undefined) {
        const key = value === null ? "null" : "undefined";
        node.primitiveTypes[key] = (node.primitiveTypes[key] ?? 0) + 1;
        // Folded into enumValues too (not just primitiveTypes) so "values seen" shows how often
        // a field is null/undefined right alongside its real literal values, instead of only
        // being visible separately in the "string | null" type union.
        recordLiteralToken(node, key);
        return;
    }

    if (typeof value === "object") {
        if (seen.has(value) || depth >= MAX_SHAPE_DEPTH) {
            node.primitiveTypes["circular/truncated"] = (node.primitiveTypes["circular/truncated"] ?? 0) + 1;
            return;
        }
        seen.add(value);

        try {
            if (Array.isArray(value)) {
                node.arrayItem ??= newShapeNode();
                if (value.length === 0) {
                    node.arrayEmptyCount = (node.arrayEmptyCount ?? 0) + 1;
                    return;
                }
                for (const v of value) accumulate(node.arrayItem, v, seen, depth + 1, fieldName);
                return;
            }

            node.objectSampleCount = (node.objectSampleCount ?? 0) + 1;
            node.objectFields ??= {};
            const keys = Object.keys(value);
            for (const k of keys) {
                let field = node.objectFields[k];
                if (!field) field = node.objectFields[k] = { shape: newShapeNode(), count: 0 };
                field.count++;
                accumulate(field.shape, (value as Record<string, unknown>)[k], seen, depth + 1, k);
            }
            recordFieldSet(node, keys);
            return;
        } finally {
            seen.delete(value);
        }
    }

    const t = typeof value;
    node.primitiveTypes[t] = (node.primitiveTypes[t] ?? 0) + 1;
    if (t === "string" || t === "number") recordEnumValue(node, fieldName, value as string | number, t);
}

/** Renders an accumulator as a TypeScript-ish type string, marking optional (?) and unions (|). */
export function renderShape(node: ShapeNode, indent = 0): string {
    if (node.totalSamples === 0) return "unknown";

    const parts: string[] = [];
    const pad = "  ".repeat(indent);
    const childPad = "  ".repeat(indent + 1);

    for (const t of Object.keys(node.primitiveTypes)) parts.push(t);

    if (node.arrayItem) {
        const itemStr = node.arrayItem.totalSamples === 0 ? "unknown" : renderShape(node.arrayItem, indent);
        const wrapped = itemStr.includes("|") || itemStr.startsWith("{") ? `(${itemStr})` : itemStr;
        parts.push(`${wrapped}[]${renderEnumValues(node.arrayItem)}`);
    }

    if (node.objectFields) {
        const total = node.objectSampleCount ?? 1;
        const fieldLines = Object.entries(node.objectFields)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, f]) => {
                const optional = f.count < total ? "?" : "";
                return `${childPad}${k}${optional}: ${renderShape(f.shape, indent + 1)};${renderEnumValues(f.shape)}`;
            });
        const fieldSets = renderFieldSets(node, total);
        const fieldSetLines = fieldSets ? `\n${childPad}// field sets seen together:\n${fieldSets.map(l => `${childPad}//   ${l}`).join("\n")}` : "";
        parts.push(fieldLines.length ? `{\n${fieldLines.join("\n")}${fieldSetLines}\n${pad}}` : "{}");
    }

    return parts.length ? parts.join(" | ") : "unknown";
}

/** Renders captured enum-like literal values as a trailing comment, most common first. */
function renderEnumValues(node: ShapeNode): string {
    if (!node.enumValues) return "";
    const entries = Object.entries(node.enumValues);
    if (entries.length === 0) return "";

    entries.sort(([, a], [, b]) => b - a);
    const rendered = entries.map(([v, c]) => `${v} (${c})`).join(", ");
    return ` // values seen: ${rendered}`;
}

/**
 * Lists the distinct combinations of fields actually seen together on the same object, most
 * common first - e.g. "id, username, avatar (12x)" vs "id, username, avatar, bot (3x)". Only
 * emitted when there's more than one combination; a single fixed field set is already fully
 * described by the required/optional markers on each field.
 */
function renderFieldSets(node: ShapeNode, total: number): string[] | null {
    if (!node.fieldSetCounts) return null;
    const entries = Object.entries(node.fieldSetCounts);
    if (entries.length <= 1) return null;

    entries.sort(([, a], [, b]) => b - a);
    const lines = entries.map(([signature, count]) => `${signature.split(",").join(", ")} (${count}/${total})`);
    if (node.fieldSetOverflow) lines.push(`... (${MAX_FIELD_SETS}+ distinct combinations seen, showing top ${MAX_FIELD_SETS})`);
    return lines;
}

export interface HeaderStats {
    count: number;
    valueKinds: Record<string, number>;
}

export function guessHeaderValueKind(value: string): string {
    if (/^\d+$/.test(value)) return "numeric";
    if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(value)) return "jwt-like";
    if (/^[A-Za-z0-9+/_-]{20,}={0,2}$/.test(value)) return "base64-like";
    if (value.length > 64) return "long-string";
    return "string";
}

export function accumulateHeader(map: Record<string, HeaderStats>, name: string, value: string): void {
    const key = name.toLowerCase();
    let stats = map[key];
    if (!stats) stats = map[key] = { count: 0, valueKinds: {} };
    stats.count++;
    const kind = guessHeaderValueKind(value);
    stats.valueKinds[kind] = (stats.valueKinds[kind] ?? 0) + 1;
}

export function renderHeaderMap(map: Record<string, HeaderStats>, totalRequests: number): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, stats] of Object.entries(map)) {
        const kinds = Object.keys(stats.valueKinds).sort().join(" | ");
        const optional = stats.count < totalRequests ? " (optional)" : "";
        out[name] = `${kinds}${optional}`;
    }
    return out;
}
