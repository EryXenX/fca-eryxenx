<div align="center">

# 💬 fca-eryxenx

**Unofficial Facebook Chat API for Node.js** - Fork of @dongdev/fca-unofficial with bug fixes and improvements

[Features](#-features) • [Installation](#-installation) • [Quick Start](#-quick-start) • [Documentation](#-documentation)

</div>

---

## ⚡ Why fca-eryxenx?

- ✅ `setMessageReaction` — threadID is now **optional** (backward compatible with all GoatBot commands)
- ✅ Fixed group message handling (parseDelta fix)
- ✅ Stable session management
- ✅ Based on [@dongdev/fca-unofficial](https://github.com/dongp06/fca-unofficial) v3.0.31

---

## ✨ Features

- ✅ **Full Messenger API** - Send messages, files, stickers, and more
- ✅ **Real-time Events** - Listen to messages, reactions, and thread events
- ✅ **AppState Support** - Save login state to avoid re-authentication
- ✅ **MQTT Protocol** - Real-time messaging via MQTT
- ✅ **TypeScript Support** - Includes TypeScript definitions

---

## 📦 Installation

```bash
npm install fca-eryxenx
```

**Requirements:**
- Node.js >= 12.0.0
- Active Facebook account

---

## 🚀 Quick Start

### 1️⃣ Login and Simple Echo Bot

```javascript
const login = require("fca-eryxenx");

login({ appState: [] }, (err, api) => {
  if (err) return console.error(err);

  api.listenMqtt((err, event) => {
    if (err) return console.error(err);
    if (event.type === "message") {
      api.sendMessage(event.body, event.threadID);
    }
  });
});
```

### 2️⃣ Send Text Message

```javascript
const login = require("fca-eryxenx");

login({ appState: [] }, (err, api) => {
  if (err) return console.error("Login Error:", err);

  const yourID = "000000000000000";
  api.sendMessage("Hey! 👋", yourID, (err) => {
    if (err) console.error(err);
    else console.log("✅ Message sent!");
  });
});
```

### 3️⃣ Send File/Image

```javascript
const login = require("fca-eryxenx");
const fs = require("fs");

login({ appState: [] }, (err, api) => {
  if (err) return console.error(err);

  const msg = {
    body: "Check this out! 📷",
    attachment: fs.createReadStream(__dirname + "/image.jpg"),
  };
  api.sendMessage(msg, "000000000000000");
});
```

---

## 📝 Message Types

| Type | Usage | Example |
| --- | --- | --- |
| **Regular text** | `{ body: "message" }` | `{ body: "Hello!" }` |
| **Sticker** | `{ sticker: "sticker_id" }` | `{ sticker: "369239263222822" }` |
| **File/Image** | `{ attachment: fs.createReadStream(path) }` | `{ attachment: fs.createReadStream("image.jpg") }` |
| **URL** | `{ url: "https://example.com" }` | `{ url: "https://github.com" }` |
| **Large emoji** | `{ emoji: "👍", emojiSize: "large" }` | `{ emoji: "👍", emojiSize: "large" }` |

---

## 💾 AppState Management

### Save AppState

```javascript
const fs = require("fs");
const login = require("fca-eryxenx");

login({ email: "YOUR_EMAIL", password: "YOUR_PASSWORD" }, (err, api) => {
  if (err) return console.error(err);
  fs.writeFileSync("appstate.json", JSON.stringify(api.getAppState(), null, 2));
  console.log("✅ AppState saved!");
});
```

### Use Saved AppState

```javascript
const fs = require("fs");
const login = require("fca-eryxenx");

login(
  { appState: JSON.parse(fs.readFileSync("appstate.json", "utf8")) },
  (err, api) => {
    if (err) return console.error(err);
    console.log("✅ Logged in!");
  }
);
```

---

## 🔄 Auto Login

Create `fca-config.json` in your project root:

```json
{
  "autoLogin": true,
  "apiServer": "https://minhdong.site",
  "apiKey": "",
  "credentials": {
    "email": "YOUR_EMAIL_OR_PHONE",
    "password": "YOUR_PASSWORD",
    "twofactor": ""
  }
}
```

---

## 👂 Listening for Messages

```javascript
const fs = require("fs");
const login = require("fca-eryxenx");

login(
  { appState: JSON.parse(fs.readFileSync("appstate.json", "utf8")) },
  (err, api) => {
    if (err) return console.error(err);

    api.setOptions({ listenEvents: true });

    api.listenMqtt((err, event) => {
      if (err) return console.error(err);

      switch (event.type) {
        case "message":
          api.sendMessage(`🤖 BOT: ${event.body}`, event.threadID);
          break;
        case "event":
          console.log("📢 Event:", event);
          break;
      }
    });
  }
);
```

---

## 🎯 API Quick Reference

### 📨 Messaging
`sendMessage`, `sendTypingIndicator`, `getMessage`, `editMessage`, `deleteMessage`, `unsendMessage`, `setMessageReaction`, `forwardAttachment`, `uploadAttachment`, `createPoll`

### 📬 Read Receipt
`markAsRead`, `markAsReadAll`, `markAsDelivered`, `markAsSeen`

### 👥 Thread Management
`getThreadInfo`, `getThreadList`, `getThreadHistory`, `deleteThread`, `changeThreadColor`, `changeThreadEmoji`, `changeGroupImage`, `setTitle`, `changeNickname`

### 👤 User & Group
`getUserInfo`, `getFriendsList`, `getCurrentUserID`, `createNewGroup`, `addUserToGroup`, `removeUserFromGroup`, `changeAdminStatus`

### 🔐 Auth & Listening
`logout`, `getAppState`, `setOptions`, `listenMqtt`

---

## 📄 License

MIT License — see [LICENSE-MIT](./LICENSE-MIT)

Original by [DongDev](https://github.com/dongp06) • Modified by [EryXenX](https://github.com/EryXenX)

---

<div align="center">

Made with ❤️ by EryXenX

</div>
