/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { updateMessage } from "@api/MessageUpdater";
import { definePluginSettings } from "@api/Settings";
import { classNameFactory } from "@api/Styles";
import { Button } from "@components/Button";
import { Flex } from "@components/Flex";
import { Paragraph } from "@components/Paragraph";
import { Devs } from "@utils/constants";
import { sendMessage } from "@utils/discord";
import definePlugin, { IconComponent, OptionType } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { Alerts, ChannelStore, ContextMenuApi, Menu, MessageStore, SelectedChannelStore, showToast, Toasts, Tooltip, useEffect, UserStore, useState } from "@webpack/common";

import * as e2ee from "./crypto";

const cl = classNameFactory("vc-e2ee-");

// ---------- settings ----------

function IdentitySettings() {
    const version = useE2EEVersion();
    const [fp, setFp] = useState("");
    useEffect(() => {
        e2ee.init().then(() => setFp(e2ee.getCurrentFingerprint()));
    }, [version]);

    return (
        <Flex flexDirection="column" style={{ gap: "0.5em" }}>
            <Paragraph>
                Your identity key fingerprint: <code className={cl("fp")}>{fp ? e2ee.formatFingerprint(fp) : "…"}</code>
            </Paragraph>
            <Paragraph>
                Compare fingerprints with your contacts over another channel (voice, in person) to make sure nobody is sitting in the middle.
                Keys live only in this Discord client, so encrypted messages cannot be read on mobile or on other devices.
            </Paragraph>
            <Flex style={{ gap: "0.5em" }}>
                <Button
                    variant="dangerSecondary"
                    size="small"
                    onClick={() => Alerts.show({
                        title: "Regenerate identity key?",
                        body: "A new key pair will be generated. Old keys are kept so you can still read older messages, but you will need to share your new public key again in every conversation.",
                        confirmText: "Regenerate",
                        cancelText: "Cancel",
                        onConfirm: async () => {
                            await e2ee.generateIdentity();
                            notify();
                            showToast("New identity key generated", Toasts.Type.SUCCESS);
                        }
                    })}
                >
                    Regenerate identity key
                </Button>
            </Flex>
        </Flex>
    );
}

const settings = definePluginSettings({
    autoReply: {
        type: OptionType.BOOLEAN,
        description: "Automatically share your public key when someone shares theirs with you (this sends a message)",
        default: true,
    },
    autoAnnounce: {
        type: OptionType.BOOLEAN,
        description: "Automatically share your public key when opening any DM / group DM (this sends a message in every DM you open!)",
        default: false,
    },
    showDecoration: {
        type: OptionType.BOOLEAN,
        description: "Show a small lock next to messages that were end-to-end encrypted",
        default: true,
    },
    identity: {
        type: OptionType.COMPONENT,
        component: IdentitySettings,
    },
});

// ---------- tiny change emitter for React ----------

const listeners = new Set<() => void>();
function notify() {
    for (const l of listeners) l();
}
function useE2EEVersion() {
    const [v, setV] = useState(0);
    useEffect(() => {
        const l = () => setV(x => x + 1);
        listeners.add(l);
        return () => void listeners.delete(l);
    }, []);
    return v;
}

// ---------- channel status ----------

function me() {
    return UserStore.getCurrentUser()?.id;
}

function getRecipients(channel: Channel): string[] {
    const self = me();
    return (channel.recipients ?? []).filter(id => id !== self);
}

interface ChannelStatus {
    supported: boolean;
    recipients: string[];
    missing: string[];
    announced: boolean;
    established: boolean;
    enabled: boolean;
}

function getStatus(channel: Channel | undefined | null): ChannelStatus {
    if (!channel?.isPrivate?.() || !channel.recipients)
        return { supported: false, recipients: [], missing: [], announced: false, established: false, enabled: false };

    const recipients = getRecipients(channel);
    const missing = recipients.filter(id => !e2ee.hasPeerKey(id));
    const announced = e2ee.hasAnnounced(channel.id, recipients);
    const established = recipients.length > 0 && missing.length === 0 && announced;
    return {
        supported: true,
        recipients,
        missing,
        announced,
        established,
        enabled: established && e2ee.isChannelEncryptionEnabled(channel.id),
    };
}

function userName(id: string) {
    const u = UserStore.getUser(id);
    return u ? (u.globalName || u.username) : id;
}

