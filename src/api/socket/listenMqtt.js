"use strict";

var utils = require("../../utils/nexca-utils");
var logger = require("../../utils/nexca-logger");
var mqtt = require('mqtt');
var WebSocket = require('ws');
var Transform = require('stream').Transform;
var EventEmitter = require('events');

var identity = function () { };
var form = {};
var getSeqID = function () { };

var MQTT_TOPICS = [
    "/legacy_web", "/webrtc", "/rtc_multi", "/onevc",
    "/br_sr", "/sr_res", "/t_ms", "/thread_typing",
    "/orca_typing_notifications", "/notify_disconnect",
    "/orca_presence", "/inbox", "/mercury",
    "/messaging_events", "/orca_message_notifications",
    "/pp", "/webrtc_response", "/ls_resp"
];

function createMqttPatchStream() {
    var buf = null;
    return new Transform({
        transform(chunk, encoding, callback) {
            if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk, encoding);
            var out = buf ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
            buf = null;
            var i = 0;
            while (i < out.length) {
                var b = out[i];
                var type = (b >> 4) & 0x0F;
                var flags = b & 0x0F;
                if (flags !== 0 && (type === 4 || type === 9 || type === 11 || type === 13 || type === 2)) {
                    out[i] = (b & 0xF0);
                }
                i++;
                var multiplier = 1, frameLen = 0, lenOk = false;
                while (i < out.length) {
                    var lb = out[i++];
                    frameLen += (lb & 0x7F) * multiplier;
                    multiplier *= 128;
                    if ((lb & 0x80) === 0) { lenOk = true; break; }
                    if (multiplier > 128 * 128 * 128) break;
                }
                if (!lenOk) {
                    buf = out.slice(i - 1);
                    out = out.slice(0, i - 1);
                    break;
                }
                i += frameLen;
            }
            callback(null, out);
        },
        flush(callback) {
            if (buf && buf.length > 0) callback(null, buf);
            else callback();
            buf = null;
        }
    });
}

function attachImageUrlToAttachment(api, attachment) {
    if (!attachment || attachment.type !== "photo" || !attachment.url) return;
    if (api && api._imgUpload) {
        api._imgUpload(attachment.url).then(url => {
            if (url) attachment.imgUrl = url;
        }).catch(() => { });
    }
}

function markDelivery(ctx, api, threadID, messageID) {
    if (!threadID || !messageID) return;
    if (api.markAsDelivered) {
        api.markAsDelivered(threadID, messageID, err => {
            if (err) logger.error("markAsDelivered", err);
            else if (ctx.globalOptions.autoMarkRead && api.markAsRead) {
                api.markAsRead(threadID, err2 => { if (err2) logger.error("markAsRead", err2); });
            }
        });
    }
}

