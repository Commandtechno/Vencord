/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "@plugins/personalPurge/styles.css";

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { Devs } from "@utils/constants";
import { classNameFactory, createAndAppendStyle } from "@utils/css";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { Constants, NavigationRouter, RestAPI, SnowflakeUtils, useEffect, UserStore, useState } from "@webpack/common";

import { parseTime } from "./parseTime";

const cl = classNameFactory("vc-personalpurge-");
const logger = new Logger("PersonalPurge");

const settings = definePluginSettings({
    deleteDelay: {
        type: OptionType.NUMBER,
        description: "Minimum delay between deletions, in milliseconds. Raised automatically whenever Discord rate limits you",
        default: 1000,
    },
});

// Only these of your own messages can actually be deleted — calls, group DM renames/icon changes,
// recipient adds etc. are authored by you but Discord refuses to delete them.
const DELETABLE_TYPES = new Set([
    0, // DEFAULT
    6, // CHANNEL_PINNED_MESSAGE
    18, // THREAD_CREATED
    19, // REPLY
]);

const ERROR_UNKNOWN_MESSAGE = 10008;
const ERROR_SYSTEM_MESSAGE = 50021;

// Give up if this many deletions fail in a row for reasons other than rate limits.
const MAX_CONSECUTIVE_FAILURES = 5;
const MAX_DELETE_DELAY_MS = 10_000;
const PAGE_SIZE = 100;

const MESSAGE_LINK_RE = /^<?https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/channels\/(?:@me|\d+)\/(\d+)\/(\d+)\/?>?$/;
const SNOWFLAKE_RE = /^\d{17,20}$/;
const DISCORD_EPOCH = 1420070400000;

/** The raw REST shape — just the bits we need. */
interface ApiMessage {
    id: string;
    type: number;
    author: { id: string; };
}

type Phase = "scanning" | "confirm" | "deleting" | "done" | "cancelled" | "error";

interface PurgeJob {
    channelId: string;
    guildId?: string;
    statusMessageId: string;
    phase: Phase;
    /** Exclusive bounds, as snowflakes. */
    after: bigint;
    before: bigint;
    scanned: number;
    /** Your messages in range, newest first. */
    found: ApiMessage[];
    deleted: number;
    skipped: number;
    failed: number;
    delay: number;
    deleteStartedAt: number;
    finishedAt: number;
    error?: string;
    cancelled: boolean;
    resolveConfirm?: (confirmed: boolean) => void;
}

const jobs = new Map<string, PurgeJob>();
const jobListeners = new Set<() => void>();
let activeJob: PurgeJob | null = null;

function notify() {
    jobListeners.forEach(fn => fn());
}

