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
import { createRoot, useEffect, useState } from "@webpack/common";
import type { Root } from "react-dom/client";

const logger = new Logger("StickyStickers", "#f4b8e4");

const StickersStore = findStoreLazy("StickersStore");
const MessageStore = findStoreLazy("MessageStore");

const StickerExt = [, "png", "png", "json", "gif"] as const;
// Lottie stickers have no static image asset we can just drop an <img> for
const UNSUPPORTED_FORMAT_TYPE = 3;
// How far the pointer has to move before we treat this as a drag rather than a click,
// so a normal click-to-send still works exactly like it did before this plugin.
const DRAG_THRESHOLD_PX = 8;

// We (ab)use a message's own content as storage for where its sticker should float:
// "SS{anchorMessageId,dx,dy,rotationDeg}". The sticker is positioned relative to the
// message it landed nearest to (dx/dy offset from that message's top-left corner), so it
// scrolls along with chat instead of staying pinned to a fixed screen position. An
// anchorMessageId of "0" means no message was found to anchor to, and dx/dy are instead
// treated as plain fixed viewport coordinates. Any message - from anyone - matching this
// plus exactly one sticker is treated as a placed sticker rather than a normal message.
const XY_PATTERN = /^SS\{(\d+),(-?\d+),(-?\d+),(-?\d+)\}$/;

function getUrl(id: string, formatType: number) {
  return new URL(
    `${window.GLOBAL_ENV.MEDIA_PROXY_ENDPOINT}/stickers/${id}.${StickerExt[formatType]}?size=320&lossless=true`,
    location.toString()
  ).toString();
}

interface StickerItem {
  id: string;
  format_type: number;
  name: string;
}

interface StickyMessage {
  id: string;
  channel_id?: string;
  channelId?: string;
  content: string;
  stickerItems?: StickerItem[];
}

interface OverlaySticker {
  messageId: string;
  channelId: string;
  url: string;
  anchorMessageId: string;
  dx: number;
  dy: number;
  rotation: number;
}

function parseStickyMessage(message: StickyMessage | null | undefined): OverlaySticker | null {
  if (!message) return null;

  const match = XY_PATTERN.exec(message.content ?? "");
  if (!match) return null;

  // From here on the content clearly looks like one of ours, so any further rejection
  // is unexpected - log it loudly instead of silently dropping it.
  const { stickerItems } = message;
  if (!stickerItems || stickerItems.length !== 1) {
    logger.info("parseStickyMessage: content matched SS{x,y} but stickerItems check failed for", message.id, "stickerItems:", stickerItems);
    return null;
  }

  const sticker = stickerItems[0];
  if (sticker.format_type === UNSUPPORTED_FORMAT_TYPE) {
    logger.info("parseStickyMessage: sticker on", message.id, "is an unsupported Lottie sticker");
    return null;
  }

  const channelId = message.channel_id ?? message.channelId;
  if (!channelId) {
    logger.info("parseStickyMessage: message", message.id, "had no channel_id/channelId", message);
    return null;
  }

  const parsed = {
    messageId: message.id,
    channelId,
    url: getUrl(sticker.id, sticker.format_type),
    anchorMessageId: match[1],
    dx: parseInt(match[2], 10),
    dy: parseInt(match[3], 10),
    rotation: parseInt(match[4], 10)
  };
  logger.info("parseStickyMessage: parsed", message.id, "as", parsed);
  return parsed;
}

const overlayStickers = new Map<string, OverlaySticker>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach(l => l());
}

function registerIfSticky(message: StickyMessage | null | undefined) {
  const parsed = parseStickyMessage(message);
  if (!parsed) return;
  overlayStickers.set(parsed.messageId, parsed);
  logger.info("Registered overlay sticker from message", parsed.messageId, "anchored to", parsed.anchorMessageId, "offset", { dx: parsed.dx, dy: parsed.dy }, "rotation", parsed.rotation);
  notify();
}

