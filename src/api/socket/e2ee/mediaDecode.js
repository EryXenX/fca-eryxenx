"use strict";

// Generic protobuf wire-format field reader (varint / length-delimited /
// fixed32 / fixed64). Returns { fieldNumber: [values...] }.
function readVarint(buf, offset) {
    let result = 0n, shift = 0n, b;
    do {
        b = buf[offset++];
        result |= BigInt(b & 0x7f) << shift;
        shift += 7n;
    } while (b & 0x80);
    return [result, offset];
}

function decodeFields(buf) {
    const fields = {};
    let offset = 0;
    while (offset < buf.length) {
        let tag;
        try {
            [tag, offset] = readVarint(buf, offset);
        } catch (_) { break; }
        const fieldNum = Number(tag >> 3n);
        const wireType = Number(tag & 7n);
        let value;
        if (wireType === 0) {
            [value, offset] = readVarint(buf, offset);
        } else if (wireType === 2) {
            let len;
            [len, offset] = readVarint(buf, offset);
            len = Number(len);
            value = buf.slice(offset, offset + len);
            offset += len;
        } else if (wireType === 1) {
            value = buf.readBigUInt64LE(offset); offset += 8;
        } else if (wireType === 5) {
            value = buf.readUInt32LE(offset); offset += 4;
        } else {
            break;
        }
        if (!fields[fieldNum]) fields[fieldNum] = [];
        fields[fieldNum].push(value);
    }
    return fields;
}

function bytesField(fields, n) { return fields[n] ? fields[n][0] : undefined; }
function strField(fields, n) {
    const b = bytesField(fields, n);
    return b !== undefined ? Buffer.from(b).toString("utf8") : undefined;
}
function numField(fields, n) {
    const v = fields[n] ? fields[n][0] : undefined;
    return v !== undefined ? Number(v) : undefined;
}

// WACommon.SubProtocol { bytes payload = 1; int32 version = 2; }
function decodeSubProtocol(buf) {
    const f = decodeFields(buf);
    return { payload: bytesField(f, 1), version: numField(f, 2) };
}

// WAMediaTransport {
//   Integral  { bytes fileSHA256=1; bytes mediaKey=2; bytes fileEncSHA256=3; string directPath=4; int64 mediaKeyTimestamp=5; }
//   Ancillary { uint64 fileLength=1; string mimetype=2; Thumbnail thumbnail=3; string objectID=4; }
//   Integral integral = 1; Ancillary ancillary = 2;
// }
function decodeWAMediaTransport(buf) {
    const top = decodeFields(buf);
    const integralBuf = bytesField(top, 1);
    const ancillaryBuf = bytesField(top, 2);
    const integral = integralBuf ? decodeFields(integralBuf) : {};
    const ancillary = ancillaryBuf ? decodeFields(ancillaryBuf) : {};
    return {
        fileSHA256: bytesField(integral, 1),
        mediaKey: bytesField(integral, 2),
        fileEncSHA256: bytesField(integral, 3),
        directPath: strField(integral, 4),
        mediaKeyTimestamp: numField(integral, 5),
        fileLength: numField(ancillary, 1),
        mimeType: strField(ancillary, 2),
        objectId: strField(ancillary, 4)
    };
}

// {Image,Video,Audio,Document}Transport {
//   Integral  { WAMediaTransport transport = 1; }
//   Ancillary { uint32 height=1; uint32 width=2; ... }  (varies per type, only
//               height/width are common to image/video and are all we need)
//   Integral integral = 1; Ancillary ancillary = 2;
// }
function decodeMediaTransportPayload(buf) {
    const top = decodeFields(buf);
    const integralWrapBuf = bytesField(top, 1);
    const ancillaryBuf = bytesField(top, 2);

    let transport = {};
    if (integralWrapBuf) {
        const integralWrap = decodeFields(integralWrapBuf);
        const transportBuf = bytesField(integralWrap, 1);
        if (transportBuf) transport = decodeWAMediaTransport(transportBuf);
    }
    let width, height;
    if (ancillaryBuf) {
        const anc = decodeFields(ancillaryBuf);
        height = numField(anc, 1);
        width = numField(anc, 2);
    }
    return { ...transport, width, height };
}

/**
 * Decodes a Content.{image,video,audio,document}Message object (as produced
 * by the vendor engine's normalizeE2EEMessage) into flat transport fields
 * usable by client.downloadMedia({directPath, mediaKey, mediaSha256, ...}).
 * @param {"image"|"video"|"audio"|"document"} kind
 * @param {object} mediaMessage e.g. content.imageMessage
 */
function decodeIncomingMedia(kind, mediaMessage) {
    if (!mediaMessage) return null;
    const sub = kind === "image" ? mediaMessage.image
        : kind === "video" ? mediaMessage.video
        : kind === "audio" ? mediaMessage.audio
        : mediaMessage.document;
    if (!sub) return null;

    const subBuf = Buffer.isBuffer(sub) ? sub
        : (sub.payload && Buffer.isBuffer(sub.payload)) ? sub.payload
        : null;
    if (!subBuf) return null;

    let payload;
    try {
        const proto = decodeSubProtocol(subBuf);
        payload = proto.payload ? decodeMediaTransportPayload(Buffer.from(proto.payload)) : decodeMediaTransportPayload(subBuf);
    } catch (_) {
        try { payload = decodeMediaTransportPayload(subBuf); } catch (__) { return null; }
    }
    if (!payload || !payload.directPath || !payload.mediaKey) return null;

    return {
        kind,
        directPath: payload.directPath,
        mediaKey: payload.mediaKey,
        fileSHA256: payload.fileSHA256,
        fileEncSHA256: payload.fileEncSHA256,
        mimeType: payload.mimeType || (kind === "image" ? "image/jpeg" : kind === "video" ? "video/mp4" : kind === "audio" ? "audio/ogg" : "application/octet-stream"),
        fileLength: payload.fileLength,
        width: payload.width,
        height: payload.height,
        fileName: mediaMessage.fileName || undefined
    };
}

module.exports = { decodeIncomingMedia, decodeFields, decodeSubProtocol, decodeWAMediaTransport };
