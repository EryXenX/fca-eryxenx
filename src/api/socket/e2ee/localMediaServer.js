"use strict";

const http = require("http");
const crypto = require("crypto");

let _server = null;
let _port = 0;
const _cache = new Map(); // token -> { buffer, mimeType, expiresAt }

const TTL_MS = 15 * 60 * 1000; // 15 min is plenty for a command to fetch it

function _cleanup() {
    const now = Date.now();
    for (const [token, entry] of _cache) {
        if (entry.expiresAt < now) _cache.delete(token);
    }
}

function ensureServer() {
    if (_server) return Promise.resolve(_port);
    return new Promise((resolve, reject) => {
        _server = http.createServer((req, res) => {
            const token = (req.url || "").replace(/^\/+/, "").split("?")[0];
            const entry = _cache.get(token);
            if (!entry) {
                res.writeHead(404);
                res.end("not found");
                return;
            }
            res.writeHead(200, {
                "Content-Type": entry.mimeType || "application/octet-stream",
                "Content-Length": entry.buffer.length
            });
            res.end(entry.buffer);
        });
        _server.on("error", reject);
        // 127.0.0.1 only — never expose this outside the container
        _server.listen(0, "127.0.0.1", () => {
            _port = _server.address().port;
            setInterval(_cleanup, 60 * 1000).unref();
            resolve(_port);
        });
    });
}

/**
 * Stores a decrypted media buffer and returns a short-lived local URL for it.
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {Promise<string>} e.g. http://127.0.0.1:53211/ab12cd34
 */
async function serveBuffer(buffer, mimeType) {
    const port = await ensureServer();
    const token = crypto.randomBytes(12).toString("hex");
    _cache.set(token, { buffer, mimeType, expiresAt: Date.now() + TTL_MS });
    return `http://127.0.0.1:${port}/${token}`;
}

module.exports = { serveBuffer };