function useJob(statusMessageId: string) {
    const [, bump] = useState(0);
    useEffect(() => {
        const onChange = () => bump(x => x + 1);
        jobListeners.add(onChange);
        return () => void jobListeners.delete(onChange);
    }, []);
    return jobs.get(statusMessageId);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Runs a request, waiting out and retrying any 429s. */
async function withRateLimit<T>(request: () => Promise<T>, onRateLimited?: (retryAfterMs: number) => void): Promise<T> {
    while (true) {
        try {
            return await request();
        } catch (e: any) {
            if (e?.status !== 429) throw e;

            const retryAfterMs = Math.ceil(Number(e.body?.retry_after ?? 1) * 1000);
            logger.warn(`Rate limited, retrying in ${retryAfterMs}ms`);
            onRateLimited?.(retryAfterMs);
            await sleep(retryAfterMs + 250);
        }
    }
}

// ---------- highlighting ----------

// Marks the messages about to be deleted by targeting their list items' DOM ids
// (chat-messages-<channel>-<message>), so no render patch is needed.
let highlightStyle: HTMLStyleElement | null = null;
let highlightOwner: PurgeJob | null = null;

function highlightMessages(job: PurgeJob) {
    clearHighlight();
    if (!job.found.length) return;

    highlightOwner = job;
    highlightStyle = createAndAppendStyle("vc-personalpurge-highlight", document.head);
    const selectors = job.found.map(m => `#chat-messages-${job.channelId}-${m.id}`);
    highlightStyle.textContent = `:is(${selectors.join(",")}) {
        background: color-mix(in srgb, var(--status-danger, #da373c) 14%, transparent) !important;
        box-shadow: inset 3px 0 0 var(--status-danger, #da373c);
    }`;
}

function clearHighlight(owner?: PurgeJob) {
    if (owner && owner !== highlightOwner) return;
    highlightStyle?.remove();
    highlightStyle = null;
    highlightOwner = null;
}

// ---------- bounds ----------

interface Bound {
    id: bigint;
    label: string;
}

function messageUrl(channel: Channel, messageId: string) {
    return `https://discord.com/channels/${channel.guild_id ?? "@me"}/${channel.id}/${messageId}`;
}

function resolveBound(input: string, channel: Channel, kind: "after" | "before"): Bound | string {
    const text = input.trim();

    const link = MESSAGE_LINK_RE.exec(text);
    if (link) {
        if (link[1] !== channel.id) return "That message link is from a different channel. Run `/purge` in that channel instead.";
        return { id: BigInt(link[2]), label: messageUrl(channel, link[2]) };
    }

    if (SNOWFLAKE_RE.test(text)) return { id: BigInt(text), label: messageUrl(channel, text) };

    const date = parseTime(text);
    if (!date) return `Couldn't understand \`${text}\` as a time or message link. Try something like \`2 hours ago\`, \`yesterday 5pm\`, \`last monday\` or \`oct 3\`.`;
    if (date.getTime() > Date.now() + 60_000) return `\`${text}\` is in the future (<t:${Math.floor(date.getTime() / 1000)}:f>).`;

    const snowflake = BigInt(SnowflakeUtils.fromTimestamp(Math.max(date.getTime(), DISCORD_EPOCH)));
    const seconds = Math.floor(date.getTime() / 1000);
    return {
        // Both bounds are exclusive; nudge "after" back so a message sent exactly at that time is included.
        id: kind === "after" ? snowflake - 1n : snowflake,
        label: `<t:${seconds}:f> (<t:${seconds}:R>)`,
    };
}

// ---------- the purge ----------

async function scan(job: PurgeJob) {
    const me = UserStore.getCurrentUser().id;
    let cursor = job.after;

    while (!job.cancelled) {
        const { body: page } = await withRateLimit(() => RestAPI.get({
            url: Constants.Endpoints.MESSAGES(job.channelId),
            query: { after: cursor.toString(), limit: PAGE_SIZE },
            retries: 2,
        })) as { body: ApiMessage[]; };

        if (!page.length) break;

        let reachedEnd = false;
        for (const message of page) {
            const id = BigInt(message.id);
            if (id > cursor) cursor = id;
            if (id >= job.before) {
                reachedEnd = true;
                continue;
            }
            if (message.author.id === me && DELETABLE_TYPES.has(message.type)) job.found.push(message);
        }

        job.scanned += page.length;
        notify();

        if (reachedEnd || page.length < PAGE_SIZE) break;
    }

    job.found.sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
}

async function deleteAll(job: PurgeJob) {
    let consecutiveFailures = 0;

    for (const message of job.found) {
        if (job.cancelled) return;

        const startedAt = Date.now();
        try {
            await withRateLimit(
                () => RestAPI.del({ url: Constants.Endpoints.MESSAGE(job.channelId, message.id) }),
                () => {
                    job.delay = Math.min(Math.round(job.delay * 1.25), MAX_DELETE_DELAY_MS);
                    notify();
                }
            );
            job.deleted++;
            consecutiveFailures = 0;
        } catch (e: any) {
            const code = e?.body?.code;
            if (e?.status === 404 || code === ERROR_UNKNOWN_MESSAGE || code === ERROR_SYSTEM_MESSAGE) {
                job.skipped++;
                consecutiveFailures = 0;
            } else {
                logger.error(`Failed to delete message ${message.id}`, e);
                job.failed++;
                if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES)
                    throw new Error(`${MAX_CONSECUTIVE_FAILURES} deletions failed in a row (last error: ${e?.body?.message ?? e?.message ?? e?.status ?? "unknown"})`);
            }
        }
        notify();

        await sleep(Math.max(0, job.delay - (Date.now() - startedAt)));
    }
}

function waitForConfirmation(job: PurgeJob) {
    return new Promise<boolean>(resolve => {
        job.resolveConfirm = confirmed => {
            job.resolveConfirm = undefined;
            resolve(confirmed);
        };
    });
}

