# fca-eryxenx

**Facebook Chat API** - Modified & Enhanced by **EryXenX**

Based on [@dongdev/fca-unofficial](https://github.com/dongp06/fca-unofficial) with improvements.

## 🔥 What's New in fca-eryxenx

- ✅ `setMessageReaction` — threadID is now **optional** (backward compatible with all GoatBot commands)
- ✅ More stable session management
- ✅ Auto re-login support

## 📦 Installation

```bash
npm install fca-eryxenx
```

## 🚀 Usage

```js
const login = require("fca-eryxenx");

login({ appState: JSON.parse(require("fs").readFileSync("account.txt", "utf8")) }, (err, api) => {
    if (err) return console.error(err);
    console.log("Logged in!");
});
```

## 👤 Author

**EryXenX** - [GitHub](https://github.com/EryXenX)

Original by [DongDev](https://github.com/dongp06)
