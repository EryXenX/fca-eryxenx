"use strict";

const path = require("path");
const fs = require("fs");
const log = require("../../func/logger");

function loadEngine() {
  try {
    return require(path.join(__dirname, "net", "bridge.cjs")).FBClient;
  } catch (e) {
    throw new Error("FCA secure engine missing at src/core/net/bridge.cjs\n" + e.message);
  }
}

function makeGateway(ctx, api, funcs) {
  return {
    fb_dtsg: ctx.fb_dtsg,
    getCurrentUserID: () => api.getCurrentUserID ? api.getCurrentUserID() : ctx.userID,
    getAppState: () => api.getAppState(),
    setOptions: () => {},
    listenMqtt: () => {},
    stopListenMqtt: () => {},
    httpPost: async (url, form) => {
      const data = Object.assign({}, form);
      if (!data.fb_dtsg && ctx.fb_dtsg) data.fb_dtsg = ctx.fb_dtsg;
      if (!data.__user) data.__user = ctx.userID;
      if (funcs && funcs.post) {
        const r = await funcs.post(url, ctx.jar, data);
        return r && r.body;
      }
      return new Promise((ok, fail) => {
        require("request")({ method: "POST", url, jar: ctx.jar, form: data, gzip: true },
          (e, r) => e ? fail(e) : ok(r && r.body));
      });
    },
    sendMessage: (m, t, cb, rep) => api.sendMessage(m, t, cb, rep),
    sendTypingIndicator: (v, t, cb) => api.sendTypingIndicator && api.sendTypingIndicator(v, t, cb),
    setMessageReaction: (r, m, cb, f) => api.setMessageReaction && api.setMessageReaction(r, m, cb, f),
    unsendMessage: (m, cb) => api.unsendMessage && api.unsendMessage(m, cb),
    markAsRead: (t, r, cb) => api.markAsRead && api.markAsRead(t, r, cb),
    muteThread: (t, s, cb) => api.muteThread && api.muteThread(t, s, cb),
    setTitle: (title, t, cb) => api.setTitle && api.setTitle(title, t, cb),
    changeGroupImage: (img, t, cb) => api.changeGroupImage && api.changeGroupImage(img, t, cb),
  };
}

function toEvent(msg, ctx) {
  const senderID = msg.senderId ||
    (typeof msg.senderJid === "string" ? msg.senderJid.split(".")[0] : "");

  const mentions = {};
  if (Array.isArray(msg.mentions)) {
    msg.mentions.forEach(m => { if (m && m.id) mentions[m.id] = m.text || "@" + m.id; });
  } else if (msg.mentions && typeof msg.mentions === "object") {
    Object.assign(mentions, msg.mentions);
  }

  const hasReply = !!(msg.replyTo && msg.replyTo.messageId);
  const body = msg.text || "";

  const ev = {
    type: hasReply ? "message_reply" : "message",
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

  if (!ev.isGroup && msg.threadId) {
    ctx.threadTypes = ctx.threadTypes || {};
    ctx.threadTypes[String(msg.threadId)] = "dm";
  }

  if (hasReply) {
    const rb = msg.replyTo.text || "";
    ev.messageReply = {
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

  return ev;
}

function readStream(stream) {
  return new Promise((ok, fail) => {
    const parts = [];
    stream.on("data", c => parts.push(c));
    stream.on("end", () => ok(Buffer.concat(parts)));
    stream.on("error", fail);
  });
}

function detectMime(name) {
  const ext = (name || "").split(".").pop().toLowerCase();
  const m = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
    mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo",
    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4",
    aac: "audio/aac", opus: "audio/ogg; codecs=opus",
    pdf: "application/pdf", zip: "application/zip",
  };
  return m[ext] || "application/octet-stream";
}

class EncryptedChannel {
  constructor(ctx, api, funcs) {
    this.ctx = ctx;
    this.api = api;
    this.funcs = funcs || null;
    this.engine = null;
    this.active = false;
    this._handler = null;
  }

  async boot(sessionFile) {
    if (!sessionFile) sessionFile = path.join(process.cwd(), ".session", "keys.json");
    try { fs.mkdirSync(path.dirname(sessionFile), { recursive: true }); } catch (_) {}

    const Engine = loadEngine();
    const gw = makeGateway(this.ctx, this.api, this.funcs);

    this.engine = new Engine({ appState: this.api.getAppState(), platform: "facebook" });

    global._nexcaE2EEAdapter = gw;
    let uid;
    try {
      const r = await this.engine.connect();
      uid = r && r.userId;
    } finally {
      delete global._nexcaE2EEAdapter;
    }

    if (this.engine.controller) this.engine.controller.api = gw;

    await this.engine.connectE2EE(sessionFile, uid || this.ctx.userID);

    this.engine.onEvent("e2ee_message", (msg) => {
      if (this._handler) this._handler(null, toEvent(msg, this.ctx));
    });

    this.engine.onEvent("error", (err) => {
      if (!err) return;
      if (err.code === 1 || (err.message && err.message.includes("old counter"))) return;
      log("Channel error: " + (err.message || String(err)), "error");
    });

    this.active = true;
    log("Encrypted channel active.", "info");
    return this;
  }

  isActive() { return this.active; }

  setHandler(fn) { this._handler = fn; }

  _guard() {
    if (!this.active || !this.engine) throw new Error("EncryptedChannel not active.");
  }

  async sendMsg(threadId, msg, replyTo) {
    this._guard();
    const text = typeof msg === "string" ? msg : (msg && msg.body != null ? String(msg.body) : "");
    const att = msg && typeof msg === "object" ? (msg.attachment || null) : null;

    if (!att) return this.engine.sendMessage({ threadId, text, replyToMessageId: replyTo });

    let mime;
    try { mime = require("mime"); } catch (_) {}

    const list = Array.isArray(att) ? att : [att];
    const out = [];

    for (const s of list) {
      const data = await readStream(s);
      const fileName = s.path ? path.basename(String(s.path)) : "file.bin";
      const mimeType = (mime && mime.getType(fileName)) || detectMime(fileName);
      const payload = { threadId, data, fileName, mimeType, caption: text || undefined, replyToMessageId: replyTo };

      let res;
      if (mimeType.startsWith("image/")) res = await this.engine.sendImage(payload);
      else if (mimeType.startsWith("video/")) res = await this.engine.sendVideo(payload);
      else if (mimeType.startsWith("audio/")) res = await this.engine.sendAudio(payload);
      else res = await this.engine.sendFile(payload);
      out.push(res);
    }

    return out.length === 1 ? out[0] : out;
  }

  async sendReact(threadId, messageId, reaction, senderJid) {
    this._guard();
    return this.engine.sendReaction({ threadId, messageId, reaction, senderJid });
  }

  async sendTyping(threadId, on) {
    this._guard();
    return this.engine.sendTyping({ threadId, isTyping: on !== false });
  }

  async deleteMsg(messageId, threadId) {
    this._guard();
    return this.engine.unsendMessage({ messageId, threadId });
  }

  async editMsg(threadId, messageId, text) {
    this._guard();
    return this.engine.editMessage({ threadId, messageId, newText: text });
  }

  async shutdown() {
    if (this.engine) try { await this.engine.disconnect(); } catch (_) {}
    this.active = false;
    log("Encrypted channel closed.", "info");
  }
}

module.exports = { EncryptedChannel };
