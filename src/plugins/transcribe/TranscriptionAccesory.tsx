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

import { classNameFactory } from '@api/Styles';
import { Message } from "@vencord/discord-types";
import { MessageFlags } from "@vencord/discord-types/enums";
import { useEffect, useRef, useState } from "@webpack/common";
import { settings } from './settings';

export interface Segment {
  text: string;
  start: number;
  end: number;
}

export const cl = classNameFactory("transcribe-");

export function TranscriptionAccessory({ message, }: { message: Message; }) {
  const isVoiceMessage = (message.flags & MessageFlags.IS_VOICE_MESSAGE) !== 0;
  if (!isVoiceMessage) return null;

  const [error, setError] = useState<string | null>(null);
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [activeSegment, setActiveSegment] = useState<number | null>(null);

  useEffect(() => {
    const sourceElement = document.querySelector<HTMLSourceElement>(`audio > source[src="${message.attachments[0].url}"]`);
    if (!sourceElement || !segments) return;

    const audioElement = sourceElement.parentElement as HTMLAudioElement;
    audioElement.ontimeupdate = () => {
      const currentTime = audioElement.currentTime;
      const segmentIndex = segments.findIndex(segment => segment.start <= currentTime && segment.end > currentTime);
      if (segmentIndex !== activeSegment) {
        // console.log('setting active segment', segmentIndex);
        setActiveSegment(segmentIndex);
      };
    };
  }, [segments]);

  useEffect(() => {
    (async () => {
      const { url } = message.attachments[0];

      try {
        const resp = await fetch(`https://api.runpod.ai/v2/${settings.store.endpoint}/runsync `, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${settings.store.apiKey}`,
            'Content-Type': "application/json"
          },
          body: JSON.stringify({
            input: {
              audio: url,
            }
          })
        });

        if (!resp.ok) {
          throw new Error(`bad status ${resp.status}`);
        }

        const result = await resp.json();
        if (result.status !== 'COMPLETED') {
          console.error(result);
          throw new Error('transcribe failed');
        }

        setSegments(result.output.segments);
      } catch (err) {
        setError(`${err}`);
        return;
      }
    })();
  }, []);

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
      <div ref={transcriptionElement} className={cl("transcription", expanded && 'expanded')}>
        {error ?? (segments ? segments.map((segment, i) => (
          <div key={i} className={cl("segment", activeSegment === i && 'active')} onClick={(ev) => {
            console.log(segment.start, i);
            const sourceElement = document.querySelector<HTMLSourceElement>(`audio > source[src="${message.attachments[0].url}"]`);
            if (!sourceElement || !segments) return;

            const audioElement = sourceElement.parentElement as HTMLAudioElement;
            audioElement.currentTime = segment.start;
            setActiveSegment(i);
          }}>
            {segment.text}
          </div >
        )) : 'Transcribing...')}
      </div>
      {clamped && <a onClick={() => setExpanded(!expanded)}>Read {expanded ? 'Less' : "More"}</a>}
    </div>
  );
};
