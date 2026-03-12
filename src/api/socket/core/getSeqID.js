"use strict";
/**
 * Fetches MQTT sync sequence ID from GraphQL and starts listenMqtt.
 * Handles retries and auto re-login via fca-config.json when session expires.
 */
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
  } catch { }
  return {};
}

// Parse cookie string to array format
function parseCookieString(cookieStr) {
  if (!cookieStr || typeof cookieStr !== "string") return [];
  const cookies = [];
  const pairs = cookieStr.split(";").map(p => p.trim()).filter(Boolean);
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq > 0) {
      const key = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (key && value) {
        cookies.push({
          key,
          value,
          domain: ".facebook.com",
          path: "/"
        });
      }
    }
  }
  return cookies;
}

// Try to auto-login using API and refresh web session
async function tryAutoLogin(logger, config, ctx, defaultFuncs) {
  const email = config.credentials?.email || config.email;
  const password = config.credentials?.password || config.password;
  const twofactor = config.credentials?.twofactor || config.twofactor || null;

  if (config.autoLogin === false || !email || !password) {
    return null;
  }

  logger("getSeqID: attempting auto re-login via API...", "warn");

  try {
    const result = await loginHelper.tokensViaAPI(
      email,
      password,
      twofactor,
      config.apiServer || null
    );

    if (result && result.status) {
      const normalizeCookieHeaderString = loginHelper.normalizeCookieHeaderString;
      let cookiePairs = [];

      if (typeof result.cookies === "string") {
        cookiePairs = normalizeCookieHeaderString(result.cookies);
      } 
      // If cookies is an array, convert to pairs
      else if (Array.isArray(result.cookies)) {
        cookiePairs = result.cookies.map(c => {
          if (typeof c === "string") {
            // Already in "key=value" format
            return c;
          } else if (c && typeof c === "object") {
            // Object format {key, value} or {name, value}
            return `${c.key || c.name}=${c.value}`;
          }
          return null;
        }).filter(Boolean);
      }
      
      // Also check for cookie field (alternative field name)
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
        logger(`getSeqID: auto re-login successful! UID: ${result.uid}, Cookies: ${cookiePairs.length}`, "info");

        // Apply cookies to ctx.jar using setJarFromPairs approach
        if (ctx.jar && cookiePairs.length > 0) {
          const expires = new Date(Date.now() + 31536e6).toUTCString();
          for (const kv of cookiePairs) {
            const cookieStr = `${kv}; expires=${expires}; domain=.facebook.com; path=/;`;
            try {
              if (typeof ctx.jar.setCookieSync === "function") {
                ctx.jar.setCookieSync(cookieStr, "https://www.facebook.com");
              } else if (typeof ctx.jar.setCookie === "function") {
                await ctx.jar.setCookie(cookieStr, "https://www.facebook.com");
              }
            } catch (err) {
              logger(`getSeqID: Failed to set cookie ${kv.substring(0, 50)}: ${err && err.message ? err.message : String(err)}`, "warn");
            }
          }
          logger(`getSeqID: applied ${cookiePairs.length} API cookies to jar`, "info");
        }

        // Now refresh web session to get proper web cookies
        logger("getSeqID: refreshing web session after API login...", "info");
        try {
          const { get, jar: globalJar } = require("../../../utils/request");
          const { saveCookies: saveWebCookies } = require("../../../utils/client");

          // Apply cookies to global jar as well using cookie pairs
          const expires = new Date(Date.now() + 31536e6).toUTCString();
          for (const kv of cookiePairs) {
            const cookieStr = `${kv}; expires=${expires}; domain=.facebook.com; path=/;`;
            try {
              if (typeof globalJar.setCookieSync === "function") {
                globalJar.setCookieSync(cookieStr, "https://www.facebook.com");
              } else if (typeof globalJar.setCookie === "function") {
                await globalJar.setCookie(cookieStr, "https://www.facebook.com");
              }
            } catch (err) {
              logger(`getSeqID: Failed to set cookie in global jar ${kv.substring(0, 50)}: ${err && err.message ? err.message : String(err)}`, "warn");
            }
          }

          // Fetch Facebook to refresh and get web session cookies
          // Do this multiple times to ensure session is fully established
          // Try both m.facebook.com and www.facebook.com
          let webResponse = null;
          let htmlContent = "";
          const htmlUID = body => {
            const s = typeof body === "string" ? body : String(body ?? "");
            return s.match(/"USER_ID"\s*:\s*"(\d+)"/)?.[1] || s.match(/\["CurrentUserInitialData",\[\],\{.*?"USER_ID":"(\d+)".*?\},\d+\]/)?.[1];
          };
          const isValidUID = uid => uid && uid !== "0" && /^\d+$/.test(uid) && parseInt(uid, 10) > 0;
          const urlsToTry = ["https://m.facebook.com/", "https://www.facebook.com/"];

          // Try refreshing up to 3 times to get valid session
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              // Try m.facebook.com first (mobile version often works better for API login)
              const urlToUse = attempt === 0 ? urlsToTry[0] : urlsToTry[attempt % urlsToTry.length];
              logger(`getSeqID: Refreshing ${urlToUse} (attempt ${attempt + 1}/3)...`, "info");
              
              webResponse = await get(urlToUse, ctx.jar, null, ctx.globalOptions, ctx);
              if (webResponse && webResponse.data) {
                await saveWebCookies(ctx.jar)(webResponse);
                htmlContent = typeof webResponse.data === "string" ? webResponse.data : String(webResponse.data || "");
                
                // Check if HTML contains valid USER_ID
                const htmlUserID = htmlUID(htmlContent);
                if (isValidUID(htmlUserID)) {
                  logger(`getSeqID: Found valid USER_ID in HTML from ${urlToUse}: ${htmlUserID}`, "info");
                  break;
                } else if (attempt < 2) {
                  logger(`getSeqID: No valid USER_ID in HTML from ${urlToUse} (attempt ${attempt + 1}/3), retrying...`, "warn");
                  await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
                }
              }
            } catch (refreshErr) {
              logger(`getSeqID: Error refreshing session (attempt ${attempt + 1}/3): ${refreshErr && refreshErr.message ? refreshErr.message : String(refreshErr)}`, "warn");
              if (attempt < 2) {
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
              }
            }
          }

          if (webResponse && webResponse.data) {
            // Get updated cookies from jar
            const updatedCookies = await ctx.jar.getCookies("https://www.facebook.com");
            logger(`getSeqID: refreshed session, now have ${updatedCookies.length} web cookies`, "info");
            
            // Check HTML for USER_ID
            const htmlUserID = htmlUID(htmlContent);
            if (!isValidUID(htmlUserID)) {
              logger("getSeqID: WARNING - HTML does not show valid USER_ID after refresh. Session may not be fully established.", "warn");
            }
            
            // Update ctx state
            if (ctx) {
              ctx.loggedIn = true;
              // Use USER_ID from HTML if available, otherwise from API response
              if (isValidUID(htmlUserID)) {
                ctx.userID = htmlUserID;
                logger(`getSeqID: Updated ctx.userID from HTML: ${htmlUserID}`, "info");
              } else if (result.uid && isValidUID(result.uid)) {
                ctx.userID = result.uid;
                logger(`getSeqID: Updated ctx.userID from API: ${result.uid}`, "info");
              }
            }
          } else {
            logger("getSeqID: Failed to refresh web session after API login", "error");
          }
        } catch (refreshErr) {
          logger(`getSeqID: web session refresh failed - ${refreshErr && refreshErr.message ? refreshErr.message : String(refreshErr)}`, "warn");
        }

        return { ...result, cookies };
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

  return function getSeqID(defaultFuncs, api, ctx, globalCallback, form, retryCount = 0) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 2000;
    ctx.t_mqttCalled = false;

    return defaultFuncs
      .post("https://www.facebook.com/api/graphqlbatch/", ctx.jar, form)
      .then(parseAndCheckLogin(ctx, defaultFuncs))
      .then(async resData => {
        // Better error handling: check what we actually got
        if (getType(resData) !== "Array") {
          // Log what we actually received for debugging
          logger(`getSeqID: Unexpected response type: ${getType(resData)}, value: ${JSON.stringify(resData).substring(0, 200)}`, "warn");
          
          // If parseAndCheckLogin returned an error object, check if it's an auth error
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

        const syncSeqId = resData[0]?.o0?.data?.viewer?.message_threads?.sync_sequence_id;
        if (syncSeqId) {
          ctx.lastSeqId = syncSeqId;
          logger("mqtt getSeqID ok -> listenMqtt()", "info");
          listenMqtt(defaultFuncs, api, ctx, globalCallback);
        } else {
          throw { error: "getSeqId: no sync_sequence_id found." };
        }
      })
      .catch(async err => {
        const detail = (err && err.detail && err.detail.message) ? ` | detail=${err.detail.message}` : "";
        const msg = ((err && err.error) || (err && err.message) || String(err || "")) + detail;

        // Check if this is an auth-related error
        const isAuthError = /Not logged in|no sync_sequence_id found|blocked the login|401|403/i.test(msg);

        // For auth errors, try retry + auto-login
        if (isAuthError) {
          // Retry logic with increasing delay
          if (retryCount < MAX_RETRIES) {
            const delay = RETRY_DELAY * (retryCount + 1); // Increasing delay: 2s, 4s, 6s
            logger(`getSeqID: retry ${retryCount + 1}/${MAX_RETRIES} after ${delay}ms... (error: ${msg})`, "warn");
            await new Promise(resolve => setTimeout(resolve, delay));
            
            // Before retrying, try to refresh the session if this is the first retry
            if (retryCount === 0 && ctx.loggedIn) {
              try {
                logger("getSeqID: refreshing session before retry...", "info");
                const { get } = require("../../../utils/request");
                const { saveCookies } = require("../../../utils/client");
                await get("https://www.facebook.com/", ctx.jar, null, ctx.globalOptions, ctx).then(saveCookies(ctx.jar));
              } catch (refreshErr) {
                logger(`getSeqID: session refresh failed: ${refreshErr && refreshErr.message ? refreshErr.message : String(refreshErr)}`, "warn");
              }
            }
            
            return getSeqID(defaultFuncs, api, ctx, globalCallback, form, retryCount + 1);
          }

          // All retries failed, try auto-login
          logger("getSeqID: all retries failed, attempting auto re-login...", "warn");
          const config = getConfig();
          const loginResult = await tryAutoLogin(logger, config, ctx, defaultFuncs);

          if (loginResult) {
            // Wait longer after auto-login to ensure session is ready
            logger("getSeqID: retrying with new session...", "info");
            await new Promise(resolve => setTimeout(resolve, 3000)); // Increased delay to 3s
            return getSeqID(defaultFuncs, api, ctx, globalCallback, form, 0);
          }

          // Determine the auth error type
          if (/blocked/i.test(msg)) {
            return emitAuth(ctx, api, globalCallback, "login_blocked", msg);
          }
          if (/Not logged in/i.test(msg)) {
            return emitAuth(ctx, api, globalCallback, "not_logged_in", msg);
          }
        }

        logger(`getSeqID error: ${msg}`, "error");
        return emitAuth(ctx, api, globalCallback, "auth_error", msg);
      });
  };
};
