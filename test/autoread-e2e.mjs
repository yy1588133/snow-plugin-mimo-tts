// 自动播报端到端：模拟 messages 实时域推送，验证「不补播旧消息 / 流式中不播 / 结束后只播一次」
// 运行：$env:MIMO_KEY="sk-..."; node test/autoread-e2e.mjs
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const KEY = process.env.MIMO_KEY || "";
if (!KEY) {
  console.error("缺少环境变量 MIMO_KEY");
  process.exit(2);
}

/* ---------- 最小 IndexedDB 桩 ---------- */
function makeIdb() {
  const stores = new Map();
  let created = false;
  function request(run) {
    const req = {};
    queueMicrotask(() => {
      try {
        req.result = run();
        if (req.onsuccess) req.onsuccess();
      } catch (err) {
        req.error = err;
        if (req.onerror) req.onerror();
      }
    });
    return req;
  }
  function storeApi(name) {
    const map = stores.get(name);
    return {
      getAll: () => request(() => Array.from(map.values())),
      put: (value) =>
        request(() => {
          map.set(value.id, Object.assign({}, value));
          return value.id;
        }),
      delete: (key) =>
        request(() => {
          map.delete(key);
        }),
      clear: () =>
        request(() => {
          map.clear();
        }),
    };
  }
  const db = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore: (name) => {
      stores.set(name, new Map());
      return { createIndex() {} };
    },
    transaction: () => ({ objectStore: (name) => storeApi(name) }),
    close() {},
  };
  return {
    open() {
      const req = {};
      queueMicrotask(() => {
        if (!created) {
          created = true;
          stores.set("clips", new Map());
          stores.set("samples", new Map());
          req.result = db;
          if (req.onupgradeneeded) req.onupgradeneeded();
        }
        req.result = db;
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}

/* ---------- 宿主 API 桩：捕获 messages 订阅回调 ---------- */
const subscriptions = {};
const store = new Map();
const fakeApi = {
  t: (key, options) => (options && options.defaultValue) || key,
  storage: {
    async getJson(key) {
      const raw = store.get(key);
      return raw ? JSON.parse(raw) : null;
    },
    async setJson(key, value) {
      store.set(key, JSON.stringify(value));
    },
  },
  net: {
    async fetch(url, options) {
      try {
        const res = await fetch(url, {
          method: options.method,
          headers: options.headers,
          body: options.body,
          signal: AbortSignal.timeout(options.timeoutMs || 60000),
        });
        const buf = Buffer.from(await res.arrayBuffer());
        return { ok: res.ok, status: res.status, statusText: res.statusText, headers: {}, url, body: "", bodyBase64: buf.toString("base64") };
      } catch (err) {
        return { ok: false, status: 0, statusText: "", headers: {}, url, body: "", error: String(err && err.message) };
      }
    },
  },
  metadata: {
    async subscribe(domain, listener) {
      subscriptions[domain] = listener;
      return { unsubscribe() { delete subscriptions[domain]; } };
    },
    async get() {
      return { generatedAt: Date.now(), domains: {}, denied: {}, withheld: {}, unknown: [] };
    },
  },
};

/* ---------- 播放器桩：让 speak() 真正跑完状态机 ---------- */
if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:stub";
  URL.revokeObjectURL = () => {};
}
globalThis.Audio = class FakeAudio {
  constructor(src) {
    this.src = src;
    this.duration = 2;
    this.currentTime = 0;
    this.volume = 1;
    this.playbackRate = 1;
  }
  play() {
    setTimeout(() => {
      if (this.onended) this.onended();
    }, 20);
    return Promise.resolve();
  }
  pause() {}
  removeAttribute() {}
};

globalThis.window = { SnowAppPlugin: { React: null, icons: {}, api: fakeApi, locale: "zh-CN" } };
globalThis.indexedDB = makeIdb();

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "index.js"), "utf8");
const generated = join(tmpdir(), "mtts-autoread-" + process.pid + ".mjs");
writeFileSync(
  generated,
  source +
    "\nexport { startWatcher, handleMessages, updateSettings, getSettings, listClips, cleanText };\n",
  "utf8"
);
const mod = await import(pathToFileURL(generated).href);

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok || extra === undefined ? "" : "  → " + JSON.stringify(extra)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitIdle(timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = window.snowMimoTts.getState();
    if (state.status === "idle" || state.status === "error") return state;
    await sleep(120);
  }
  return window.snowMimoTts.getState();
}

