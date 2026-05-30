"use strict";

const path = require("path");
const _log = require("../../func/logger");

const logger = {
  info: (tag, msg) => _log(`[${tag}] ${msg}`, "info"),
  warn: (tag, msg) => _log(`[${tag}] ${msg}`, "warn"),
  error: (tag, msg) => _log(`[${tag}] ${msg}`, "error"),
  success: (tag, msg) => _log(`[${tag}] ${msg}`, "info"),
};

function loadFBClient() {
  try {
    const vendorPath = path.join(__dirname, "vendor", "fb-e2ee.cjs");
    return require(vendorPath).FBClient;
  } catch (err) {
    throw new Error(
      "E2EE engine failed to load.\n" +
      "  Expected at: src/e2ee/vendor/fb-e2ee.cjs\n" +
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
    this._connectPromise = null;
  }

  async connect(deviceStorePath, userId) {
    if (this.connected) return this;
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = (async () => {
      const fs = require("fs");
      userId = userId || this.ctx.userID;

      if (!deviceStorePath) {
        deviceStorePath = path.join(process.cwd(), ".fca-e2ee", "device.json");
      }

      try { fs.mkdirSync(path.dirname(deviceStorePath), { recursive: true }); } catch (_) {}

      logger.info("E2EE", "Device store: " + deviceStorePath);

      if (typeof WebSocket === "undefined") {
        global.WebSocket = require("ws");
      }

      const FBClient = loadFBClient();
      const appState = this.api.getAppState();

      this.client = new FBClient({ appState, platform: "facebook" });

      const _ctx = this.ctx;
      const _api = this.api;
      const _funcs = this.defaultFuncs;

      const adapter = {
        fb_dtsg: _ctx.fb_dtsg,
        getCurrentUserID: () => _api.getCurrentUserID ? _api.getCurrentUserID() : _ctx.userID,
        getAppState: () => _api.getAppState(),
        login: async () => ({ userID: _ctx.userID, appState: _api.getAppState() }),
        setOptions: () => {},
        listenMqtt: () => {},
        stopListenMqtt: () => {},
        httpPost: async (url, form) => {
          const data = Object.assign({}, form);
          if (!data.fb_dtsg && _ctx.fb_dtsg) data.fb_dtsg = _ctx.fb_dtsg;
          if (!data.__user) data.__user = _ctx.userID;
          if (_funcs && _funcs.post) {
            const r = await _funcs.post(url, _ctx.jar, data);
            return r && r.body;
          }
          return new Promise((ok, fail) => {
            require("request")({ method: "POST", url, jar: _ctx.jar, form: data, gzip: true },
              (e, r) => e ? fail(e) : ok(r && r.body));
          });
        },
        sendMessage: (m, t, cb, rep) => _api.sendMessage(m, t, cb, rep),
        sendTypingIndicator: (v, t, cb) => _api.sendTypingIndicator && _api.sendTypingIndicator(v, t, cb),
        setMessageReaction: (r, m, cb, f) => _api.setMessageReaction && _api.setMessageReaction(r, m, cb, f),
        unsendMessage: (m, cb) => _api.unsendMessage && _api.unsendMessage(m, cb),
        markAsRead: (t, r, cb) => _api.markAsRead && _api.markAsRead(t, r, cb),
        muteThread: (t, s, cb) => _api.muteThread && _api.muteThread(t, s, cb),
        setTitle: (title, t, cb) => _api.setTitle && _api.setTitle(title, t, cb),
        changeGroupImage: (img, t, cb) => _api.changeGroupImage && _api.changeGroupImage(img, t, cb),
      };

      global._nexcaE2EEAdapter = adapter;
      let resolvedUserId;
      try {
        const r = await this.client.connect();
        resolvedUserId = r && r.userId;
      } finally {
        delete global._nexcaE2EEAdapter;
      }

      if (this.client.controller) this.client.controller.api = adapter;

      logger.info("E2EE", "Opening Noise WebSocket...");
      await this.client.connectE2EE(deviceStorePath, resolvedUserId || userId);

      this.client.onEvent("e2ee_message", (msg) => {
        if (!this._messageCallback) return;

        const senderID = msg.senderId ||
          (typeof msg.senderJid === "string" ? msg.senderJid.split(".")[0] : "");

        const mentions = {};
        if (Array.isArray(msg.mentions)) {
          msg.mentions.forEach(m => { if (m && m.id) mentions[m.id] = m.text || "@" + m.id; });
        } else if (msg.mentions && typeof msg.mentions === "object") {
          Object.assign(mentions, msg.mentions);
        }

        const isReply = !!(msg.replyTo && msg.replyTo.messageId);
        const body = msg.text || "";

        const event = {
          type: isReply ? "message_reply" : "message",
          senderID,
          threadID: msg.threadId,
          body,
          isE2EE: true,
          isGroup: !!msg.isGroup,
          timestamp: msg.timestampMs || Date.now(),
          messageID: msg.id || "",
          attachments: [],
          mentions,
          args: body.trim().split(/\s+/).filter(Boolean),
        };

        if (!event.isGroup && msg.threadId) {
          this.ctx.threadTypes = this.ctx.threadTypes || {};
          this.ctx.threadTypes[String(msg.threadId)] = "dm";
        }

        if (isReply) {
          const rb = msg.replyTo.text || "";
          event.messageReply = {
            messageID: msg.replyTo.messageId,
            senderID: msg.replyTo.senderId || "",
            threadID: msg.threadId,
            body: rb,
            args: rb.trim().split(/\s+/).filter(Boolean),
            isE2EE: true,
            isGroup: !!msg.isGroup,
            mentions: {},
            attachments: [],
          };
        }

        this._messageCallback(null, event);
      });

      this.client.onEvent("error", (err) => {
        if (!err) return;
        if (err.code === 1 || (err.message && err.message.includes("old counter"))) return;
        logger.error("E2EE", err.message || String(err));
      });

      this.connected = true;
      logger.success("E2EE", "Active — Signal Protocol / Noise WebSocket");
      return this;
    })();

    return this._connectPromise;
  }

  isConnected() { return this.connected; }

  onMessage(callback) { this._messageCallback = callback; }

  async sendMessage(threadId, msg, replyToMessageId) {
    if (!this.connected) throw new Error("E2EE not connected.");
    const text = typeof msg === "string" ? msg : (msg && msg.body != null ? String(msg.body) : "");
    const att = msg && typeof msg === "object" ? (msg.attachment || null) : null;

    if (!att) return this.client.sendMessage({ threadId, text, replyToMessageId });

    let mime;
    try { mime = require("mime"); } catch (_) {}

    const list = Array.isArray(att) ? att : [att];
    const out = [];
    for (const s of list) {
      const data = await _streamToBuffer(s);
      const fileName = s.path ? path.basename(String(s.path)) : "file.bin";
      const mimeType = (mime && mime.getType(fileName)) || _guessMime(fileName);
      const payload = { threadId, data, fileName, mimeType, caption: text || undefined, replyToMessageId };
      let res;
      if (mimeType.startsWith("image/")) res = await this.client.sendImage(payload);
      else if (mimeType.startsWith("video/")) res = await this.client.sendVideo(payload);
      else if (mimeType.startsWith("audio/")) res = await this.client.sendAudio(payload);
      else res = await this.client.sendFile(payload);
      out.push(res);
    }
    return out.length === 1 ? out[0] : out;
  }

  async sendReaction(threadId, messageId, reaction, senderJid) {
    if (!this.connected) throw new Error("E2EE not connected.");
    return this.client.sendReaction({ threadId, messageId, reaction, senderJid });
  }

  async sendTyping(threadId, isTyping) {
    if (!this.connected) throw new Error("E2EE not connected.");
    return this.client.sendTyping({ threadId, isTyping: isTyping !== false });
  }

  async unsendMessage(messageId, threadId) {
    if (!this.connected) throw new Error("E2EE not connected.");
    return this.client.unsendMessage({ messageId, threadId });
  }

  async editMessage(threadId, messageId, newText) {
    if (!this.connected) throw new Error("E2EE not connected.");
    return this.client.editMessage({ threadId, messageId, newText });
  }

  async disconnect() {
    if (this.client) try { await this.client.disconnect(); } catch (_) {}
    this.connected = false;
    this._connectPromise = null;
    logger.info("E2EE", "Disconnected.");
  }
}

module.exports = { E2EEBridge };

function _streamToBuffer(stream) {
  return new Promise((ok, fail) => {
    const parts = [];
    stream.on("data", c => parts.push(c));
    stream.on("end", () => ok(Buffer.concat(parts)));
    stream.on("error", fail);
  });
}

function _guessMime(name) {
  const ext = (name || "").split(".").pop().toLowerCase();
  const map = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
    mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo",
    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4",
    aac: "audio/aac", opus: "audio/ogg; codecs=opus",
    pdf: "application/pdf", zip: "application/zip",
  };
  return map[ext] || "application/octet-stream";
}
