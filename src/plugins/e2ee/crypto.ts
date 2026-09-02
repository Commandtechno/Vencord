/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";

export const logger = new Logger("E2EE", "#43b581");

/** Message prefix for encrypted payloads: 🔒 + base64 */
export const CIPHER_PREFIX = "\u{1F512}";
/** Message prefix for public key announcements: 🔐E2EE1: + base64(raw P-256 point) */
export const BEACON_PREFIX = "\u{1F510}E2EE1:";

const CIPHER_RE = /^\u{1F512}([A-Za-z0-9+/]{16,}={0,2})$/u;
const BEACON_RE = /^\u{1F510}E2EE1:([A-Za-z0-9+/]{80,}={0,2})$/u;

/**
 * Attachments can't carry a text prefix, so an encrypted file is instead marked by appending this
 * suffix to its filename. Discord will serve it as an opaque blob (no thumbnail/preview) to
 * everyone; only clients with this plugin recognize the suffix and know to decrypt it.
 */
export const ATTACHMENT_MARKER = ".e2ee";

export function isEncryptedAttachmentFilename(filename: string | undefined) {
    return !!filename && filename.endsWith(ATTACHMENT_MARKER);
}

/** Strip the marker to recover the original filename (and its extension, for guessing how to render it). */
export function originalAttachmentFilename(filename: string) {
    return isEncryptedAttachmentFilename(filename) ? filename.slice(0, -ATTACHMENT_MARKER.length) : filename;
}

const VERSION = 1;
const FP_LEN = 4;
const WRAPPED_LEN = 40; // AES-KW of a 32 byte key
const IV_LEN = 12;

const HKDF_SALT = new TextEncoder().encode("vencord-e2ee-v1");
const HKDF_INFO = new TextEncoder().encode("pairwise-wrap-key");

const ECDH_PARAMS: EcKeyImportParams = { name: "ECDH", namedCurve: "P-256" };

const DS_IDENTITIES = "E2EE_identities";
const DS_PEERS = "E2EE_peers";
const DS_ANNOUNCED = "E2EE_announced";
const DS_CHANNEL_PREFS = "E2EE_channelPrefs";
const DS_CHANNEL_PEERS = "E2EE_channelPeers";

interface StoredIdentity {
    privateJwk: JsonWebKey;
    publicRaw: string; // base64
    createdAt: number;
}

interface IdentityStore {
    current: string; // fingerprint hex (8 bytes)
    keys: Record<string, StoredIdentity>;
}

export interface PeerKey {
    userId: string;
    publicRaw: string; // base64
    seenAt: number;
}

interface Identity {
    fp: string; // long fingerprint (hex)
    tag: Uint8Array<ArrayBuffer>; // first 4 bytes of the fingerprint
    privateKey: CryptoKey;
    publicKey: CryptoKey;
    publicRaw: Uint8Array<ArrayBuffer>;
}

interface Peer extends PeerKey {
    fp: string;
    tag: Uint8Array<ArrayBuffer>;
    publicKey: CryptoKey;
}

// ---------- byte helpers ----------

export function toBase64(bytes: Uint8Array<ArrayBuffer>) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}

export function fromBase64(b64: string) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

