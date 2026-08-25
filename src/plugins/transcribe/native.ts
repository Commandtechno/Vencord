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

import { IpcMainInvokeEvent } from "electron";

// the discord cdn doesn't send CORS headers, so the renderer can't fetch
// attachments itself. fetch them here in the main process instead
export async function fetchAudio(_: IpcMainInvokeEvent, url: string): Promise<ArrayBuffer> {
    const { host } = new URL(url);
    if (host !== "cdn.discordapp.com" && host !== "media.discordapp.net")
        throw new Error(`refusing to fetch from ${host}`);

    const res = await fetch(url);
    if (!res.ok) throw new Error(`bad status ${res.status}`);

    return res.arrayBuffer();
}
