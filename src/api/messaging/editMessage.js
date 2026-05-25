"use strict";

const { generateOfflineThreadingID } = require('../utils/format');

module.exports = function (defaultFuncs, api, ctx) {
  return function editMessage(text, messageID, callback) {
    if (!ctx.mqttClient) {
      if (typeof callback === "function") callback({ error: "Not connected to MQTT" });
      return Promise.reject(new Error("Not connected to MQTT"));
    }

    if (!messageID || !text) {
      if (typeof callback === "function") callback({ error: "messageID and text are required." });
      return Promise.reject(new Error("messageID and text are required."));
    }

    ctx.wsReqNumber += 1;
    ctx.wsTaskNumber += 1;

    const context = {
      app_id: "2220391788200892",
      payload: JSON.stringify({
        data_trace_id: null,
        epoch_id: parseInt(generateOfflineThreadingID()),
        tasks: [{
          failure_count: null,
          label: "742",
          payload: JSON.stringify({
            message_id: messageID,
            text: text,
          }),
          queue_name: "edit_message",
          task_id: ctx.wsTaskNumber,
        }],
        version_id: "6903494529735864",
      }),
      request_id: ctx.wsReqNumber,
      type: 3
    };

    ctx.mqttClient.publish("/ls_req", JSON.stringify(context), { qos: 1, retain: false });

    if (typeof callback === "function") callback(null, { messageID, body: text });
    return Promise.resolve({ messageID, body: text });
  };
};