function toHex(bytes: Uint8Array<ArrayBuffer>) {
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function tagKey(tag: Uint8Array<ArrayBuffer>) {
    return toHex(tag);
}

function concat(...parts: Uint8Array<ArrayBuffer>[]) {
    const len = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}

async function fingerprintOf(publicRaw: Uint8Array<ArrayBuffer>) {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", publicRaw));
    return { fp: toHex(hash.slice(0, 8)), tag: hash.slice(0, FP_LEN) };
}

/** Pretty-print a fingerprint like "1A2B 3C4D 5E6F 7A8B" */
export function formatFingerprint(fp: string) {
    return fp.toUpperCase().match(/.{1,4}/g)?.join(" ") ?? "";
}

// ---------- state ----------

let identities: Map<string, Identity> = new Map();
let currentFp = "";
let peersByTag: Map<string, Peer> = new Map();
let announced: Record<string, string> = {};
let channelPrefs: Record<string, boolean> = {};
/** channelId -> user IDs seen announcing a key in that channel. Only meaningful for guild channels, where there's no fixed recipient list like a DM has. */
let channelPeers: Record<string, string[]> = {};

const pairwiseCache = new Map<string, Promise<CryptoKey>>();

let ready: Promise<void> | null = null;

export function init() {
    return ready ??= load();
}

async function load() {
    const [ids, peers, ann, prefs, chanPeers] = await Promise.all([
        DataStore.get<IdentityStore>(DS_IDENTITIES),
        DataStore.get<Record<string, PeerKey>>(DS_PEERS),
        DataStore.get<Record<string, string>>(DS_ANNOUNCED),
        DataStore.get<Record<string, boolean>>(DS_CHANNEL_PREFS),
        DataStore.get<Record<string, string[]>>(DS_CHANNEL_PEERS),
    ]);

    announced = ann ?? {};
    channelPrefs = prefs ?? {};
    channelPeers = chanPeers ?? {};

    identities = new Map();
    if (ids) {
        for (const stored of Object.values(ids.keys)) {
            try {
                const id = await importIdentity(stored);
                identities.set(id.fp, id);
            } catch (e) {
                logger.error("Failed to import stored identity", e);
            }
        }
        currentFp = ids.current;
    }
    if (!identities.has(currentFp)) {
        await generateIdentity();
    }

    peersByTag = new Map();
    if (peers) {
        for (const [fp, p] of Object.entries(peers)) {
            try {
                const peer = await importPeer(p);
                if (peer.fp === fp) peersByTag.set(tagKey(peer.tag), peer);
            } catch (e) {
                logger.error("Failed to import stored peer key", e);
            }
        }
    }
}

async function importIdentity(stored: StoredIdentity): Promise<Identity> {
    const privateKey = await crypto.subtle.importKey("jwk", stored.privateJwk, ECDH_PARAMS, true, ["deriveBits"]);
    const publicRaw = fromBase64(stored.publicRaw);
    const publicKey = await crypto.subtle.importKey("raw", publicRaw, ECDH_PARAMS, true, []);
    const { fp, tag } = await fingerprintOf(publicRaw);
    return { fp, tag, privateKey, publicKey, publicRaw };
}

async function importPeer(p: PeerKey): Promise<Peer> {
    const publicRaw = fromBase64(p.publicRaw);
    const publicKey = await crypto.subtle.importKey("raw", publicRaw, ECDH_PARAMS, true, []);
    const { fp, tag } = await fingerprintOf(publicRaw);
    return { ...p, fp, tag, publicKey };
}

async function persistIdentities() {
    const store: IdentityStore = { current: currentFp, keys: {} };
    for (const id of identities.values()) {
        store.keys[id.fp] = {
            privateJwk: await crypto.subtle.exportKey("jwk", id.privateKey),
            publicRaw: toBase64(id.publicRaw),
            createdAt: Date.now(),
        };
    }
    await DataStore.set(DS_IDENTITIES, store);
}

async function persistPeers() {
    const store: Record<string, PeerKey> = {};
    for (const p of peersByTag.values()) {
        store[p.fp] = { userId: p.userId, publicRaw: p.publicRaw, seenAt: p.seenAt };
    }
    await DataStore.set(DS_PEERS, store);
}

/** Generate a fresh identity key and make it current. Old keys are kept so old messages still decrypt. */
export async function generateIdentity() {
    const pair = await crypto.subtle.generateKey(ECDH_PARAMS, true, ["deriveBits"]);
    const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const { fp, tag } = await fingerprintOf(publicRaw);
    identities.set(fp, { fp, tag, privateKey: pair.privateKey, publicKey: pair.publicKey, publicRaw });
    currentFp = fp;
    pairwiseCache.clear();
    announced = {};
    await Promise.all([persistIdentities(), DataStore.set(DS_ANNOUNCED, announced)]);
    return fp;
}

export function getCurrentFingerprint() {
    return currentFp;
}

/** Raw announced marker stored for a channel (debugging) */
export function getAnnouncedRaw(channelId: string) {
    return announced[channelId];
}

/** JSON-safe dump of all E2EE state (debugging) */
export function debugSnapshot() {
    return {
        currentFp,
        identityFps: [...identities.keys()],
        peers: [...peersByTag.values()].map(p => ({ userId: p.userId, fp: p.fp, seenAt: new Date(p.seenAt).toISOString() })),
        announced: { ...announced },
        channelPrefs: { ...channelPrefs },
        channelPeers: { ...channelPeers },
    };
}

export function getCurrentPublicKeyBase64() {
    return toBase64(identities.get(currentFp)!.publicRaw);
}

export function buildBeacon() {
    return BEACON_PREFIX + getCurrentPublicKeyBase64();
}

export function isBeacon(content: string | undefined) {
    return !!content && BEACON_RE.test(content);
}

export function isCiphertext(content: string | undefined) {
    return !!content && CIPHER_RE.test(content);
}

/** Record a peer's public key from a beacon message. Returns the peer (or null if invalid). */
export async function learnPeerKey(userId: string, content: string): Promise<Peer | null> {
    const m = content.match(BEACON_RE);
    if (!m) return null;
    try {
        const peer = await importPeer({ userId, publicRaw: m[1], seenAt: Date.now() });
        const existing = peersByTag.get(tagKey(peer.tag));
        if (existing && existing.userId === userId) {
            // same key, keep original seenAt ordering unless it's newer than what we have
            return existing;
        }
        peersByTag.set(tagKey(peer.tag), peer);
        await persistPeers();
        return peer;
    } catch (e) {
        logger.error("Invalid beacon from", userId, e);
        return null;
    }
}

/** Fingerprint (long) of the beacon's key, without storing it */
export async function beaconFingerprint(content: string) {
    const m = content.match(BEACON_RE);
    if (!m) return null;
    try {
        return (await fingerprintOf(fromBase64(m[1]))).fp;
    } catch {
        return null;
    }
}

/** Latest known key for a user, if any */
export function getPeerKey(userId: string): Peer | undefined {
    let best: Peer | undefined;
    for (const p of peersByTag.values()) {
        if (p.userId === userId && (!best || p.seenAt > best.seenAt)) best = p;
    }
    return best;
}

export function hasPeerKey(userId: string) {
    return getPeerKey(userId) !== undefined;
}

export function forgetPeer(userId: string) {
    for (const [k, p] of peersByTag) if (p.userId === userId) peersByTag.delete(k);
    return persistPeers();
}

// ---------- announcements & prefs ----------

export function announcementKey(recipients: string[]) {
    return `${currentFp}:${[...recipients].sort().join(",")}`;
}

export function hasAnnounced(channelId: string, recipients: string[]) {
    return announced[channelId] === announcementKey(recipients);
}

export function markAnnounced(channelId: string, recipients: string[]) {
    announced[channelId] = announcementKey(recipients);
    return DataStore.set(DS_ANNOUNCED, announced);
}

/** Defaults to ON. Only meaningful once a channel is fully established (DM/group DM) — everyone's key is known, so there's nobody left to surprise. */
export function isChannelEncryptionEnabled(channelId: string) {
    return channelPrefs[channelId] !== false;
}

/** Defaults to OFF. Used anywhere encryption isn't fully established (partial/guild), so merely already knowing a recipient's key from some other channel can never silently turn encryption on here — it takes an explicit toggle. */
export function isChannelEncryptionExplicitlyEnabled(channelId: string) {
    return channelPrefs[channelId] === true;
}

export function setChannelEncryptionEnabled(channelId: string, enabled: boolean) {
    channelPrefs[channelId] = enabled;
    return DataStore.set(DS_CHANNEL_PREFS, channelPrefs);
}

/** User IDs that have announced a public key in this channel. Used as the recipient set for guild channels, which have no fixed member list. */
export function getChannelPeers(channelId: string): string[] {
    return channelPeers[channelId] ?? [];
}

export async function addChannelPeer(channelId: string, userId: string) {
    const list = channelPeers[channelId] ?? (channelPeers[channelId] = []);
    if (list.includes(userId)) return;
    list.push(userId);
    await DataStore.set(DS_CHANNEL_PEERS, channelPeers);
}

// ---------- crypto ----------

async function pairwiseKey(ours: Identity, theirs: Peer) {
    const cacheKey = `${ours.fp}:${theirs.fp}`;
    let p = pairwiseCache.get(cacheKey);
    if (!p) {
        p = (async () => {
            const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: theirs.publicKey }, ours.privateKey, 256);
            const hkdf = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
            return crypto.subtle.deriveKey(
                { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: HKDF_INFO },
                hkdf,
                { name: "AES-KW", length: 256 },
                false,
                ["wrapKey", "unwrapKey"]
            );
        })();
        pairwiseCache.set(cacheKey, p);
        p.catch(() => pairwiseCache.delete(cacheKey));
    }
    return p;
}

