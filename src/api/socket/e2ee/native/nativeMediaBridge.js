"use strict";

/**
 * Native E2EE media bridge — mautrix-go / mautrix-meta (MPL-2.0)
 * Copyright (c) Tulir Asokan and mautrix-go/mautrix-meta contributors.
 * Upstream: https://github.com/mautrix/go, https://github.com/mautrix/meta
 * License:  https://www.mozilla.org/en-US/MPL/2.0/
 *
 * fca-eryxenx's own hand-written Signal/Noise media encoder (vendor/fme)
 * sends E2EE image/video/audio/document messages that Facebook's server
 * accepts (valid messageId + CDN path returned) but that the real Messenger
 * client silently fails to render — the reverse-engineered .proto schema
 * used there doesn't match Messenger's actual wire format closely enough.
 *
 * This module instead calls into a precompiled native library built from
 * mautrix-go/mautrix-meta (a maintained, protocol-accurate Go implementation
 * of the same E2EE stack) via the `koffi` FFI, exactly like the reference
 * "stfca" package does. Only MEDIA sending is routed through here — text
 * messages keep using fca-eryxenx's existing, already-working E2EE path.
 */

const path = require("path");
const logger = require("../../../../utils/nexca-logger");

let _clientPromise = null;
let _client = null;

function _dynamicImport(specifier) {
    // eslint-disable-next-line no-new-func
    return new Function("s", "return import(s)")(specifier);
}

function _cookiesFromAppState(appState) {
    const out = {};
    if (!Array.isArray(appState)) return out;
    appState.forEach((c) => {
        if (c && c.key) out[c.key] = c.value;
    });
    if (!out.c_user && out.i_user) out.c_user = out.i_user;
    return out;
}

/**
 * Returns a connected native Client, creating/connecting it on first use.
 * @param {Array} appState fca-eryxenx's appState (from api.getAppState())
 */
async function getClient(appState) {
    if (_client) return _client;
    if (_clientPromise) return _clientPromise;

    _clientPromise = (async () => {
        const libUrl = require("url").pathToFileURL(
            path.join(__dirname, "lib", "index.mjs")
        ).href;

        let mod;
        try {
            mod = await _dynamicImport(libUrl);
        } catch (err) {
            throw new Error(
                "Native E2EE media engine failed to load (" + libUrl + "): " +
                (err && err.message ? err.message : String(err)) +
                "\nMake sure `koffi` and `yumi-json-bigint` are installed, and that " +
                "native/build/messagix.{so,dll} is present for this platform."
            );
        }

        const cookies = _cookiesFromAppState(appState);
        if (!cookies.c_user || !cookies.xs) {
            throw new Error("Native E2EE media engine: c_user/xs cookies missing from appState");
        }

        const client = new mod.Client(cookies, {
            enableE2EE: true,
            e2eeMemoryOnly: true,
            autoReconnect: true,
            logLevel: "none"
        });

        logger.info("E2EE", "[native-media] Connecting native mautrix-go client for media sends...");
        await client.connect();
        await client.connectE2EE();

        client.on("error", (err) => {
            logger.warn("E2EE", "[native-media] " + (err && err.message ? err.message : String(err)));
        });
        client.on("disconnected", () => {
            logger.warn("E2EE", "[native-media] native client disconnected, will reconnect on next send");
            _client = null;
            _clientPromise = null;
        });

        _client = client;
        return client;
    })();

    try {
        return await _clientPromise;
    } catch (err) {
        _clientPromise = null;
        throw err;
    }
}

/**
 * Sends an E2EE media attachment via the native engine.
 * @param {Array} appState
 * @param {string} chatJid  numeric thread id (bare, no @suffix needed)
 * @param {"image"|"video"|"audio"|"document"} mediaType
 * @param {Buffer} data
 * @param {string} mimeType
 * @param {object} opts { caption, width, height, duration, fileName, replyToId, replyToSenderJid }
 */
async function sendMedia(appState, chatJid, mediaType, data, mimeType, opts) {
    const client = await getClient(appState);
    opts = opts || {};

    // Native client needs a full JID (id@server). fca-eryxenx normalizes
    // E2EE thread ids down to bare numeric strings for GoatBot's benefit,
    // so re-attach the "@msgr" domain here if it's missing.
    if (typeof chatJid === "string" && chatJid.indexOf("@") === -1) {
        chatJid = chatJid + "@msgr";
    }

    switch (mediaType) {
        case "image":
            return client.sendE2EEImage(chatJid, data, mimeType || "image/jpeg", {
                caption: opts.caption, width: opts.width, height: opts.height,
                replyToId: opts.replyToId, replyToSenderJid: opts.replyToSenderJid
            });
        case "video":
            return client.sendE2EEVideo(chatJid, data, mimeType || "video/mp4", {
                caption: opts.caption, width: opts.width, height: opts.height,
                duration: opts.duration,
                replyToId: opts.replyToId, replyToSenderJid: opts.replyToSenderJid
            });
        case "audio":
            return client.sendE2EEAudio(chatJid, data, mimeType || "audio/ogg; codecs=opus", {
                ptt: false, duration: opts.duration,
                replyToId: opts.replyToId, replyToSenderJid: opts.replyToSenderJid
            });
        case "document":
        default:
            return client.sendE2EEDocument(
                chatJid, data, opts.fileName || "file.bin",
                mimeType || "application/octet-stream",
                { replyToId: opts.replyToId, replyToSenderJid: opts.replyToSenderJid }
            );
    }
}

/**
 * Sends/removes an E2EE reaction via the native engine.
 * Pass emoji="" to remove a reaction.
 */
async function sendReaction(appState, chatJid, messageId, senderJid, emoji) {
    const client = await getClient(appState);
    if (typeof chatJid === "string" && chatJid.indexOf("@") === -1) chatJid = chatJid + "@msgr";
    return client.sendE2EEReaction(chatJid, messageId, senderJid, emoji || "");
}

/** Unsends/revokes an E2EE message via the native engine. */
async function unsendMessage(appState, chatJid, messageId) {
    const client = await getClient(appState);
    if (typeof chatJid === "string" && chatJid.indexOf("@") === -1) chatJid = chatJid + "@msgr";
    return client.unsendE2EEMessage(chatJid, messageId);
}

/** Marks an E2EE thread as read via the native engine. */
async function markRead(appState, chatJid, watermarkTs) {
    const client = await getClient(appState);
    if (typeof chatJid === "string" && chatJid.indexOf("@") === -1) chatJid = chatJid + "@msgr";
    return client.markAsRead(chatJid, watermarkTs ? BigInt(watermarkTs) : undefined);
}

module.exports = { getClient, sendMedia, sendReaction, unsendMessage, markRead };
