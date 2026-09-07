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

const settings = definePluginSettings({
    dmsOnly: {
        type: OptionType.BOOLEAN,
        description: "Only apply in DMs and group DMs (not servers)",
        default: true,
    },
});

const URL_RE = /https?:\/\/\S+/g;

// Copied verbatim from embed-team/embedly's own link matchers, so we only fire on
// links Embedly actually knows how to embed (the platforms wired up in main.ts's
// matchURL — Reddit's matcher exists in the repo but isn't registered there, so
// it's intentionally left out here too).
// https://github.com/embed-team/embedly/tree/main/packages/platforms/src/platforms
const PLATFORM_PATTERNS: RegExp[] = [
    // twitter.ts
    /^(?:https?:\/\/)?(?:[\w-]+\.)*(?:twitter|x)\.com\/.*\/status(?:es)?\/(?<tweet_id>[^/?]+)/,
    // instagram.ts
    /^(?:https?:\/\/)?(?:[\w-]+\.)*instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(?<ig_type>p|share|reels|reel)\/(?<ig_shortcode>[A-Za-z0-9-_]+)/,
    // tiktok.ts
    /^(?:https?:\/\/)?(?:[\w-]+\.)*tiktok\.com(?:\/|$)/,
    // threads.ts
    /^(?:https?:\/\/)?(?:[\w-]+\.)*threads\.com\/@.*\/post\/(?<thread_shortcode>[A-Za-z0-9-_]+)/,
    /^(?:https?:\/\/)?(?:[\w-]+\.)*threads\.com\/share\/[^/?#]+/,
    // bluesky.ts
    /^(?:https?:\/\/)?(?:www\.)?bsky\.app\/profile\/(?<actor>[^/?#]+)\/post\/(?<post_id>[^/?#]+)/,
    // facebook-marketplace.ts
    /^(?:https?:\/\/)?(?:www\.|m\.)?facebook\.com\/marketplace\/item\/(\d+)\/?(?:[?#].*)?$/,
];

function messageHasSupportedLink(content: string): boolean {
    const urls = content.match(URL_RE);
    if (!urls) return false;

    return urls.some(url => PLATFORM_PATTERNS.some(re => re.test(url)));
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
    description: "When you send a message with a link Embedly can embed (Twitter/X, Instagram, TikTok, Threads, Bluesky, Facebook Marketplace), automatically runs Embedly's \"Embed Links\" command on it and suppresses Discord's own embed",
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
            if (settings.store.dmsOnly && !channel.isPrivate()) return;

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
