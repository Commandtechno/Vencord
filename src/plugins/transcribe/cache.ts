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

import { settings } from "./settings";
import type { Segment } from "./TranscriptionAccesory";

// attachmentId -> transcription, kept in memory for instant sync access
const cache = new Map<string, Segment[]>();
// attachmentId -> in-flight request, so multiple mounts for the same
// attachment (e.g. scrolling past a message again) share one request
// instead of queueing duplicate transcriptions
const inFlight = new Map<string, Promise<Segment[]>>();

async function fetchTranscription(url: string): Promise<Segment[]> {
    const resp = await fetch(`https://api.runpod.ai/v2/${settings.store.endpoint}/runsync`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${settings.store.apiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            input: { audio: url }
        })
    });

    if (!resp.ok) {
        throw new Error(`bad status ${resp.status}`);
    }

    const result = await resp.json();
    if (result.status !== "COMPLETED") {
        console.error(result);
        throw new Error("transcribe failed");
    }

    return result.output.segments;
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