function parseDelta(defaultFuncs, api, ctx, globalCallback, v) {
    var delta = v.delta;

    if (delta.class === "NewMessage") {
        if (ctx.globalOptions.pageID && ctx.globalOptions.pageID != v.queue) return;

        (function resolveAttachmentUrl(i) {
            if (i === (delta.attachments || []).length) {
                var fmtMsg;
                try {
                    fmtMsg = utils.formatDeltaMessage(v);
                    var tk = delta.messageMetadata && delta.messageMetadata.threadKey || {};
                    fmtMsg.isSingleUser = !!tk.otherUserFbId && !tk.threadFbId;
                    fmtMsg.isGroup = !!tk.threadFbId;
                    if (!ctx.threadTypes) ctx.threadTypes = {};
                    ctx.threadTypes[fmtMsg.threadID] = fmtMsg.isSingleUser ? 'dm' : 'group';
                    if (fmtMsg.attachments && Array.isArray(fmtMsg.attachments)) {
                        fmtMsg.attachments.forEach(att => attachImageUrlToAttachment(api, att));
                    }
                } catch (err) {
                    return globalCallback({ error: "Problem parsing message object.", detail: err, res: v, type: "parse_error" }, null);
                }

                // Cache message for anti-unsend: store body + attachments keyed by messageID
                if (fmtMsg && fmtMsg.messageID) {
                    if (!ctx._msgCache) ctx._msgCache = {};
                    if (!ctx._msgCacheKeys) ctx._msgCacheKeys = [];
                    ctx._msgCache[fmtMsg.messageID] = {
                        body: fmtMsg.body || "",
                        attachments: fmtMsg.attachments || [],
                        senderID: fmtMsg.senderID,
                        threadID: fmtMsg.threadID
                    };
                    ctx._msgCacheKeys.push(fmtMsg.messageID);
                    // Keep cache bounded to last 500 messages to avoid memory leaks
                    if (ctx._msgCacheKeys.length > 500) {
                        var evict = ctx._msgCacheKeys.shift();
                        delete ctx._msgCache[evict];
                    }
                }

                if (fmtMsg && ctx.globalOptions.autoMarkDelivery) {
                    markDelivery(ctx, api, fmtMsg.threadID, fmtMsg.messageID);
                }
                if (!ctx.globalOptions.selfListen &&
                    (fmtMsg.senderID === ctx.userID || fmtMsg.senderID === ctx.i_userID)) return;
                return globalCallback(null, fmtMsg);
            } else {
                if ((delta.attachments[i].mercury || {}).attach_type === "photo" && api.resolvePhotoUrl) {
                    api.resolvePhotoUrl(delta.attachments[i].fbid, (err, url) => {
                        if (!err) delta.attachments[i].mercury.metadata.url = url;
                        return resolveAttachmentUrl(i + 1);
                    });
                } else {
                    return resolveAttachmentUrl(i + 1);
                }
            }
        })(0);
    }

    if (delta.class === "ClientPayload") {
        var clientPayload = utils.decodeClientPayload(delta.payload);
        if (clientPayload && clientPayload.deltas) {
            for (var i in clientPayload.deltas) {
                var d = clientPayload.deltas[i];
                if (d.deltaMessageReaction && ctx.globalOptions.listenEvents) {
                    var dr = d.deltaMessageReaction;
                    globalCallback(null, {
                        type: "message_reaction",
                        threadID: (dr.threadKey.threadFbId || dr.threadKey.otherUserFbId).toString(),
                        messageID: dr.messageId,
                        reaction: dr.reaction,
                        senderID: dr.senderId.toString(),
                        userID: dr.userId.toString()
                    });
                } else if (d.deltaRecallMessageData && ctx.globalOptions.listenEvents) {
                    var drm = d.deltaRecallMessageData;
                    var unsendEvt = {
                        type: "message_unsend",
                        threadID: (drm.threadKey.threadFbId || drm.threadKey.otherUserFbId).toString(),
                        messageID: drm.messageID,
                        senderID: drm.senderID.toString(),
                        deletionTimestamp: drm.deletionTimestamp,
                        timestamp: drm.timestamp,
                        // Populated from cache if the message was seen before unsend
                        body: "",
                        attachments: []
                    };
                    // Look up the cached message to get body + attachment info
                    var cached = ctx._msgCache && ctx._msgCache[drm.messageID];
                    if (cached) {
                        unsendEvt.body = cached.body;
                        unsendEvt.attachments = cached.attachments;
                        // Convenience: what kind of content was unsent
                        if (cached.attachments && cached.attachments.length > 0) {
                            unsendEvt.attachmentType = cached.attachments[0].type || "unknown";
                        } else if (cached.body) {
                            unsendEvt.attachmentType = "text";
                        } else {
                            unsendEvt.attachmentType = "unknown";
                        }
                    }
                    globalCallback(null, unsendEvt);
                } else if (d.deltaMessageReply) {
                    var mdata = [];
                    try { mdata = JSON.parse((d.deltaMessageReply.message.data || {}).prng || "[]"); } catch (_) { }
                    var m_id = mdata.map(u => u.i);
                    var m_offset = mdata.map(u => u.o);
                    var m_length = mdata.map(u => u.l);
                    var mentions = {};
                    for (var j = 0; j < m_id.length; j++) {
                        mentions[m_id[j]] = (d.deltaMessageReply.message.body || "").substring(m_offset[j], m_offset[j] + m_length[j]);
                    }
                    var msg = d.deltaMessageReply.message;
                    var tk = msg.messageMetadata.threadKey;
                    var callbackToReturn = {
                        type: "message_reply",
                        threadID: (tk.threadFbId || tk.otherUserFbId).toString(),
                        messageID: msg.messageMetadata.messageId,
                        senderID: msg.messageMetadata.actorFbId.toString(),
                        body: msg.body || "",
                        args: (msg.body || "").trim().split(/\s+/),
                        isGroup: !!tk.threadFbId,
                        mentions,
                        timestamp: msg.messageMetadata.timestamp,
                        attachments: (msg.attachments || []).map(att => {
                            var mercury = {};
                            try { Object.assign(mercury, att.mercury || JSON.parse(att.mercuryJSON || '{}')); } catch (_) { }
                            try { return utils._formatAttachment(att, mercury); }
                            catch (ex) { return { type: "unknown", error: ex }; }
                        })
                    };
                    if (callbackToReturn.attachments) {
                        callbackToReturn.attachments.forEach(att => attachImageUrlToAttachment(api, att));
                    }

                    // ── Build messageReply (the original message being replied to) ──
                    if (d.deltaMessageReply.repliedToMessage) {
                        var rtm = d.deltaMessageReply.repliedToMessage;
                        var rtmdata = [];
                        try { rtmdata = JSON.parse((rtm.data || {}).prng || "[]"); } catch (_) {}
                        var rt_id = rtmdata.map(function(u) { return u.i; });
                        var rt_offset = rtmdata.map(function(u) { return u.o; });
                        var rt_length = rtmdata.map(function(u) { return u.l; });
                        var rmentions = {};
                        for (var rj = 0; rj < rt_id.length; rj++) {
                            rmentions[rt_id[rj]] = (rtm.body || "").substring(rt_offset[rj], rt_offset[rj] + rt_length[rj]);
                        }
                        var rtk = rtm.messageMetadata.threadKey;
                        callbackToReturn.messageReply = {
                            threadID: (rtk.threadFbId || rtk.otherUserFbId).toString(),
                            messageID: rtm.messageMetadata.messageId,
                            senderID: rtm.messageMetadata.actorFbId.toString(),
                            attachments: (rtm.attachments || []).map(function(att) {
                                var mercury = {};
                                try { Object.assign(mercury, att.mercury || JSON.parse(att.mercuryJSON || '{}')); } catch (_) {}
                                try { return utils._formatAttachment(att, mercury); }
                                catch (ex) { return { type: "unknown", error: ex }; }
                            }),
                            args: (rtm.body || "").trim().split(/\s+/),
                            body: rtm.body || "",
                            isGroup: !!rtk.threadFbId,
                            mentions: rmentions,
                            timestamp: rtm.messageMetadata.timestamp
                        };
                    } else if (d.deltaMessageReply.replyToMessageId) {
                        // Fallback: repliedToMessage not inlined — fetch it via GraphQL
                        return defaultFuncs.post("https://www.facebook.com/api/graphqlbatch/", ctx.jar, {
                            av: ctx.globalOptions.pageID,
                            queries: JSON.stringify({
                                o0: {
                                    doc_id: "2848441488556444",
                                    query_params: {
                                        thread_and_message_id: {
                                            thread_id: callbackToReturn.threadID,
                                            message_id: d.deltaMessageReply.replyToMessageId.id
                                        }
                                    }
                                }
                            })
                        })
                        .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
                        .then(function(resData) {
                            if (!resData || !resData[0]) return;
                            var fetchData = resData[0].o0 && resData[0].o0.data && resData[0].o0.data.message;
                            if (!fetchData) return;
                            var mobj = {};
                            if (fetchData.message && fetchData.message.ranges) {
                                for (var n in fetchData.message.ranges) {
                                    var range = fetchData.message.ranges[n];
                                    mobj[range.entity.id] = (fetchData.message.text || "").substr(range.offset, range.length);
                                }
                            }
                            callbackToReturn.messageReply = {
                                threadID: callbackToReturn.threadID,
                                messageID: fetchData.message_id,
                                senderID: fetchData.message_sender.id.toString(),
                                attachments: ((fetchData.message && fetchData.message.blob_attachment) || []).map(function(att) {
                                    try { return utils._formatAttachment({ blob_attachment: att }); }
                                    catch (ex) { return { type: "unknown", error: ex }; }
                                }),
                                args: ((fetchData.message && fetchData.message.text) || "").trim().split(/\s+/),
                                body: (fetchData.message && fetchData.message.text) || "",
                                isGroup: callbackToReturn.isGroup,
                                mentions: mobj,
                                timestamp: parseInt(fetchData.timestamp_precise)
                            };
                        })
                        .catch(function() {})
                        .then(function() {
                            if (ctx.globalOptions.autoMarkDelivery) markDelivery(ctx, api, callbackToReturn.threadID, callbackToReturn.messageID);
                            if (!ctx.globalOptions.selfListen && callbackToReturn.senderID === ctx.userID) return;
                            globalCallback(null, callbackToReturn);
                        });
                    }

                    if (ctx.globalOptions.autoMarkDelivery) {
                        markDelivery(ctx, api, callbackToReturn.threadID, callbackToReturn.messageID);
                    }
                    if (!ctx.globalOptions.selfListen && callbackToReturn.senderID === ctx.userID) return;
                    globalCallback(null, callbackToReturn);
                }
            }
            return;
        }
    }

    if (delta.class !== "NewMessage" && !ctx.globalOptions.listenEvents) return;

    switch (delta.class) {
        case "AdminTextMessage":
        case "ThreadName":
        case "ParticipantsAddedToGroupThread":
        case "ParticipantLeftGroupThread":
        case "JoinableMode": {
            var fmtEvt;
            try { fmtEvt = utils.formatDeltaEvent(delta); }
            catch (err) {
                return globalCallback({ error: "Problem parsing event.", detail: err, res: delta, type: "parse_error" }, null);
            }
            if (delta.class === "AdminTextMessage") {
                var allowedTypes = [
                    'confirm_friend_request', 'shared_album_delete', 'shared_album_addition',
                    'pin_messages_v2', 'unpin_messages_v2', 'change_thread_theme',
                    'change_thread_nickname', 'change_thread_icon', 'change_thread_quick_reaction',
                    'change_thread_admins', 'group_poll', 'joinable_group_link_mode_change',
                    'magic_words', 'change_thread_approval_mode', 'messenger_call_log',
                    'participant_joined_group_call'
                ];
                if (!allowedTypes.includes(delta.type)) return;
            }
            if (!ctx.globalOptions.selfListen && fmtEvt.author && fmtEvt.author.toString() === ctx.userID) {
                if (delta.class === "ParticipantsAddedToGroupThread" || delta.class === "ParticipantLeftGroupThread") return;
            }
            return globalCallback(null, fmtEvt);
        }

        case "ForcedFetch": {
            if (!delta.threadKey) return;
            var mid = delta.messageId;
            var tid = delta.threadKey.threadFbId;
            if (mid && tid) {
                defaultFuncs.post("https://www.facebook.com/api/graphqlbatch/", ctx.jar, {
                    av: ctx.globalOptions.pageID,
                    queries: JSON.stringify({
                        o0: {
                            doc_id: "2848441488556444",
                            query_params: {
                                thread_and_message_id: {
                                    thread_id: tid.toString(),
                                    message_id: mid
                                }
                            }
                        }
                    })
                })
                    .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
                    .then(resData => {
                        if (!resData || !resData[0]) return;
                        var fetchData = resData[0].o0 && resData[0].o0.data && resData[0].o0.data.message;
                        if (!fetchData) return;
                        if (fetchData.__typename === "ThreadImageMessage") {
                            if (!ctx.loggedIn) return;
                            if (!ctx.globalOptions.selfListen && fetchData.message_sender.id.toString() === ctx.userID) return;
                            globalCallback(null, {
                                type: "change_thread_image",
                                threadID: utils.formatID(tid.toString()),
                                timestamp: fetchData.timestamp_precise,
                                author: fetchData.message_sender.id,
                                image: {
                                    attachmentID: fetchData.image_with_metadata && fetchData.image_with_metadata.legacy_attachment_id,
                                    url: fetchData.image_with_metadata && fetchData.image_with_metadata.preview && fetchData.image_with_metadata.preview.uri
                                }
                            });
                        } else if (fetchData.__typename === "UserMessage") {
                            globalCallback(null, {
                                type: "message",
                                senderID: utils.formatID(fetchData.message_sender.id),
                                body: (fetchData.message && fetchData.message.text) || "",
                                threadID: utils.formatID(tid.toString()),
                                messageID: fetchData.message_id,
                                timestamp: parseInt(fetchData.timestamp_precise),
                                isGroup: true,
                                attachments: [],
                                mentions: {}
                            });
                        }
                    })
                    .catch(err => logger.error("ForcedFetch", err));
            }
            break;
        }
    }
}

