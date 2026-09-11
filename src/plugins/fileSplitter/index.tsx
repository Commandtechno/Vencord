/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "@plugins/fileSplitter/styles.css";

import { updateMessage } from "@api/MessageUpdater";
import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { Devs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { Channel, CloudUpload as TCloudUpload, Message } from "@vencord/discord-types";
import { CloudUploadPlatform, PremiumType } from "@vencord/discord-types/enums";
import { findLazy } from "@webpack";
import { Alerts, Constants, MessageActions, MessageStore, RestAPI, SelectedChannelStore, showToast, SnowflakeUtils, Toasts, useEffect, useMemo, UserStore, useState } from "@webpack/common";

const cl = classNameFactory("vc-filesplitter-");
const logger = new Logger("FileSplitter");

/** Same lookup e2ee/VoiceMessages use — the real CloudUpload class, not just the type. */
const CloudUpload: typeof TCloudUpload = findLazy(m => m.prototype?.trackUploadFinished);

const MAGIC = "vcsplit";
// vcsplit__<groupId hex8>__<index>-<total>__<origSize>__<origFilename>
const CHUNK_RE = /^vcsplit__([0-9a-f]{8})__(\d+)-(\d+)__(\d+)__(.+)$/;

const FLOOR_CHUNK_BYTES = 512 * 1024;

interface ParsedChunk {
  groupId: string;
  index: number;
  total: number;
  origSize: number;
  origName: string;
}

function parseChunkFilename(filename: string): ParsedChunk | null {
  const m = CHUNK_RE.exec(filename);
  if (!m) return null;
  return {
    groupId: m[1],
    index: Number(m[2]),
    total: Number(m[3]),
    origSize: Number(m[4]),
    origName: m[5],
  };
}

function buildChunkFilename(groupId: string, index: number, total: number, origSize: number, origName: string): string {
  return `${MAGIC}__${groupId}__${index}-${total}__${origSize}__${origName}`;
}

function generateGroupId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function humanSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

// Hard byte limits, not user-configurable — these mirror Discord's own per-plan attachment caps,
// and apply to a whole message's combined attachment size (not per-file), so one full-size chunk
// already saturates a message — every part is sent as its own message.
// TIER_0 is Nitro Basic (its numeric value is 3, an artifact of when it was added); TIER_1/TIER_2
// (legacy Nitro Classic / full Nitro) both get the full-Nitro cap.
const FREE_LIMIT_BYTES = 20 * 1024 * 1024;
const BASIC_LIMIT_BYTES = 50 * 1024 * 1024;
const NITRO_LIMIT_BYTES = 500 * 1024 * 1024;

const LIMIT_BY_PREMIUM_TYPE: Record<number, number> = {
  [PremiumType.NONE]: FREE_LIMIT_BYTES,
  [PremiumType.TIER_0]: BASIC_LIMIT_BYTES,
  [PremiumType.TIER_1]: NITRO_LIMIT_BYTES,
  [PremiumType.TIER_2]: NITRO_LIMIT_BYTES,
};

// TEMPORARY — testing override, forces everyone onto a 10MB chunk size regardless of actual plan so
// splitting/reassembly can be tested without uploading huge files. Set back to null before shipping.
const DEBUG_FORCE_CHUNK_SIZE_BYTES: number | null = 10 * 1024 * 1024;

function getPlanChunkSizeBytes(): number {
  // if (DEBUG_FORCE_CHUNK_SIZE_BYTES != null) return DEBUG_FORCE_CHUNK_SIZE_BYTES;
  const premiumType = UserStore.getCurrentUser()?.premiumType ?? PremiumType.NONE;
  return LIMIT_BY_PREMIUM_TYPE[premiumType] ?? FREE_LIMIT_BYTES;
}

// ---------- live progress (no toasts — a real, continuously updating bar) ----------

interface TransferState {
  fileName: string;
  totalBytes: number;
  uploadedBytes: number;
  partIndex: number;
  partsTotal: number;
  phase: "uploading" | "sending" | "done" | "error";
}

const transfers = new Map<string, TransferState>();
const transferListeners = new Map<string, Set<() => void>>();

function updateTransfer(messageId: string, patch: Partial<TransferState>) {
  const cur = transfers.get(messageId);
  if (!cur) return;
  Object.assign(cur, patch);
  transferListeners.get(messageId)?.forEach(fn => fn());
}

function useTransfer(messageId: string): TransferState | undefined {
  const [, bump] = useState(0);
  useEffect(() => {
    let listeners = transferListeners.get(messageId);
    if (!listeners) transferListeners.set(messageId, listeners = new Set());
    const onChange = () => bump(x => x + 1);
    listeners.add(onChange);
    return () => {
      listeners!.delete(onChange);
      if (listeners!.size === 0) transferListeners.delete(messageId);
    };
  }, [messageId]);
  return transfers.get(messageId);
}

function TransferProgress({ messageId }: { messageId: string; }) {
  const state = useTransfer(messageId);
  if (!state) return null;

  const pct = state.totalBytes > 0 ? Math.min(100, (state.uploadedBytes / state.totalBytes) * 100) : 0;

  return (
    <div className={cl("progress")}>
      <div className={cl("progress-track")}>
        <div className={cl("progress-fill")} style={{ width: `${pct}%` }} />
      </div>
      <Paragraph className={cl("info")}>
        {state.phase === "uploading" && `Part ${state.partIndex}/${state.partsTotal} — ${humanSize(state.uploadedBytes)} / ${humanSize(state.totalBytes)} (${pct.toFixed(0)}%)`}
        {state.phase === "sending" && `Part ${state.partIndex}/${state.partsTotal} — sending message…`}
      </Paragraph>
    </div>
  );
}

// ---------- sending ----------

/** Uploads a single file, polling `.loaded` for live byte-level progress (same field Discord's own progress bar reads). */
function uploadFileWithProgress(file: File, channelId: string, onProgress: (loadedBytes: number) => void): Promise<TCloudUpload> {
  return new Promise((resolve, reject) => {
    const upload = new CloudUpload({
      file,
      isThumbnail: false,
      platform: CloudUploadPlatform.WEB,
    }, channelId);

    const poll = setInterval(() => {
      if (upload.status === "UPLOADING" || upload.status === "STARTED") onProgress(upload.loaded ?? 0);
    }, 150);

    upload.on("complete", () => {
      clearInterval(poll);
      onProgress(file.size);
      resolve(upload);
    });
    upload.on("error", () => {
      clearInterval(poll);
      reject(new Error(`upload of "${file.name}" was rejected (likely too large for this channel)`));
    });

    upload.upload();
  });
}

async function postStatusMessage(channelId: string, file: File, totalParts: number): Promise<string> {
  const { body } = await RestAPI.post({
    url: Constants.Endpoints.MESSAGES(channelId),
    body: {
      content: `📦 Sending **${file.name}** (${humanSize(file.size)}) as ${totalParts} message${totalParts === 1 ? "" : "s"}…`,
      nonce: SnowflakeUtils.fromTimestamp(Date.now()),
      sticker_ids: [],
      type: 0,
      attachments: [],
    },
  });
  return body.id;
}

async function editStatusMessage(channelId: string, messageId: string, content: string) {
  await MessageActions.editMessage(channelId, messageId, { content });
}

async function sendPartMessage(channelId: string, upload: TCloudUpload) {
  await RestAPI.post({
    url: Constants.Endpoints.MESSAGES(channelId),
    body: {
      content: "",
      nonce: SnowflakeUtils.fromTimestamp(Date.now()),
      sticker_ids: [],
      type: 0,
      attachments: [{ id: "0", filename: upload.filename, uploaded_filename: upload.uploadedFilename }],
    },
  });
}

function confirmSplitSend(file: File, totalParts: number): Promise<boolean> {
  if (totalParts <= 1) return Promise.resolve(true);
  return new Promise(resolve => {
    Alerts.show({
      title: "Send large file?",
      body: `"${file.name}" (${humanSize(file.size)}) is too big for one message. It'll be split into ${totalParts} parts and sent as ${totalParts} separate messages. Continue?`,
      confirmText: "Send",
      cancelText: "Cancel",
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

function doneNote(file: File, totalParts: number): string {
  if (totalParts <= 1) return "";
  return `📦 **${file.name}** (${humanSize(file.size)}) — sent as ${totalParts} parts by FileSplitter.\n`
    + "Install the FileSplitter Vencord plugin to auto-download & reassemble, or manually download every part in order and join the raw bytes yourself "
    + "(e.g. `copy /b part1+part2+... whole.file` on Windows, or `cat part1 part2 ... > whole.file` on macOS/Linux).";
}

async function sendSplitFile(file: File, channelId: string) {
  let chunkSize = getPlanChunkSizeBytes();
  let totalParts = Math.max(1, Math.ceil(file.size / chunkSize));

  if (!await confirmSplitSend(file, totalParts)) return;

  const groupId = generateGroupId();
  let statusMessageId: string | null = null;

  try {
    outer: while (true) {
      totalParts = Math.max(1, Math.ceil(file.size / chunkSize));

      if (statusMessageId == null) {
        statusMessageId = await postStatusMessage(channelId, file, totalParts);
        transfers.set(statusMessageId, {
          fileName: file.name, totalBytes: file.size, uploadedBytes: 0,
          partIndex: 0, partsTotal: totalParts, phase: "uploading",
        });
      } else {
        updateTransfer(statusMessageId, { partsTotal: totalParts, uploadedBytes: 0, partIndex: 0 });
      }

      let completedBytes = 0;
      for (let i = 1; i <= totalParts; i++) {
        const start = (i - 1) * chunkSize;
        const end = Math.min(file.size, start + chunkSize);
        const blob = file.slice(start, end);
        const chunkName = totalParts === 1 ? file.name : buildChunkFilename(groupId, i, totalParts, file.size, file.name);
        // Part 1 keeps the real MIME type (not application/octet-stream like the rest) so
        // Discord's own backend processes it as a real, if truncated, video/image and computes
        // real width/height/thumbnail data for it — free metadata we can borrow for the
        // synthetic reassembled attachment later, no reencoding needed. Only works when the
        // format's metadata happens to live in this first chunk's byte range (e.g. a faststart
        // MP4); nothing is lost by trying it unconditionally.
        const chunkFile = new File([blob], chunkName, { type: totalParts === 1 || i === 1 ? file.type : "application/octet-stream" });

        updateTransfer(statusMessageId, { partIndex: i, phase: "uploading" });

        let upload: TCloudUpload;
        try {
          upload = await uploadFileWithProgress(chunkFile, channelId, loaded =>
            updateTransfer(statusMessageId!, { uploadedBytes: completedBytes + loaded }));
        } catch (err) {
          // Nothing has been sent yet on the very first part — safe to shrink and restart
          // the whole split from scratch in case our hardcoded plan limit is stale.
          if (i === 1 && chunkSize > FLOOR_CHUNK_BYTES) {
            logger.warn("First part rejected, shrinking chunk size and retrying", err);
            chunkSize = Math.max(FLOOR_CHUNK_BYTES, Math.floor(chunkSize / 2));
            continue outer;
          }
          throw err;
        }

        completedBytes += end - start;
        updateTransfer(statusMessageId, { uploadedBytes: completedBytes, phase: "sending" });
        await sendPartMessage(channelId, upload);
      }

      break;
    }

    if (statusMessageId) await editStatusMessage(channelId, statusMessageId, doneNote(file, totalParts) || `📦 Sent **${file.name}**`);
  } catch (err) {
    logger.error("Split-file transfer failed", err);
    if (statusMessageId) {
      await editStatusMessage(channelId, statusMessageId, `📦 Failed to fully send **${file.name}**: ${err}`).catch(() => { });
    }
    showToast(`Failed to send "${file.name}": ${err}`, Toasts.Type.FAILURE);
  } finally {
    if (statusMessageId) transfers.delete(statusMessageId);
  }
}

// ---------- intercept the normal upload flow ----------

/**
 * Called from inside Discord's own upload-prompt function (patched below), before it does
 * anything else — including before its own "file too large" check that would otherwise show
 * Discord's native error modal. Splits out anything over the plan limit to `sendSplitFile`, and
 * returns only the files Discord should keep handling normally (also filtering `options.filesMetadata`
 * in lockstep, if the caller passed one, so the arrays stay aligned instead of throwing Discord's own
 * "Unexpected mismatch between files and file metadata" error).
 */
function interceptUpload(files: File[] | FileList, channel: Channel, options: any): File[] {
  // Discord doesn't guarantee an actual Array here (its own code does the same `Array.from`
  // right after this call returns) — could be a FileList from a drop or a native file input.
  const fileArray = Array.from(files as ArrayLike<File>);
  const limit = getPlanChunkSizeBytes();
  const meta = options?.filesMetadata as any[] | undefined;
  const passthroughFiles: File[] = [];
  const passthroughMeta: any[] = [];

  fileArray.forEach((file, i) => {
    if (file.size <= limit) {
      passthroughFiles.push(file);
      if (meta) passthroughMeta.push(meta[i]);
    } else {
      sendSplitFile(file, channel.id);
    }
  });

  if (meta && options) options.filesMetadata = passthroughMeta;
  return passthroughFiles;
}

// ---------- receiving ----------

function isChunkMessage(message: Message | any): boolean {
  const attachments = message?.attachments;
  return !!attachments?.length && attachments.every((a: any) => parseChunkFilename(a.filename) != null);
}

interface FoundChunk { index: number; url: string; size: number; raw: any; }

function collectGroupChunks(channelId: string, groupId: string, total: number): FoundChunk[] {
  const messages = (MessageStore.getMessages(channelId) as any)?._array as Message[] | undefined ?? [];
  const found = new Map<number, FoundChunk>();

  for (const m of messages) {
    for (const a of (m as any).attachments ?? []) {
      const parsed = parseChunkFilename(a.filename);
      if (parsed && parsed.groupId === groupId) found.set(parsed.index, { index: parsed.index, url: a.url, size: a.size, raw: a });
    }
  }

  const ordered: FoundChunk[] = [];
  for (let i = 1; i <= total; i++) {
    const chunk = found.get(i);
    if (!chunk) return ordered;
    ordered.push(chunk);
  }
  return ordered;
}

/**
 * Builds a vcstream://FileSplitter/... URL backed by our native.ts handler, which proxies real
 * HTTP range requests straight to the underlying CDN parts — the file is never buffered whole
 * anywhere, renderer or main process. Desktop only; see native.ts and @main/index.ts for the rest.
 * vcstream: is a dedicated scheme (registered privileged, standard+stream) specifically so
 * <video>/<audio> will actually treat it as a real streamable media source.
 */
/**
 * Base64url so the manifest never contains a literal "/", ":" or recognizable URL/filename
 * pattern — the manifest embeds the real Discord CDN URLs (which themselves contain the raw,
 * vcsplit__-prefixed chunk filenames), and plain JSON+encodeURIComponent leaves those fully
 * decodable as a substring of our own URL. Something downstream appears to sniff a filename out
 * of any URL-shaped text it finds rather than trusting the attachment's actual filename field —
 * this makes there be no such text to find.
 */
function base64UrlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildStreamUrl(origName: string, chunks: FoundChunk[], totalSize: number, mimeType: string): string {
  const manifest = {
    urls: chunks.map(c => c.url),
    sizes: chunks.map(c => c.size),
    totalSize,
    mimeType,
    // cdn.discordapp.com (chunk 1's plain .url) serves files as-is — it doesn't do on-the-fly
    // thumbnail resizing. Only proxy_url (media.discordapp.net) honors the format=/width=/height=
    // params Discord's client appends for a preview image, so that's what native.ts needs for
    // forwarding those requests (and falling back to a placeholder when chunk 1 alone isn't a
    // parseable container on its own — e.g. non-faststart video).
    part1ProxyUrl: chunks[0]?.raw?.proxy_url as string | undefined,
  };
  const dot = origName.lastIndexOf(".");
  const ext = dot === -1 ? "" : origName.slice(dot);
  return `vcstream://FileSplitter/stream${ext}?m=${base64UrlEncode(JSON.stringify(manifest))}`;
}

/**
 * A synthetic Discord `MessageAttachment`, based on chunk 1's own *real* attachment — {filename,
 * id, proxy_url, size, spoiler, url, content_type} is the entire shape Discord's own renderer
 * needs (see discord-types), so handing it chunk 1's real one back with `url`/`proxy_url` (and a
 * couple of cosmetic fields) pointed at our vcstream:// URL is enough to get Discord's real, native
 * attachment UI (player, controls, download button, everything) instead of our own.
 *
 * Both `url` (actual video/audio bytes) and `proxy_url` (the `?format=&width=&height=` poster
 * request Discord makes before showing a player) are routed through vcstream:// rather than
 * leaving proxy_url as chunk 1's real media.discordapp.net URL — chunk 1 alone isn't always a
 * parseable container on its own (e.g. non-faststart video has its moov atom past chunk 1's byte
 * range entirely), and a hard failure straight from Discord's CDN can break the whole embed. Going
 * through native.ts lets it forward to the real thumbnail when chunk 1 can produce one, and fall
 * back to a placeholder when it can't, instead of ever passing an error through untouched.
 */
function buildNativeAttachment(groupId: string, chunks: FoundChunk[], origSize: number, origName: string) {
  const mimeType = mimeTypeFor(origName) ?? "application/octet-stream";
  const url = buildStreamUrl(origName, chunks, origSize, mimeType);

  const base = chunks[0]?.raw ?? {};
  const kind = guessMediaKind(origName);

  return {
    ...base,
    // A real Discord attachment id is always a numeric snowflake — our hex groupId is not a valid
    // decimal string, and if anything internally does numeric/BigInt handling on this field (sort,
    // cache key, permission check, anything), a non-numeric id would throw. Use a real snowflake.
    id: SnowflakeUtils.fromTimestamp(Date.now()),
    filename: origName,
    size: origSize,
    url,
    proxy_url: url,
    content_type: base.content_type || mimeType,
    spoiler: false,
    // Video/image attachments need a real (non-zero) width/height for Discord to treat them as
    // inline-embeddable at all — audio needs no dimensions, which is exactly why this worked for
    // audio without this fallback. `base` carries real dimensions when chunk 1's byte range happened
    // to contain the format's metadata; when it doesn't (e.g. non-faststart video, moov elsewhere),
    // fall back to a placeholder rather than silently missing them and losing the inline player.
    ...(kind === "video" || kind === "image") && !(base.width && base.height)
      ? { width: 1280, height: 720 }
      : {},
  };
}

/**
 * Runs on every message right before Discord's own attachment renderer sees it (patched below).
 * For a message made of split-file parts: if we're on desktop and every part of a group is
 * available, swap part 1's raw chunk attachment for one synthetic "real" attachment (built on top
 * of its own real metadata — see buildNativeAttachment) so Discord's native renderer draws it —
 * same player, same controls, same download button as any other attachment. Every other part's
 * attachment is dropped entirely (nothing useful to show on its own); renderMessageAccessory shows
 * the appropriate notice/fallback instead. Non-split-file messages pass through completely
 * untouched.
 */
function transformAttachmentsForRender(message: any) {
  const attachments: any[] = message?.attachments;
  if (!attachments?.length) return message;

  const parsedList = attachments.map(a => parseChunkFilename(a.filename));
  if (parsedList.some(p => p == null)) return message;

  const byGroup = new Map<string, ParsedChunk[]>();
  for (const parsed of parsedList as ParsedChunk[]) {
    const arr = byGroup.get(parsed.groupId) ?? [];
    arr.push(parsed);
    byGroup.set(parsed.groupId, arr);
  }

  const newAttachments: any[] = [];
  for (const [groupId, group] of byGroup) {
    const { total, origSize, origName } = group[0];
    const hasFirstPart = group.some(p => p.index === 1);
    if (!IS_DISCORD_DESKTOP || !hasFirstPart) continue;

    const chunks = collectGroupChunks(message.channel_id, groupId, total);
    if (chunks.length !== total) continue;

    const attachment = buildNativeAttachment(groupId, chunks, origSize, origName);
    newAttachments.push(attachment);
  }

  // Not a plain object spread: message is a real Message record with prototype methods
  // (renderAttachments itself calls e.isPoll()) — {...message} would drop the prototype chain
  // entirely and break those. Keep the same prototype, copy the own data properties, and only
  // override attachments.
  return Object.assign(Object.create(Object.getPrototypeOf(message)), message, { attachments: newAttachments });
}

/**
 * transformAttachmentsForRender only ever substitutes the *argument* passed into Discord's
 * renderAttachments, transiently, for that one call — it never touches the actual Message record
 * sitting in MessageStore. If anything downstream reads attachment data from the stored message
 * directly rather than from that argument, our substitution never reaches it. This is the
 * authoritative fix: persist the corrected attachment straight into the message store with
 * updateMessage (the same technique e2ee uses for rewriting message content), once a group's
 * parts are all known — so every consumer, whatever it reads from, sees the same correct data.
 *
 * Deliberately touches only the message containing part 1, not every message in the group — later
 * parts' "part N of total" messages are already rendering correctly today (their own
 * renderMessageAccessory reads their real, untouched chunk attachment to build that text), and
 * clearing their attachments here would break that. Only part 1's message actually needs a fix
 * (it carries the real, Discord-computed metadata the synthetic attachment is built on — see
 * buildNativeAttachment), so only it gets one.
 */
function tryFinalizeGroup(channelId: string, groupId: string) {
  const allMessages = (MessageStore.getMessages(channelId) as any)?._array as any[] | undefined ?? [];
  let total: number | null = null, origSize = 0, origName = "";
  let firstPartMessage: any = null;

  for (const m of allMessages) {
    for (const a of m.attachments ?? []) {
      const parsed = parseChunkFilename(a.filename);
      if (parsed && parsed.groupId === groupId) {
        total = parsed.total;
        origSize = parsed.origSize;
        origName = parsed.origName;
        if (parsed.index === 1) firstPartMessage = m;
      }
    }
  }
  if (total == null || !firstPartMessage || !IS_DISCORD_DESKTOP) return;

  const chunks = collectGroupChunks(channelId, groupId, total);
  if (chunks.length !== total) return; // not all parts loaded yet — leave everything alone, retried later

  const synthetic = buildNativeAttachment(groupId, chunks, origSize, origName);
  logger.info("[finalize] persisting first-part message", { groupId, messageId: firstPartMessage.id });
  updateMessage(channelId, firstPartMessage.id, { attachments: [synthetic] });
}

function scanForGroupIds(messages: any[]): Set<string> {
  const groupIds = new Set<string>();
  for (const m of messages) {
    for (const a of m.attachments ?? []) {
      const parsed = parseChunkFilename(a.filename);
      if (parsed) groupIds.add(parsed.groupId);
    }
  }
  return groupIds;
}

function tryFinalizeGroupsInChannel(channelId: string) {
  const messages = (MessageStore.getMessages(channelId) as any)?._array as any[] | undefined ?? [];
  for (const groupId of scanForGroupIds(messages)) tryFinalizeGroup(channelId, groupId);
}

type MediaKind = "image" | "video" | "audio" | "file";

function guessMediaKind(name: string): MediaKind {
  if (/\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name)) return "image";
  if (/\.(mp4|webm|mov|m4v|mkv)$/i.test(name)) return "video";
  if (/\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(name)) return "audio";
  return "file";
}

const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/x-m4v", mkv: "video/x-matroska",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif",
};

function mimeTypeFor(name: string): string | undefined {
  const ext = name.split(".").pop()?.toLowerCase();
  return ext ? MIME_BY_EXT[ext] : undefined;
}

function triggerDownload(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function fetchAllChunks(channelId: string, groupId: string, total: number, onProgress: (current: number) => void): Promise<Blob | "missing" | "error"> {
  const chunks = collectGroupChunks(channelId, groupId, total);
  if (chunks.length !== total) return "missing";

  try {
    const buffers: ArrayBuffer[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const res = await fetch(chunks[i].url);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching part ${chunks[i].index}`);
      buffers.push(await res.arrayBuffer());
      onProgress(i + 1);
    }
    return new Blob(buffers);
  } catch (err) {
    logger.error("Failed to reassemble split file", err);
    return "error";
  }
}

type LoadState =
  | { phase: "idle"; }
  | { phase: "loading"; current: number; total: number; }
  | { phase: "missing"; }
  | { phase: "error"; }
  | { phase: "loaded"; blobUrl: string; };

function SplitFileGroup({ channelId, groupId, chunksInThisMessage }: {
  channelId: string;
  groupId: string;
  chunksInThisMessage: ParsedChunk[];
}) {
  const { total, origSize, origName } = chunksInThisMessage[0];
  const hasFirstPart = chunksInThisMessage.some(c => c.index === 1);
  const indices = chunksInThisMessage.map(c => c.index).sort((a, b) => a - b);
  const kind = guessMediaKind(origName);

  // Hooks must run unconditionally on every render — some are only acted on in branches below,
  // but still need to be declared before any early return.
  const [state, setState] = useState<LoadState>({ phase: "idle" });
  useEffect(() => () => {
    if (state.phase === "loaded") URL.revokeObjectURL(state.blobUrl);
  }, [state]);

  // Memoized so the <video>/<audio> src is a genuinely stable string across incidental
  // re-renders (parent message re-rendering, unrelated store updates, etc.) — recomputed only
  // when the group/file identity itself changes, not on every render.
  const streamUrl = useMemo(() => {
    if (!IS_DISCORD_DESKTOP || !hasFirstPart) return null;
    const chunks = collectGroupChunks(channelId, groupId, total);
    if (chunks.length !== total) return "missing" as const;
    return buildStreamUrl(origName, chunks, origSize, mimeTypeFor(origName) ?? "application/octet-stream");
  }, [channelId, groupId, total, origSize, origName, hasFirstPart, kind]);

  const infoLine = (extra?: string) => (
    <Paragraph className={cl("info")}>
      📦 Split file: <strong>{origName}</strong> ({humanSize(origSize)}) — part{indices.length > 1 ? "s" : ""} {indices.join(", ")} of {total}{extra ? ` — ${extra}` : ""}
    </Paragraph>
  );

  if (!hasFirstPart) {
    return infoLine();
  }

  // Desktop, and every part resolvable: transformAttachmentsForRender (see the renderAttachments
  // patch) has already swapped this group's chunk attachments for one synthetic real one, so
  // Discord's own native renderer is drawing the actual player right now — nothing left to add.
  // Only genuinely missing parts need a notice here; a working stream needs none.
  if (IS_DISCORD_DESKTOP) {
    if (streamUrl === "missing" || streamUrl === null) {
      return infoLine("parts missing — scroll up to load the rest");
    }
    return null;
  }

  async function load() {
    setState({ phase: "loading", current: 0, total });
    const result = await fetchAllChunks(channelId, groupId, total, current => setState({ phase: "loading", current, total }));

    if (result === "missing") return setState({ phase: "missing" });
    if (result === "error") return setState({ phase: "error" });

    const mime = mimeTypeFor(origName);
    const blob = mime ? new Blob([result], { type: mime }) : result;
    const blobUrl = URL.createObjectURL(blob);

    if (kind === "file") {
      // Nothing to embed — save straight to disk.
      triggerDownload(blobUrl, origName);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
      setState({ phase: "idle" });
    } else {
      setState({ phase: "loaded", blobUrl });
    }
  }

  const busy = state.phase === "loading";
  const loadLabel = kind === "image" ? "Load & view" : kind === "file" ? "Download & reassemble" : "Load & play";

  return (
    <div className={cl("group")}>
      {infoLine()}
      {state.phase !== "loaded" && (
        <Button size="small" variant="secondary" disabled={busy} onClick={load}>
          {state.phase === "idle" && `${loadLabel} (${humanSize(origSize)})`}
          {state.phase === "loading" && `Loading part ${state.current}/${state.total}…`}
          {state.phase === "missing" && "Missing some parts — click to retry"}
          {state.phase === "error" && "Failed — click to retry"}
        </Button>
      )}
      {state.phase === "loaded" && (
        <>
          {kind === "video" && <video src={state.blobUrl} controls className={cl("media")} />}
          {kind === "audio" && <audio src={state.blobUrl} controls className={cl("media")} />}
          {kind === "image" && <img src={state.blobUrl} alt={origName} className={cl("media")} />}
          <Button size="small" variant="secondary" onClick={() => triggerDownload((state as { blobUrl: string; }).blobUrl, origName)}>
            Save to disk
          </Button>
        </>
      )}
    </div>
  );
}

function SplitFileAccessory({ message }: { message: Message | any; }) {
  const chunks: ParsedChunk[] = (message.attachments as any[])
    .map(a => parseChunkFilename(a.filename))
    .filter((c): c is ParsedChunk => c != null);
  if (chunks.length === 0) return null;

  const byGroup = new Map<string, ParsedChunk[]>();
  for (const c of chunks) {
    const arr = byGroup.get(c.groupId) ?? [];
    arr.push(c);
    byGroup.set(c.groupId, arr);
  }

  return (
    <>
      {Array.from(byGroup.entries()).map(([groupId, group]) => (
        <SplitFileGroup key={groupId} channelId={message.channel_id} groupId={groupId} chunksInThisMessage={group} />
      ))}
    </>
  );
}

export default definePlugin({
  name: "FileSplitter",
  description: "Send files bigger than your plan's upload limit — they're transparently split into parts and sent as multiple messages, with live progress. Anyone with this plugin sees one click to reassemble & download.",
  authors: [Devs.Commandtechno],
  tags: ["Chat", "Utility"],
  dependencies: ["MessageAccessoriesAPI", "MessageUpdaterAPI"],

  patches: [
    {
      // Rather than hide Discord's normal attachment renderer for split-file messages and draw
      // our own player, feed it a transformed message instead — when the file is fully
      // reassemblable, this hands it one synthetic "real" attachment (see
      // transformAttachmentsForRender) so Discord's own native player/controls/download button
      // renders it, indistinguishable from a normal attachment. Otherwise the group's chunk
      // attachments are stripped out entirely and renderMessageAccessory shows a notice/fallback
      // instead. Matches the call expression itself (not what precedes it) so this composes
      // correctly even if another plugin (e.g. e2ee) has already wrapped the same call site.
      find: "this.renderAttachments(",
      replacement: {
        // Global: Discord's bundle calls this.renderAttachments(...) from more than one
        // code path within this module, and Vencord's patcher does a plain (non-global)
        // string replace per regex — without "g" only the first call site gets transformed,
        // leaving any others rendering the raw, untransformed chunk attachments.
        match: /this\.renderAttachments\((\i)\)/g,
        replace: "this.renderAttachments($self.transformAttachmentsForRender($1))"
      }
    },
    {
      // This is Discord's real, single upload-prompt implementation — shared by drag-drop,
      // paste, and the attach button alike. Intercepting here (rather than monkeypatching our
      // own resolved reference to it, which only affects callers going through *that* copy)
      // means every real entry point is covered, and we run before Discord's own size check
      // ever gets a chance to show its native "file too large" modal.
      find: "Unexpected mismatch between files and file metadata",
      replacement: {
        match: /async function (\i)\((\i),(\i),(\i)\)\{/,
        replace: "async function $1($2,$3,$4){$2=$self.interceptUpload($2,$3,arguments[3]);if($2.length===0)return;"
      }
    },
  ],

  transformAttachmentsForRender,
  interceptUpload,

  start() {
    // Fix up anything already loaded (e.g. after a plugin/renderer reload) — flux events below only
    // cover things happening from here on.
    const channelId = SelectedChannelStore.getChannelId();
    if (channelId) tryFinalizeGroupsInChannel(channelId);
  },

  stop() {
    transfers.clear();
    transferListeners.clear();
  },

  flux: {
    MESSAGE_CREATE({ message }: { message: any; }) {
      for (const groupId of scanForGroupIds([message])) tryFinalizeGroup(message.channel_id, groupId);
    },
    LOAD_MESSAGES_SUCCESS({ messages }: { messages: any[]; }) {
      if (messages[0]) tryFinalizeGroupsInChannel(messages[0].channel_id);
    },
    CHANNEL_SELECT({ channelId }: { channelId?: string; }) {
      if (channelId) tryFinalizeGroupsInChannel(channelId);
    },
  },

  renderMessageAccessory({ message }) {
    if (transfers.has(message.id)) return <TransferProgress messageId={message.id} />;
    if (!isChunkMessage(message)) return null;
    return <SplitFileAccessory message={message} />;
  },
});
