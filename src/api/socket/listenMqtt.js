"use strict";
const mqtt = require("mqtt");
const WebSocket = require("ws");
const HttpsProxyAgent = require("https-proxy-agent");
const EventEmitter = require("events");
const logger = require("../../../func/logger");
const { parseAndCheckLogin } = require("../../utils/client");
const { buildProxy, buildStream } = require("./detail/buildStream");
const { topics } = require("./detail/constants");
const createParseDelta = require("./core/parseDelta");
const createListenMqtt = require("./core/connectMqtt");
const createGetSeqID = require("./core/getSeqID");
const getTaskResponseData = require("./core/getTaskResponseData");
const createEmitAuth = require("./core/emitAuth");
const createMiddlewareSystem = require("./middleware");

const CYCLE_MS_DEFAULT = 60 * 60 * 1000;
const RECONNECT_DELAY_MS_DEFAULT = 5000;
const UNSUB_ALL_TIMEOUT_MS = 5000;

const parseDelta = createParseDelta({ parseAndCheckLogin });
const emitAuth = createEmitAuth({ logger });
const listenMqtt = createListenMqtt({ WebSocket, mqtt, HttpsProxyAgent, buildStream, buildProxy, topics, parseDelta, getTaskResponseData, logger, emitAuth });
const getSeqIDFactory = createGetSeqID({ parseAndCheckLogin, listenMqtt, logger, emitAuth });

const MQTT_DEFAULTS = { cycleMs: CYCLE_MS_DEFAULT, reconnectDelayMs: RECONNECT_DELAY_MS_DEFAULT, autoReconnect: true, reconnectAfterStop: false };

function mqttConf(ctx, overrides) {
  ctx._mqttOpt = Object.assign({}, MQTT_DEFAULTS, ctx._mqttOpt || {}, overrides || {});
  if (typeof ctx._mqttOpt.autoReconnect === "boolean") ctx.globalOptions.autoReconnect = ctx._mqttOpt.autoReconnect;
  return ctx._mqttOpt;
}

