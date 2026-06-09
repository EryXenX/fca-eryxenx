<div align="center">

# 💬 fca-eryxenx

**Unofficial Facebook Chat API for Node.js** — Fork of @dongdev/fca-unofficial with stability fixes and new features

[Features](#-features) • [Installation](#-installation) • [Quick Start](#-quick-start) • [MessengerBot](#-messengerbot) • [createFcaClient](#-createfcaclient) • [Documentation](#-documentation)

</div>

---

## ⚡ Why fca-eryxenx?

- ✅ **Fixed MQTT subscribe race condition** — no more "Connection refused: No subscription existed" crashes
- ✅ **`isActiveClient()` guard** — stale MQTT client events no longer processed (stops duplicate messages / reconnect loops)
- ✅ **`connectTimeout` 5s → 12s** — no premature logout on slow networks
- ✅ **`close`/`disconnect` autoReconnect** — bot now actually reconnects after dropped connections
- ✅ **`setMessageReaction`** — threadID optional (backward compatible with all GoatBot commands)
- ✅ **`MessengerBot`** — Discord.js/Telegraf-style event-driven bot class
- ✅ **`createFcaClient`** — Namespaced facade API (`client.messages`, `client.threads`, etc.)
- ✅ **`attachThreadInfoRealtimeSync`** — SQLite thread cache kept in sync with realtime events
- ✅ Based on [@dongdev/fca-unofficial](https://github.com/dongp06/fca-unofficial)

---

## ✨ Features

- ✅ **Full Messenger API** — Send messages, files, stickers, reactions, and more
- ✅ **Real-time MQTT Events** — Messages, reactions, typing, thread events
- ✅ **MessengerBot** — High-level bot class with middleware pipeline
- ✅ **createFcaClient** — Domain-grouped namespaced facade
- ✅ **Thread Cache Sync** — Realtime SQLite cache invalidation
- ✅ **AppState Support** — Save/restore login state
- ✅ **TypeScript Definitions** — Full type support via `index.d.ts`
- ✅ **GoatBot Compatible** — Drop-in replacement

---

## 📦 Installation

```bash
npm install fca-eryxenx
```

**Requirements:** Node.js >= 12.0.0

---

## 🚀 Quick Start

### Classic style (GoatBot / Mirai compatible)

```javascript
const login = require("fca-eryxenx");

login({ appState: require("./appstate.json") }, (err, api) => {
  if (err) return console.error(err);
  api.setOptions({ listenEvents: true });
  api.listenMqtt((err, event) => {
    if (err) return console.error(err);
    if (event.type === "message") api.sendMessage(event.body, event.threadID);
  });
});
```

### Promise style

```javascript
const { login } = require("fca-eryxenx");

const api = await login({ appState: require("./appstate.json") });
api.listenMqtt((err, event) => { /* ... */ });
```

---

## 🤖 MessengerBot

High-level Discord.js/Telegraf-style bot interface.

### Basic usage

```javascript
const { createMessengerBot } = require("fca-eryxenx");

const bot = await createMessengerBot(
  { appState: require("./appstate.json") },
  {
    listenEvents: true,
    commandPrefix: "/",
    stopOnSignals: true
  }
);

bot.on("messageCreate", (event) => {
  console.log(`[${event.threadID}] ${event.body}`);
});

bot.command("ping", async (ctx) => {
  await ctx.replyAsync("pong 🏓");
});

bot.hears(/hello/i, async (ctx) => {
  await ctx.replyAsync("Hi there! 👋");
});

bot.hears("bye", async (ctx) => {
  ctx.reply("See you! 👋");
});

bot.catch((err, ctx) => {
  console.error("Middleware error:", err);
});
```

### MessengerBot Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `autoListen` | `boolean` | `true` | Start MQTT automatically after login |
| `enableComposer` | `boolean` | `true` | Enable middleware pipeline |
| `commandPrefix` | `string` | `"/"` | Prefix for `command()` matching |
| `stopOnSignals` | `boolean` | `false` | Auto-stop on SIGINT/SIGTERM |
| `maxEventListeners` | `number` | `64` | Max EventEmitter listeners (0 = unlimited) |

### Bot Events

| Event | Trigger |
|-------|---------|
| `message` / `messageCreate` | Any incoming message |
| `message_reply` | Reply to a message |
| `messageReactionAdd` | Reaction added |
| `messageDelete` | Message unsent |
| `typingStart` / `typingStop` | Typing indicator |
| `threadUpdate` | Thread metadata changed |
| `ready` / `shardReady` | MQTT connected |
| `raw` / `update` | Every MQTT delta (unfiltered) |
| `error` | Any error |

### MessengerContext (ctx)

| Property/Method | Description |
|----------------|-------------|
| `ctx.text` | Trimmed message body |
| `ctx.body` | Raw message body |
| `ctx.threadID` | Thread ID |
| `ctx.senderID` | Sender user ID |
| `ctx.messageID` | Message ID |
| `ctx.event` | Full event object |
| `ctx.reply(payload)` | Send reply (callback-style) |
| `ctx.replyAsync(payload)` | Send reply (returns Promise) |

### Lifecycle

```javascript
await bot.launch({ stopOnSignals: true });
await bot.stop(); // graceful shutdown
```

---

## 🎯 createFcaClient

Namespaced facade grouping all API methods by domain.

```javascript
const { createFcaClient } = require("fca-eryxenx");

login({ appState: require("./appstate.json") }, (err, api) => {
  const client = createFcaClient(api);

  // Messages
  await client.messages.send("Hello!", threadID);
  await client.messages.react(":heart:", messageID);
  await client.messages.markRead(threadID);

  // Threads
  const info = await client.threads.getInfo(threadID);
  const list = await client.threads.getList(10);
  await client.threads.setTitle("New Name", threadID);

  // Users
  const user = await client.users.getInfo(userID);
  const friends = await client.users.getFriends();

  // Account
  const myID = client.account.getCurrentUserID();
  await client.account.refreshDtsg();
  await client.account.logout();

  // Realtime
  const emitter = client.realtime.listen();
  emitter.on("message", (ev) => console.log(ev));
});
```

### Available Namespaces

| Namespace | Methods |
|-----------|---------|
| `messages` | `send`, `edit`, `delete`, `unsend`, `get`, `markRead`, `markReadAll`, `markSeen`, `markDelivered`, `typing`, `react`, `shareContact`, `uploadAttachment`, `forwardAttachment` |
| `threads` | `createGroup`, `getInfo`, `getList`, `getHistory`, `getPictures`, `addUsers`, `removeUser`, `setAdmin`, `setImage`, `setColor`, `setEmoji`, `setNickname`, `createPoll`, `delete`, `mute`, `setTitle`, `search`, `archive`, `handleMessageRequest` |
| `users` | `getID`, `getInfo`, `getInfoV2`, `getFriends` |
| `account` | `getCurrentUserID`, `changeAvatar`, `changeBio`, `logout`, `refreshDtsg`, `getAppState`, `getCookies`, `setOptions`, `handleFriendRequest`, `unfriend` |
| `realtime` | `listen`, `stop`, `stopAsync`, `useMiddleware`, `removeMiddleware` |
| `http` | `get`, `post`, `postFormData` |

---

## 🔄 Thread Cache Realtime Sync

Keeps SQLite thread cache in sync with realtime MQTT events. Call after login when Sequelize models are available:

```javascript
const { attachThreadInfoRealtimeSync } = require("fca-eryxenx");

login({ appState: require("./appstate.json") }, (err, api) => {
  // models = { Thread, User } from your Sequelize setup
  attachThreadInfoRealtimeSync(ctx, models, logger, api);
  // Now thread cache auto-updates on: name changes, member add/leave,
  // admin changes, nicknames, theme/color, approval mode, etc.
});
```

---

## 💾 AppState & Auto Login

```javascript
// Save appState
const fs = require("fs");
login({ email: "YOUR_EMAIL", password: "YOUR_PASSWORD" }, (err, api) => {
  fs.writeFileSync("appstate.json", JSON.stringify(api.getAppState()));
});

// Use saved appState
login({ appState: JSON.parse(fs.readFileSync("appstate.json", "utf8")) }, (err, api) => {
  // ...
});
```

### fca-config.json (auto login)

```json
{
  "autoLogin": true,
  "apiServer": "https://minhdong.site",
  "credentials": {
    "email": "YOUR_EMAIL",
    "password": "YOUR_PASSWORD",
    "twofactor": ""
  }
}
```

---

## 🎯 API Quick Reference

### Messaging
`sendMessage`, `editMessage`, `deleteMessage`, `unsendMessage`, `setMessageReaction`, `sendTypingIndicator`, `getMessage`, `forwardAttachment`, `uploadAttachment`, `shareContact`, `createPoll`

### Read Receipts
`markAsRead`, `markAsReadAll`, `markAsDelivered`, `markAsSeen`

### Thread Management
`getThreadInfo`, `getThreadList`, `getThreadHistory`, `getThreadPictures`, `deleteThread`, `changeThreadColor`, `changeThreadEmoji`, `changeGroupImage`, `setTitle`, `changeNickname`, `changeAdminStatus`, `addUserToGroup`, `removeUserFromGroup`, `createNewGroup`, `muteThread`, `changeArchivedStatus`, `handleMessageRequest`, `searchForThread`

### Users
`getUserInfo`, `getUserInfoV2`, `getUserID`, `getFriendsList`

### Account
`getCurrentUserID`, `logout`, `getAppState`, `setOptions`, `listenMqtt`, `refreshFb_dtsg`, `changeAvatar`, `changeBio`, `handleFriendRequest`, `unfriend`, `enableAutoSaveAppState`

---

## 📄 License

MIT License — see [LICENSE-MIT](./LICENSE-MIT)

Original by [DongDev](https://github.com/dongp06) • Modified by [EryXenX](https://github.com/EryXenX)

---

<div align="center">

Made with ❤️ by EryXenX

</div>
