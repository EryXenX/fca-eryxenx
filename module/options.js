const { getType } = require("../src/utils/format");
const { setProxy } = require("../src/utils/request");
const logger = require("../func/logger");
const Boolean_Option = [
  "online",
  "selfListen",
  "listenEvents",
  "updatePresence",
  "forceLogin",
  "autoMarkRead",
  "listenTyping",
  "autoReconnect",
  "emitReady",
  "selfListenEvent"
];
function setOptions(globalOptions, options) {
  for (const key of Object.keys(options || {})) {
    if (Boolean_Option.includes(key)) {
      globalOptions[key] = Boolean(options[key]);
      continue;
    }
    switch (key) {
      case "userAgent": {
        globalOptions.userAgent = options.userAgent || "Mozilla/5.0 (Linux; Android 12; M2102J20SG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.0.0 Mobile Safari/537.36";
        break;
      }
      case "proxy": {
        if (typeof options.proxy !== "string") {
          delete globalOptions.proxy;
          setProxy();
        } else {
          globalOptions.proxy = options.proxy;
          setProxy(globalOptions.proxy);
        }
        break;
      }
      default: {
        logger("setOptions Unrecognized option given to setOptions: " + key, "warn");
        break;
      }
    }
  }
}
module.exports = { setOptions, Boolean_Option };
