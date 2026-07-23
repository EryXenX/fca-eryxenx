"use strict";

/**
 * NEXCA E2EE Bridge — Signal Protocol + Noise WebSocket
 *
 * Wraps the `fb-messenger-e2ee` npm package (real dependency, not a bundled
 * vendor copy) and exposes it through NEXCA's own api.e2ee / connectE2EE /
 * listenE2EE surface, so the rest of fca-eryxenx and GoatBot never need to
 * know which E2EE engine is underneath.
 *

 * Full protocol stack:
 *   • @signalapp/libsignal-client — Signal Protocol (Double Ratchet)
 *   • Noise_XX_25519_AESGCM_SHA256 WebSocket handshake
 *   • WA-binary + Protobuf message encoding
 *   • ICDC device registration with Facebook
 */

const path = require("path");
const logger = require("../../../utils/nexca-logger");
const nativeMediaBridge = require("./native/nativeMediaBridge");
const { decodeIncomingMedia } = require("./mediaDecode");
const localMediaServer = require("./localMediaServer");

function loadFBClient() {
    try {
        // Pre-compiled from HerokeyVN/FB-Messenger-E2EE (fb-messenger-e2ee).
        // Compiled ahead of time (esbuild, CJS, node16 target) and committed
        // directly here because:
        //   1. fb-messenger-e2ee is NOT published on the npm registry — only
        //      available as TypeScript source on GitHub.
        //   2. Depending on it as a git/file dependency nested inside
        //      fca-eryxenx (itself installed via `github:` in GoatBot-Pro)
        //      is unreliable — npm does not consistently build nested
        //      non-registry dependencies during a git-dependency install.
        // Shipping plain compiled JS here means zero build step is needed
        // at install time — just `require()`.
        return require("./vendor/fme/dist/index.cjs").FBClient;
    } catch (err) {
        throw new Error(
            "E2EE engine (vendor/fme) failed to load.\n" +
            "  Make sure these are installed: @noble/curves, @noble/hashes,\n" +
            "  @signalapp/libsignal-client, protobufjs, ws, fca-unofficial\n" +
            "  Cause: " + err.message
        );
    }
}

