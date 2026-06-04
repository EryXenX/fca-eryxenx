"use strict";
const { formatID } = require("../../../utils/format");

const DEFAULT_RECONNECT_DELAY_MS = 5000;
const T_MS_WAIT_TIMEOUT_MS = 10000;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BACKOFF_MAX = 60000;

module.exports = function createListenMqtt(deps) {
  const { WebSocket, mqtt, HttpsProxyAgent, buildStream, buildProxy,
    topics, parseDelta, getTaskResponseData, logger, emitAuth
  } = deps;

  return function listenMqtt(defaultFuncs, api, ctx, globalCallback) {

    // Reset stuck _ending state if not actually ending
    if (ctx._ending && !ctx._cycling) {
      logger("mqtt connectMqtt: resetting stale _ending flag", "warn");
      ctx._ending = false;
    }

    // Track reconnect attempts for backoff
    if (typeof ctx._reconnectAttempts !== "number") ctx._reconnectAttempts = 0;

    function getBackoffDelay() {
      const base = (ctx._mqttOpt && ctx._mqttOpt.reconnectDelayMs) || DEFAULT_RECONNECT_DELAY_MS;
      const attempts = ctx._reconnectAttempts || 0;
      const backoff = Math.min(base * Math.pow(1.5, attempts), RECONNECT_BACKOFF_MAX);
      return Math.floor(backoff + Math.random() * 1000);
    }

    function scheduleReconnect(delayMs) {
      if (ctx._reconnectTimer) {
        logger("mqtt reconnect already scheduled", "warn");
        return;
      }
      if (ctx._ending && !ctx._cycling) {
        logger("mqtt reconnect skipped - ending", "warn");
        return;
      }
      if ((ctx._reconnectAttempts || 0) >= MAX_RECONNECT_ATTEMPTS) {
        logger(`mqtt max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached, emitting auth error`, "error");
        ctx._reconnectAttempts = 0;
        return emitAuth(ctx, api, globalCallback, "auth_error", "Max reconnect attempts reached");
      }
      const ms = typeof delayMs === "number" ? delayMs : getBackoffDelay();
      logger(`mqtt will reconnect in ${ms}ms (attempt ${(ctx._reconnectAttempts || 0) + 1}/${MAX_RECONNECT_ATTEMPTS})`, "warn");
      ctx._reconnectTimer = setTimeout(() => {
        ctx._reconnectTimer = null;
        if (!ctx._ending || ctx._cycling) {
          ctx._reconnectAttempts = (ctx._reconnectAttempts || 0) + 1;
          listenMqtt(defaultFuncs, api, ctx, globalCallback);
        }
      }, ms);
    }

    const chatOn = ctx.globalOptions.online;
    const sessionID = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER) + 1;
    const username = {
      u: ctx.userID, s: sessionID, chat_on: chatOn, fg: false, d: ctx.clientId,
      ct: "websocket", aid: 219994525426954, aids: null, mqtt_sid: "",
      cp: 3, ecp: 10, st: [], pm: [], dc: "", no_auto_fg: true, gas: null, pack: [], p: null, php_override: ""
    };

    const cookies = api.getCookies();
    let host;
    if (ctx.mqttEndpoint) host = `${ctx.mqttEndpoint}&sid=${sessionID}&cid=${ctx.clientId}`;
    else if (ctx.region) host = `wss://edge-chat.facebook.com/chat?region=${ctx.region.toLowerCase()}&sid=${sessionID}&cid=${ctx.clientId}`;
    else host = `wss://edge-chat.facebook.com/chat?sid=${sessionID}&cid=${ctx.clientId}`;

    const options = {
      clientId: "mqttwsclient",
      protocolId: "MQIsdp",
      protocolVersion: 3,
      username: JSON.stringify(username),
      clean: true,
      wsOptions: {
        headers: {
          Cookie: cookies,
          Origin: "https://www.facebook.com",
          "User-Agent": ctx.globalOptions.userAgent || "Mozilla/5.0",
          Referer: "https://www.facebook.com/",
          Host: "edge-chat.facebook.com",
          Connection: "Upgrade",
          Pragma: "no-cache",
          "Cache-Control": "no-cache",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Accept-Encoding": "gzip, deflate, br",
          "Accept-Language": "vi,en;q=0.9",
          "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits"
        },
        origin: "https://www.facebook.com",
        protocolVersion: 13,
        binaryType: "arraybuffer"
      },
      keepalive: 60,
      reschedulePings: true,
      reconnectPeriod: 0,
      connectTimeout: 10000
    };

    if (ctx.globalOptions.proxy !== undefined) {
      const agent = new HttpsProxyAgent(ctx.globalOptions.proxy);
      options.wsOptions.agent = agent;
    }

    // Destroy previous client cleanly before creating new one
    if (ctx.mqttClient) {
      try {
        ctx.mqttClient.removeAllListeners();
        if (ctx.mqttClient.connected) ctx.mqttClient.end(true);
      } catch (_) {}
      ctx.mqttClient = undefined;
    }

    ctx.mqttClient = new mqtt.Client(
      () => buildStream(options, new WebSocket(host, options.wsOptions), buildProxy()),
      options
    );
    const mqttClient = ctx.mqttClient;

    mqttClient.on("error", function (err) {
      const msg = String(err && err.message ? err.message : err || "");
      if ((ctx._ending || ctx._cycling) && /No subscription existed|client disconnecting/i.test(msg)) {
        logger(`mqtt expected during shutdown: ${msg}`, "info");
        return;
      }
      if (/Not logged in|blocked the login|401|403/i.test(msg)) {
        try { if (mqttClient && mqttClient.connected) mqttClient.end(true); } catch (_) {}
        return emitAuth(ctx, api, globalCallback,
          /blocked/i.test(msg) ? "login_blocked" : "not_logged_in", msg);
      }
      logger(`mqtt error: ${msg}`, "error");
      try { if (mqttClient && mqttClient.connected) mqttClient.end(true); } catch (_) {}
      if (ctx._ending || ctx._cycling) return;
      if (ctx.globalOptions.autoReconnect && !ctx._ending) {
        scheduleReconnect();
      } else {
        globalCallback({ type: "stop_listen", error: msg || "Connection refused" }, null);
      }
    });

    mqttClient.on("connect", function () {
      if (process.env.OnStatus === undefined) {
        logger("fca-unofficial", "info");
        process.env.OnStatus = true;
      }
      ctx._cycling = false;
      // Reset reconnect counter on successful connect
      ctx._reconnectAttempts = 0;

      topics.forEach(t => mqttClient.subscribe(t));

      const queue = {
        sync_api_version: 11, max_deltas_able_to_process: 100, delta_batch_size: 500,
        encoding: "JSON", entity_fbid: ctx.userID, initial_titan_sequence_id: ctx.lastSeqId, device_params: null
      };
      const topic = ctx.syncToken ? "/messenger_sync_get_diffs" : "/messenger_sync_create_queue";
      if (ctx.syncToken) { queue.last_seq_id = ctx.lastSeqId; queue.sync_token = ctx.syncToken; }
      mqttClient.publish(topic, JSON.stringify(queue), { qos: 1, retain: false });
      mqttClient.publish("/foreground_state", JSON.stringify({ foreground: chatOn }), { qos: 1 });
      mqttClient.publish("/set_client_settings", JSON.stringify({ make_user_available_when_in_foreground: true }), { qos: 1 });

      let rTimeout = setTimeout(function () {
        rTimeout = null;
        ctx._rTimeout = null;
        if (ctx._ending) {
          logger("mqtt t_ms timeout skipped - ending", "warn");
          return;
        }
        logger("mqtt t_ms timeout, cycling", "warn");
        try { if (mqttClient && mqttClient.connected) mqttClient.end(true); } catch (_) {}
        scheduleReconnect();
      }, T_MS_WAIT_TIMEOUT_MS);

      ctx._rTimeout = rTimeout;

      ctx.tmsWait = function () {
        if (rTimeout) { clearTimeout(rTimeout); rTimeout = null; }
        if (ctx._rTimeout) { clearTimeout(ctx._rTimeout); ctx._rTimeout = null; }
        if (ctx.globalOptions.emitReady) globalCallback({ type: "ready", error: null });
        delete ctx.tmsWait;
      };
    });

    mqttClient.on("message", function (topic, message) {
      if (ctx._ending && !ctx._cycling) return;
      try {
        let jsonMessage = Buffer.isBuffer(message) ? Buffer.from(message).toString() : message;
        try {
          jsonMessage = JSON.parse(jsonMessage);
        } catch (parseErr) {
          logger(`mqtt message parse error for topic ${topic}: ${parseErr && parseErr.message ? parseErr.message : String(parseErr)}`, "warn");
          jsonMessage = {};
        }

        if (jsonMessage.type === "jewel_requests_add") {
          globalCallback(null, { type: "friend_request_received", actorFbId: jsonMessage.from.toString(), timestamp: Date.now().toString() });
        } else if (jsonMessage.type === "jewel_requests_remove_old") {
          globalCallback(null, { type: "friend_request_cancel", actorFbId: jsonMessage.from.toString(), timestamp: Date.now().toString() });
        } else if (topic === "/t_ms") {
          if (ctx.tmsWait && typeof ctx.tmsWait == "function") ctx.tmsWait();
          if (jsonMessage.firstDeltaSeqId && jsonMessage.syncToken) {
            ctx.lastSeqId = jsonMessage.firstDeltaSeqId;
            ctx.syncToken = jsonMessage.syncToken;
          }
          if (jsonMessage.lastIssuedSeqId) ctx.lastSeqId = parseInt(jsonMessage.lastIssuedSeqId);
          for (const dlt of (jsonMessage.deltas || [])) {
            parseDelta(defaultFuncs, api, ctx, globalCallback, { delta: dlt });
          }
        } else if (topic === "/thread_typing" || topic === "/orca_typing_notifications") {
          const typ = {
            type: "typ",
            isTyping: !!jsonMessage.state,
            from: jsonMessage.sender_fbid.toString(),
            threadID: formatID((jsonMessage.thread || jsonMessage.sender_fbid).toString())
          };
          globalCallback(null, typ);
        } else if (topic === "/orca_presence") {
          if (!ctx.globalOptions.updatePresence) {
            for (const data of (jsonMessage.list || [])) {
              const presence = { type: "presence", userID: String(data.u), timestamp: data.l * 1000, statuses: data.p };
              globalCallback(null, presence);
            }
          }
        } else if (topic === "/ls_resp") {
          try {
            const parsedPayload = JSON.parse(jsonMessage.payload);
            const reqID = jsonMessage.request_id;
            const tasks = ctx.tasks;
            if (tasks && tasks instanceof Map && tasks.has(reqID)) {
              const taskData = tasks.get(reqID);
              const { type: taskType, callback: taskCallback } = taskData;
              const taskRespData = getTaskResponseData(taskType, parsedPayload);
              if (taskRespData == null) taskCallback("error", null);
              else taskCallback(null, Object.assign({ type: taskType, reqID }, taskRespData));
              tasks.delete(reqID);
            }
          } catch (lsErr) {
            logger(`mqtt /ls_resp parse error: ${lsErr && lsErr.message ? lsErr.message : String(lsErr)}`, "warn");
          }
        }
      } catch (ex) {
        const errMsg = ex && ex.message ? ex.message : String(ex || "Unknown error");
        logger(`mqtt message handler error: ${errMsg}`, "error");
      }
    });

    mqttClient.on("close", function () {
      if (ctx._ending || ctx._cycling) {
        logger("mqtt close expected", "info");
        return;
      }
      logger("mqtt connection closed unexpectedly, scheduling reconnect", "warn");
      if (ctx.globalOptions.autoReconnect) scheduleReconnect();
    });

    mqttClient.on("disconnect", () => {
      if (ctx._ending || ctx._cycling) {
        logger("mqtt disconnect expected", "info");
        return;
      }
      logger("mqtt disconnected unexpectedly", "warn");
    });

    mqttClient.on("offline", () => {
      if (ctx._ending || ctx._cycling) return;
      logger("mqtt went offline", "warn");
    });
  };
};
