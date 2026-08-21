/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
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

import { Devs } from "@utils/constants";
import { getCurrentChannel, sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { findStoreLazy } from "@webpack";

const logger = new Logger("StickyStickers", "#f4b8e4");

const StickersStore = findStoreLazy("StickersStore");

const StickerExt = [, "png", "png", "json", "gif"] as const;
// Lottie stickers have no static image asset we can just drop an <img> for
const UNSUPPORTED_FORMAT_TYPE = 3;
// How far the pointer has to move before we treat this as a drag rather than a click,
// so a normal click-to-send still works exactly like it did before this plugin.
const DRAG_THRESHOLD_PX = 8;

function getUrl(id: string, formatType: number) {
    return new URL(
        `${window.GLOBAL_ENV.MEDIA_PROXY_ENDPOINT}/stickers/${id}.${StickerExt[formatType]}?size=192&lossless=true`,
        location.toString()
    ).toString();
}

// Some picker tiles render an <img>, which browsers make natively draggable by default.
// If a real HTML5 drag session kicks off, it swallows subsequent pointermove events, which
// would break our own pointer-based drag below - so we unconditionally cancel any native
// drag that starts from a sticker tile.
function onNativeDragStart(e: DragEvent) {
    const target = e.target as HTMLElement | null;
    if (target?.closest("[data-type=\"sticker\"]")) {
        logger.debug("Cancelling native HTML5 drag on sticker tile so our pointer-based drag can run");
        e.preventDefault();
    }
}

interface PendingDrag {
    id: string;
    tile: HTMLElement;
    startX: number;
    startY: number;
    dragging: boolean;
}

let pending: PendingDrag | null = null;
let ghost: HTMLImageElement | null = null;
// Set right after we handle a drag-drop, so the click event that (may) follow the
// pointerup doesn't also trigger Discord's own click-to-send for the same sticker.
let suppressNextClick = false;

function removeGhost() {
    ghost?.remove();
    ghost = null;
}

function updateGhostPosition(x: number, y: number) {
    if (!ghost) return;
    ghost.style.left = `${x}px`;
    ghost.style.top = `${y}px`;
}

function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;

    const target = e.target as HTMLElement | null;
    const tile = target?.closest("[data-type=\"sticker\"]") as HTMLElement | null;
    if (!tile) return;

    const { id } = tile.dataset;
    if (!id) return;

    pending = { id, tile, startX: e.clientX, startY: e.clientY, dragging: false };
    logger.debug("pointerdown on sticker tile", id);
}

function beginDrag(e: PointerEvent, drag: PendingDrag) {
    const sticker = StickersStore.getStickerById(drag.id);
    if (!sticker) {
        logger.warn("pointer-drag: no sticker data found in StickersStore for id", drag.id, "- cancelling");
        pending = null;
        return;
    }
    if (sticker.format_type === UNSUPPORTED_FORMAT_TYPE) {
        logger.warn("pointer-drag: sticker", drag.id, "is a Lottie sticker (unsupported) - cancelling");
        pending = null;
        return;
    }

    drag.dragging = true;
    logger.info("pointer-drag: started dragging sticker", drag.id);

    // Prefer the image the tile is already rendering - it's guaranteed to be a valid,
    // already-loading URL, unlike a freshly reconstructed CDN URL which may not match
    // the exact size/format variant Discord's media proxy expects.
    const tileImg = drag.tile.querySelector("img") as HTMLImageElement | null;
    const url = tileImg?.src || getUrl(sticker.id, sticker.format_type);
    logger.debug("pointer-drag: ghost image source", url, tileImg ? "(from tile)" : "(constructed)");

    ghost = document.createElement("img");
    ghost.src = url;
    ghost.style.cssText = "position:fixed;z-index:2147483647;width:96px;max-width:96px;"
        + "pointer-events:none;opacity:.85;transform:translate(-50%,-50%);";
    document.body.appendChild(ghost);
    updateGhostPosition(e.clientX, e.clientY);
}

function onPointerMove(e: PointerEvent) {
    if (!pending) return;

    if (!pending.dragging) {
        const dx = e.clientX - pending.startX;
        const dy = e.clientY - pending.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        beginDrag(e, pending);
        if (!pending?.dragging) return;
    }

    updateGhostPosition(e.clientX, e.clientY);
}

function onPointerUp(e: PointerEvent) {
    if (!pending) return;
    const drag = pending;
    pending = null;
    removeGhost();

    if (!drag.dragging) {
        logger.debug("pointerup: movement under threshold, treating as a normal click");
        return;
    }

    suppressNextClick = true;

    const channel = getCurrentChannel();
    if (!channel) {
        logger.warn("pointerup: no current channel to send the sticker to");
        return;
    }

    const { x, y } = e;
    logger.info("pointerup: dropped sticker", drag.id, "at", { x, y }, "- sending to channel", channel.id);

    sendMessage(channel.id, { content: `x: ${x}, y: ${y}` }, true, { stickerIds: [drag.id] })
        .then(() => logger.info("Sent sticker message successfully"))
        .catch((err: unknown) => logger.error("Failed to send sticker message", err));
}

function onPointerCancel() {
    if (!pending) return;
    logger.debug("pointercancel: aborting in-progress drag");
    pending = null;
    removeGhost();
}

function onClickCapture(e: MouseEvent) {
    if (!suppressNextClick) return;
    suppressNextClick = false;
    logger.debug("Suppressing click after a drag-drop so the sticker doesn't also get sent normally");
    e.preventDefault();
    e.stopPropagation();
}

export default definePlugin({
    name: "StickyStickers",
    description: "Drag a sticker out of the sticker picker and drop it anywhere to send it to the current channel, with the drop position included in the message.",
    authors: [Devs.Commandtechno],

    start() {
        document.addEventListener("dragstart", onNativeDragStart, true);
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("pointermove", onPointerMove, true);
        document.addEventListener("pointerup", onPointerUp, true);
        document.addEventListener("pointercancel", onPointerCancel, true);
        document.addEventListener("click", onClickCapture, true);

        logger.info("Started - listeners attached");
    },

    stop() {
        document.removeEventListener("dragstart", onNativeDragStart, true);
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("pointermove", onPointerMove, true);
        document.removeEventListener("pointerup", onPointerUp, true);
        document.removeEventListener("pointercancel", onPointerCancel, true);
        document.removeEventListener("click", onClickCapture, true);

        pending = null;
        suppressNextClick = false;
        removeGhost();

        logger.info("Stopped - listeners removed");
    }
});