function rescanCurrentChannel() {
  const channel = getCurrentChannel();
  if (!channel) return;

  const messages = MessageStore.getMessages(channel.id);
  logger.debug("Rescanning channel", channel.id, "for placed stickers");
  messages?.forEach?.((message: StickyMessage) => registerIfSticky(message));
  notify();
}

// Picker tiles don't consistently render an <img> - some render the sticker as a CSS
// background-image instead. Check both, and search the whole subtree (not just direct
// children), so we find whatever is actually visually there regardless of markup shape.
function findTileImageUrl(tile: HTMLElement): string | null {
  const img = tile.querySelector("img") as HTMLImageElement | null;
  if (img?.src) return img.src;

  for (const el of [tile, ...Array.from(tile.querySelectorAll<HTMLElement>("*"))]) {
    const bg = getComputedStyle(el).backgroundImage;
    const match = /url\(["']?(.*?)["']?\)/.exec(bg);
    if (match?.[1]) return match[1];
  }

  return null;
}

// Discord gives every rendered message's root element a stable id of this shape, which
// lets us both find "the message nearest a drop point" and later re-look-up that same
// message's live on-screen position (so our overlay can track it as chat scrolls).
const MESSAGE_ELEMENT_ID_PREFIX = "chat-messages-";

function parseMessageElementId(id: string): { channelId: string; messageId: string; } | null {
  if (!id.startsWith(MESSAGE_ELEMENT_ID_PREFIX)) return null;
  const rest = id.slice(MESSAGE_ELEMENT_ID_PREFIX.length);
  const dashIdx = rest.indexOf("-");
  if (dashIdx === -1) return null;
  return { channelId: rest.slice(0, dashIdx), messageId: rest.slice(dashIdx + 1) };
}

function getMessageElement(channelId: string, messageId: string): HTMLElement | null {
  return document.getElementById(`${MESSAGE_ELEMENT_ID_PREFIX}${channelId}-${messageId}`);
}

// Finds whichever currently-rendered message is nearest the given point, so a dropped
// sticker can be anchored to it instead of a fixed screen position.
function findAnchorMessageElement(x: number, y: number): HTMLElement | null {
  const direct = (document.elementFromPoint(x, y) as HTMLElement | null)
    ?.closest(`[id^="${MESSAGE_ELEMENT_ID_PREFIX}"]`) as HTMLElement | null;
  if (direct) return direct;

  let best: HTMLElement | null = null;
  let bestDist = Infinity;
  document.querySelectorAll(`[id^="${MESSAGE_ELEMENT_ID_PREFIX}"]`).forEach(el => {
    const rect = el.getBoundingClientRect();
    const dist = Math.abs((rect.top + rect.bottom) / 2 - y);
    if (dist < bestDist) {
      bestDist = dist;
      best = el as HTMLElement;
    }
  });
  return best;
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

// The ghost swings like it's on a pendant while dragging, based on how fast it's moving
// sideways, and settles back toward level as movement slows - whatever angle it's at the
// instant you drop is what gets locked into the placed sticker.
const ROTATION_MAX_DEG = 35;
const ROTATION_VELOCITY_SCALE = 25; // deg per (px/ms) of horizontal speed
const ROTATION_SMOOTHING = 0.3; // how quickly rotation eases toward its target each move event

let rotation = 0;
let lastMoveX = 0;
let lastMoveTime = 0;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function removeGhost() {
  ghost?.remove();
  ghost = null;
}

function updateGhostTransform() {
  if (!ghost) return;
  ghost.style.transform = `translate(-50%, -50%) rotate(${rotation.toFixed(1)}deg)`;
}

function updateGhostPosition(x: number, y: number) {
  if (!ghost) return;
  ghost.style.left = `${x}px`;
  ghost.style.top = `${y}px`;
}

function updateGhostRotation(e: PointerEvent) {
  const now = performance.now();
  const dt = now - lastMoveTime;
  if (dt > 0) {
    const velocityX = (e.clientX - lastMoveX) / dt; // px per ms
    const target = clamp(velocityX * ROTATION_VELOCITY_SCALE, -ROTATION_MAX_DEG, ROTATION_MAX_DEG);
    rotation += (target - rotation) * ROTATION_SMOOTHING;
  }
  lastMoveX = e.clientX;
  lastMoveTime = now;
  updateGhostTransform();
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

  rotation = 0;
  lastMoveX = e.clientX;
  lastMoveTime = performance.now();

  const url = findTileImageUrl(drag.tile) || getUrl(sticker.id, sticker.format_type);
  logger.info("pointer-drag: ghost image source", url, "tile outerHTML:", drag.tile.outerHTML.slice(0, 500));

  ghost = document.createElement("img");
  ghost.addEventListener("load", () => logger.info("pointer-drag: ghost image loaded successfully", url));
  ghost.addEventListener("error", ev => logger.warn("pointer-drag: ghost image FAILED to load", url, ev));
  ghost.src = url;
  ghost.style.cssText = "position:fixed;z-index:2147483647;width:96px;max-width:96px;"
    + "pointer-events:none;opacity:.85;";
  document.body.appendChild(ghost);
  updateGhostPosition(e.clientX, e.clientY);
  updateGhostTransform();
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
  updateGhostRotation(e);
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

  const lockedRotation = Math.round(rotation);
  const anchorEl = findAnchorMessageElement(e.clientX, e.clientY);
  const anchorInfo = anchorEl && parseMessageElementId(anchorEl.id);

  let content: string;
  if (anchorInfo) {
    const rect = anchorEl!.getBoundingClientRect();
    const dx = Math.round(e.clientX - rect.left);
    const dy = Math.round(e.clientY - rect.top);
    content = `SS{${anchorInfo.messageId},${dx},${dy},${lockedRotation}}`;
    logger.info("pointerup: dropped sticker", drag.id, "anchored to message", anchorInfo.messageId, "offset", { dx, dy }, "rotation", lockedRotation);
  } else {
    const x = Math.round(e.clientX);
    const y = Math.round(e.clientY);
    content = `SS{0,${x},${y},${lockedRotation}}`;
    logger.warn("pointerup: no nearby message to anchor to - falling back to fixed viewport position", { x, y }, "rotation", lockedRotation);
  }

  logger.info("pointerup: sending to channel", channel.id, "content:", content);

  sendMessage(channel.id, { content }, true, { stickerIds: [drag.id] })
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

// A placed sticker's on-screen position is always derived live from its anchor message's
// current bounding rect (not stored), so it naturally tracks that message as chat scrolls.
// Returns null if the anchor message isn't currently rendered (e.g. scrolled out of the
// virtualized list) - such stickers are simply not shown, same as the message itself.
function computeStickerPosition(s: OverlaySticker): { left: number; top: number; } | null {
  if (s.anchorMessageId === "0") {
    return { left: s.dx, top: s.dy };
  }
  const anchorEl = getMessageElement(s.channelId, s.anchorMessageId);
  if (!anchorEl) return null;
  const rect = anchorEl.getBoundingClientRect();
  return { left: rect.left + s.dx, top: rect.top + s.dy };
}

function StickerOverlay() {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const cb = () => forceUpdate(n => n + 1);
    listeners.add(cb);
    return () => void listeners.delete(cb);
  }, []);

  const currentChannelId = getCurrentChannel()?.id;
  const all = Array.from(overlayStickers.values());
  const visible = all
    .filter(s => s.channelId === currentChannelId)
    .map(s => ({ sticker: s, pos: computeStickerPosition(s) }))
    .filter((v): v is { sticker: OverlaySticker; pos: { left: number; top: number; }; } => v.pos !== null);

  logger.debug("StickerOverlay render: currentChannelId=", currentChannelId, "total registered=", all.length, "visible=", visible.length);

  return (
    <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 2147483647 }}>
      {visible.map(({ sticker: s, pos }) => (
        <img
          key={s.messageId}
          src={s.url}
          onLoad={() => logger.debug("Overlay sticker image loaded", s.messageId, s.url)}
          onError={() => logger.warn("Overlay sticker image FAILED to load", s.messageId, s.url)}
          style={{
            position: "fixed",
            left: pos.left,
            top: pos.top,
            width: 96,
            maxWidth: 96,
            transform: `translate(-50%, -50%) rotate(${s.rotation}deg)`,
            pointerEvents: "none"
          }}
        />
      ))}
    </div>
  );
}