async function announce(channel: Channel) {
    await e2ee.init();
    const recipients = getRecipients(channel);
    await e2ee.markAnnounced(channel.id, recipients);
    notify();
    try {
        await sendMessage(channel.id, { content: e2ee.buildBeacon() });
    } catch (err) {
        e2ee.logger.error("Failed to send key announcement", err);
        showToast("Failed to share E2EE public key", Toasts.Type.FAILURE);
    }
}

// ---------- message processing ----------

interface RawMessage {
    id: string;
    channel_id: string;
    content?: string;
    author?: { id: string; };
}

type MessageState = "encrypted" | "no-key" | "failed" | "beacon";
const messageStates = new Map<string, MessageState>();
/** messageId -> last ciphertext we handled and what we replaced it with, so we don't decrypt the same thing twice */
const handled = new Map<string, { cipher: string; display: string; }>();

/** Re-apply a previous result if the store still (or again) holds the same ciphertext */
function reapply(raw: RawMessage, content: string) {
    const prev = handled.get(raw.id);
    if (prev?.cipher !== content) return false;
    updateMessage(raw.channel_id, raw.id, { content: prev.display });
    return true;
}
/** messages we couldn't decrypt, kept so we can retry once we learn a key */
const undecryptable = new Map<string, RawMessage>();

function decryptedPlaceholder(reason: e2ee.DecryptError["reason"]) {
    return reason === "no-key"
        ? "\u{1F512} *Encrypted message — you don't have the key to read it*"
        : "\u{1F512} *Encrypted message — could not be decrypted*";
}

async function processMessage(raw: RawMessage) {
    const { content } = raw;
    if (!content) return;
    if (!ChannelStore.getChannel(raw.channel_id)?.isPrivate?.()) return;

    if (e2ee.isBeacon(content)) return handleBeacon(raw, content);
    if (e2ee.isCiphertext(content)) return handleCiphertext(raw, content);
}

async function handleBeacon(raw: RawMessage, content: string) {
    await e2ee.init();
    const authorId = raw.author?.id;
    if (!authorId) return;

    if (reapply(raw, content)) return;
    messageStates.set(raw.id, "beacon");

    const self = me();
    if (authorId === self) {
        const display = `\u{1F510} You shared your E2EE public key · \`${e2ee.formatFingerprint((await e2ee.beaconFingerprint(content)) ?? "")}\``;
        handled.set(raw.id, { cipher: content, display });
        updateMessage(raw.channel_id, raw.id, { content: display });
        return;
    }

    const peer = await e2ee.learnPeerKey(authorId, content);
    if (!peer) return;
    notify();

    const display = `\u{1F510} ${userName(authorId)} shared their E2EE public key · \`${e2ee.formatFingerprint(peer.fp)}\``;
    handled.set(raw.id, { cipher: content, display });
    updateMessage(raw.channel_id, raw.id, { content: display });

    // Retry anything we couldn't read before
    for (const m of [...undecryptable.values()]) {
        undecryptable.delete(m.id);
        handled.delete(m.id);
        processMessage(m);
    }

    const channel = ChannelStore.getChannel(raw.channel_id);
    if (!channel) return;
    if (settings.store.autoReply && !e2ee.hasAnnounced(channel.id, getRecipients(channel))) {
        await announce(channel);
    }
}

async function handleCiphertext(raw: RawMessage, content: string) {
    await e2ee.init();
    if (reapply(raw, content)) return;

    try {
        const plain = await e2ee.decrypt(content);
        messageStates.set(raw.id, "encrypted");
        undecryptable.delete(raw.id);
        handled.set(raw.id, { cipher: content, display: plain });
        updateMessage(raw.channel_id, raw.id, { content: plain });
    } catch (err) {
        const reason = err instanceof e2ee.DecryptError ? err.reason : "failed";
        if (reason === "malformed") {
            // Doesn't look like ours after all; leave the message alone
            messageStates.delete(raw.id);
            return;
        }
        messageStates.set(raw.id, reason === "no-key" ? "no-key" : "failed");
        undecryptable.set(raw.id, { ...raw, content });
        const display = decryptedPlaceholder(reason);
        handled.set(raw.id, { cipher: content, display });
        updateMessage(raw.channel_id, raw.id, { content: display });
    }
}

