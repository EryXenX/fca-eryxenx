"use strict";

const { generateOfflineThreadingID } = require("../../utils/format");
module.exports = function(defaultFuncs, api, ctx) {
  return function shareContact(text, senderID, threadID, callback) {
    if (!text) {
      text = "";
    }

    // Some callers (e.g. GoatBot's uid.js) pass a messageID string in the
    // 4th ("callback") slot to reply to, not an actual callback function.
    var replyToMessageId;
    if (typeof callback !== "function") {
      if (typeof callback === "string" || typeof callback === "number") {
        replyToMessageId = String(callback);
      }
      callback = undefined;
    }

    var resolveFunc = function() {};
    var rejectFunc = function() {};
    var returnPromise = new Promise(function(resolve, reject) {
      resolveFunc = resolve;
      rejectFunc = reject;
    });
    var cb = callback || function(err, data) {
      if (err) return rejectFunc(err);
      resolveFunc(data);
    };

    // E2EE threads don't accept this plaintext MQTT task, and there's no
    // native E2EE "contact card" message type in either engine — so degrade
    // gracefully to a plain text message with the contact info instead of
    // silently hanging forever.
    const isE2EEThread = ctx.threadTypes && ctx.threadTypes[String(threadID)] === 'dm' &&
      api.e2ee && typeof api.e2ee.isConnected === "function" && api.e2ee.isConnected();

    if (isE2EEThread) {
      const fallbackText = (text ? text + "\n" : "") + `👤 Contact ID: ${senderID}\n🔗 https://www.facebook.com/${senderID}`;
      return api.sendMessage(fallbackText, threadID, undefined, replyToMessageId)
        .then((result) => { cb(null, result); return result; })
        .catch((err) => { cb(err); throw err; });
    }

    let count_req = 0;
    var reqID = ++count_req;
    var form = JSON.stringify({
      app_id: "2220391788200892",
      payload: JSON.stringify({
        tasks: [
          {
            label: "359",
            payload: JSON.stringify({
              contact_id: senderID,
              sync_group: 1,
              text: text || "",
              thread_id: threadID
            }),
            queue_name: "messenger_contact_sharing",
            task_id: (Math.random() * 1001) << 0,
            failure_count: null
          }
        ],
        epoch_id: generateOfflineThreadingID(),
        version_id: "7214102258676893"
      }),
      request_id: reqID,
      type: 3
    });

    // Guard against a response that never arrives (network issue, server
    // silently drops the task, etc.) so callers awaiting this never hang.
    var settled = false;
    var timeout = setTimeout(function () {
      if (settled) return;
      settled = true;
      ctx.mqttClient.removeListener("message", handleResponse);
      cb(null, { success: true, note: "no server ack received (fire-and-forget)" });
    }, 8000);

    function handleResponse(topic, message) {
      if (topic !== "/ls_resp") return;
      let json;
      try {
        json = JSON.parse(message.toString());
      } catch (_) { return; }
      if (json.request_id !== reqID) return;
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ctx.mqttClient.removeListener("message", handleResponse);
      callback(null, { success: true });
    }
    ctx.mqttClient.on("message", handleResponse);
    ctx.mqttClient.publish("/ls_req", form);
    return returnPromise;
  };
};