/* ---------- 准备 ---------- */
mod.updateSettings(
  {
    apiKey: KEY,
    baseUrl: "https://api.xiaomimimo.com/v1",
    model: "mimo-v2.5-tts",
    voice: "冰糖",
    instruction: "",
    range: "full",
    localMode: "off",
    autoRead: true,
    sfx: false,
  },
  { persist: false }
);
await mod.startWatcher();
check("已订阅 messages 实时域", typeof subscriptions.messages === "function");

const oldMessage = { id: "m-old", role: "assistant", content: "这是一条早就存在的旧回复，不应该被补播。", createdAt: Date.now() - 60000 };
const userMessage = { id: "u-1", role: "user", content: "你好", createdAt: Date.now() - 5000 };

/* 1. 首次快照：建立基线，不朗读历史 */
subscriptions.messages({
  domains: { messages: { conversationId: "c1", live: { isStreaming: false }, items: [userMessage, oldMessage] } },
});
await sleep(300);
check("首次快照不补播旧消息", window.snowMimoTts.getState().status === "idle", window.snowMimoTts.getState().status);
check("播报前没有音频历史", (await mod.listClips()).length === 0);

/* 2. 流式中：不朗读 */
const streamingMessage = { id: "m-new", role: "assistant", content: "这是新回复的第一句。", createdAt: Date.now() };
subscriptions.messages({
  domains: { messages: { conversationId: "c1", live: { isStreaming: true }, items: [userMessage, oldMessage, streamingMessage] } },
});
await sleep(400);
check("流式过程中保持安静", window.snowMimoTts.getState().status === "idle", window.snowMimoTts.getState().status);

/* 3. 流式结束：朗读一次 */
const finalMessage = {
  id: "m-new",
  role: "assistant",
  content: "这是新回复的第一句。这是第二句，用来凑出两段音频。",
  createdAt: Date.now(),
};
subscriptions.messages({
  domains: { messages: { conversationId: "c1", live: { isStreaming: false }, items: [userMessage, oldMessage, finalMessage] } },
});
await sleep(600);
const during = window.snowMimoTts.getState();
check("结束后自动开始播报", during.status === "buffering" || during.status === "playing", during.status);

const done = await waitIdle();
check("播报正常结束（无错误）", done.status === "idle", done);
check("朗读的是新回复而不是旧回复", done.text.indexOf("这是新回复") >= 0, done.text);
check("旧回复没有被读", done.text.indexOf("旧回复") < 0, done.text);

const clipsAfter = await mod.listClips();
check("历史写入一条音频", clipsAfter.length === 1, clipsAfter.length);
check("历史文本对应新回复", clipsAfter[0] && clipsAfter[0].text.indexOf("这是新回复") >= 0, clipsAfter[0] && clipsAfter[0].text);
check("历史记录为完整音频", clipsAfter[0] && clipsAfter[0].whole === true, clipsAfter[0] && clipsAfter[0].whole);

/* 4. 同一快照重复推送：不重复朗读 */
subscriptions.messages({
  domains: { messages: { conversationId: "c1", live: { isStreaming: false }, items: [userMessage, oldMessage, finalMessage] } },
});
await sleep(800);
check("同一回复重复推送不会二次播报", (await mod.listClips()).length === 1, (await mod.listClips()).length);

/* 5. 切换会话：建立新基线，不朗读 */
subscriptions.messages({
  domains: { messages: { conversationId: "c2", live: { isStreaming: false }, items: [{ id: "m-c2", role: "assistant", content: "另一个会话里的旧回复。" }] } },
});
await sleep(500);
check("切会话不补播", (await mod.listClips()).length === 1, (await mod.listClips()).length);

/* 6. 关闭自动播报后不朗读 */
mod.updateSettings({ autoRead: false }, { persist: false });
subscriptions.messages({
  domains: {
    messages: {
      conversationId: "c2",
      live: { isStreaming: false },
      items: [
        { id: "m-c2", role: "assistant", content: "另一个会话里的旧回复。" },
        { id: "m-c2b", role: "assistant", content: "自动播报关掉之后，这条不该被读出来。" },
      ],
    },
  },
});
await sleep(800);
check("关闭自动播报后不朗读", (await mod.listClips()).length === 1, (await mod.listClips()).length);

try {
  unlinkSync(generated);
} catch (e) {}

console.log(failures === 0 ? "\n自动播报：ALL PASS" : "\n自动播报：" + failures + " 项失败");
process.exit(failures === 0 ? 0 : 1);