class E2EEBridge {
    constructor(ctx, api, defaultFuncs) {
        this.ctx = ctx;
        this.api = api;
        this.defaultFuncs = defaultFuncs || null;
        this.client = null;
        this.connected = false;
        this._messageCallback = null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Setup
    // ─────────────────────────────────────────────────────────────────────────

    async connect(deviceStorePath, userId) {
        // Guard against concurrent/duplicate connect() calls (e.g. bot code
        // calling api.connectE2EE() explicitly while auto-connect is also
        // running) — without this, two parallel connects race and corrupt
        // `this.client`, causing undefined responses downstream.
        if (this._connectPromise) return this._connectPromise;
        if (this.connected) return Promise.resolve({ userId: this.ctx.userID });

        this._connectPromise = this._doConnect(deviceStorePath, userId)
            .catch((err) => {
                this._connectPromise = null;
                throw err;
            });
        return this._connectPromise;
    }

    async _doConnect(deviceStorePath, userId) {
        const fs = require("fs");

        userId = userId || this.ctx.userID;

        // Default to .nexca/e2ee_device.json in the user's project directory
        if (!deviceStorePath) {
            deviceStorePath = path.join(process.cwd(), ".nexca", "e2ee_device.json");
        }

        // Auto-create parent directory — users don't need to create it manually
        try {
            fs.mkdirSync(path.dirname(deviceStorePath), { recursive: true });
        } catch (_) {}

        logger.info("E2EE", "Device store: " + deviceStorePath);

        const FBClient = loadFBClient();

        // Re-use the already-loaded session from NEXCA's cookie jar.
        // fb-messenger-e2ee accepts an in-memory appState directly (array or
        // cookie string) and does its own independent fca-unofficial login
        // internally to derive the CAT/bootstrap material E2EE needs. This is
        // the library's documented, supported flow — it runs alongside NEXCA's
        // own MQTT session without conflict (separate login call, same cookies).
        const appState = this.api.getAppState();

        this.client = new FBClient({
            appState,
            platform: "facebook",
        });

        logger.info("E2EE", "Bootstrapping auth via fb-messenger-e2ee (appState login)...");
        const connectResult = await this.client.connect();
        const resolvedUserId = connectResult && connectResult.userId;

        logger.info("E2EE", "Opening Noise WebSocket (Signal Protocol)...");
        const _e2eeDevicePath = deviceStorePath;
        const _e2eeUserId     = resolvedUserId || userId;
        await this.client.connectE2EE(_e2eeDevicePath, _e2eeUserId);

        // Auto-reconnect the Noise WebSocket whenever it drops unexpectedly.
        // `this.connected` stays true through reconnect cycles; it's only set
        // false by an explicit api.e2ee.disconnect() call.
        const _self = this;
        this.client.onEvent("disconnected", function _onE2EEDisconnected() {
            if (!_self.connected) return; // intentional disconnect — skip
            logger.warn("E2EE", "Noise WebSocket disconnected — reconnecting in 5s...");
            setTimeout(async function () {
                if (!_self.connected) return;
                try {
                    await _self.client.connectE2EE(_e2eeDevicePath, _e2eeUserId);
                    logger.success("E2EE", "E2EE WebSocket reconnected.");
                } catch (err) {
                    logger.error("E2EE", "E2EE reconnect failed: " + (err && err.message ? err.message : String(err)));
                    // Retry again after another 10s if reconnect failed
                    if (_self.connected) {
                        setTimeout(async function () {
                            if (!_self.connected) return;
                            try {
                                await _self.client.connectE2EE(_e2eeDevicePath, _e2eeUserId);
                                logger.success("E2EE", "E2EE WebSocket reconnected (retry).");
                            } catch (err2) {
                                logger.error("E2EE", "E2EE reconnect retry failed: " + (err2 && err2.message ? err2.message : String(err2)));
                            }
                        }, 10000);
                    }
                }
            }, 5000);
        });

        // Forward incoming E2EE messages to the registered callback.
        this.client.onEvent("e2ee_message", async (msg) => {
            this._senderJidMap = this._senderJidMap || new Map();
            this._mediaCache = this._mediaCache || new Map();
            this._msgThreadMap = this._msgThreadMap || new Map();
            this._msgTextCache = this._msgTextCache || new Map();
            if (msg.id) this._senderJidMap.set(String(msg.id), msg.senderJid || null);
            if (msg.id && msg.text) this._msgTextCache.set(String(msg.id), String(msg.text));

            if (msg.kind && msg.kind !== "text" && msg.media) {
                try {
                    const meta = decodeIncomingMedia(msg.kind, msg.media);
                    if (meta) this._mediaCache.set(String(msg.id), meta);
                } catch (err) {
                    logger.error("E2EE", "[media-decode] failed to decode incoming " + msg.kind + ": " +
                        (err && err.message ? err.message : String(err)));
                }
            }

            if (!this._messageCallback) return;

            const senderID =
                msg.senderId ||
                (typeof msg.senderJid === "string" ? msg.senderJid.split(".")[0] : "");

            // GoatBot (handlerEvents.js, threadsData, etc.) expects plain
            // numeric threadIDs everywhere — DB lookups, isNaN() checks, etc.
            // FME group threads arrive as "<id>@g.us" (WA-binary JID style),
            // which breaks those checks and crashes handlerEvents.js. Strip
            // any "@..." suffix so downstream code sees a plain numeric ID.
            function normalizeThreadId(id) {
                if (typeof id !== "string") return id;
                var at = id.indexOf("@");
                return at === -1 ? id : id.slice(0, at);
            }
            const normalizedThreadId = normalizeThreadId(msg.threadId);
            this._knownE2EEThreads = this._knownE2EEThreads || new Set();
            this._knownE2EEThreads.add(normalizedThreadId);
            if (msg.id) this._msgThreadMap.set(String(msg.id), normalizedThreadId);
            if (msg.replyTo && msg.replyTo.messageId) this._msgThreadMap.set(String(msg.replyTo.messageId), normalizedThreadId);

            // Build mentions: vendor surfaces an array [{ id, text }] or object
            var mentions = {};
            if (Array.isArray(msg.mentions)) {
                msg.mentions.forEach(function(m) {
                    if (m && m.id) mentions[m.id] = m.text || "@" + m.id;
                });
            } else if (msg.mentions && typeof msg.mentions === "object") {
                mentions = msg.mentions;
            }

            const isReply = !!(msg.replyTo && msg.replyTo.messageId);
            if (isReply) {
                try {
                    console.log("[E2EE-DEBUG] msg.replyTo raw:", JSON.stringify(msg.replyTo, (k, v) => Buffer.isBuffer(v) ? `<Buffer ${v.length}b>` : v));
                } catch (_) { console.log("[E2EE-DEBUG] msg.replyTo (raw, non-serializable):", msg.replyTo); }
            }
            if (msg.kind && msg.kind !== "text") {
                try {
                    console.log("[E2EE-DEBUG] msg.kind=" + msg.kind + " msg.media keys:", msg.media ? Object.keys(msg.media) : null);
                } catch (_) {}
            }
            if (msg.kind === "reaction") {
                try {
                    console.log("[E2EE-DEBUG] FULL reaction msg dump:", JSON.stringify(msg, (k, v) => Buffer.isBuffer(v) ? `<Buffer ${v.length}b>` : v, 2));
                } catch (_) { console.log("[E2EE-DEBUG] FULL reaction msg (non-serializable):", msg); }
            }

            const event = {
                type:        isReply ? "message_reply" : "message",
                senderID,
                threadID:    normalizedThreadId,
                body:        msg.text || "",
                isE2EE:      true,
                isGroup:     !!msg.isGroup,
                timestamp:   msg.timestampMs || Date.now(),
                messageID:   msg.id || "",
                attachments: [],
                mentions,
                args:        (msg.text || "").trim().split(/\s+/).filter(Boolean),
            };

            // Populate ctx.threadTypes so that sendMessage.js can detect this
            // as a DM and route attachments through OldMessage (not MQTT).
            // E2EE DM messages arrive via the Noise WebSocket — not MQTT — so
            // parseDelta never sees them and ctx.threadTypes stays empty unless
            // we populate it here.
            if (!event.isGroup && normalizedThreadId) {
                this.ctx.threadTypes = this.ctx.threadTypes || {};
                this.ctx.threadTypes[String(normalizedThreadId)] = 'dm';
            }

            // Eagerly resolve any E2EE media on this message itself.
            const ownMeta = this._mediaCache.get(String(msg.id));
            if (ownMeta) {
                try {
                    const url = await this.resolveAttachment(ownMeta);
                    event.attachments = [{
                        type: ownMeta.kind === "image" ? "photo" : ownMeta.kind === "video" ? "video" : ownMeta.kind === "audio" ? "audio" : "file",
                        ID: event.messageID,
                        url,
                        isE2EE: true,
                        filename: ownMeta.fileName,
                        width: ownMeta.width,
                        height: ownMeta.height
                    }];
                } catch (err) {
                    logger.error("E2EE", "[media-resolve] failed to resolve own attachment: " + (err && err.message ? err.message : String(err)));
                }
            }

            // Populate messageReply so reply handlers work the same as in MQTT
            if (isReply) {
                const replyText = msg.replyTo.text || this._msgTextCache.get(String(msg.replyTo.messageId)) || "";
                event.messageReply = {
                    messageID: msg.replyTo.messageId,
                    senderID:  msg.replyTo.senderId || "",
                    threadID:  normalizedThreadId,
                    body:      replyText,
                    args:      replyText.trim().split(/\s+/).filter(Boolean),
                    isE2EE:    true,
                    isGroup:   !!msg.isGroup,
                    mentions:  {},
                    attachments: []
                };

                // Resolve the ORIGINAL message's media (if any) from cache — this
                // is what makes reply-based commands like imgur.js work in E2EE.
                const repliedMeta = this._mediaCache.get(String(msg.replyTo.messageId));
                if (repliedMeta) {
                    try {
                        const url = await this.resolveAttachment(repliedMeta);
                        event.messageReply.attachments = [{
                            type: repliedMeta.kind === "image" ? "photo" : repliedMeta.kind === "video" ? "video" : repliedMeta.kind === "audio" ? "audio" : "file",
                            ID: msg.replyTo.messageId,
                            url,
                            isE2EE: true,
                            filename: repliedMeta.fileName,
                            width: repliedMeta.width,
                            height: repliedMeta.height
                        }];
                    } catch (err) {
                        logger.error("E2EE", "[media-resolve] failed to resolve replied attachment: " + (err && err.message ? err.message : String(err)));
                    }
                }
            }

            this._messageCallback(null, event);
        });

        // Incoming E2EE reactions — needed for onReaction handlers (e.g. a
        // reaction-triggered unsend feature) to fire in encrypted threads.
        this.client.onEvent("e2ee_reaction", (r) => {
            console.log("[E2EE-DEBUG] e2ee_reaction fired:", JSON.stringify(r));
            if (!this._messageCallback) return;
            const threadID = r.chatJid ? String(r.chatJid).split("@")[0].split(".")[0] : "";
            const senderID = r.senderId || (r.senderJid ? String(r.senderJid).split(".")[0] : "");
            this._messageCallback(null, {
                type: "message_reaction",
                threadID,
                messageID: r.messageId,
                reaction: r.reaction,
                senderID,
                userID: senderID,
                isE2EE: true
            });
        });

        // Catch-all: log any E2EE event type we haven't explicitly handled,
        // so we can see the real event name if our assumptions above are wrong.
        this.client.onEvent((evt) => {
            const known = ["e2ee_message", "e2ee_reaction", "connected", "disconnected", "error"];
            if (evt && !known.includes(evt.type)) {
                console.log("[E2EE-DEBUG] unhandled event type:", evt.type, "data keys:", evt.data ? Object.keys(evt.data) : null);
            }
        });

        // Surface connection errors so the bot log shows them.
        // Silently ignore DuplicatedMessage errors — these are harmless replays on reconnect.
        this.client.onEvent("error", (err) => {
            if (err && (err.code === 1 || (err.message && err.message.includes("old counter")))) return;
            logger.error("E2EE", "E2EE error: " + (err && err.message ? err.message : String(err)));
        });

        this.connected = true;
        logger.success("E2EE", "E2EE active — Signal Protocol / Noise WebSocket (vendored)");
        return this;
    }

    ensureConnected() {
        if (!this.connected || !this.client) {
            throw new Error("E2EE not connected. Call api.connectE2EE() first.");
        }
    }

    isConnected() {
        return this.connected;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Send API  (all go through the Noise WebSocket)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Send a message on an E2EE (or non-E2EE) thread.
     *
     * msg can be:
     *   - string              → plain text
     *   - { body, attachment} → text + one or more readable streams
     *
     * Attachments on E2EE threads are encrypted and sent via the Noise WebSocket.
     * Attachments on non-E2EE threads fall back to api.sendMessage (NEXCA's own).
     */
    async sendMessage(threadId, msg, replyToMessageId) {
        this.ensureConnected();

        const text = typeof msg === "string" ? msg : (msg && msg.body != null ? String(msg.body) : "");
        const attachment = (msg && typeof msg === "object") ? (msg.attachment || null) : null;

        this._msgThreadMap = this._msgThreadMap || new Map();
        this._msgTextCache = this._msgTextCache || new Map();

        if (!attachment) {
            const result = await this.client.sendMessage({ threadId, text, replyToMessageId });
            if (result && result.messageId) {
                this._msgThreadMap.set(String(result.messageId), threadId);
                if (text) this._msgTextCache.set(String(result.messageId), text);
            }
            return result;
        }

        // Always use the vendor's Noise WebSocket path for attachments.
        // The isE2EEThreadId() check was removed because:
        //   1. It frequently returns false for valid E2EE DM thread IDs (user-id format),
        //      which caused fallback to api.sendMessage → MQTT, where Facebook strips
        //      attachment_fbids from the E2EE envelope → attachment silently dropped.
        //   2. This method is only called when the thread is KNOWN to be an E2EE DM
        //      (sendMessage.js routes here only when isSingleUser=true AND e2ee.isConnected()).
        //   3. client.sendImage/sendVideo/sendAudio handle the JID conversion internally
        //      (100055943906136 → 100055943906136.0@msgr) so the threadId format is fine.

        // E2EE path: read stream(s) → Buffer, detect type, send via vendor
        const path = require("path");
        let mime;
        try { mime = require("mime"); } catch (_) {}

        const list = Array.isArray(attachment) ? attachment : [attachment];
        const results = [];

        for (const stream of list) {
            const data = await _streamToBuffer(stream);
            let fileName = (stream.path ? path.basename(String(stream.path)) : null);
            let mimeType = fileName ? ((mime && mime.getType(fileName)) || _guessMime(fileName)) : null;

            if (!fileName || !mimeType || mimeType === "application/octet-stream") {
                const sniffed = _sniffMime(data);
                if (sniffed) {
                    mimeType = sniffed.mimeType;
                    if (!fileName) fileName = `file.${sniffed.ext}`;
                } else {
                    fileName = fileName || "file.bin";
                    mimeType = mimeType || "application/octet-stream";
                }
            }

            const dims = mimeType.startsWith("image/") ? _getImageDimensions(data, mimeType) : null;

            console.log(`[E2EEBridge] sendMessage attachment (native engine): fileName=${fileName}, mimeType=${mimeType}, size=${data.length} bytes, dims=${dims ? dims.width + "x" + dims.height : "n/a"}, threadId=${threadId}`);

            let mediaType;
            if (mimeType.startsWith("image/")) mediaType = "image";
            else if (mimeType.startsWith("video/")) mediaType = "video";
            else if (mimeType.startsWith("audio/")) mediaType = "audio";
            else mediaType = "document";

            const appState = this.api.getAppState();
            let result;
            try {
                result = await nativeMediaBridge.sendMedia(appState, threadId, mediaType, data, mimeType, {
                    caption: text || undefined,
                    width: dims ? dims.width : undefined,
                    height: dims ? dims.height : undefined,
                    fileName,
                    replyToId: replyToMessageId
                });
            } catch (nativeErr) {
                logger.error("E2EE", "[native-media] send failed, falling back to legacy vendor engine: " +
                    (nativeErr && nativeErr.message ? nativeErr.message : String(nativeErr)));
                const input = { threadId, data, fileName, mimeType, caption: text || undefined, replyToMessageId,
                    width: dims ? dims.width : undefined, height: dims ? dims.height : undefined };
                if (mediaType === "image") result = await this.client.sendImage(input);
                else if (mediaType === "video") result = await this.client.sendVideo(input);
                else if (mediaType === "audio") result = await this.client.sendAudio(input);
                else result = await this.client.sendFile(input);
            }
            console.log(`[E2EEBridge] send result:`, JSON.stringify(result));
            if (result && result.messageId) this._msgThreadMap.set(String(result.messageId), threadId);
            results.push(result);
        }

        return results.length === 1 ? results[0] : results;
    }

    /**
     * Downloads + decrypts an incoming E2EE media attachment and returns a
     * short-lived local HTTP URL for it (so existing GoatBot commands that
     * do axios.get(attachment.url) work unmodified).
     */
    async resolveAttachment(meta) {
        if (!meta || !meta.directPath || !meta.mediaKey) throw new Error("Invalid E2EE attachment metadata");

        // directPath from the message is host-relative (e.g. "/v/t800.../x.enc?...").
        // The exact CDN host Messenger's own client resolves this against isn't
        // captured anywhere in the decoded message — this default is a
        // best-effort guess and can be overridden via env if it turns out wrong.
        const host = process.env.FB_E2EE_MEDIA_DOWNLOAD_HOST || "rupload.facebook.com";
        const fullUrl = meta.directPath.startsWith("http") ? meta.directPath : `https://${host}${meta.directPath}`;

        const result = await this.client.downloadMedia({
            directPath: fullUrl,
            mediaKey: Buffer.from(meta.mediaKey).toString("base64"),
            mediaSha256: meta.fileSHA256 ? Buffer.from(meta.fileSHA256).toString("base64") : undefined,
            mediaEncSha256: meta.fileEncSHA256 ? Buffer.from(meta.fileEncSHA256).toString("base64") : undefined,
            mediaType: meta.kind,
            mimeType: meta.mimeType
        });

        const buffer = Buffer.isBuffer(result) ? result : (result && result.data ? result.data : null);
        if (!buffer) throw new Error("downloadMedia returned no data");

        return localMediaServer.serveBuffer(buffer, meta.mimeType);
    }

    getKnownThreads() {
        return this._knownE2EEThreads ? Array.from(this._knownE2EEThreads) : [];
    }

    async markRead(threadId, watermarkTs) {
        this.ensureConnected();
        return nativeMediaBridge.markRead(this.api.getAppState(), threadId, watermarkTs);
    }

    getThreadIdForMessage(messageId) {
        return (this._msgThreadMap && this._msgThreadMap.get(String(messageId))) || undefined;
    }

    getSenderJid(messageId) {
        return (this._senderJidMap && this._senderJidMap.get(String(messageId))) || undefined;
    }

    async sendReaction(threadId, messageId, reaction, senderJid) {
        this.ensureConnected();
        if (!senderJid) senderJid = this.getSenderJid(messageId);
        try {
            return await nativeMediaBridge.sendReaction(this.api.getAppState(), threadId, messageId, senderJid, reaction);
        } catch (err) {
            logger.error("E2EE", "[native-media] reaction failed, falling back to legacy engine: " + (err && err.message ? err.message : String(err)));
            return this.client.sendReaction({ threadId, messageId, reaction, senderJid });
        }
    }

    async sendTyping(threadId, isTyping) {
        this.ensureConnected();
        return this.client.sendTyping({ threadId, isTyping: isTyping !== false });
    }

    async unsendMessage(messageId, threadId) {
        this.ensureConnected();
        try {
            return await nativeMediaBridge.unsendMessage(this.api.getAppState(), threadId, messageId);
        } catch (err) {
            logger.error("E2EE", "[native-media] unsend failed, falling back to legacy engine: " + (err && err.message ? err.message : String(err)));
            return this.client.unsendMessage({ messageId, threadId });
        }
    }

    async editMessage(threadId, messageId, newText) {
        this.ensureConnected();
        return this.client.editMessage({ threadId, messageId, newText });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Receive API
    // ─────────────────────────────────────────────────────────────────────────

    onMessage(callback) {
        this._messageCallback = callback;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Info / lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    getPublicKeys() {
        return {
            info: "Keys managed by vendored E2EE engine (Signal Protocol / Noise handshake).",
            note: "Identity + device keys are stored in the device-store file. Do NOT delete it.",
        };
    }

    async disconnect() {
        if (this.client) {
            try { await this.client.disconnect(); } catch (_) {}
        }
        this.connected = false;
        logger.info("E2EE", "E2EE disconnected.");
    }
}

module.exports = { E2EEBridge };

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

function _streamToBuffer(stream) {
    return new Promise(function (resolve, reject) {
        var chunks = [];
        stream.on("data", function (c) { chunks.push(c); });
        stream.on("end", function () { resolve(Buffer.concat(chunks)); });
        stream.on("error", reject);
    });
}

function _guessMime(fileName) {
    var ext = (fileName || "").split(".").pop().toLowerCase();
    var map = {
        jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
        webp: "image/webp", mp4: "video/mp4", mov: "video/quicktime",
        avi: "video/x-msvideo", mkv: "video/x-matroska",
        mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
        m4a: "audio/mp4", aac: "audio/aac", opus: "audio/ogg; codecs=opus",
        pdf: "application/pdf", zip: "application/zip"
    };
    return map[ext] || "application/octet-stream";
}

// Detects file type from the actual downloaded bytes when no filename/extension
// is available (e.g. axios/http response streams used by commands like sing.js
// that download remote media — those streams have no .path, so the old code
// always fell back to fileName=file.bin / mimeType=application/octet-stream,
// which Messenger's E2EE client does not render as playable media/images).
function _sniffMime(buf) {
    if (!buf || buf.length < 12) return null;

    // MP3: 'ID3' tag, or frame sync (0xFF Ex/Fx)
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return { mimeType: "audio/mpeg", ext: "mp3" };
    if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return { mimeType: "audio/mpeg", ext: "mp3" };

    // WAV: 'RIFF'....'WAVE'
    if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WAVE")
        return { mimeType: "audio/wav", ext: "wav" };

    // OGG: 'OggS'
    if (buf.slice(0, 4).toString("ascii") === "OggS") return { mimeType: "audio/ogg", ext: "ogg" };

    // M4A/MP4 family: '....ftyp'
    if (buf.slice(4, 8).toString("ascii") === "ftyp") {
        var brand = buf.slice(8, 12).toString("ascii");
        if (brand.indexOf("M4A") !== -1) return { mimeType: "audio/mp4", ext: "m4a" };
        return { mimeType: "video/mp4", ext: "mp4" };
    }

    // PNG
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47)
        return { mimeType: "image/png", ext: "png" };

    // JPEG
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { mimeType: "image/jpeg", ext: "jpg" };

    // GIF
    if (buf.slice(0, 3).toString("ascii") === "GIF") return { mimeType: "image/gif", ext: "gif" };

    // WEBP: 'RIFF'....'WEBP'
    if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP")
        return { mimeType: "image/webp", ext: "webp" };

    // PDF
    if (buf.slice(0, 4).toString("ascii") === "%PDF") return { mimeType: "application/pdf", ext: "pdf" };

    return null;
}

// Parses width/height from raw image bytes (no external deps).
// Needed because Messenger's E2EE ImageMessage/VideoMessage transport expects
// dimension hints, and the vendored library previously never populated them.
function _getImageDimensions(buf, mimeType) {
    try {
        if (mimeType === "image/png" && buf.length >= 24) {
            return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
        }
        if (mimeType === "image/gif" && buf.length >= 10) {
            return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
        }
        if (mimeType === "image/jpeg") {
            let offset = 2;
            while (offset < buf.length) {
                if (buf[offset] !== 0xFF) break;
                const marker = buf[offset + 1];
                if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) {
                    offset += 2;
                    continue;
                }
                const segLength = buf.readUInt16BE(offset + 2);
                if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
                    return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
                }
                offset += 2 + segLength;
            }
        }
    } catch (_) {}
    return null;
}
