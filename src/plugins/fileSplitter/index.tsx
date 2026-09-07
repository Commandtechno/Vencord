/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "@plugins/fileSplitter/styles.css";

import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { Devs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { Channel, CloudUpload as TCloudUpload, Message } from "@vencord/discord-types";
import { CloudUploadPlatform, PremiumType } from "@vencord/discord-types/enums";
import { findLazy } from "@webpack";
import { Alerts, Constants, MessageActions, MessageStore, RestAPI, showToast, SnowflakeUtils, Toasts, useEffect, UserStore, useState } from "@webpack/common";

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

function getPlanChunkSizeBytes(): number {
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
                const chunkFile = new File([blob], chunkName, { type: totalParts === 1 ? file.type : "application/octet-stream" });

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
            await editStatusMessage(channelId, statusMessageId, `📦 Failed to fully send **${file.name}**: ${err}`).catch(() => {});
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

interface FoundChunk { index: number; url: string; }

function collectGroupChunks(channelId: string, groupId: string, total: number): FoundChunk[] {
    const messages = (MessageStore.getMessages(channelId) as any)?._array as Message[] | undefined ?? [];
    const found = new Map<number, FoundChunk>();

    for (const m of messages) {
        for (const a of (m as any).attachments ?? []) {
            const parsed = parseChunkFilename(a.filename);
            if (parsed && parsed.groupId === groupId) found.set(parsed.index, { index: parsed.index, url: a.url });
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

type DownloadStatus = "idle" | "missing" | "error" | { current: number; total: number; };

function SplitFileGroup({ channelId, groupId, chunksInThisMessage }: {
    channelId: string;
    groupId: string;
    chunksInThisMessage: ParsedChunk[];
}) {
    const { total, origSize, origName } = chunksInThisMessage[0];
    const hasLastPart = chunksInThisMessage.some(c => c.index === total);
    const indices = chunksInThisMessage.map(c => c.index).sort((a, b) => a - b);

    const [status, setStatus] = useState<DownloadStatus>("idle");
    const busy = typeof status === "object";

    async function download() {
        setStatus({ current: 0, total });
        const chunks = collectGroupChunks(channelId, groupId, total);
        if (chunks.length !== total) {
            setStatus("missing");
            return;
        }

        try {
            const buffers: ArrayBuffer[] = [];
            for (let i = 0; i < chunks.length; i++) {
                const res = await fetch(chunks[i].url);
                if (!res.ok) throw new Error(`HTTP ${res.status} fetching part ${chunks[i].index}`);
                buffers.push(await res.arrayBuffer());
                setStatus({ current: i + 1, total });
            }

            const blob = new Blob(buffers);
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = origName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10_000);

            setStatus("idle");
        } catch (err) {
            logger.error("Failed to reassemble split file", err);
            setStatus("error");
        }
    }

    return (
        <div className={cl("group")}>
            <Paragraph className={cl("info")}>
                📦 Split file: <strong>{origName}</strong> ({humanSize(origSize)}) — part{indices.length > 1 ? "s" : ""} {indices.join(", ")} of {total}
            </Paragraph>
            {hasLastPart && (
                <Button size="small" variant="secondary" disabled={busy} onClick={download}>
                    {status === "idle" && "Download & reassemble"}
                    {busy && `Downloading part ${(status as { current: number; }).current}/${total}…`}
                    {status === "missing" && "Missing some parts — click to retry"}
                    {status === "error" && "Download failed — click to retry"}
                </Button>
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
    dependencies: ["MessageAccessoriesAPI"],

    patches: [
        {
            // Suppress Discord's normal attachment renderer for messages made entirely of split-file
            // parts (they're opaque binary chunks); renderMessageAccessory below renders our UI instead.
            // Matches the call expression itself (not what precedes it) so this composes correctly
            // even if another plugin (e.g. e2ee) has already wrapped the same call site.
            find: "this.renderAttachments(",
            replacement: {
                match: /this\.renderAttachments\((\i)\)/,
                replace: "($self.shouldHideAttachments($1)?null:this.renderAttachments($1))"
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

    shouldHideAttachments: isChunkMessage,
    interceptUpload,

    stop() {
        transfers.clear();
        transferListeners.clear();
    },

    renderMessageAccessory({ message }) {
        if (transfers.has(message.id)) return <TransferProgress messageId={message.id} />;
        if (!isChunkMessage(message)) return null;
        return <SplitFileAccessory message={message} />;
    },
});
