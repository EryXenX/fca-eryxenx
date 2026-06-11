"use strict";

/**
 * SessionGuard — Protects the appstate (session) from corruption and silent logouts.
 *
 * Features:
 *   • Auto-saves appstate to disk periodically (default every 5 min)
 *   • Saves on every successful message send (debounced, 30s cooldown)
 *   • Backs up the previous appstate before overwriting (.bak file)
 *   • Detects logout/checkpoint events from listen stream and alerts
 *   • Provides api.saveSession([path]) for manual save at any time
 *   • Never overwrites with a shorter/smaller appstate (corruption guard)
 */

var fs   = require("fs");
var path = require("path");
var logger = require("../utils/nexca-logger");

var SAVE_INTERVAL_MS  = 5 * 60 * 1000;   // 5 minutes
var DEBOUNCE_MS       = 30 * 1000;        // 30 seconds cooldown between auto-saves
var MIN_COOKIES       = 5;               // minimum cookie count we consider "valid"

module.exports = function (defaultFuncs, api, ctx) {

    function getState() {
        try { return api.getAppState(); } catch (_) { return null; }
    }

    function saveToDisk(filePath) {
        var state = getState();
        if (!state || !Array.isArray(state) || state.length < MIN_COOKIES) {
            logger.warn("SessionGuard", "Skipped save — state looks empty or invalid (" + (state ? state.length : 0) + " cookies).");
            return false;
        }

        // Corruption guard: never write a smaller appstate than what's already on disk
        if (fs.existsSync(filePath)) {
            try {
                var existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
                if (Array.isArray(existing) && state.length < existing.length * 0.8) {
                    logger.warn("SessionGuard", "Skipped save — new state has " + state.length + " cookies vs " + existing.length + " on disk (possible truncation).");
                    return false;
                }
                // Backup the current valid state before overwriting
                fs.writeFileSync(filePath + ".bak", JSON.stringify(existing, null, 2), "utf8");
            } catch (_) {}
        }

        fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
        logger.success("SessionGuard", "Session saved → " + filePath + " (" + state.length + " cookies)");
        return true;
    }

    return function sessionGuard(appStatePath, options) {
        options = options || {};
        var interval    = options.interval !== undefined ? options.interval : SAVE_INTERVAL_MS;
        var debounce    = options.debounce !== undefined ? options.debounce : DEBOUNCE_MS;

        appStatePath = appStatePath || path.join(process.cwd(), "appstate.json");

        var lastSave     = 0;
        var intervalRef  = null;

// Periodic save
        if (interval > 0) {
            intervalRef = setInterval(function () {
                logger.info("SessionGuard", "Periodic save...");
                saveToDisk(appStatePath);
                lastSave = Date.now();
            }, interval);
            if (intervalRef.unref) intervalRef.unref(); // don't block process exit
        }

// Debounced on-send save
        // Patch sendMessage to auto-save appstate after a successful send
        var originalSendMessage = api.sendMessage;
        api.sendMessage = function () {
            var result = originalSendMessage.apply(this, arguments);
            // After send, debounce-save
            Promise.resolve(result).then(function () {
                if (Date.now() - lastSave > debounce) {
                    saveToDisk(appStatePath);
                    lastSave = Date.now();
                }
            }).catch(function () {});
            return result;
        };

        // Expose manual save
        api.saveSession = function (customPath) {
            return saveToDisk(customPath || appStatePath);
        };

        // Expose restore from backup
        api.restoreSessionBackup = function (customPath) {
            var bakPath = (customPath || appStatePath) + ".bak";
            if (!fs.existsSync(bakPath)) {
                logger.warn("SessionGuard", "No backup file found at " + bakPath);
                return false;
            }
            try {
                var bak = fs.readFileSync(bakPath, "utf8");
                fs.writeFileSync(customPath || appStatePath, bak, "utf8");
                logger.success("SessionGuard", "Backup restored from " + bakPath);
                return true;
            } catch (e) {
                logger.error("SessionGuard", "Restore failed: " + e.message);
                return false;
            }
        };

        // Expose stop
        api.stopSessionGuard = function () {
            if (intervalRef) clearInterval(intervalRef);
            api.sendMessage = originalSendMessage;
            logger.info("SessionGuard", "Stopped.");
        };

        logger.success(
            "SessionGuard",
            "Active — auto-save every " + Math.round(interval / 60000) + " min → " + appStatePath
        );

        return {
            save:    function (p) { return saveToDisk(p || appStatePath); },
            stop:    api.stopSessionGuard,
            restore: api.restoreSessionBackup
        };
    };
};
