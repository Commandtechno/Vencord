/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { pluginStreamHandlers } from "@main/pluginStreams";
import { net } from "electron";

const TAG = "[FileSplitter/native]";

/** Counterpart to the renderer's base64UrlEncode — see its comment for why this isn't plain JSON+encodeURIComponent. */
function base64UrlDecode(str: string): string {
    const base64 = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(str.length + (4 - str.length % 4) % 4, "=");
    return Buffer.from(base64, "base64").toString("utf-8");
}

interface StreamManifest {
    /** Ordered CDN attachment URLs, one per part. */
    urls: string[];
    /** Real byte size of each part, same order as `urls` — read straight from Discord's own attachment metadata, so this is exact even if the last part is a different size than the rest. */
    sizes: number[];
    totalSize: number;
    mimeType: string;
    /** Part 1's real media.discordapp.net proxy_url — the only one of the urls that honors format=/width=/height= for thumbnail requests (plain cdn.discordapp.com urls just serve the file as-is). May be absent if Discord didn't return one. */
    part1ProxyUrl?: string;
}

/** Prefix-sum byte offsets: offsets[i] is the first absolute byte of part i, offsets[sizes.length] is totalSize. */
function partOffsets(sizes: number[]): number[] {
    const offsets = [0];
    for (const size of sizes) offsets.push(offsets[offsets.length - 1] + size);
    return offsets;
}

function partIndexForByte(offsets: number[], byte: number): number {
    // offsets.length === sizes.length + 1, so this always lands on a valid part index.
    for (let i = 0; i < offsets.length - 1; i++) {
        if (byte < offsets[i + 1]) return i;
    }
    return offsets.length - 2;
}

interface ByteRange {
    start: number;
    end: number;
    /** Whether the request asked for a sub-range (206) vs the whole thing (200). */
    partial: boolean;
}

function parseRange(header: string | null, totalSize: number): ByteRange {
    const match = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (match && (match[1] !== "" || match[2] !== "")) {
        const start = match[1] === "" ? Math.max(0, totalSize - Number(match[2])) : Number(match[1]);
        const end = match[1] === "" || match[2] === "" ? totalSize - 1 : Number(match[2]);
        return {
            start: Math.max(0, Math.min(start, totalSize - 1)),
            end: Math.max(0, Math.min(end, totalSize - 1)),
            partial: true,
        };
    }
    return { start: 0, end: totalSize - 1, partial: false };
}

function isValidManifest(m: any): m is StreamManifest {
    return m
        && Array.isArray(m.urls) && m.urls.length > 0
        && Array.isArray(m.sizes) && m.sizes.length === m.urls.length
        && typeof m.totalSize === "number" && m.totalSize > 0
        && typeof m.mimeType === "string";
}

// If the upstream CDN never responds, or the download stalls partway through, a request would
// otherwise hang forever with nothing to show the user but an endless spinner — this bounds both
// "never got a response" and "response started then went silent" to a hard failure instead.
const UPSTREAM_TIMEOUT_MS = 20_000;

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            onTimeout();
            reject(new TimeoutError(`timed out after ${ms}ms`));
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Fallback only — used when forwarding to chunk 1's real thumbnail (below) fails or can't produce
// one (e.g. chunk 1 alone isn't a parseable container — common for non-faststart video, where the
// moov atom lives at the end of the original file, past chunk 1's byte range entirely; Discord's
// own CDN then 415s trying to thumbnail it, through no fault of ours). A 1x1 transparent PNG, just
// enough to be a validly-decodable image so Discord's renderer doesn't choke on a hard failure.
const PLACEHOLDER_THUMBNAIL_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
);

let reqCounter = 0;

/**
 * Discord's client appends &format=webp&width=W&height=H to an attachment's own proxy_url to fetch
 * a resized poster/thumbnail via its own media proxy before it'll show a player. Part 1 is uploaded
 * with the real MIME type (see sendSplitFile in index.tsx), so when its byte range happens to
 * contain enough of the container to be parseable on its own (e.g. a faststart MP4), Discord's
 * backend can generate a real thumbnail from it — forward the same format/width/height params onto
 * part 1's real proxy_url (media.discordapp.net, which actually honors these) and proxy back
 * whatever it returns. When it can't (chunk 1 alone isn't a valid/complete container — e.g. a
 * screen-recorded .mov with its moov atom at the end, past chunk 1 entirely), fall back to the
 * placeholder rather than passing a hard error straight through to Discord's renderer.
 */
