/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { type AutomaticSpeechRecognitionPipeline, pipeline, type ProgressInfo, WhisperTextStreamer, type WhisperTokenizer } from "@huggingface/transformers";

import type { Segment } from "./TranscriptionAccesory";

function log(...args: unknown[]) {
    console.debug(`[Transcriber ${new Date().toISOString()}]`, ...args);
}

// logs initiate/done/ready immediately, and download progress at most once per
// 10% per file, so we can tell which stage (and which file) it's stuck on
// without flooding the console
function makeProgressLogger(label: string): (info: ProgressInfo) => void {
    const lastLoggedDecile = new Map<string, number>();
    return info => {
        switch (info.status) {
            case "initiate":
                log(`${label}: fetching ${info.file}`);
                break;
            case "done":
                log(`${label}: done ${info.file}`);
                break;
            case "ready":
                log(`${label}: ready (task=${info.task}, model=${info.model})`);
                break;
            case "progress": {
                const decile = Math.floor(info.progress / 10);
                if (lastLoggedDecile.get(info.file) !== decile) {
                    lastLoggedDecile.set(info.file, decile);
                    log(`${label}: ${info.file} ${info.progress.toFixed(0)}% (${info.loaded}/${info.total} bytes)`);
                }
                break;
            }
        }
    };
}

// logs a heartbeat while a stage is pending, so a genuine hang (as opposed to
// a slow-but-progressing download) is visible even with no other output
function withHeartbeat<T>(label: string, promise: Promise<T>): Promise<T> {
    const start = Date.now();
    const interval = setInterval(() => log(`${label}: still waiting (${((Date.now() - start) / 1000).toFixed(0)}s elapsed)`), 10_000);
    return promise.finally(() => clearInterval(interval));
}

const MODEL = "onnx-community/whisper-small";
// whisper models expect 16kHz mono pcm
const SAMPLE_RATE = 16000;
// whisper only sees 30s at a time; chunk with overlap so longer
// voice messages get transcribed in full
const CHUNK_LENGTH_S = 30;
const STRIDE_LENGTH_S = 5;

// attachmentId -> transcription, kept in memory for instant sync access
const cache = new Map<string, Segment[]>();
// attachmentId -> in-flight request, so multiple mounts for the same
// attachment (e.g. scrolling past a message again) share one request
// instead of queueing duplicate transcriptions
const inFlight = new Map<string, Promise<Segment[]>>();

// streaming partial results for in-flight transcriptions, so segments show
// up as they are decoded instead of all at once when done
const partials = new Map<string, Segment[]>();
const partialListeners = new Map<string, Set<(segments: Segment[]) => void>>();

function emitPartial(attachmentId: string, segments: Segment[]) {
    partials.set(attachmentId, segments);
    for (const listener of partialListeners.get(attachmentId) ?? []) listener(segments);
}

// the model is ~400MB of weights, so it is only loaded on the first voice
// message and then kept around. weights are cached by the browser after the
// first download
let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

function getTranscriber(): Promise<AutomaticSpeechRecognitionPipeline> {
    transcriberPromise ??= (async () => {
        log("starting webgpu pipeline load");
        try {
            const result = await withHeartbeat("webgpu pipeline load", pipeline("automatic-speech-recognition", MODEL, {
                device: "webgpu",
                dtype: { encoder_model: "fp16", decoder_model_merged: "q4" },
                progress_callback: makeProgressLogger("webgpu"),
            }));
            log("webgpu pipeline load succeeded");
            return result;
        } catch (err) {
            console.warn("[Transcriber] WebGPU unavailable, falling back to WASM", err);
            log("starting wasm pipeline load");
            const result = await withHeartbeat("wasm pipeline load", pipeline("automatic-speech-recognition", MODEL, {
                device: "wasm",
                dtype: "q8",
                progress_callback: makeProgressLogger("wasm"),
            }));
            log("wasm pipeline load succeeded");
            return result;
        }
    })();

    transcriberPromise.catch(err => {
        log("pipeline load failed", err);
        transcriberPromise = null;
    });
    return transcriberPromise;
}