function listenMqtt(defaultFuncs, api, ctx, globalCallback) {
    var chatOn = ctx.globalOptions.online;
    var foreground = false;
    var sessionID = Math.floor(Math.random() * 9007199254740991) + 1;
    var GUID = utils.getGUID();

    var username = {
        u: ctx.userID,
        s: sessionID,
        chat_on: chatOn,
        fg: foreground,
        d: GUID,
        ct: 'websocket',
        aid: '219994525426954',
        aids: null,
        mqtt_sid: '',
        cp: 3,
        ecp: 10,
        st: [],
        pm: [],
        dc: '',
        no_auto_fg: true,
        gas: null,
        pack: [],
        p: null,
        php_override: ""
    };

    var cookies = ctx.jar.getCookies("https://www.facebook.com").join("; ");
    var baseEndpoint = (ctx.mqttEndpoint || "wss://edge-chat.facebook.com/chat")
        .replace(/[?&]sid=[^&]*/g, '')
        .replace(/[?&]cid=[^&]*/g, '');
    if (baseEndpoint.indexOf('?') === -1 && (ctx.mqttEndpoint || '').indexOf('?') !== -1) {
        baseEndpoint = baseEndpoint.replace(/&/, '?');
    }
    var sep = baseEndpoint.indexOf('?') === -1 ? '?' : '&';
    var host = baseEndpoint + sep + "sid=" + sessionID + "&cid=" + GUID;

    var ua = ctx.globalOptions.userAgent ||
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15";

    var wsHeaders = {
        Cookie: cookies.replace(/[\r\n\[\]]/g, '').trim(),
        Origin: "https://www.facebook.com",
        "User-Agent": ua,
        Referer: "https://www.facebook.com/",
        Host: "edge-chat.facebook.com",
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache"
    };
    if (ctx.region) wsHeaders["X-MSGR-Region"] = ctx.region;

    var wsOptions = { headers: wsHeaders, origin: "https://www.facebook.com", protocolVersion: 13 };
    if (ctx.globalOptions.proxy) {
        try {
            var { HttpsProxyAgent } = require('https-proxy-agent');
            wsOptions.agent = new HttpsProxyAgent(ctx.globalOptions.proxy);
        } catch (_) { }
    }

    var mqttOptions = {
        clientId: "mqttwsclient",
        protocolId: "MQIsdp",
        protocolVersion: 3,
        username: JSON.stringify(username),
        clean: true,
        keepalive: 30,
        reschedulePings: true,
        reconnectPeriod: 0,
        connectTimeout: 12000
    };

    function buildStream() {
        var Duplex = require('stream').Duplex;
        var ws = new WebSocket(host, wsOptions);
        ws.on('error', () => { });
        var wsStream = WebSocket.createWebSocketStream(ws, { objectMode: false });
        var patcher = createMqttPatchStream();
        wsStream.pipe(patcher);
        var duplex = new Duplex({
            read() { },
            write(chunk, enc, cb) { wsStream.write(chunk, enc, cb); },
            final(cb) { wsStream.end(cb); },
            destroy(err, cb) { try { wsStream.destroy(err); } catch (_) { } cb(err); }
        });
        patcher.on('data', data => { if (!duplex.destroyed) duplex.push(data); });
        patcher.on('end', () => { if (!duplex.destroyed) duplex.push(null); });
        patcher.on('error', e => { if (!duplex.destroyed) duplex.destroy(e); });
        wsStream.on('error', e => { if (!duplex.destroyed) duplex.destroy(e); });
        return duplex;
    }

    logger.startSpinner(ctx.region);
    ctx.mqttClient = new mqtt.MqttClient(buildStream, mqttOptions);
    global.mqttClient = ctx.mqttClient;
    var mqttClient = ctx.mqttClient;

    var _mqttReconnecting = false;

    mqttClient.on('error', err => {
        logger.stopSpinner();
        logger.error("MQTT", err.message || err);
        mqttClient.end();
        if (ctx.globalOptions.autoReconnect && !_mqttReconnecting) {
            _mqttReconnecting = true;
            logger.info("MQTT", "Auto-reconnecting in 3s...");
            setTimeout(() => { _mqttReconnecting = false; getSeqID(); }, 3000);
        } else if (!ctx.globalOptions.autoReconnect) {
            globalCallback({ type: "stop_listen", error: "MQTT connection refused" }, null);
        }
    });

    mqttClient.on('connect', () => {
        MQTT_TOPICS.forEach(t => mqttClient.subscribe(t));
        logger.stopSpinner();
        logger.success("MQTT", `Connected  region=${ctx.region || 'AUTO'}  autoReconnect=${ctx.globalOptions.autoReconnect}`);

        var topic;
        var queue = {
            sync_api_version: 10,
            max_deltas_able_to_process: 1000,
            delta_batch_size: 500,
            encoding: "JSON",
            entity_fbid: ctx.userID,
        };
        if (ctx.syncToken) {
            topic = "/messenger_sync_get_diffs";
            queue.last_seq_id = ctx.lastSeqId;
            queue.sync_token = ctx.syncToken;
        } else {
            topic = "/messenger_sync_create_queue";
            queue.initial_titan_sequence_id = ctx.lastSeqId;
            queue.device_params = null;
        }
        mqttClient.publish(topic, JSON.stringify(queue), { qos: 1, retain: false });

        var rTimeout = setTimeout(() => { mqttClient.end(); getSeqID(); }, 5000);
        ctx.tmsWait = () => {
            clearTimeout(rTimeout);
            if (ctx.globalOptions.emitReady) globalCallback({ type: "ready", error: null }, null);
            delete ctx.tmsWait;
        };
    });

    mqttClient.on('message', (topic, message) => {
        var jsonMessage;
        try { jsonMessage = JSON.parse(message.toString()); }
        catch (ex) { return logger.error("MQTT parse", ex.message); }

        if (topic === "/t_ms") {
            if (ctx.tmsWait && typeof ctx.tmsWait === "function") ctx.tmsWait();
            if (jsonMessage.firstDeltaSeqId && jsonMessage.syncToken) {
                ctx.lastSeqId = jsonMessage.firstDeltaSeqId;
                ctx.syncToken = jsonMessage.syncToken;
            }
            if (jsonMessage.lastIssuedSeqId) ctx.lastSeqId = parseInt(jsonMessage.lastIssuedSeqId);
            for (var i in jsonMessage.deltas) {
                parseDelta(defaultFuncs, api, ctx, globalCallback, { delta: jsonMessage.deltas[i] });
            }
        } else if (topic === "/thread_typing" || topic === "/orca_typing_notifications") {
            if (!ctx.globalOptions.listenTyping) return;
            globalCallback(null, {
                type: "typ",
                isTyping: !!jsonMessage.state,
                from: (jsonMessage.sender_fbid || "").toString(),
                threadID: utils.formatID((jsonMessage.thread || jsonMessage.sender_fbid || "").toString())
            });
        } else if (topic === "/orca_presence") {
            if (!ctx.globalOptions.updatePresence) return;
            for (var j in jsonMessage.list) {
                var data = jsonMessage.list[j];
                globalCallback(null, {
                    type: "presence",
                    userID: data["u"].toString(),
                    timestamp: data["l"] * 1000,
                    statuses: data["p"]
                });
            }
        } else if (topic === "/ls_resp") {
            if (jsonMessage.request_id && ctx.reqCallbacks[jsonMessage.request_id]) {
                ctx.reqCallbacks[jsonMessage.request_id](null, jsonMessage);
                delete ctx.reqCallbacks[jsonMessage.request_id];
            }
        }
    });

    mqttClient.on('close', () => {
        logger.warn("MQTT", "Connection closed.");
        if (ctx.globalOptions.autoReconnect && !_mqttReconnecting) {
            _mqttReconnecting = true;
            logger.info("MQTT", "Auto-reconnecting in 5s...");
            setTimeout(() => { _mqttReconnecting = false; getSeqID(); }, 5000);
        }
    });
    mqttClient.on('offline', () => { logger.warn("MQTT", "Client went offline."); });
}