function scanChannel(channelId: string) {
    const messages = MessageStore.getMessages(channelId);
    if (!messages) return;
    messages.forEach(m => {
        if (e2ee.isBeacon(m.content) || e2ee.isCiphertext(m.content)) {
            processMessage({ id: m.id, channel_id: m.channel_id, content: m.content, author: m.author });
        }
    });
}

function maxMessageLength() {
    return UserStore.getCurrentUser()?.premiumType === 2 ? 4000 : 2000;
}

async function encryptOutgoing(channelId: string, content: string): Promise<string | null> {
    const channel = ChannelStore.getChannel(channelId);
    const status = getStatus(channel);
    try {
        const encrypted = await e2ee.encrypt(content, status.recipients);
        if (encrypted.length > maxMessageLength()) {
            showToast(`Message too long to send encrypted (${encrypted.length}/${maxMessageLength()} characters after encryption)`, Toasts.Type.FAILURE);
            return null;
        }
        return encrypted;
    } catch (err) {
        e2ee.logger.error("Failed to encrypt message", err);
        showToast("Failed to encrypt message — not sent", Toasts.Type.FAILURE);
        return null;
    }
}

// ---------- UI ----------

const LockIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg viewBox="0 0 24 24" height={height} width={width} className={className}>
        <path fill="currentColor" d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" />
    </svg>
);

const LockOpenIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg viewBox="0 0 24 24" height={height} width={width} className={className}>
        <path fill="currentColor" d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z" />
    </svg>
);

function showFingerprints(channel: Channel, status: ChannelStatus) {
    Alerts.show({
        title: "E2EE key fingerprints",
        body: (
            <div className={cl("fp-list")}>
                <div><b>You</b>: <code className={cl("fp")}>{e2ee.formatFingerprint(e2ee.getCurrentFingerprint())}</code></div>
                {status.recipients.map(id => {
                    const key = e2ee.getPeerKey(id);
                    return (
                        <div key={id}>
                            <b>{userName(id)}</b>: {key
                                ? <code className={cl("fp")}>{e2ee.formatFingerprint(key.fp)}</code>
                                : <i>no public key received yet</i>}
                        </div>
                    );
                })}
                <Paragraph style={{ marginTop: "0.75em" }}>
                    Verify these with each other out-of-band to rule out a man-in-the-middle.
                </Paragraph>
            </div>
        ),
    });
}

function tooltipFor(status: ChannelStatus) {
    if (!status.established) {
        if (status.recipients.length === 0) return "E2EE unavailable: nobody else is in this conversation";
        if (status.missing.length > 0) {
            const names = status.missing.map(userName).join(", ");
            return status.announced
                ? `E2EE: waiting for ${names} to share a public key`
                : `E2EE: click to share your public key. Still need a key from ${names}`;
        }
        return "E2EE: click to share your public key with this conversation";
    }
    return status.enabled
        ? "End-to-end encryption ON — click to send unencrypted"
        : "End-to-end encryption OFF — click to send encrypted";
}

const E2EEChatBarButton: ChatBarButtonFactory = ({ channel, isMainChat }) => {
    useE2EEVersion();
    const [, setReady] = useState(false);
    useEffect(() => { e2ee.init().then(() => setReady(true)); }, []);

    if (!isMainChat) return null;
    const status = getStatus(channel);
    if (!status.supported) return null;

    const onClick = async () => {
        await e2ee.init();
        if (!status.established) {
            if (status.recipients.length === 0) return;
            await announce(channel);
            if (status.missing.length > 0)
                showToast(`Shared your public key. Waiting for ${status.missing.map(userName).join(", ")}…`, Toasts.Type.MESSAGE);
            return;
        }
        await e2ee.setChannelEncryptionEnabled(channel.id, !status.enabled);
        notify();
    };

    const onContextMenu = (e: React.MouseEvent) => {
        ContextMenuApi.openContextMenu(e, () => (
            <Menu.Menu navId="vc-e2ee-menu" onClose={ContextMenuApi.closeContextMenu} aria-label="E2EE options">
                {status.established && (
                    <Menu.MenuCheckboxItem
                        id="vc-e2ee-toggle"
                        label="Encrypt messages"
                        checked={status.enabled}
                        action={async () => {
                            await e2ee.setChannelEncryptionEnabled(channel.id, !status.enabled);
                            notify();
                        }}
                    />
                )}
                <Menu.MenuItem
                    id="vc-e2ee-share"
                    label="Share my public key"
                    action={() => announce(channel)}
                />
                <Menu.MenuItem
                    id="vc-e2ee-fingerprints"
                    label="Show key fingerprints"
                    action={() => showFingerprints(channel, status)}
                />
            </Menu.Menu>
        ));
    };

    const state = !status.established ? "unavailable" : status.enabled ? "on" : "off";
    const Icon = status.enabled ? LockIcon : LockOpenIcon;

    return (
        <ChatBarButton tooltip={tooltipFor(status)} onClick={onClick} onContextMenu={onContextMenu}>
            <Icon className={cl("chat-icon", `chat-icon-${state}`)} />
        </ChatBarButton>
    );
};