const THUMBNAIL_TIMEOUT_MS = 10_000;

async function handleThumbnail(requestUrl: URL, manifest: StreamManifest, log: (...a: unknown[]) => void, logErr: (...a: unknown[]) => void): Promise<Response> {
    try {
        const base = manifest.part1ProxyUrl ?? manifest.urls[0];
        const thumbUrl = new URL(base);
        for (const key of ["format", "width", "height"]) {
            const value = requestUrl.searchParams.get(key);
            if (value) thumbUrl.searchParams.set(key, value);
        }

        // Without a bound, a hung fetch here holds a connection open indefinitely — and since
        // that's a real shared connection pool per host, several of these stacking up (e.g.
        // multiple completed groups all requesting thumbnails at once on startup) can starve out
        // *every* other request to that host, including Discord's own unrelated avatar/emoji/image
        // loads. Always abort and fall through to the placeholder.
        const abort = new AbortController();
        const res = await withTimeout(
            net.fetch(thumbUrl.toString(), { signal: abort.signal }),
            THUMBNAIL_TIMEOUT_MS,
            () => { logErr("thumbnail forward timed out, aborting"); abort.abort(); },
        );
        const contentType = res.headers.get("content-type") ?? "";
        log(`thumbnail forward (${base === manifest.part1ProxyUrl ? "proxy_url" : "url"}) status=${res.status} content-type=${contentType}`);

        // A non-2xx (e.g. 415 — chunk 1 alone wasn't a parseable container) or a 200 with a
        // non-image body is not actually usable — treat both as a failed request.
        if (res.ok && res.body && contentType.startsWith("image/")) {
            return new Response(res.body, {
                status: 200,
                headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
            });
        }
        logErr(`thumbnail forward didn't return a usable image (status=${res.status} content-type=${contentType}), falling back to placeholder`);
    } catch (e) {
        logErr("thumbnail forward failed, falling back to placeholder", e);
    }
    return new Response(PLACEHOLDER_THUMBNAIL_PNG, {
        status: 200,
        headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
    });
}

