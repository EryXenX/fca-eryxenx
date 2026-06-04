"use strict";
const { getType } = require("../../../utils/format");
const { parseAndCheckLogin, saveCookies } = require("../../../utils/client");
const path = require("path");
const loginHelper = require("../../../../module/loginHelper");

function getConfig() {
  try {
    const configPath = path.join(process.cwd(), "fca-config.json");
    const fs = require("fs");
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, "utf8"));
    }
  } catch {}
  return {};
}

async function tryAutoLogin(logger, config, ctx, defaultFuncs) {
  const email = (config.credentials && config.credentials.email) || config.email;
  const password = (config.credentials && config.credentials.password) || config.password;
  const twofactor = (config.credentials && config.credentials.twofactor) || config.twofactor || null;

  if (config.autoLogin === false || !email || !password) return null;

  logger("getSeqID: attempting auto re-login via API...", "warn");

  try {
    const result = await loginHelper.tokensViaAPI(email, password, twofactor, config.apiServer || null);

    if (result && result.status) {
      const normalizeCookieHeaderString = loginHelper.normalizeCookieHeaderString;
      let cookiePairs = [];

      if (typeof result.cookies === "string") {
        cookiePairs = normalizeCookieHeaderString(result.cookies);
      } else if (Array.isArray(result.cookies)) {
        cookiePairs = result.cookies.map(c => {
          if (typeof c === "string") return c;
          if (c && typeof c === "object") return `${c.key || c.name}=${c.value}`;
          return null;
        }).filter(Boolean);
      }

      if (cookiePairs.length === 0 && result.cookie) {
        if (typeof result.cookie === "string") {
          cookiePairs = normalizeCookieHeaderString(result.cookie);
        } else if (Array.isArray(result.cookie)) {
          cookiePairs = result.cookie.map(c => {
            if (typeof c === "string") return c;
            if (c && typeof c === "object") return `${c.key || c.name}=${c.value}`;
            return null;
          }).filter(Boolean);
        }
      }

      if (cookiePairs.length > 0 || result.uid) {
        logger(`getSeqID: auto re-login successful! UID: ${result.uid}`, "info");

        if (ctx.jar && cookiePairs.length > 0) {
          const expires = new Date(Date.now() + 31536e6).toUTCString();
          for (const kv of cookiePairs) {
            const cookieStr = `${kv}; expires=${expires}; domain=.facebook.com; path=/;`;
            try {
              if (typeof ctx.jar.setCookieSync === "function") ctx.jar.setCookieSync(cookieStr, "https://www.facebook.com");
              else if (typeof ctx.jar.setCookie === "function") await ctx.jar.setCookie(cookieStr, "https://www.facebook.com");
            } catch (err) {
              logger(`getSeqID: cookie set error: ${err && err.message ? err.message : String(err)}`, "warn");
            }
          }
        }

        try {
          const { get } = require("../../../utils/request");
          const { saveCookies: saveWebCookies } = require("../../../utils/client");
          const expires = new Date(Date.now() + 31536e6).toUTCString();

          if (ctx.jar && cookiePairs.length > 0) {
            for (const kv of cookiePairs) {
              const cookieStr = `${kv}; expires=${expires}; domain=.facebook.com; path=/;`;
              try {
                const { jar: globalJar } = require("../../../utils/request");
                if (typeof globalJar.setCookieSync === "function") globalJar.setCookieSync(cookieStr, "https://www.facebook.com");
              } catch (_) {}
            }
          }

          const webResponse = await get("https://www.facebook.com/", ctx.jar, null, ctx.globalOptions, ctx);
          if (webResponse && webResponse.data) {
            await saveWebCookies(ctx.jar)(webResponse);
            ctx.loggedIn = true;
            if (result.uid) ctx.userID = result.uid;
          }
        } catch (refreshErr) {
          logger(`getSeqID: web session refresh failed: ${refreshErr && refreshErr.message ? refreshErr.message : String(refreshErr)}`, "warn");
        }

        return result;
      }
    }

    logger(`getSeqID: auto re-login failed - ${result && result.message ? result.message : "unknown error"}`, "error");
  } catch (loginErr) {
    logger(`getSeqID: auto re-login error - ${loginErr && loginErr.message ? loginErr.message : String(loginErr)}`, "error");
  }

  return null;
}