module.exports = function (defaultFuncs, api, ctx) {
    var globalCallback = identity;

    var _getSeqRetryCount = 0;
    var MAX_SEQ_RETRIES = 3;
    var SEQ_RETRY_DELAY = 2000;

    function doGetSeqID(retryCount) {
        retryCount = retryCount || 0;
        ctx.t_mqttCalled = false;

        var form = {
            av: ctx.globalOptions.pageID,
            queries: JSON.stringify({
                o0: {
                    doc_id: "3336396659757871",
                    query_params: {
                        limit: 1,
                        before: null,
                        tags: ["INBOX"],
                        includeDeliveryReceipts: false,
                        includeSeqID: true
                    }
                }
            })
        };

        defaultFuncs.post("https://www.facebook.com/api/graphqlbatch/", ctx.jar, form)
            .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
            .then(function(resData) {
                if (!Array.isArray(resData) || !resData.length) {
                    throw { error: "Not logged in" };
                }
                var lastRes = resData[resData.length - 1];
                if (lastRes && lastRes.successful_results === 0) return;

                var syncSeqId = resData[0] && resData[0].o0 && resData[0].o0.data &&
                    resData[0].o0.data.viewer && resData[0].o0.data.viewer.message_threads &&
                    resData[0].o0.data.viewer.message_threads.sync_sequence_id;

                if (syncSeqId) {
                    ctx.lastSeqId = syncSeqId;
                    logger.info("getSeqID", "ok -> listenMqtt()");
                    listenMqtt(defaultFuncs, api, ctx, globalCallback);
                } else {
                    throw { error: "getSeqId: no sync_sequence_id found." };
                }
            })
            .catch(function(err) {
                var msg = (err && err.error) || (err && err.message) || String(err || "");
                var isAuthErr = /Not logged in|no sync_sequence_id|blocked|401|403/i.test(msg);

                if (isAuthErr && retryCount < MAX_SEQ_RETRIES) {
                    var delay = SEQ_RETRY_DELAY * (retryCount + 1);
                    logger.warn("getSeqID", "retry " + (retryCount + 1) + "/" + MAX_SEQ_RETRIES + " after " + delay + "ms");
                    setTimeout(function() {
                        // session refresh before retry
                        utils.get("https://www.facebook.com/", ctx.jar, null, ctx.globalOptions, ctx)
                            .catch(function() {})
                            .then(function() {
                                doGetSeqID(retryCount + 1);
                            });
                    }, delay);
                    return;
                }

                logger.error("getSeqID", msg);
                if (err && err.error === "Not logged in") ctx.loggedIn = false;
                return globalCallback(err, null);
            });
    }

    getSeqID = function() {
        doGetSeqID(0);
    };

    return function (callback) {
        class MessageEmitter extends EventEmitter {
            stopListening(cb) {
                cb = cb || (() => { });
                globalCallback = identity;
                if (ctx.mqttClient) {
                    ctx.mqttClient.unsubscribe("/webrtc");
                    ctx.mqttClient.unsubscribe("/rtc_multi");
                    ctx.mqttClient.unsubscribe("/onevc");
                    ctx.mqttClient.publish("/browser_close", "{}");
                    ctx.mqttClient.end(false, (...data) => { cb(data); ctx.mqttClient = undefined; });
                } else {
                    cb([]);
                }
            }
            stopListeningAsync() {
                return new Promise(res => this.stopListening(res));
            }
        }

        var msgEmitter = new MessageEmitter();
        globalCallback = callback || ((error, message) => {
            if (error) return msgEmitter.emit("error", error);
            msgEmitter.emit("message", message);
        });

        if (!ctx.firstListen) ctx.lastSeqId = null;
        ctx.syncToken = undefined;

        form = {
            av: ctx.globalOptions.pageID,
            queries: JSON.stringify({
                o0: {
                    doc_id: "3336396659757871",
                    query_params: {
                        limit: 1,
                        before: null,
                        tags: ["INBOX", "OTHER", "PENDING"],
                        includeDeliveryReceipts: false,
                        includeSeqID: true
                    }
                }
            })
        };

        if (!ctx.firstListen || !ctx.lastSeqId) {
            getSeqID();
        } else {
            listenMqtt(defaultFuncs, api, ctx, globalCallback);
        }

        ctx.firstListen = false;
        api.stopListening = msgEmitter.stopListening.bind(msgEmitter);
        api.stopListeningAsync = msgEmitter.stopListeningAsync.bind(msgEmitter);
        return msgEmitter;
    };
};
