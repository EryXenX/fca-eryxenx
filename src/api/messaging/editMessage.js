"use strict";

const generateOfflineThreadingId = require('../utils');

module.exports = function (defaultFuncs, api, ctx) {
  return function editMessage(text, messageID, callback) {
    let resolveFunc = () => {};
    let rejectFunc = () => {};
    const returnPromise = new Promise((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    if (!callback) {
      callback = (err, data) => {
        if (err) return rejectFunc(err);
        resolveFunc(data);
      };
    }

    if (!ctx.mqttClient) {
      callback({ error: "Not connected to MQTT" });
      return returnPromise;
    }

    if (!messageID || !text) {
      callback({ error: "messageID and text are required." });
      return returnPromise;
    }

    ctx.wsReqNumber += 1;
    ctx.wsTaskNumber += 1;

    const reqID = ctx.wsReqNumber;

    const context = {
      app_id: "2220391788200892",
      payload: JSON.stringify({
        data_trace_id: null,
        epoch_id: parseInt(generateOfflineThreadingId()),
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
      request_id: reqID,
      type: 3
    };

    ctx.mqttClient.publish("/ls_req", JSON.stringify(context), { qos: 1, retain: false });

    const timeout = setTimeout(() => {
      ctx.mqttClient.removeListener("message", handleRes);
      resolveFunc({ messageID, body: text });
    }, 5000);

    const handleRes = (topic, message) => {
      if (topic !== "/ls_resp") return;
      try {
        let jsonMsg = JSON.parse(message.toString());
        if (!jsonMsg.payload) return;
        jsonMsg.payload = JSON.parse(jsonMsg.payload);
        if (jsonMsg.request_id != reqID) return;

        clearTimeout(timeout);
        ctx.mqttClient.removeListener("message", handleRes);

        callback(undefined, { messageID, body: text });
      } catch (e) {
        clearTimeout(timeout);
        ctx.mqttClient.removeListener("message", handleRes);
        callback(undefined, { messageID, body: text });
      }
    };

    ctx.mqttClient.on("message", handleRes);
    return returnPromise;
  };
};