// "scroll" doesn't bubble, but it can be caught in the capture phase from any ancestor
// (including document), which is how we notice the chat scroller moving without needing
// to locate that specific internal element ourselves. rAF-throttled since scroll fires
// far faster than we need to re-derive positions.
let viewportChangeRafPending = false;

function onViewportChange() {
  if (viewportChangeRafPending) return;
  viewportChangeRafPending = true;
  requestAnimationFrame(() => {
    viewportChangeRafPending = false;
    notify();
  });
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

export default definePlugin({
  name: "StickyStickers",
  description: "Drag a sticker out of the sticker picker and drop it anywhere to place it on screen at that spot, for everyone in the channel.",
  authors: [Devs.Commandtechno],

  patches: [
    {
      find: "}renderStickersAccessories(",
      replacement: {
        match: /renderStickersAccessories\((\i)\){let (\i)=\(0,\i\.\i\)\(\i\).+?;/,
        replace: (m, message, stickers) => `${m}${stickers}=$self.filterStickyStickerAccessories(${stickers},${message});`
      }
    }
  ],

  filterStickyStickerAccessories(stickers: unknown[], message: StickyMessage) {
    if (parseStickyMessage(message)) {
      logger.debug("Suppressing inline sticker render for placed-sticker message", message.id);
      return [];
    }
    return stickers;
  },

  flux: {
    MESSAGE_CREATE({ message, optimistic }: { message: StickyMessage; optimistic: boolean; }) {
      // Skip the client's own not-yet-acknowledged echo of a just-sent message -
      // we'll register it once the real, server-confirmed create comes through.
      if (optimistic) return;

      const channelId = message.channel_id ?? message.channelId;
      // The MESSAGE_CREATE event's own payload can lag behind what's actually in
      // MessageStore (e.g. stickerItems not hydrated yet) - re-fetch the authoritative
      // copy rather than trusting the event payload directly.
      const stored: StickyMessage | undefined = channelId ? MessageStore.getMessage(channelId, message.id) : undefined;
      // Only log messages that could plausibly be one of ours, so normal chat doesn't spam this.
      if (XY_PATTERN.test(message.content ?? "") || (message.stickerItems?.length ?? 0) > 0) {
        logger.info(
          "MESSAGE_CREATE", message.id, "channel:", channelId,
          "content:", message.content,
          "stickerItems in event:", message.stickerItems?.length ?? 0,
          "stickerItems in store:", stored?.stickerItems?.length ?? 0
        );
      }
      registerIfSticky(stored ?? message);
    },
    MESSAGE_DELETE({ id }: { id: string; }) {
      if (overlayStickers.delete(id)) {
        logger.info("Removed overlay sticker for deleted message", id);
        notify();
      }
    },
    CHANNEL_SELECT() {
      rescanCurrentChannel();
    },
    LOAD_MESSAGES_SUCCESS() {
      rescanCurrentChannel();
    }
  },

  start() {
    document.addEventListener("dragstart", onNativeDragStart, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerCancel, true);
    document.addEventListener("click", onClickCapture, true);
    document.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);

    container = document.createElement("div");
    container.id = "vc-sticky-stickers-root";
    document.body.append(container);
    root = createRoot(container);
    root.render(<StickerOverlay />);

    rescanCurrentChannel();

    logger.info("Started - listeners attached");
  },

  stop() {
    document.removeEventListener("dragstart", onNativeDragStart, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerup", onPointerUp, true);
    document.removeEventListener("pointercancel", onPointerCancel, true);
    document.removeEventListener("click", onClickCapture, true);
    document.removeEventListener("scroll", onViewportChange, true);
    window.removeEventListener("resize", onViewportChange);

    pending = null;
    suppressNextClick = false;
    removeGhost();

    root?.unmount();
    root = undefined;
    container?.remove();
    container = undefined;

    overlayStickers.clear();

    logger.info("Stopped - listeners removed");
  }
});
