/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import definePlugin from "@utils/types";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, ReactDOM, Tooltip, useRef, UserSettingsActionCreators, useState } from "@webpack/common";
import { ReactNode } from "react";

const cl = classNameFactory("vc-reorder-gifs-");

interface FavoriteGif {
  format: number;
  src: string;
  width: number;
  height: number;
  order: number;
}

interface FavoriteWithUrl extends FavoriteGif {
  url: string;
}

// Discord sorts favorites by order descending (newest favorite = highest order = first)
function getFavorites(): FavoriteWithUrl[] {
  const gifs: Record<string, FavoriteGif> =
    UserSettingsActionCreators.FrecencyUserSettingsActionCreators.getCurrentValue()?.favoriteGifs?.gifs ?? {};

  return Object.entries(gifs)
    .map(([url, gif]) => ({ ...gif, url }))
    .sort((a, b) => b.order - a.order);
}

function saveOrder(gifs: FavoriteWithUrl[]) {
  UserSettingsActionCreators.FrecencyUserSettingsActionCreators.updateAsync(
    "favoriteGifs",
    (favoriteGifs: { gifs: Record<string, FavoriteGif>; }) => {
      gifs.forEach((gif, i) => {
        const entry = favoriteGifs.gifs[gif.url];
        if (entry != null) entry.order = gifs.length - i;
      });
    },
    0
  );
}

const isVideo = (src: string) => /\.(mp4|webm)(\?|$)/i.test(src);

const DRAG_THRESHOLD = 5;
const AUTOSCROLL_ZONE = 48;
const AUTOSCROLL_SPEED = 16;

function GifMedia({ gif }: { gif: FavoriteGif; }) {
  return isVideo(gif.src)
    ? <video src={gif.src} autoPlay loop muted playsInline />
    : <img src={gif.src} alt="" loading="lazy" draggable={false} />;
}

interface DragState {
  index: number;
  x: number;
  y: number;
}

// Custom pointer-based drag: native HTML5 dnd breaks inside Discord
// (global file upload drag handlers + Chromium aborting drags when the
// source node is reordered mid-drag)
function ReorderModal({ modalProps }: { modalProps: RenderModalProps; }) {
  const [gifs, setGifs] = useState(getFavorites);
  const [drag, setDrag] = useState<DragState | null>(null);
  // authoritative drag position; state above only mirrors it for rendering
  const dragRef = useRef<DragState | null>(null);
  const pendingRef = useRef<DragState | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  function findScroller() {
    for (let node = gridRef.current?.parentElement; node != null; node = node.parentElement) {
      const { overflowY } = getComputedStyle(node);
      if (overflowY === "auto" || overflowY === "scroll") return node;
    }
    return null;
  }

  function onPointerDown(e: React.PointerEvent, index: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    pendingRef.current = { index, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const pending = pendingRef.current;
    if (pending == null) return;

    if (dragRef.current == null) {
      if (Math.abs(e.clientX - pending.x) + Math.abs(e.clientY - pending.y) < DRAG_THRESHOLD) return;
      dragRef.current = pending;
    }

    const scroller = findScroller();
    if (scroller != null) {
      const { top, bottom } = scroller.getBoundingClientRect();
      if (e.clientY < top + AUTOSCROLL_ZONE) scroller.scrollBy(0, -AUTOSCROLL_SPEED);
      else if (e.clientY > bottom - AUTOSCROLL_ZONE) scroller.scrollBy(0, AUTOSCROLL_SPEED);
    }

    const target = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest<HTMLElement>("[data-reorder-index]");

    if (target != null) {
      const from = dragRef.current.index;
      const targetIndex = Number(target.dataset.reorderIndex);

      if (targetIndex !== from) {
        setGifs(gifs => {
          const next = [...gifs];
          const [item] = next.splice(from, 1);
          next.splice(targetIndex, 0, item);
          return next;
        });
        dragRef.current.index = targetIndex;
      }
    }

    dragRef.current = { ...dragRef.current, x: e.clientX, y: e.clientY };
    setDrag(dragRef.current);
  }

  function onPointerEnd() {
    pendingRef.current = null;
    dragRef.current = null;
    setDrag(null);
  }

  return (
    <Modal
      {...modalProps}
      size="lg"
      title="Reorder Favorite GIFs"
      subtitle="Drag & drop to change the order your favorites appear in"
      actions={[
        {
          text: "Cancel",
          variant: "secondary",
          onClick: modalProps.onClose
        },
        {
          text: "Save",
          variant: "primary",
          disabled: gifs.length === 0,
          onClick: () => {
            saveOrder(gifs);
            modalProps.onClose();
          }
        }
      ]}
    >
      {gifs.length === 0
        ? <div className={cl("empty")}>You don't have any favorite GIFs</div>
        : (
          <div className={cl("grid")} ref={gridRef}>
            {gifs.map((gif, i) => (
              <div
                key={gif.url}
                data-reorder-index={i}
                className={cl("item", { dragging: drag?.index === i })}
                onPointerDown={e => onPointerDown(e, i)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerEnd}
                onPointerCancel={onPointerEnd}
              >
                <GifMedia gif={gif} />
                <span className={cl("index")}>{i + 1}</span>
              </div>
            ))}

            {/* portaled to body: the modal's transform would otherwise become
                the containing block for position: fixed and offset the ghost */}
            {drag != null && ReactDOM.createPortal(
              <div
                className={cl("ghost")}
                style={{ left: drag.x, top: drag.y }}
              >
                <GifMedia gif={gifs[drag.index]} />
              </div>,
              document.body
            )}
          </div>
        )}
    </Modal>
  );
}

function ReorderButton() {
  return (
    <Tooltip text="Reorder favorites">
      {tooltipProps => (
        <button
          {...tooltipProps}
          className={cl("button")}
          aria-label="Reorder favorites"
          onClick={() => openModal(props => (
            <ErrorBoundary>
              <ReorderModal modalProps={props} />
            </ErrorBoundary>
          ))}
        >
          <svg role="img" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16 17.01V10h-2v7.01h-3L15 21l4-3.99h-3zM9 3L5 6.99h3V14h2V6.99h3L9 3z" />
          </svg>
        </button>
      )}
    </Tooltip>
  );
}

export default definePlugin({
  name: "ReorderGifs",
  description: "Reorder your favorite GIFs in the GIF picker via drag & drop",
  authors: [Devs.Commandtechno],
  tags: ["Media", "Customisation"],

  patches: [
    {
      find: "renderHeaderContent(){",
      replacement: {
        // wrap the returned favorites header to append the reorder button
        match: /(?<=FAVORITES:return)(.+?)(?=;case)/,
        replace: " $self.renderFavoritesHeader($1)"
      }
    }
  ],

  renderFavoritesHeader: (original: ReactNode) => (
    <>
      {original}
      <ErrorBoundary noop>
        <ReorderButton />
      </ErrorBoundary>
    </>
  )
});
