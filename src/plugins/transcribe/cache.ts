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

import { type AutomaticSpeechRecognitionPipeline,pipeline } from "@huggingface/transformers";
import { PluginNative } from "@utils/types";

import type { Segment } from "./TranscriptionAccesory";

const Native = VencordNative.pluginHelpers.Transcriber as PluginNative<typeof import("./native")>;

const MODEL = "onnx-community/whisper-small";
// whisper models expect 16kHz mono pcm
const SAMPLE_RATE = 16000;

// attachmentId -> transcription, kept in memory for instant sync access
const cache = new Map<string, Segment[]>();
// attachmentId -> in-flight request, so multiple mounts for the same
// attachment (e.g. scrolling past a message again) share one request
// instead of queueing duplicate transcriptions
const inFlight = new Map<string, Promise<Segment[]>>();

// the model is ~250MB of weights, so it is only loaded on the first voice
// message and then kept around. weights are cached by the browser after the
// first download
let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

function getTranscriber(): Promise<AutomaticSpeechRecognitionPipeline> {
    transcriberPromise ??= (async () => {
        try {
            return await pipeline("automatic-speech-recognition", MODEL, {
                device: "webgpu",
                dtype: { encoder_model: "fp16", decoder_model_merged: "q4" },
            });
        } catch (err) {
            console.warn("[Transcriber] WebGPU unavailable, falling back to WASM", err);
            return await pipeline("automatic-speech-recognition", MODEL, {
                device: "wasm",
                dtype: "q8",
            });
        }
    })();

    transcriberPromise.catch(() => { transcriberPromise = null; });
    return transcriberPromise;
}

// the audio has to be fetched by the main process (no CORS headers on the
// discord cdn) and decoded here, since transformers.js can't fetch it itself
async function getAudio(url: string): Promise<Float32Array> {
    const buf = await Native.fetchAudio(url);

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    try {
        const decoded = await ctx.decodeAudioData(buf);
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

async function fetchTranscription(url: string): Promise<Segment[]> {
    const [transcriber, audio] = await Promise.all([getTranscriber(), getAudio(url)]);
    const output = await transcriber(audio, {
        // whisper only sees 30s at a time; chunk with overlap so longer
        // voice messages get transcribed in full
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true,
    });

    const { chunks } = Array.isArray(output) ? output[0] : output;
    if (!chunks) throw new Error("transcribe failed: no chunks returned");

    return chunks.map(({ text, timestamp }) => ({
        text,
        start: timestamp[0] ?? 0,
        // the final chunk can have a null end timestamp
        end: timestamp[1] ?? Infinity,
    }));
}

export function getTranscription(attachmentId: string, url: string): Promise<Segment[]> {
    const cached = cache.get(attachmentId);
    if (cached) return Promise.resolve(cached);

    const pending = inFlight.get(attachmentId);
    if (pending) return pending;

    const promise = (async () => {
        try {
            const segments = await fetchTranscription(url);
            cache.set(attachmentId, segments);
            return segments;
        } finally {
            inFlight.delete(attachmentId);
        }
    })();

    inFlight.set(attachmentId, promise);
    return promise;
}