// ---------- plugin ----------

export default definePlugin({
    name: "E2EE",
    description: "End-to-end encrypt DMs and group DMs with other Vencord users who have this plugin. Exchange public keys once, then everything you type is encrypted before it leaves your client.",
    authors: [Devs.Commandtechno],
    tags: ["Chat", "Privacy"],
    settings,

    chatBarButton: {
        icon: LockIcon,
        render: E2EEChatBarButton,
    },

    async start() {
        await e2ee.init();
        const channelId = SelectedChannelStore.getChannelId();
        if (channelId) scanChannel(channelId);
    },

    stop() {
        messageStates.clear();
        handled.clear();
        undecryptable.clear();
    },

    flux: {
        MESSAGE_CREATE({ message }: { message: RawMessage; }) {
            processMessage(message);
        },
        MESSAGE_UPDATE({ message }: { message: RawMessage; }) {
            processMessage(message);
        },
        MESSAGE_SEND_SUCCESS({ channelId, messageId }: { channelId: string; messageId: string; }) {
            const m = MessageStore.getMessage(channelId, messageId);
            if (m) processMessage({ id: m.id, channel_id: m.channel_id, content: m.content, author: m.author });
        },
        LOAD_MESSAGES_SUCCESS({ messages }: { messages: RawMessage[]; }) {
            for (const m of messages) processMessage(m);
        },
        async CHANNEL_SELECT({ channelId }: { channelId?: string; }) {
            if (!channelId) return;
            scanChannel(channelId);

            if (!settings.store.autoAnnounce) return;
            const channel = ChannelStore.getChannel(channelId);
            const status = getStatus(channel);
            if (status.supported && status.recipients.length > 0 && !status.announced) {
                await announce(channel);
            }
        },
    },

    async onBeforeMessageSend(channelId, message) {
        if (!message.content) return;
        if (e2ee.isBeacon(message.content) || e2ee.isCiphertext(message.content)) return;
        await e2ee.init();

        const status = getStatus(ChannelStore.getChannel(channelId));
        if (!status.enabled) return;

        const encrypted = await encryptOutgoing(channelId, message.content);
        if (encrypted === null) return { cancel: true };
        message.content = encrypted;
    },

    async onBeforeMessageEdit(channelId, messageId, message) {
        if (!message.content) return;
        if (e2ee.isBeacon(message.content) || e2ee.isCiphertext(message.content)) return;
        await e2ee.init();

        const wasEncrypted = messageStates.get(messageId) === "encrypted";
        const status = getStatus(ChannelStore.getChannel(channelId));
        if (!wasEncrypted && !status.enabled) return;
        if (!status.established) {
            showToast("Can't re-encrypt edit: E2EE is no longer established in this conversation", Toasts.Type.FAILURE);
            return { cancel: true };
        }

        const encrypted = await encryptOutgoing(channelId, message.content);
        if (encrypted === null) return { cancel: true };
        message.content = encrypted;
    },

    renderMessageDecoration({ message }) {
        if (!settings.store.showDecoration) return null;
        const state = messageStates.get(message.id);
        if (!state || state === "beacon") return null;

        const text = state === "encrypted"
            ? "End-to-end encrypted"
            : state === "no-key"
                ? "Encrypted, but you don't have the key for this message"
                : "Encrypted, but it could not be decrypted";

        return (
            <Tooltip text={text}>
                {props => (
                    <span {...props} className={cl("decoration", `decoration-${state}`)}>
                        <LockIcon width={14} height={14} />
                    </span>
                )}
            </Tooltip>
        );
    },
});
