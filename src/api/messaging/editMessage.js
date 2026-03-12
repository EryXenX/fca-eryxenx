"use strict";

const { generateOfflineThreadingID } = require("../../utils/format");

module.exports = (defaultFuncs, api, ctx) => {
  return (text, messageID, callback) => {
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

    if (!ctx.mqttClient || !ctx.mqttClient.connected) {
      callback({ error: "Not connected to MQTT. Please try again later." });
      return returnPromise;
    }

    if (!messageID || !text) {
      callback({ error: "messageID and text are required." });
      return returnPromise;
    }

    let reqID = ++ctx.wsReqNumber;

    const content = {
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
          task_id: ++ctx.wsTaskNumber,
        }],
        version_id: "6903494529735864",
      }),
      request_id: reqID,
      type: 3
    };

    try {
      ctx.mqttClient.publish("/ls_req", JSON.stringify(content), { qos: 1, retain: false });
    } catch (err) {
      callback({ error: "Failed to send edit request: " + (err && err.message ? err.message : String(err)) });
      return returnPromise;
    }

    const timeout = setTimeout(() => {
      ctx.mqttClient.removeListener("message", handleRes);
      callback({ error: "editMessage timed out." });
    }, 15000);

    const handleRes = (topic, message) => {
      if (topic !== "/ls_resp") return;
      try {
        let jsonMsg = JSON.parse(message.toString());
        if (!jsonMsg.payload) return;
        jsonMsg.payload = JSON.parse(jsonMsg.payload);
        if (jsonMsg.request_id != reqID) return;

        clearTimeout(timeout);
        ctx.mqttClient.removeListener("message", handleRes);

        const step = jsonMsg.payload && jsonMsg.payload.step;
        if (!step || !step[1] || !step[1][2] || !step[1][2][2] || !step[1][2][2][1]) {
          return callback({ error: "Unexpected response from server." });
        }

        const msgID = step[1][2][2][1][2];
        const msgReplace = step[1][2][2][1][4];
        const bodies = { body: msgReplace, messageID: msgID };

        if (msgReplace != text) {
          return callback({ error: "The message is too old or not from you!" }, bodies);
        }
        return callback(undefined, bodies);
      } catch (err) {
        clearTimeout(timeout);
        ctx.mqttClient.removeListener("message", handleRes);
        callback({ error: "Failed to parse edit response: " + (err && err.message ? err.message : String(err)) });
      }
    };

    ctx.mqttClient.on("message", handleRes);
    return returnPromise;
  };
};
