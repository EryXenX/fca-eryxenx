"use strict";
const log = require("../../../func/logAdapter");
const { getType } = require("../../utils/format");
const { isReadableStream } = require("../../utils/constants");
const { generateOfflineThreadingID } = require("../../utils/format");

const SEND_TIMEOUT_MS = 20000;
const MAX_PENDING_LISTENERS = 50;

module.exports = function (defaultFuncs, api, ctx) {
  const uploadAttachment = require("./uploadAttachment")(defaultFuncs, api, ctx);
  const hasLinks = s => typeof s === "string" && /(https?:\/\/|www\.|t\.me\/|fb\.me\/|youtu\.be\/|facebook\.com\/|youtube\.com\/)/i.test(s);
  const emojiSizes = { small: 1, medium: 2, large: 3 };

  function extractIdsFromPayload(payload) {
    let messageID = null;
    let threadID = null;
    function walk(n) {
      if (Array.isArray(n)) {
        if (n[0] === 5 && (n[1] === "replaceOptimsiticMessage" || n[1] === "replaceOptimisticMessage")) {
          messageID = String(n[3]);
        }
        if (n[0] === 5 && n[1] === "writeCTAIdToThreadsTable") {
          const a = n[2];
          if (Array.isArray(a) && a[0] === 19) threadID = String(a[1]);
        }
        for (const x of n) walk(x);
      }
    }
    walk(payload && payload.step);
    return { threadID, messageID };
  }

  function publishWithAck(content, text, reqID, callback) {
    return new Promise((resolve, reject) => {
      if (!ctx.mqttClient || typeof ctx.mqttClient.on !== "function" || typeof ctx.mqttClient.publish !== "function") {
        const err = new Error("MQTT client is not initialized or disconnected");
        log.error("sendMessage", err.message);
        callback && callback(err);
        return reject(err);
      }

      if (!ctx.mqttClient.connected) {
        const err = new Error("MQTT client is not connected, message dropped");
        log.error("sendMessage", err.message);
        callback && callback(err);
        return reject(err);
      }

      // Prevent listener accumulation
      const currentListeners = ctx.mqttClient.listenerCount("message");
      if (currentListeners >= MAX_PENDING_LISTENERS) {
        const err = new Error(`Too many pending sendMessage listeners (${currentListeners}), possible hang`);
        log.error("sendMessage", err.message);
        callback && callback(err);
        return reject(err);
      }

      if (typeof ctx.mqttClient.setMaxListeners === "function") {
        ctx.mqttClient.setMaxListeners(0);
      }

      let done = false;
      let timeoutHandle = null;

      const cleanup = () => {
        if (done) return;
        done = true;
        if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
        ctx.mqttClient && ctx.mqttClient.removeListener("message", handleRes);
        ctx.mqttClient && ctx.mqttClient.removeListener("close", handleClose);
        ctx.mqttClient && ctx.mqttClient.removeListener("error", handleMqttErr);
      };

      const handleClose = () => {
        if (done) return;
        cleanup();
        const err = new Error("MQTT disconnected while waiting for ACK");
        callback && callback(err);
        reject(err);
      };

      const handleMqttErr = (mqttErr) => {
        if (done) return;
        cleanup();
        const err = new Error(`MQTT error while waiting for ACK: ${mqttErr && mqttErr.message ? mqttErr.message : String(mqttErr)}`);
        callback && callback(err);
        reject(err);
      };

      const handleRes = (topic, message) => {
        if (topic !== "/ls_resp") return;
        let jsonMsg;
        try {
          jsonMsg = JSON.parse(message.toString());
          jsonMsg.payload = JSON.parse(jsonMsg.payload);
        } catch {
          return;
        }
        if (jsonMsg.request_id !== reqID) return;
        const { threadID, messageID } = extractIdsFromPayload(jsonMsg.payload);
        const bodies = { body: text || null, messageID, threadID };
        cleanup();
        callback && callback(undefined, bodies);
        resolve(bodies);
      };

      ctx.mqttClient.on("message", handleRes);
      ctx.mqttClient.once("close", handleClose);
      ctx.mqttClient.once("error", handleMqttErr);

      ctx.mqttClient.publish("/ls_req", JSON.stringify(content), { qos: 1, retain: false }, err => {
        if (err) {
          cleanup();
          callback && callback(err);
          reject(err);
        }
      });

      timeoutHandle = setTimeout(() => {
        if (done) return;
        cleanup();
        const err = { error: "Timeout waiting for message ACK" };
        log.error("sendMessage", `reqID ${reqID} timed out after ${SEND_TIMEOUT_MS}ms`);
        callback && callback(err);
        reject(err);
      }, SEND_TIMEOUT_MS);
    });
  }

  function buildMentionData(msg, baseBody) {
    if (!msg.mentions || !Array.isArray(msg.mentions) || !msg.mentions.length) return null;
    const base = typeof baseBody === "string" ? baseBody : "";
    const ids = [], offsets = [], lengths = [], types = [];
    let cursor = 0;
    for (const m of msg.mentions) {
      const raw = String(m.tag || "");
      const name = raw.replace(/^@+/, "");
      const start = Number.isInteger(m.fromIndex) ? m.fromIndex : cursor;
      let idx = base.indexOf(raw, start);
      let adj = 0;
      if (idx === -1) { idx = base.indexOf(name, start); adj = 0; }
      else { adj = raw.length - name.length; }
      if (idx < 0) { idx = 0; adj = 0; }
      const off = idx + adj;
      ids.push(String(m.id || 0));
      offsets.push(off);
      lengths.push(name.length);
      types.push("p");
      cursor = off + name.length;
    }
    return {
      mention_ids: ids.join(","),
      mention_offsets: offsets.join(","),
      mention_lengths: lengths.join(","),
      mention_types: types.join(",")
    };
  }

  function coerceMsg(x) {
    if (x == null) return { body: "" };
    if (typeof x === "string") return { body: x };
    if (typeof x === "object") return x;
    return { body: String(x) };
  }

  return async function sendMessageMqtt(msg, threadID, callback, replyToMessage) {
    if (typeof threadID === "function") return threadID({ error: "Pass a threadID as a second argument." });
    if (typeof callback === "string" && !replyToMessage) {
      replyToMessage = callback;
      callback = () => {};
    }
    if (typeof callback !== "function") callback = () => {};
    if (!threadID) {
      const err = { error: "threadID is required" };
      callback(err);
      throw err;
    }

    // Check MQTT state before attempting send
    if (!ctx.mqttClient || !ctx.mqttClient.connected) {
      const err = { error: "MQTT not connected, cannot send message" };
      log.error("sendMessage", err.error);
      callback(err);
      return Promise.reject(err);
    }

    const m = coerceMsg(msg);
    const baseBody = m.body != null ? String(m.body) : "";
    const reqID = Math.floor(100 + Math.random() * 900);
    const epoch = (BigInt(Date.now()) << 22n).toString();

    const payload0 = {
      thread_id: String(threadID),
      otid: generateOfflineThreadingID(),
      source: 2097153,
      send_type: 1,
      sync_group: 1,
      mark_thread_read: 1,
      text: baseBody === "" ? null : baseBody,
      initiating_source: 0,
      skip_url_preview_gen: 1,
      text_has_links: hasLinks(baseBody) ? 1 : 0,
      multitab_env: 0,
      metadata_dataclass: JSON.stringify({ media_accessibility_metadata: { alt_text: null } })
    };

    const mentionData = buildMentionData(m, baseBody);
    if (mentionData) payload0.mention_data = mentionData;

    if (m.sticker) { payload0.send_type = 2; payload0.sticker_id = m.sticker; }

    if (m.emoji) {
      const size = !isNaN(m.emojiSize) ? Number(m.emojiSize) : emojiSizes[m.emojiSize || "small"] || 1;
      payload0.send_type = 1;
      payload0.text = m.emoji;
      payload0.hot_emoji_size = Math.min(3, Math.max(1, size));
    }

    if (m.location && m.location.latitude != null && m.location.longitude != null) {
      payload0.send_type = 1;
      payload0.location_data = {
        coordinates: { latitude: m.location.latitude, longitude: m.location.longitude },
        is_current_location: !!m.location.current,
        is_live_location: !!m.location.live
      };
    }

    if (replyToMessage) {
      payload0.reply_metadata = { reply_source_id: replyToMessage, reply_source_type: 1, reply_type: 0 };
    }

    if (m.attachment) {
      payload0.send_type = 3;
      if (payload0.text === "") payload0.text = null;
      payload0.attachment_fbids = [];
      let list = m.attachment;
      if (getType(list) !== "Array") list = [list];
      const idsFromPairs = [];
      const streams = [];
      for (const it of list) {
        if (Array.isArray(it) && typeof it[0] === "string") {
          idsFromPairs.push(String(it[1]));
        } else if (isReadableStream(it)) {
          streams.push(it);
        }
      }
      if (idsFromPairs.length) payload0.attachment_fbids.push(...idsFromPairs);
      if (streams.length) {
        try {
          const files = await uploadAttachment(streams);
          for (const file of files) {
            const id = file.video_id || file.image_id || file.audio_id || file.file_id || file.gif_id || file.fbid || file.id || file.upload_id;
            if (id) payload0.attachment_fbids.push(String(id));
          }
        } catch (err) {
          log.error("uploadAttachment", err);
          callback(err);
          throw err;
        }
      }
    }

    const content = {
      app_id: "2220391788200892",
      payload: {
        tasks: [
          {
            label: "46",
            payload: payload0,
            queue_name: String(threadID),
            task_id: 400,
            failure_count: null
          },
          {
            label: "21",
            payload: {
              thread_id: String(threadID),
              last_read_watermark_ts: Date.now(),
              sync_group: 1
            },
            queue_name: String(threadID),
            task_id: 401,
            failure_count: null
          }
        ],
        epoch_id: epoch,
        version_id: "24804310205905615",
        data_trace_id: "#" + Buffer.from(String(Math.random())).toString("base64").replace(/=+$/g, "")
      },
      request_id: reqID,
      type: 3
    };
    content.payload.tasks.forEach(t => (t.payload = JSON.stringify(t.payload)));
    content.payload = JSON.stringify(content.payload);
    return publishWithAck(content, baseBody, reqID, callback);
  };
};
