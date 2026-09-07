/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { AuthenticationStore, ChannelStore, Constants, RestAPI, SnowflakeUtils, UserStore } from "@webpack/common";

const logger = new Logger("AutoEmbedly");

// The "Embed Links" message context menu command exposed by the Embedly bot/app.
const EMBEDLY_APPLICATION_ID = "1386571219670794371";
const EMBEDLY_COMMAND_ID = "1386587948669206657";
const EMBEDLY_COMMAND_VERSION = "1386587948669206658";
const EMBEDLY_COMMAND_NAME = "Embed Links";

const EMBED_SUPPRESSED = 1 << 2; // 4

// Discord's own link crawler can unfurl an embed a moment after the message lands,
// which sometimes clobbers our suppress flag. Re-apply it once more after a delay
// to win that race.
const RESUPPRESS_DELAY_MS = 3000;

const DEFAULT_DOMAINS = [
    "x.com",
    "twitter.com",
    "instagram.com",
    "tiktok.com",
    "vm.tiktok.com",
    "vt.tiktok.com",
    "reddit.com",
    "threads.net",
    "bsky.app",
    "facebook.com",
    "pixiv.net",
].join("\n");

const settings = definePluginSettings({
    domains: {
        type: OptionType.STRING,
        description: "Domains that should trigger Embedly (one per line, or comma separated)",
        multiline: true,
        default: DEFAULT_DOMAINS,
    },
});

function buildDomainRegex(): RegExp | null {
    const domains = settings.store.domains
        .split(/[\n,]/)
        .map(d => d.trim())
        .filter(Boolean)
        .map(d => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

    if (!domains.length) return null;

    return new RegExp(`https?:\\/\\/(?:www\\.)?(?:${domains.join("|")})\\/\\S+`, "i");
}

function messageHasSupportedLink(content: string): boolean {
    const regex = buildDomainRegex();
    return regex != null && regex.test(content);
}

async function runEmbedlyEmbedLinks(channelId: string, guildId: string | undefined, messageId: string) {
    await RestAPI.post({
        url: "/interactions",
        body: {
            type: 2, // APPLICATION_COMMAND
            application_id: EMBEDLY_APPLICATION_ID,
            ...(guildId ? { guild_id: guildId } : {}),
            channel_id: channelId,
            session_id: AuthenticationStore.getSessionId(),
            data: {
                version: EMBEDLY_COMMAND_VERSION,
                id: EMBEDLY_COMMAND_ID,
                name: EMBEDLY_COMMAND_NAME,
                type: 3, // MESSAGE context menu command
                target_id: messageId,
            },
            nonce: SnowflakeUtils.fromTimestamp(Date.now()),
        },
    });
}

async function suppressEmbeds(channelId: string, messageId: string) {
    await RestAPI.patch({
        url: Constants.Endpoints.MESSAGE(channelId, messageId),
        body: { flags: EMBED_SUPPRESSED },
    });
}

export default definePlugin({
    name: "AutoEmbedly",
    description: "When you send a message with a supported social media link, automatically runs Embedly's \"Embed Links\" command on it and suppresses Discord's own embed",
    authors: [Devs.Commandtechno],
    tags: ["Chat", "Utility"],

    settings,

    flux: {
        async MESSAGE_CREATE({ message, optimistic }: { message: Message; optimistic: boolean; }) {
            if (optimistic) return;
            if (message.author?.id !== UserStore.getCurrentUser()?.id) return;
            if (!message.content || !messageHasSupportedLink(message.content)) return;

            const channel = ChannelStore.getChannel(message.channel_id);
            if (!channel) return;

            try {
                await runEmbedlyEmbedLinks(channel.id, channel.guild_id, message.id);
            } catch (e) {
                logger.error("Failed to run Embedly's Embed Links command", e);
                return;
            }

            try {
                await suppressEmbeds(channel.id, message.id);
            } catch (e) {
                logger.error("Failed to suppress embeds on the original message", e);
            }

            setTimeout(() => {
                suppressEmbeds(channel.id, message.id).catch(e =>
                    logger.error("Failed to re-suppress embeds on the original message", e)
                );
            }, RESUPPRESS_DELAY_MS);
        },
    },
});