async function handleStream(request: Request): Promise<Response> {
    const reqId = ++reqCounter;
    const t0 = Date.now();
    const elapsed = () => `+${Date.now() - t0}ms`;
    const log = (...args: unknown[]) => console.log(TAG, `#${reqId}`, elapsed(), ...args);
    const logErr = (...args: unknown[]) => console.error(TAG, `#${reqId}`, elapsed(), ...args);

    const requestUrl = new URL(request.url);
    const rangeHeader = request.headers.get("range");
    log(`incoming request, method=${request.method}, range=${rangeHeader ?? "(none)"}, format=${requestUrl.searchParams.get("format") ?? "(none)"}`);

    let manifest: StreamManifest;
    try {
        const raw = requestUrl.searchParams.get("m");
        manifest = raw && JSON.parse(base64UrlDecode(raw));
    } catch (e) {
        logErr("failed to parse manifest", e);
        return new Response("Invalid manifest", { status: 400 });
    }
    if (!isValidManifest(manifest)) {
        logErr("manifest failed validation", manifest);
        return new Response("Invalid manifest", { status: 400 });
    }

    if (requestUrl.searchParams.has("format")) {
        return handleThumbnail(requestUrl, manifest, log, logErr);
    }

    const { urls, sizes, totalSize, mimeType } = manifest;
    const { start, end, partial } = parseRange(rangeHeader, totalSize);

    const offsets = partOffsets(sizes);
    const firstPart = partIndexForByte(offsets, start);
    const lastPart = partIndexForByte(offsets, end);

    log(`parts=${urls.length} totalSize=${totalSize} mimeType=${mimeType} -> byteRange=${start}-${end} (partial=${partial}) spans part ${firstPart}..${lastPart}`);

    let bytesStreamed = 0;
    let cancelled = false;
    // The consumer (the browser) cancels and re-requests constantly while seeking/buffering — that's
    // normal player behavior, not an error. What matters is that we react to it immediately: without
    // this, an abandoned upstream fetch/reader just keeps running in the background after cancellation,
    // silently holding a connection open. Pile up enough of those or since re-requesting is so common,
    // and a brand new request can end up queued behind them waiting for a free connection — which is
    // exactly what timed out one out of every few loads: a request sat for ~3s with zero bytes while
    // earlier abandoned fetches to the same host were still finishing on their own.
    let currentAbort: AbortController | null = null;
    let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                for (let i = firstPart; i <= lastPart && !cancelled; i++) {
                    const partStart = offsets[i];
                    const partEnd = offsets[i + 1] - 1;
                    const wantStart = Math.max(start, partStart) - partStart;
                    const wantEnd = Math.min(end, partEnd) - partStart;

                    log(`fetching part ${i} (upstream bytes ${wantStart}-${wantEnd} of ${sizes[i]})`);

                    const abort = new AbortController();
                    currentAbort = abort;
                    const res = await withTimeout(
                        net.fetch(urls[i], { headers: { Range: `bytes=${wantStart}-${wantEnd}` }, signal: abort.signal }),
                        UPSTREAM_TIMEOUT_MS,
                        () => { logErr(`part ${i} upstream response timed out, aborting`); abort.abort(); },
                    );
                    if (cancelled) break;
                    log(`part ${i} upstream responded status=${res.status} content-length=${res.headers.get("content-length")} content-range=${res.headers.get("content-range")}`);

                    if (!res.ok || !res.body) {
                        const bodyText = await res.text().catch(() => "<unreadable>");
                        throw new Error(`Upstream part ${i} failed: HTTP ${res.status} — ${bodyText.slice(0, 300)}`);
                    }

                    const reader = res.body.getReader();
                    currentReader = reader;
                    let partBytes = 0;
                    while (!cancelled) {
                        const { done, value } = await withTimeout(
                            reader.read(),
                            UPSTREAM_TIMEOUT_MS,
                            () => { logErr(`part ${i} read stalled (no data for ${UPSTREAM_TIMEOUT_MS}ms), cancelling upstream reader`); reader.cancel().catch(() => {}); },
                        );
                        if (done || cancelled) break;
                        controller.enqueue(value);
                        partBytes += value.byteLength;
                        bytesStreamed += value.byteLength;
                    }
                    log(`part ${i} done, streamed ${partBytes} bytes (expected ${wantEnd - wantStart + 1})`);
                }

                if (cancelled) {
                    log(`stream ended (cancelled by consumer), total ${bytesStreamed} bytes`);
                    return;
                }

                const expected = end - start + 1;
                if (bytesStreamed !== expected) {
                    logErr(`byte count mismatch: streamed ${bytesStreamed}, expected ${expected}`);
                }
                log(`stream complete, total ${bytesStreamed} bytes`);
                controller.close();
            } catch (e) {
                if (cancelled) {
                    log(`stream errored after being cancelled (expected, ignoring): ${e instanceof Error ? e.message : e}`);
                    return;
                }
                logErr(`stream failed after ${bytesStreamed} bytes`, e instanceof Error ? `${e.name}: ${e.message}` : e);
                controller.error(e);
            } finally {
                currentAbort = null;
                currentReader = null;
            }
        },
        cancel(reason) {
            cancelled = true;
            log(`cancelled by consumer after ${bytesStreamed} bytes, aborting upstream now`, reason);
            currentAbort?.abort();
            currentReader?.cancel().catch(() => {});
        },
    });

    const headers = new Headers({
        "Content-Type": mimeType,
        "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
    });
    if (partial) headers.set("Content-Range", `bytes ${start}-${end}/${totalSize}`);

    log(`responding status=${partial ? 206 : 200} content-length=${headers.get("content-length")} content-range=${headers.get("content-range") ?? "(none)"}`);
    return new Response(stream, { status: partial ? 206 : 200, headers });
}

pluginStreamHandlers.set("FileSplitter", (request: Request) => {
    return handleStream(request).catch(e => {
        console.error(TAG, "handleStream threw synchronously", e);
        return new Response("Internal error", { status: 500 });
    });
});