/**
 * Encrypt `plainBytes` for the given recipients. Used for both text messages and file attachments.
 * Layout: [version][senderTag(4)][n][ (recipientTag(4) + wrappedKey(40)) * n ][iv(12)][AES-GCM ciphertext+tag]
 */
export async function encryptBytes(plainBytes: Uint8Array<ArrayBuffer>, recipientUserIds: string[]): Promise<Uint8Array<ArrayBuffer>> {
    const me = identities.get(currentFp)!;
    const recipients = recipientUserIds.map(id => {
        const p = getPeerKey(id);
        if (!p) throw new Error(`No public key for user ${id}`);
        return p;
    });
    if (recipients.length === 0 || recipients.length > 255) throw new Error("Invalid recipient count");

    const msgKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, msgKey, plainBytes));

    const entries: Uint8Array<ArrayBuffer>[] = [];
    for (const r of recipients) {
        const wk = await pairwiseKey(me, r);
        const wrapped = new Uint8Array(await crypto.subtle.wrapKey("raw", msgKey, wk, "AES-KW"));
        entries.push(r.tag, wrapped);
    }

    const header = new Uint8Array([VERSION, ...me.tag, recipients.length]);
    return concat(header, ...entries, iv, body);
}

/** Encrypt `plaintext` for the given recipients, producing a message-ready 🔒-prefixed base64 string. */
export async function encrypt(plaintext: string, recipientUserIds: string[]) {
    const encrypted = await encryptBytes(new TextEncoder().encode(plaintext), recipientUserIds);
    return CIPHER_PREFIX + toBase64(encrypted);
}