// the discord cdn doesn't send CORS headers; our csp patcher injects them
// (see src/main/csp) so this fetch works from the renderer
async function getAudio(url: string): Promise<Float32Array> {
    log("fetching audio", url);
    const res = await withHeartbeat("audio fetch", fetch(url));
    if (!res.ok) throw new Error(`bad status ${res.status}`);
    const buf = await res.arrayBuffer();
    log(`audio fetched (${buf.byteLength} bytes), decoding`);

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    try {
        const decoded = await ctx.decodeAudioData(buf);
        log(`audio decoded (${decoded.duration.toFixed(2)}s, ${decoded.numberOfChannels}ch)`);
        if (decoded.numberOfChannels === 1) return decoded.getChannelData(0);

        const left = decoded.getChannelData(0);
        const right = decoded.getChannelData(1);
        const mono = new Float32Array(left.length);
        for (let i = 0; i < left.length; i++) mono[i] = (left[i] + right[i]) / 2;
        return mono;
    } finally {
        ctx.close();
    }
}

async function fetchTranscription(attachmentId: string, url: string): Promise<Segment[]> {
    log("fetchTranscription start", attachmentId);
    const [transcriber, audio] = await Promise.all([getTranscriber(), getAudio(url)]);
    log("transcriber ready and audio loaded, starting inference");

    // streams whisper's timestamped segments as they are decoded. window
    // offsets are approximate for audio longer than one chunk (overlapping
    // windows aren't merged until the end); the final pipeline output below
    // replaces these with exact timestamps
    const streamed: Segment[] = [];
    let current: Segment | null = null;
    let windowIndex = 0;
    const windowOffset = () => (CHUNK_LENGTH_S - STRIDE_LENGTH_S) * windowIndex;

    const timePrecision = (transcriber.processor.feature_extractor as any).config.chunk_length /
        (transcriber.model.config as any).max_source_positions;

    const streamer = new WhisperTextStreamer(transcriber.tokenizer as WhisperTokenizer, {
        time_precision: timePrecision,
        on_chunk_start: start => {
            log(`inference: chunk ${windowIndex} started at ${start}`);
            current = { text: "", start: windowOffset() + start, end: Infinity };
            streamed.push(current);
        },
        callback_function: text => {
            if (!current) return;
            current.text += text;
            emitPartial(attachmentId, [...streamed]);
        },
        on_chunk_end: end => {
            if (current) current.end = windowOffset() + end;
            current = null;
            emitPartial(attachmentId, [...streamed]);
        },
        on_finalize: () => {
            current = null;
            windowIndex++;
        },
    });

    const output = await withHeartbeat("inference", transcriber(audio, {
        chunk_length_s: CHUNK_LENGTH_S,
        stride_length_s: STRIDE_LENGTH_S,
        return_timestamps: true,
        streamer,
    }));
    log("inference done");

    const { chunks } = Array.isArray(output) ? output[0] : output;
    if (!chunks) throw new Error("transcribe failed: no chunks returned");

    return chunks.map(({ text, timestamp }) => ({
        text,
        start: timestamp[0] ?? 0,
        // the final chunk can have a null end timestamp
        end: timestamp[1] ?? Infinity,
    }));
}

export function getTranscription(
    attachmentId: string,
    url: string,
    onPartial?: (segments: Segment[]) => void,
): { promise: Promise<Segment[]>; unsubscribe(): void; } {
    let unsubscribe = () => { };
    if (onPartial) {
        let listeners = partialListeners.get(attachmentId);
        if (!listeners) partialListeners.set(attachmentId, listeners = new Set());
        listeners.add(onPartial);
        unsubscribe = () => {
            listeners.delete(onPartial);
            if (!listeners.size) partialListeners.delete(attachmentId);
        };

        // joining an in-flight transcription: catch up on what's streamed so far
        const partial = partials.get(attachmentId);
        if (partial) onPartial(partial);
    }

    const cached = cache.get(attachmentId);
    if (cached) return { promise: Promise.resolve(cached), unsubscribe };

    const pending = inFlight.get(attachmentId);
    if (pending) return { promise: pending, unsubscribe };

    const promise = (async () => {
        try {
            const segments = await fetchTranscription(attachmentId, url);
            cache.set(attachmentId, segments);
            return segments;
        } finally {
            inFlight.delete(attachmentId);
            partials.delete(attachmentId);
        }
    })();

    inFlight.set(attachmentId, promise);
    return { promise, unsubscribe };
}