function cancelJob(job: PurgeJob) {
    job.cancelled = true;
    job.resolveConfirm?.(false);
    notify();
}

async function runPurge(job: PurgeJob) {
    try {
        await scan(job);
        if (job.cancelled) return;

        if (!job.found.length) {
            job.phase = "done";
            return;
        }

        job.phase = "confirm";
        highlightMessages(job);
        notify();

        if (!await waitForConfirmation(job)) return;

        job.phase = "deleting";
        job.deleteStartedAt = Date.now();
        notify();

        await deleteAll(job);
        if (!job.cancelled) job.phase = "done";
    } catch (e: any) {
        logger.error("Purge failed", e);
        job.phase = "error";
        job.error = e?.body?.message ?? e?.message ?? String(e);
    } finally {
        if (job.cancelled) job.phase = "cancelled";
        job.finishedAt = Date.now();
        clearHighlight(job);
        if (activeJob === job) activeJob = null;
        notify();
    }
}

// ---------- status UI ----------

function formatDuration(ms: number) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
}

function formatSnowflakeTime(id: string) {
    return new Date(SnowflakeUtils.extractTimestamp(id)).toLocaleString();
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

function PurgeStatus({ statusMessageId }: { statusMessageId: string; }) {
    const job = useJob(statusMessageId);
    if (!job) return null;

    const total = job.found.length;
    const processed = job.deleted + job.skipped + job.failed;
    const extras = [
        job.skipped && `${job.skipped.toLocaleString()} skipped`,
        job.failed && `${job.failed.toLocaleString()} failed`,
    ].filter(Boolean).join(" · ");

    const jumpTo = (id: string) => NavigationRouter.transitionTo(`/channels/${job.guildId ?? "@me"}/${job.channelId}/${id}`);

    switch (job.phase) {
        case "scanning":
            return (
                <div className={cl("status")}>
                    <Paragraph className={cl("info")}>
                        Scanning… checked {plural(job.scanned, "message")}, {total.toLocaleString()} of them yours.
                    </Paragraph>
                    <div className={cl("buttons")}>
                        <Button size="small" variant="secondary" onClick={() => cancelJob(job)}>Stop</Button>
                    </div>
                </div>
            );

        case "confirm": {
            const oldest = job.found[total - 1].id, newest = job.found[0].id;
            return (
                <div className={cl("status")}>
                    <Paragraph>
                        Found <strong>{plural(total, "message")}</strong> of yours, highlighted in red,
                        from {formatSnowflakeTime(oldest)} to {formatSnowflakeTime(newest)}.
                    </Paragraph>
                    <Paragraph className={cl("info")}>
                        This can't be undone. It'll take about {formatDuration(total * job.delay)}.
                    </Paragraph>
                    <div className={cl("buttons")}>
                        <Button size="small" variant="dangerPrimary" onClick={() => job.resolveConfirm?.(true)}>
                            Delete {plural(total, "message")}
                        </Button>
                        <Button size="small" variant="secondary" onClick={() => jumpTo(oldest)}>Jump to oldest</Button>
                        <Button size="small" variant="secondary" onClick={() => cancelJob(job)}>Cancel</Button>
                    </div>
                </div>
            );
        }

        case "deleting": {
            const elapsed = Date.now() - job.deleteStartedAt;
            const perMessage = processed >= 3 ? elapsed / processed : job.delay;
            const pct = total ? (processed / total) * 100 : 100;
            return (
                <div className={cl("status")}>
                    <div className={cl("progress-track")}>
                        <div className={cl("progress-fill")} style={{ width: `${pct}%` }} />
                    </div>
                    <Paragraph className={cl("info")}>
                        Deleted {job.deleted.toLocaleString()} / {total.toLocaleString()} ({pct.toFixed(0)}%)
                        {extras && ` · ${extras}`} · ~{formatDuration((total - processed) * perMessage)} left
                    </Paragraph>
                    <div className={cl("buttons")}>
                        <Button size="small" variant="secondary" onClick={() => cancelJob(job)}>Stop</Button>
                    </div>
                </div>
            );
        }

        case "done":
            return (
                <div className={cl("status")}>
                    <Paragraph className={cl("info")}>
                        {total
                            ? `Done. Deleted ${plural(job.deleted, "message")} in ${formatDuration(job.finishedAt - job.deleteStartedAt)}${extras && ` (${extras})`}.`
                            : `No messages of yours found in that range (checked ${plural(job.scanned, "message")}).`}
                    </Paragraph>
                </div>
            );

        case "cancelled":
            return (
                <div className={cl("status")}>
                    <Paragraph className={cl("info")}>
                        {job.deleteStartedAt
                            ? `Stopped. Deleted ${job.deleted.toLocaleString()} of ${plural(total, "message")}${extras && ` (${extras})`}.`
                            : "Cancelled. Nothing was deleted."}
                    </Paragraph>
                </div>
            );

        case "error":
            return (
                <div className={cl("status")}>
                    <Paragraph className={cl("error")}>
                        Purge failed: {job.error}
                        {job.deleteStartedAt ? ` (deleted ${job.deleted.toLocaleString()} of ${total.toLocaleString()} first)` : ""}
                    </Paragraph>
                </div>
            );
    }
}

// ---------- plugin ----------

export default definePlugin({
    name: "PersonalPurge",
    description: "Bulk-delete your own messages in a channel after a time (\"2 hours ago\", \"yesterday 5pm\") or a message, with a preview and confirmation first. Use /purge",
    authors: [Devs.Commandtechno],
    tags: ["Chat", "Utility"],

    settings,

    stop() {
        if (activeJob) cancelJob(activeJob);
        clearHighlight();
    },

    commands: [
        {
            name: "purge",
            description: "Delete your own messages in this channel after a time or message (you confirm first)",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "after",
                    description: "A time (\"2 hours ago\", \"yesterday 5pm\", \"last monday\") or a message link/ID (not deleted itself)",
                    type: ApplicationCommandOptionType.STRING,
                    required: true,
                },
                {
                    name: "before",
                    description: "Optional end of the range: a time or message link/ID (not deleted itself). Defaults to now",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                },
            ],

            execute(args, ctx) {
                const { channel } = ctx;
                const reply = (content: string) => void sendBotMessage(channel.id, { content });

                if (activeJob?.phase === "deleting")
                    return reply("A purge is already deleting messages. Stop it first (its Stop button, or `/purge-stop`).");

                const after = resolveBound(findOption(args, "after", ""), channel, "after");
                if (typeof after === "string") return reply(after);

                const beforeInput = findOption<string>(args, "before");
                const before = beforeInput
                    ? resolveBound(beforeInput, channel, "before")
                    : { id: BigInt(SnowflakeUtils.fromTimestamp(Date.now())), label: "" };
                if (typeof before === "string") return reply(before);

                if (after.id >= before.id) return reply("The start of the range has to be before the end.");

                // A purge that's still scanning or waiting on confirmation just gets replaced.
                if (activeJob) cancelJob(activeJob);

                const status = sendBotMessage(channel.id, {
                    content: `🧹 **Purging your messages** after ${after.label}${before.label ? ` and before ${before.label}` : ""}`,
                    author: { username: "PersonalPurge" },
                });

                const job: PurgeJob = {
                    channelId: channel.id,
                    guildId: channel.guild_id ?? undefined,
                    statusMessageId: status.id,
                    phase: "scanning",
                    after: after.id,
                    before: before.id,
                    scanned: 0,
                    found: [],
                    deleted: 0,
                    skipped: 0,
                    failed: 0,
                    delay: Math.max(0, settings.store.deleteDelay),
                    deleteStartedAt: 0,
                    finishedAt: 0,
                    cancelled: false,
                };
                jobs.set(job.statusMessageId, job);
                activeJob = job;
                notify();

                runPurge(job);
            },
        },
        {
            name: "purge-stop",
            description: "Stop the purge that's currently running",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute(_, ctx) {
                if (!activeJob) return void sendBotMessage(ctx.channel.id, { content: "No purge is running." });
                cancelJob(activeJob);
                sendBotMessage(ctx.channel.id, { content: "Stopping the purge." });
            },
        },
    ],

    renderMessageAccessory({ message }) {
        if (!jobs.has(message.id)) return null;
        return <PurgeStatus statusMessageId={message.id} />;
    },
});
