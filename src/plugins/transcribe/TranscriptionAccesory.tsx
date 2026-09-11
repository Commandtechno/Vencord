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

import { classNameFactory } from "@api/Styles";
import { Message } from "@vencord/discord-types";
import { MessageFlags } from "@vencord/discord-types/enums";
import { useEffect, useRef, useState } from "@webpack/common";

import { getTranscription } from "./cache";

export interface Segment {
  text: string;
  start: number;
  end: number;
}

export const cl = classNameFactory("transcribe-");

// finds the <audio> element playing this attachment. matches on the URL
// without its query string, since discord rotates the CDN's signed params
// (ex/is/hm) independently of the message data we hold, and falls back to
// audio.src directly in case the player doesn't nest a <source> child
function findAudioElement(url: string): HTMLAudioElement | null {
  const base = url.split("?")[0];
  for (const audio of document.querySelectorAll<HTMLAudioElement>("audio")) {
    const src = audio.currentSrc || audio.src || audio.querySelector("source")?.src || "";
    if (src.split("?")[0] === base) return audio;
  }
  return null;
}

export function TranscriptionAccessory({ message, }: { message: Message; }) {
  const isVoiceMessage = (message.flags & MessageFlags.IS_VOICE_MESSAGE) !== 0;
  if (!isVoiceMessage) return null;

  const [error, setError] = useState<string | null>(null);
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [activeSegment, setActiveSegment] = useState<number | null>(null);

  useEffect(() => {
    if (!segments) return;

    const url = message.attachments[0].url;
    let audioElement: HTMLAudioElement | null = null;
    let observer: MutationObserver | null = null;

    const onTimeUpdate = () => {
      if (!audioElement) return;
      const { currentTime } = audioElement;
      const segmentIndex = segments.findIndex(segment => segment.start <= currentTime && segment.end > currentTime);
      setActiveSegment(prev => prev === segmentIndex ? prev : segmentIndex);
    };

    // the voice message player can mount after this effect runs (e.g. while
    // the message list is still virtualizing), so keep retrying until it
    // shows up instead of giving up on a single missed lookup
    const tryAttach = () => {
      if (audioElement) return true;
      const found = findAudioElement(url);
      if (!found) return false;

      audioElement = found;
      audioElement.addEventListener("timeupdate", onTimeUpdate);
      observer?.disconnect();
      observer = null;
      return true;
    };

    if (!tryAttach()) {
      observer = new MutationObserver(tryAttach);
      observer.observe(document.body, { childList: true, subtree: true });
    }

    return () => {
      observer?.disconnect();
      audioElement?.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [segments, message.attachments]);

  useEffect(() => {
    const { id, url } = message.attachments[0];
    let cancelled = false;

    const { promise, unsubscribe } = getTranscription(id, url, partial => {
      if (!cancelled) setSegments(partial);
    });

    promise
      .then(segments => {
        if (!cancelled) setSegments(segments);
      })
      .catch(err => {
        if (!cancelled) setError(`${err}`);
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [message.attachments[0].id]);

  const [clamped, setClamped] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const transcriptionElement = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if ((transcriptionElement.current?.scrollHeight ?? 0) > (transcriptionElement.current?.clientHeight ?? 0)) {
      setClamped(true);
    }
  }, [segments]);

  return (
    <div className={cl("accessory")}>
      <div ref={transcriptionElement} className={cl("transcription", expanded && "expanded")}>
        {error ?? (segments ? segments.map((segment, i) => (
          <div key={i} className={cl("segment", activeSegment === i && "active")} onClick={() => {
            const audioElement = findAudioElement(message.attachments[0].url);
            if (!audioElement) return;

            audioElement.currentTime = segment.start;
            setActiveSegment(i);
          }}>
            {segment.text}
          </div >
        )) : "Transcribing...")}
      </div>
      {clamped && <a onClick={() => setExpanded(!expanded)}>Read {expanded ? "Less" : "More"}</a>}
    </div>
  );
}
