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
        this.client.onEvent("e2ee_message", (msg) => {
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

            // Populate messageReply so reply handlers work the same as in MQTT
            if (isReply) {
                event.messageReply = {
                    messageID: msg.replyTo.messageId,
                    senderID:  msg.replyTo.senderId || "",
                    threadID:  normalizedThreadId,
                    body:      msg.replyTo.text || "",
                    args:      (msg.replyTo.text || "").trim().split(/\s+/).filter(Boolean),
                    isE2EE:    true,
                    isGroup:   !!msg.isGroup,
                    mentions:  {},
                    attachments: []
                };
            }

            this._messageCallback(null, event);
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

        if (!attachment) {
            return this.client.sendMessage({ threadId, text, replyToMessageId });
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
            const input = {
                threadId, data, fileName, mimeType,
                caption: text || undefined, replyToMessageId,
                width: dims ? dims.width : undefined,
                height: dims ? dims.height : undefined
            };

            console.log(`[E2EEBridge] sendMessage attachment: fileName=${fileName}, mimeType=${mimeType}, size=${data.length} bytes, dims=${dims ? dims.width + "x" + dims.height : "n/a"}, threadId=${threadId}`);
            let result;
            if (mimeType.startsWith("image/")) {
                result = await this.client.sendImage(input);
            } else if (mimeType.startsWith("video/")) {
                result = await this.client.sendVideo(input);
            } else if (mimeType.startsWith("audio/")) {
                result = await this.client.sendAudio(input);
            } else {
                result = await this.client.sendFile(input);
            }
            console.log(`[E2EEBridge] send result:`, JSON.stringify(result));
            results.push(result);
        }

        return results.length === 1 ? results[0] : results;
    }

    async sendReaction(threadId, messageId, reaction, senderJid) {
        this.ensureConnected();
        return this.client.sendReaction({ threadId, messageId, reaction, senderJid });
    }

    async sendTyping(threadId, isTyping) {
        this.ensureConnected();
        return this.client.sendTyping({ threadId, isTyping: isTyping !== false });
    }

    async unsendMessage(messageId, threadId) {
        this.ensureConnected();
        return this.client.unsendMessage({ messageId, threadId });
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
