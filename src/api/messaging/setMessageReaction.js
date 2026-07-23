"use strict";

const logger = require("../../../func/logger");
const { generateOfflineThreadingID, getCurrentTimestamp } = require("../../utils/format");

module.exports = function (defaultFuncs, api, ctx) {
  return function setMessageReaction(reaction, messageID, threadID, callback, forceCustomReaction) {
    // ✅ EryXenX Fix: threadID is now optional (backward compatible)
    if (typeof threadID === "function") {
      forceCustomReaction = callback;
      callback = threadID;
      threadID = null;
    } else if (typeof threadID === "boolean") {
      forceCustomReaction = threadID;
      callback = undefined;
      threadID = null;
    } else if (typeof callback === "boolean") {
      forceCustomReaction = callback;
      callback = undefined;
    }
    const cb = typeof callback === "function" ? callback : undefined;

    // threadID না থাকলে e2ee bridge এর ম্যাপ থেকে বের করার চেষ্টা, তারপর ctx fallback
    const resolvedThreadID = threadID ||
      (api.e2ee && typeof api.e2ee.getThreadIdForMessage === "function" ? api.e2ee.getThreadIdForMessage(messageID) : null);
    const finalThreadID = resolvedThreadID || ctx.lastThreadID || "0";

    const isE2EEThread = ctx.threadTypes && ctx.threadTypes[String(finalThreadID)] === 'dm' &&
      api.e2ee && typeof api.e2ee.isConnected === "function" && api.e2ee.isConnected();

    console.log(`[E2EE-DEBUG] setMessageReaction: messageID=${messageID}, threadID param=${threadID}, resolvedThreadID=${resolvedThreadID}, finalThreadID=${finalThreadID}, threadType=${ctx.threadTypes ? ctx.threadTypes[String(finalThreadID)] : "n/a"}, e2eeConnected=${api.e2ee && typeof api.e2ee.isConnected === "function" ? api.e2ee.isConnected() : "n/a"}, isE2EEThread=${isE2EEThread}`);

    if (isE2EEThread) {
      return api.e2ee.sendReaction(String(finalThreadID), messageID, reaction)
        .then((result) => { if (cb) cb(null, result); return result; })
        .catch((err) => { if (cb) cb(err); throw err; });
    }

    return new Promise((resolve, reject) => {
      if (!ctx.mqttClient) {
        const err = new Error("MQTT client not connected");
        if (cb) cb(err);
        return reject(err);
      }
      if (reaction === undefined || reaction === null || !messageID) {
        const err = new Error("Missing required parameters (reaction, messageID)");
        if (cb) cb(err);
        return reject(err);
      }
      if (typeof ctx.wsReqNumber !== "number") ctx.wsReqNumber = 0;
      if (typeof ctx.wsTaskNumber !== "number") ctx.wsTaskNumber = 0;
      const reqID = ++ctx.wsReqNumber;
      const taskID = ++ctx.wsTaskNumber;
      const taskPayload = {
        thread_key: finalThreadID,
        timestamp_ms: getCurrentTimestamp(),
        message_id: messageID,
        reaction: reaction,
        actor_id: ctx.userID,
        reaction_style: forceCustomReaction ? 1 : null,
        sync_group: 1,
        send_attribution: 65537,
        dataclass_params: null,
        attachment_fbid: null
      };
      const task = {
        failure_count: null,
        label: "29",
        payload: JSON.stringify(taskPayload),
        queue_name: "reaction:" + messageID,
        task_id: taskID,
      };
      const mqttForm = {
        app_id: "2220391788200892",
        payload: JSON.stringify({
          epoch_id: parseInt(generateOfflineThreadingID()),
          tasks: [task],
          version_id: "24585299697835063"
        }),
        request_id: reqID,
        type: 3
      };
      const handleResponse = (topic, message) => {
        if (topic !== "/ls_resp") return;
        let json;
        try {
          json = JSON.parse(message.toString());
          json.payload = JSON.parse(json.payload);
        } catch {
          return;
        }
        if (json.request_id !== reqID) return;
        ctx.mqttClient.removeListener("message", handleResponse);
        if (cb) cb(null, { success: true });
        return resolve({ success: true });
      };
      ctx.mqttClient.on("message", handleResponse);
      ctx.mqttClient.publish("/ls_req", JSON.stringify(mqttForm), { qos: 1, retain: false }, (err) => {
        if (err) {
          ctx.mqttClient.removeListener("message", handleResponse);
          logger("setMessageReaction" + err, "error");
          if (cb) cb(err);
          return reject(err);
        }
      });
    });
  };
};
