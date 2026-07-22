<div align="center">

# 💬 fca-eryxenx

**Unofficial Facebook Messenger Bot API for Node.js**
NEXCA MQTT · Signal Protocol E2EE (mautrix-go powered) · sessionGuard · 90+ API Methods · Zero TypeScript

[![npm](https://img.shields.io/npm/v/fca-eryxenx?color=blue)](https://www.npmjs.com/package/fca-eryxenx)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE-MIT)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

[Features](#-features) • [Installation](#-installation) • [Quick Start](#-quick-start) • [E2EE](#-e2ee--encrypted-conversations) • [sessionGuard](#-sessionguard) • [sendBroadcast](#-sendbroadcast) • [API Reference](#-api-reference)

</div>

---

## ⚡ Why fca-eryxenx?

- ✅ **NEXCA MQTT** — stable connection core, autoReconnect, jitter
- ✅ **Signal Protocol E2EE** — Facebook real encrypted conversations support. Reliable media/reaction/unsend delivery is powered by a bundled **mautrix-go / mautrix-meta** native engine (© Tulir Asokan, MPL-2.0) — NEXCA's own hand-written E2EE encoder produced protocol-valid messages that Facebook accepted but Messenger clients failed to render for attachments/reactions/unsend, so this fork routes those through the native engine instead. Text messaging still uses the original engine (already reliable).
- ✅ **sessionGuard** — appstate corruption and silent logout protection, auto-backup
- ✅ **sendBroadcast** — rate-limited multi-thread broadcast
- ✅ **Fixed MQTT subscribe race condition** — no more "Connection refused: No subscription existed"
- ✅ **`isActiveClient()` guard** — stale MQTT client events no longer processed
- ✅ **`connectTimeout` extended** — no premature logout on slow networks
- ✅ **autoReconnect** — auto-reconnect on connection drop
- ✅ **GoatBot compatible** — all API signatures unchanged (`threadID` optional etc.)
- ✅ **90+ API methods** — sendMessage, editMessage, setMessageReaction, getThreadInfo and more

---

## ✨ Features

- ✅ Full Messenger API — messages, reactions, attachments, stickers, polls, pins
- ✅ NEXCA MQTT — stable connection, autoReconnect, jitter, isActiveClient guard
- ✅ E2EE — Signal Protocol encrypted threads, auto-connects after login (listenE2EE, e2ee.*)
- ✅ E2EE media engine — native mautrix-go engine for reliable image/video/audio/document sending, reactions, and unsend in encrypted threads (falls back to the built-in JS engine automatically)
- ✅ E2EE incoming media — attachments on encrypted messages (including replies) are auto-decrypted and served locally, so existing commands work unmodified
- ✅ sessionGuard — appstate auto-save, corruption guard, .bak backup
- ✅ sendBroadcast — parallel/sequential multi-thread sending with rate limit
- ✅ MessengerBot — Discord.js/Telegraf style (.command, .hears, .launch)
- ✅ createFcaClient — namespaced facade (client.messages, client.threads etc.)
- ✅ GoatBot / Mirai compatible — drop-in replacement

---

## 📦 Installation

```bash
npm install fca-eryxenx
```

Node.js >= 20 required.

The E2EE media engine ships a precompiled native binary (`src/api/socket/e2ee/native/build/`) for **Linux (.so)** and **Windows (.dll)**, loaded via the `koffi` FFI. `npm install` pulls in `koffi` and `yumi-json-bigint` automatically — no extra setup needed. If your deployment platform isn't Linux/Windows x64 (e.g. macOS, ARM), the native engine will fail to load and E2EE media/reactions/unsend automatically fall back to the built-in JS engine (text messaging is unaffected either way).

---

## 🚀 Quick Start

### Classic (GoatBot compatible)

```javascript
const login = require("fca-eryxenx");

login({ appState: require("./account.json") }, { listenEvents: true }, (err, api) => {
  if (err) throw err;

  api.sessionGuard("./account.json", {
    interval: 3 * 60 * 1000,
    debounce: 30 * 1000
  });

  api.listenMqtt((err, event) => {
    if (err) throw err;
    if (event.type === "message") api.sendMessage(event.body, event.threadID);
  });
});
```

### With E2EE (regular + encrypted threads)

`connectE2EE()` runs **automatically** right after login — you never call it yourself. Calling it again in your own code opens a second, racing connection on the same bridge. Just check `api.e2ee.isConnected()` if you need to know the status.

```javascript
login({ appState: require("./account.json") }, { listenEvents: true }, (err, api) => {
  if (err) throw err;

  api.sessionGuard("./account.json");
  // E2EE is already connecting in the background here — do not call connectE2EE().

  api.listenE2EE((err, event) => {
    if (err) throw err;
    if (event.type === "message") {
      if (event.isE2EE) {
        api.e2ee.sendMessage(event.threadID, "Got your encrypted message!");
      } else {
        api.sendMessage("Got it!", event.threadID);
      }
    }
  });
});
```

### GoatBot login.js

```javascript
const login = require("fca-eryxenx");

login({ appState }, options, (err, api) => {
  if (err) return;

  api.sessionGuard(path.join(process.cwd(), "account.txt"), {
    interval: 3 * 60 * 1000,
    debounce: 30 * 1000
  });

  // Nothing else needed for E2EE — it auto-connects inside fca-eryxenx
  // right after login. Do NOT call api.connectE2EE() here.

  api.listenMqtt(callback);
});
```

**This is the only setup needed — nothing else in `login.js` (or anywhere in GoatBot) has to change for E2EE.** Once login succeeds, `api.e2ee` is already connecting in the background, and every existing GoatBot call — `api.sendMessage(...)` (with or without `attachment`), `api.setMessageReaction(...)`, `api.unsendMessage(...)` — automatically detects when a thread is an encrypted DM and routes through the E2EE engine internally. Commands don't need to know or care whether a thread is encrypted; they call the same functions either way.

#### Adding this to your own login.js

Your bot's actual `login.js` will look different from the snippet above (dashboard setup, database sync, custom logging, etc.) — you're not replacing the file, just adding/checking two things inside your existing login callback:

| Step | What to do |
|---|---|
| 1. sessionGuard | Add `api.sessionGuard(accountPath, { interval, debounce })` once, right after login succeeds, if it's not already there. |
| 2. E2EE | Nothing to add — it's automatic. If your `login.js` already has an explicit `await api.connectE2EE()` call, **delete it** — it's redundant with the automatic connection and the two can race. |

To check whether E2EE is already wired into your bot, search for `e2ee.isConnected` in your `login.js` — if it's there, setup is already done.

---

## 🔐 E2EE — Encrypted Conversations

Uses Facebook's real Signal Protocol infrastructure — same as the official Messenger app.

### Setup

E2EE connects automatically after login (creating `.nexca/e2ee_device.json` on first run) — there's nothing to call manually. Just check status once connected:

```javascript
console.log(api.e2ee.isConnected()); // true (may need a moment right after login)
```

### Listen (regular + E2EE combined)

```javascript
api.listenE2EE((err, event) => {
  if (event.type === "message") {
    if (event.isE2EE) {
      api.e2ee.sendMessage(event.threadID, "Encrypted reply!");
    } else {
      api.sendMessage("Normal reply!", event.threadID);
    }
  }
});
```

### E2EE Methods

```javascript
await api.e2ee.sendMessage(threadID, "Hello!");
await api.e2ee.sendMessage(threadID, { body: "Photo!", attachment: fs.createReadStream("photo.jpg") });
await api.e2ee.sendReaction(threadID, messageID, "❤️");
await api.e2ee.sendTyping(threadID, true);
await api.e2ee.unsendMessage(messageID, threadID);
await api.e2ee.editMessage(threadID, messageID, "Updated!");
api.e2ee.isConnected();
await api.e2ee.disconnect();
```

### Native media engine

Sending image/video/audio/document attachments, reactions, and unsend in E2EE threads is routed through a precompiled **mautrix-go / mautrix-meta** binary (`src/api/socket/e2ee/native/`) via the `koffi` FFI, instead of this project's own hand-written Signal Protocol encoder. This project's own encoder builds protocol-valid messages that Facebook's servers accept, but real Messenger clients silently fail to render — the native engine avoids that entirely.

- Text messages always use fca-eryxenx's own E2EE engine (already reliable, no native dependency).
- If the native engine fails to load or a send fails (unsupported platform, binary mismatch, etc.), fca-eryxenx automatically falls back to its own engine and logs `[native-media] ... falling back to legacy vendor engine`.
- See `src/api/socket/e2ee/native/NOTICE.md` for the required MPL-2.0 attribution to the upstream mautrix-go/mautrix-meta project (© Tulir Asokan and contributors) — do not remove it if you redistribute this fork.

### Receiving E2EE media (attachments & replies)

Incoming encrypted image/video/audio/document messages are automatically decrypted and served over a short-lived local URL (`http://127.0.0.1:<port>/<token>`, 15 min TTL), and populated into `event.attachments` / `event.messageReply.attachments` — same shape as normal (non-E2EE) attachments. Reply-based commands (e.g. "reply to an image with `/imgur`") work the same in E2EE threads as in normal ones, no command code changes needed.

```javascript
if (event.messageReply && event.messageReply.attachments.length) {
  const url = event.messageReply.attachments[0].url; // works for E2EE too
}
```

If media resolution fails, check the console for `[media-resolve]` / `[media-decode]` errors — this usually means the CDN download host (`FB_E2EE_MEDIA_DOWNLOAD_HOST` env var, default `rupload.facebook.com`) needs adjusting for your account/region.

---

## 🛡️ sessionGuard

Protects your appstate from corruption and silent logouts.

```javascript
api.sessionGuard("./account.json");

// Custom timing
api.sessionGuard("./account.json", {
  interval: 3 * 60 * 1000,
  debounce: 30 * 1000
});
```

What it does:
- Auto-saves appstate every N minutes
- Saves after every successful sendMessage (debounced)
- Corruption guard — never overwrites a larger appstate with a smaller one
- Auto-backup — writes `.bak` before every overwrite

```javascript
api.saveSession();           // force save now
api.restoreSessionBackup();  // restore from .bak
api.stopSessionGuard();      // stop the timer
```

---

## 📡 sendBroadcast

Rate-limited multi-thread broadcast.

```javascript
const result = await api.sendBroadcast(
  "Hello everyone!",
  ["THREAD_1", "THREAD_2", "THREAD_3"],
  {
    delay: 2000,
    parallel: 2,
    onEach: (err, info, id) => {
      console.log(err ? "Failed: " + id : "Sent: " + id);
    }
  }
);
console.log(result.sent.length + "/" + result.total + " delivered");
```

---

## 🤖 MessengerBot

Discord.js/Telegraf style high-level bot class.

```javascript
const { createMessengerBot } = require("fca-eryxenx");

const bot = await createMessengerBot(
  { appState: require("./account.json") },
  { commandPrefix: "/", stopOnSignals: true }
);

bot.command("ping", async ctx => await ctx.replyAsync("pong 🏓"));
bot.hears(/hello/i, async ctx => await ctx.replyAsync("Hi! 👋"));
bot.on("messageCreate", event => console.log(event.body));

await bot.launch({ stopOnSignals: true });
```

---

## 🎯 createFcaClient

Namespaced facade grouping all API methods by domain.

```javascript
const { createFcaClient } = require("fca-eryxenx");
const client = createFcaClient(api);

await client.messages.send("Hello!", threadID);
await client.messages.react("❤️", messageID, threadID);
await client.threads.getInfo(threadID);
await client.users.getInfo(userID);
await client.account.refreshDtsg();
```

---

## 📖 API Reference

### Sending Messages

```javascript
api.sendMessage("Hello!", threadID);
api.sendMessage({ body: "Photo!", attachment: fs.createReadStream("photo.jpg") }, threadID);
api.sendMessage({ body: "Hey @John", mentions: [{ id: "uid", tag: "@John", fromIndex: 4 }] }, threadID);
api.sendMessage({ sticker: "369239263222822" }, threadID);
api.sendMessage({ location: { latitude: 23.8, longitude: 90.4, current: true } }, threadID);
api.sendBroadcast("msg", ["tid1", "tid2"], { delay: 2000 });
api.sendGif("https://media.giphy.com/xyz.gif", threadID);
api.sendLocation(23.8, 90.4, threadID);
api.sendImage("./photo.jpg", threadID, "caption");
api.sendVideo("./video.mp4", threadID);
api.sendAudio("./voice.ogg", threadID);
api.sendFile("./doc.pdf", threadID);
api.shareLink("https://github.com", threadID, "Check this!");
api.shareContact("Meet my friend!", userID, threadID);
```

### Message Actions

```javascript
api.editMessage("Updated text", messageID);
api.unsendMessage(messageID);
api.deleteMessage([messageID]);
api.setMessageReaction("😍", messageID, threadID);  // threadID optional
api.setMessageReaction("", messageID);               // remove reaction
api.getMessage(threadID, messageID);
api.forwardAttachment(attachmentID, [userID]);
api.uploadAttachment([fs.createReadStream("photo.jpg")]);
```

### Read Receipts & Typing

```javascript
api.markAsRead(threadID);
api.markAsReadAll();
api.markAsDelivered(threadID, messageID);
api.markAsSeen();
api.sendTypingIndicator(threadID, true);
```

### Thread Management

```javascript
api.getThreadInfo(threadID);
api.getThreadList(10, null, ["INBOX"]);
api.getThreadHistory(threadID, 20);
api.createGroup("Hey!", ["uid1", "uid2"]);
api.deleteThread(threadID);
api.muteThread(threadID, 3600);
api.changeArchivedStatus(threadID, true);
api.handleMessageRequest(threadID, true);
api.searchForThread("query");
```

### Thread Customization

```javascript
api.setTitle("New Name", threadID);
api.changeThreadColor("#0084FF", threadID);
api.changeThreadEmoji("🔥", threadID);
api.changeNickname("The Boss", threadID, userID);
api.changeGroupImage(fs.createReadStream("group.jpg"), threadID);
api.changeAdminStatus(threadID, userID, true);
api.addUserToGroup(userID, threadID);
api.removeUserFromGroup(userID, threadID);
api.createPoll("Question?", threadID, { "Yes": false, "No": false });
api.pinMessage(messageID, threadID);
api.unpinMessage(messageID, threadID);
```

### User Info

```javascript
api.getUserInfo(userID);
api.getUserID("John Doe", callback);
api.getUID("https://facebook.com/zuck");
api.getFriendsList();
api.getAvatarUser(userID);
api.getProfileInfo(userID);
api.getPublicData(userID);
api.sendFriendRequest(userID);
api.handleFriendRequest(userID, true);
api.changeBlockedStatus(userID, true);
api.followUser(userID);
api.unfollowUser(userID);
api.unfriend(userID);
```

### Social

```javascript
api.reactToPost(postID, "love");
api.reactToComment(commentID, "haha");
api.postComment(postID, "Great post!");
api.sharePost(postID, "Check this!");
```

### Account & Config

```javascript
api.getCurrentUserID();
api.getAppState();
api.setOptions({ listenTyping: true });
api.logout();
api.refreshFb_dtsg();
api.addExternalModule("myFunc", (defaultFuncs, api, ctx) => {
  return function(text, threadID) {
    return api.sendMessage("[BOT] " + text, threadID);
  };
});
```

### HTTP Utilities

```javascript
api.httpGet(url, params, callback);
api.httpPost(url, form, callback);
api.httpPostFormData(url, form, callback);
api.uploadImageToImgbb(imageUrl);
```

---

## 📋 Login Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `selfListen` | boolean | false | Receive your own sent messages |
| `listenEvents` | boolean | true | Receive thread/group events |
| `listenTyping` | boolean | false | Receive typing indicator events |
| `updatePresence` | boolean | false | Receive online/offline presence events |
| `autoMarkDelivery` | boolean | false | Auto-mark incoming messages as delivered |
| `autoMarkRead` | boolean | false | Auto-mark threads as read |
| `autoReconnect` | boolean | true | Auto-reconnect MQTT on disconnect |
| `online` | boolean | false | Appear as online to others |
| `emitReady` | boolean | false | Emit ready event when MQTT connected |
| `proxy` | string | — | HTTP proxy URL |
| `userAgent` | string | Safari UA | Override HTTP User-Agent |

---

## 📄 License

MIT License

**fca-eryxenx** by [EryXenX (Mohammad Akash)](https://github.com/EryXenX)

> The E2EE native media engine (`src/api/socket/e2ee/native/`) bundles a
> precompiled binary built from **mautrix-go** / **mautrix-meta**, © Tulir
> Asokan and contributors, licensed under **MPL-2.0** (not MIT). See
> `src/api/socket/e2ee/native/NOTICE.md` for full attribution — this notice
> must be preserved in any redistribution of this fork.
NEXCA MQTT core by [Deku](https://github.com/dekuzxc) — MIT License

> Unauthorized copying or redistribution without credit is prohibited.

---

<div align="center">

Made with ❤️ by EryXenX

</div>