module.exports = function createGetSeqID(deps) {
  const { listenMqtt, logger, emitAuth } = deps;

  const MAX_RETRIES = 3;
  const RETRY_BASE_DELAY = 3000;

  return function getSeqID(defaultFuncs, api, ctx, globalCallback, form, retryCount) {
    retryCount = typeof retryCount === "number" ? retryCount : 0;
    ctx.t_mqttCalled = false;

    return defaultFuncs
      .post("https://www.facebook.com/api/graphqlbatch/", ctx.jar, form)
      .then(parseAndCheckLogin(ctx, defaultFuncs))
      .then(async resData => {
        if (getType(resData) !== "Array") {
          if (resData && typeof resData === "object") {
            const errorMsg = resData.error || resData.message || "";
            if (/Not logged in|login|blocked|401|403|checkpoint/i.test(errorMsg)) {
              throw { error: "Not logged in", originalResponse: resData };
            }
          }
          throw { error: "Not logged in", originalResponse: resData };
        }
        if (!Array.isArray(resData) || !resData.length) return;
        const lastRes = resData[resData.length - 1];
        if (lastRes && lastRes.successful_results === 0) return;

        const syncSeqId = resData[0] && resData[0].o0 && resData[0].o0.data &&
          resData[0].o0.data.viewer && resData[0].o0.data.viewer.message_threads &&
          resData[0].o0.data.viewer.message_threads.sync_sequence_id;

        if (syncSeqId) {
          ctx.lastSeqId = syncSeqId;
          // Reset reconnect counter on successful seqID fetch
          ctx._reconnectAttempts = 0;
          logger("mqtt getSeqID ok -> listenMqtt()", "info");
          listenMqtt(defaultFuncs, api, ctx, globalCallback);
        } else {
          throw { error: "getSeqId: no sync_sequence_id found." };
        }
      })
      .catch(async err => {
        const detail = (err && err.detail && err.detail.message) ? ` | detail=${err.detail.message}` : "";
        const msg = ((err && err.error) || (err && err.message) || String(err || "")) + detail;
        const isAuthError = /Not logged in|no sync_sequence_id found|blocked the login|401|403/i.test(msg);

        if (isAuthError) {
          if (retryCount < MAX_RETRIES) {
            const delay = RETRY_BASE_DELAY * (retryCount + 1);
            logger(`getSeqID: retry ${retryCount + 1}/${MAX_RETRIES} in ${delay}ms (${msg})`, "warn");
            await new Promise(resolve => setTimeout(resolve, delay));

            if (retryCount === 0 && ctx.loggedIn) {
              try {
                logger("getSeqID: refreshing session before retry...", "info");
                const { get } = require("../../../utils/request");
                await get("https://www.facebook.com/", ctx.jar, null, ctx.globalOptions, ctx)
                  .then(saveCookies(ctx.jar));
              } catch (refreshErr) {
                logger(`getSeqID: session refresh failed: ${refreshErr && refreshErr.message ? refreshErr.message : String(refreshErr)}`, "warn");
              }
            }

            return getSeqID(defaultFuncs, api, ctx, globalCallback, form, retryCount + 1);
          }

          logger("getSeqID: all retries failed, attempting auto re-login...", "warn");
          const config = getConfig();
          const loginResult = await tryAutoLogin(logger, config, ctx, defaultFuncs);

          if (loginResult) {
            logger("getSeqID: auto re-login done, retrying seqID...", "info");
            await new Promise(resolve => setTimeout(resolve, 3000));
            return getSeqID(defaultFuncs, api, ctx, globalCallback, form, 0);
          }

          if (/blocked/i.test(msg)) return emitAuth(ctx, api, globalCallback, "login_blocked", msg);
          return emitAuth(ctx, api, globalCallback, "not_logged_in", msg);
        }

        // Non-auth error — log but don't immediately kill the session
        logger(`getSeqID error (non-auth): ${msg}`, "error");

        // Retry non-auth errors too (network issue etc)
        if (retryCount < MAX_RETRIES) {
          const delay = RETRY_BASE_DELAY * (retryCount + 1);
          logger(`getSeqID: non-auth retry ${retryCount + 1}/${MAX_RETRIES} in ${delay}ms`, "warn");
          await new Promise(resolve => setTimeout(resolve, delay));
          return getSeqID(defaultFuncs, api, ctx, globalCallback, form, retryCount + 1);
        }

        return emitAuth(ctx, api, globalCallback, "auth_error", msg);
      });
  };
};