export class DecryptError extends Error {
    constructor(message: string, public readonly reason: "no-key" | "malformed" | "failed") {
        super(message);
    }
}

/** Decrypt raw bytes produced by {@link encryptBytes}. Used for both text messages and file attachments. */
export async function decryptBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    if (bytes.length < 2 + FP_LEN || bytes[0] !== VERSION) throw new DecryptError("Unsupported version", "malformed");

    const senderTag = tagKey(bytes.slice(1, 1 + FP_LEN));
    const n = bytes[1 + FP_LEN];
    let off = 2 + FP_LEN;
    const entries: { tag: string; wrapped: Uint8Array<ArrayBuffer>; }[] = [];
    for (let i = 0; i < n; i++) {
        if (off + FP_LEN + WRAPPED_LEN > bytes.length) throw new DecryptError("Truncated header", "malformed");
        entries.push({ tag: tagKey(bytes.slice(off, off + FP_LEN)), wrapped: bytes.slice(off + FP_LEN, off + FP_LEN + WRAPPED_LEN) });
        off += FP_LEN + WRAPPED_LEN;
    }
    if (off + IV_LEN + 16 > bytes.length) throw new DecryptError("Truncated body", "malformed");
    const iv = bytes.slice(off, off + IV_LEN);
    const body = bytes.slice(off + IV_LEN);

    // Figure out which pairwise key applies to us
    let wrapKey: CryptoKey | undefined;
    let wrapped: Uint8Array<ArrayBuffer> | undefined;

    const ourIdentityAsSender = [...identities.values()].find(id => tagKey(id.tag) === senderTag);
    if (ourIdentityAsSender) {
        // We sent this: use any recipient whose key we know
        for (const e of entries) {
            const peer = peersByTag.get(e.tag);
            if (!peer) continue;
            wrapKey = await pairwiseKey(ourIdentityAsSender, peer);
            wrapped = e.wrapped;
            break;
        }
    } else {
        const sender = peersByTag.get(senderTag);
        if (sender) {
            for (const e of entries) {
                const ours = [...identities.values()].find(id => tagKey(id.tag) === e.tag);
                if (!ours) continue;
                wrapKey = await pairwiseKey(ours, sender);
                wrapped = e.wrapped;
                break;
            }
        }
    }
    if (!wrapKey || !wrapped) throw new DecryptError("No key available to decrypt this message", "no-key");

    try {
        const msgKey = await crypto.subtle.unwrapKey("raw", wrapped, wrapKey, "AES-KW", { name: "AES-GCM" }, false, ["decrypt"]);
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, msgKey, body);
        return new Uint8Array(plain);
    } catch (e) {
        throw new DecryptError("Decryption failed", "failed");
    }
}

/** Decrypt a 🔒-prefixed base64 message produced by {@link encrypt}. */
export async function decrypt(content: string): Promise<string> {
    const m = content.match(CIPHER_RE);
    if (!m) throw new DecryptError("Not an encrypted message", "malformed");

    let bytes: Uint8Array<ArrayBuffer>;
    try {
        bytes = fromBase64(m[1]);
    } catch {
        throw new DecryptError("Bad base64", "malformed");
    }
    const plain = await decryptBytes(bytes);
    return new TextDecoder().decode(plain);
}