module.exports = function (defaultFuncs, api, ctx, opts) {
  const identity = function () { };
  let globalCallback = identity;

  if (!ctx._middleware) {
    ctx._middleware = createMiddlewareSystem();
  }
  const middleware = ctx._middleware;

  function installPostGuard() {
    if (ctx._postGuarded) return defaultFuncs.post;
    const rawPost = defaultFuncs.post && defaultFuncs.post.bind(defaultFuncs);
    if (!rawPost) return defaultFuncs.post;

    function postSafe(...args) {
      return rawPost(...args).catch(err => {
        const msg = (err && err.error) || (err && err.message) || String(err || "");
        if (/Not logged in|blocked the login/i.test(msg)) {
          emitAuth(ctx, api, globalCallback,
            /blocked/i.test(msg) ? "login_blocked" : "not_logged_in", msg);
        }
        throw err;
      });
    }
    defaultFuncs.post = postSafe;
    ctx._postGuarded = true;
    return postSafe;
  }

  let conf = mqttConf(ctx, opts);

  function getSeqIDWrapper() {
    if (ctx._ending && !ctx._cycling) {
      logger("mqtt getSeqID skipped - ending", "warn");
      return Promise.resolve();
    }
    const form = {
      av: ctx.globalOptions.pageID,
      queries: JSON.stringify({
        o0: {
          doc_id: "3336396659757871",
          query_params: {
            limit: 1, before: null, tags: ["INBOX", "PENDING", "OTHER"],
            includeDeliveryReceipts: false, includeSeqID: true
          }
        }
      })
    };
    logger("mqtt getSeqID call", "info");
    return getSeqIDFactory(defaultFuncs, api, ctx, globalCallback, form)
      .then(() => {
        logger("mqtt getSeqID done", "info");
        ctx._cycling = false;
        ctx._reconnectAttempts = 0;
      })
      .catch(e => {
        ctx._cycling = false;
        const errMsg = e && e.message ? e.message : String(e || "Unknown error");
        logger(`mqtt getSeqID error: ${errMsg}`, "error");
        if (ctx._ending && !ctx._cycling) return;
        if (ctx.globalOptions.autoReconnect) {
          const d = conf.reconnectDelayMs;
          logger(`mqtt getSeqID will retry in ${d}ms`, "warn");
          setTimeout(() => {
            if (!ctx._ending || ctx._cycling) getSeqIDWrapper();
          }, d);
        }
      });
  }

  function isConnected() {
    return !!(ctx.mqttClient && ctx.mqttClient.connected);
  }

  function unsubAll(cb) {
    if (!isConnected()) {
      if (cb) setTimeout(cb, 0);
      return;
    }
    let pending = topics.length;
    if (!pending) {
      if (cb) setTimeout(cb, 0);
      return;
    }
    let fired = false;
    const timeout = setTimeout(() => {
      if (!fired) {
        fired = true;
        logger("unsubAll timeout, proceeding anyway", "warn");
        if (cb) cb();
      }
    }, UNSUB_ALL_TIMEOUT_MS);

    topics.forEach(t => {
      try {
        ctx.mqttClient.unsubscribe(t, () => {
          if (--pending === 0 && !fired) {
            clearTimeout(timeout);
            fired = true;
            if (cb) cb();
          }
        });
      } catch (err) {
        logger(`unsubAll error for topic ${t}: ${err && err.message ? err.message : String(err)}`, "warn");
        if (--pending === 0 && !fired) {
          clearTimeout(timeout);
          fired = true;
          if (cb) cb();
        }
      }
    });
  }

  function fullReset() {
    try { if (ctx.mqttClient) ctx.mqttClient.removeAllListeners(); } catch (_) {}
    ctx.mqttClient = undefined;
    ctx.lastSeqId = null;
    ctx.syncToken = undefined;
    ctx.t_mqttCalled = false;
    ctx._ending = false;
    ctx._cycling = false;
    ctx._reconnectAttempts = 0;

    if (ctx._reconnectTimer) { clearTimeout(ctx._reconnectTimer); ctx._reconnectTimer = null; }
    if (ctx._rTimeout) { clearTimeout(ctx._rTimeout); ctx._rTimeout = null; }

    if (ctx.tasks && ctx.tasks instanceof Map) ctx.tasks.clear();

    if (ctx._userInfoIntervals && Array.isArray(ctx._userInfoIntervals)) {
      ctx._userInfoIntervals.forEach(iv => { try { clearInterval(iv); } catch (_) {} });
      ctx._userInfoIntervals = [];
    }
    if (ctx._autoSaveInterval && Array.isArray(ctx._autoSaveInterval)) {
      ctx._autoSaveInterval.forEach(iv => { try { clearInterval(iv); } catch (_) {} });
      ctx._autoSaveInterval = [];
    }
    if (ctx._scheduler && typeof ctx._scheduler.destroy === "function") {
      try { ctx._scheduler.destroy(); } catch (_) {}
      ctx._scheduler = undefined;
    }
  }

  function endQuietly(next) {
    const finish = () => {
      fullReset();
      next && next();
    };
    try {
      if (ctx.mqttClient) {
        if (isConnected()) {
          try { ctx.mqttClient.publish("/browser_close", "{}", { qos: 0 }); } catch (_) {}
        }
        ctx.mqttClient.end(true, finish);
      } else finish();
    } catch (_) { finish(); }
  }

  function delayedReconnect() {
    const d = conf.reconnectDelayMs;
    logger(`mqtt reconnect in ${d}ms`, "info");
    setTimeout(() => getSeqIDWrapper(), d);
  }

  function forceCycle() {
    if (ctx._cycling) {
      logger("mqtt force cycle already in progress", "warn");
      return;
    }
    ctx._cycling = true;
    ctx._ending = true;
    logger("mqtt force cycle begin", "warn");
    unsubAll(() => endQuietly(() => delayedReconnect()));
  }

  return function (callback) {
    class MessageEmitter extends EventEmitter {
      stopListening(callback2) {
        const cb = callback2 || function () { };
        logger("mqtt stop requested", "info");
        globalCallback = identity;

        if (ctx._autoCycleTimer) {
          clearInterval(ctx._autoCycleTimer);
          ctx._autoCycleTimer = null;
          logger("mqtt auto-cycle cleared", "info");
        }
        if (ctx._reconnectTimer) { clearTimeout(ctx._reconnectTimer); ctx._reconnectTimer = null; }

        ctx._ending = true;
        unsubAll(() => endQuietly(() => {
          logger("mqtt stopped", "info");
          cb();
          conf = mqttConf(ctx, conf);
          if (conf.reconnectAfterStop) delayedReconnect();
        }));
      }
      async stopListeningAsync() {
        return new Promise(resolve => { this.stopListening(resolve); });
      }
    }

    const msgEmitter = new MessageEmitter();

    const originalCallback = callback || function (error, message) {
      if (error) { logger("mqtt emit error", "error"); return msgEmitter.emit("error", error); }
      msgEmitter.emit("message", message);
    };

    if (middleware.count > 0) {
      globalCallback = middleware.wrapCallback(originalCallback);
    } else {
      globalCallback = originalCallback;
    }

    conf = mqttConf(ctx, conf);
    installPostGuard();

    // Full reset before starting to prevent stale state
    if (ctx._ending && !ctx._cycling) {
      logger("mqtt listenMqtt: clearing stale _ending state before start", "warn");
      ctx._ending = false;
    }

    if (!ctx.firstListen) ctx.lastSeqId = null;
    ctx.syncToken = undefined;
    ctx.t_mqttCalled = false;

    if (ctx._autoCycleTimer) { clearInterval(ctx._autoCycleTimer); ctx._autoCycleTimer = null; }
    if (conf.cycleMs && conf.cycleMs > 0) {
      ctx._autoCycleTimer = setInterval(forceCycle, conf.cycleMs);
      logger(`mqtt auto-cycle enabled ${conf.cycleMs}ms`, "info");
    } else {
      logger("mqtt auto-cycle disabled", "info");
    }

    if (!ctx.firstListen || !ctx.lastSeqId) getSeqIDWrapper();
    else {
      logger("mqtt starting listenMqtt", "info");
      listenMqtt(defaultFuncs, api, ctx, globalCallback);
    }

    api.stopListening = msgEmitter.stopListening.bind(msgEmitter);
    api.stopListeningAsync = msgEmitter.stopListeningAsync.bind(msgEmitter);

    let currentOriginalCallback = originalCallback;
    let currentGlobalCallback = globalCallback;

    function rewrapCallbackIfNeeded() {
      if (!ctx.mqttClient || (ctx._ending && !ctx._cycling)) return;
      const hasMiddleware = middleware.count > 0;
      const isWrapped = currentGlobalCallback !== currentOriginalCallback;
      if (hasMiddleware && !isWrapped) {
        currentGlobalCallback = middleware.wrapCallback(currentOriginalCallback);
        globalCallback = currentGlobalCallback;
        logger("Middleware added - callback re-wrapped", "info");
      } else if (!hasMiddleware && isWrapped) {
        currentGlobalCallback = currentOriginalCallback;
        globalCallback = currentGlobalCallback;
        logger("All middleware removed - callback unwrapped", "info");
      }
    }

    api.useMiddleware = function (middlewareFn, fn) {
      const result = middleware.use(middlewareFn, fn);
      rewrapCallbackIfNeeded();
      return result;
    };
    api.removeMiddleware = function (identifier) {
      const result = middleware.remove(identifier);
      rewrapCallbackIfNeeded();
      return result;
    };
    api.clearMiddleware = function () {
      const result = middleware.clear();
      rewrapCallbackIfNeeded();
      return result;
    };
    api.listMiddleware = function () { return middleware.list(); };
    api.setMiddlewareEnabled = function (name, enabled) {
      const result = middleware.setEnabled(name, enabled);
      rewrapCallbackIfNeeded();
      return result;
    };

    const existingMiddlewareCount = Object.getOwnPropertyDescriptor(api, "middlewareCount");
    if (!existingMiddlewareCount) {
      Object.defineProperty(api, "middlewareCount", {
        configurable: true, enumerable: false,
        get: function () { return (ctx._middleware && ctx._middleware.count) || 0; }
      });
    } else if (existingMiddlewareCount.configurable) {
      Object.defineProperty(api, "middlewareCount", {
        configurable: true, enumerable: existingMiddlewareCount.enumerable,
        get: function () { return (ctx._middleware && ctx._middleware.count) || 0; }
      });
    }

    return msgEmitter;
  };
};
