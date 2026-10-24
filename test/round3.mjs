// 第三轮回归：设置读盘竞态（不能冲掉已保存的 Key） / 插槽按钮的取消与空正文提示
// 运行：node test/round3.mjs
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/* ---------- 最小 DOM ---------- */
function makeElement(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    ownerDocument: null,
    listeners: Object.create(null),
    style: {},
    attributes: Object.create(null),
    appendCount: 0,
    classList: {
      _set: new Set(),
      add(n) { this._set.add(n); },
      remove(n) { this._set.delete(n); },
      contains(n) { return this._set.has(n); },
    },
    textContent: "",
    innerHTML: "",
    title: "",
    type: "",
    disabled: false,
    setAttribute(n, v) { this.attributes[n] = String(v); },
    getAttribute(n) { return n in this.attributes ? this.attributes[n] : null; },
    appendChild(child) {
      this.appendCount += 1;
      if (child.parentNode && child.parentNode !== this) child.parentNode.removeChild(child);
      if (this.children.indexOf(child) < 0) this.children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    addEventListener(t, fn) { (this.listeners[t] || (this.listeners[t] = [])).push(fn); },
    removeEventListener(t, fn) {
      const list = this.listeners[t];
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    querySelectorAll(sel) {
      const out = [];
      const name = String(sel).replace(/^\./, "");
      (function walk(p) {
        p.children.forEach((c) => {
          if (c.classList && c.classList.contains(name)) out.push(c);
          walk(c);
        });
      })(node);
      return out;
    },
  };
  Object.defineProperty(node, "nextElementSibling", {
    get() {
      const p = this.parentNode;
      if (!p) return null;
      const i = p.children.indexOf(this);
      return i >= 0 ? p.children[i + 1] || null : null;
    },
  });
  Object.defineProperty(node, "lastChild", {
    get() { return this.children.length ? this.children[this.children.length - 1] : null; },
  });
  Object.defineProperty(node, "lastElementChild", {
    get() { return this.children.length ? this.children[this.children.length - 1] : null; },
  });
  node.ownerDocument = doc;
  return node;
}
const doc = { createElement: makeElement };
globalThis.document = doc;

/* ---------- 播放轮询可手动触发 ---------- */
let intervalFn = null;
globalThis.setInterval = (fn) => {
  intervalFn = fn;
  return 1;
};
globalThis.clearInterval = () => {
  intervalFn = null;
};

/* ---------- IndexedDB 桩 ---------- */
function makeIdb() {
  const stores = new Map();
  let created = false;
  const request = (run) => {
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
  };
  const storeApi = (name) => {
    const map = stores.get(name);
    return {
      getAll: () => request(() => Array.from(map.values())),
      get: (k) => request(() => map.get(k)),
      put: (v) => request(() => (map.set(v.id, Object.assign({}, v)), v.id)),
      delete: (k) => request(() => map.delete(k)),
      clear: () => request(() => map.clear()),
    };
  };
  const db = {
    objectStoreNames: { contains: (n) => stores.has(n) },
    createObjectStore: (n) => (stores.set(n, new Map()), { createIndex() {} }),
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

/* ---------- AudioContext：长播放，便于中途停止 ---------- */
class FakeAudioContext {
  constructor() {
    this.state = "running";
    this.currentTime = 0;
    this.destination = {};
  }
  resume() { return Promise.resolve(); }
  createBufferSource() {
    return {
      playbackRate: { value: 1 },
      onended: null,
      connect() {},
      disconnect() {},
      stop() { this.stopped = true; clearTimeout(this.t); },
      start() { this.t = setTimeout(() => this.onended && this.onended(), 5000); },
    };
  }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  createOscillator() { return { type: "sine", frequency: { value: 1 }, connect() {}, start() {}, stop() {} }; }
  decodeAudioData(buf, ok) { setTimeout(() => ok({ duration: 1 }), 0); }
}

function toneWavBase64() {
  const pcm = Buffer.alloc(960);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]).toString("base64");
}

/* ---------- 宿主 API：首读盘故意慢一点，制造「读盘与用户操作并发」 ---------- */
const savedJson = {
  "settings.v1": JSON.stringify({ apiKey: "sk-saved", voice: "苏打", rate: 1.5, model: "mimo-v2.5-tts" }),
};
const writes = [];
let fetchCount = 0;
const fakeApi = {
  t: (k, o) => (o && o.defaultValue) || k,
  storage: {
    async getJson(k) {
      await new Promise((r) => setTimeout(r, 40));
      const raw = savedJson[k];
      return raw ? JSON.parse(raw) : null;
    },
    async setJson(k, v) {
      writes.push(v);
      savedJson[k] = JSON.stringify(v);
    },
  },
  net: {
    async fetch() {
      fetchCount += 1;
      return {
        ok: true,
        status: 200,
        headers: {},
        url: "x",
        body: "",
        bodyBase64: Buffer.from(JSON.stringify({ choices: [{ message: { audio: { data: toneWavBase64() } } }] })).toString("base64"),
      };
    },
  },
  metadata: {
    async subscribe() {
      return { unsubscribe() {} };
    },
    async get() {
      return {
        domains: {
          messages: {
            conversationId: "c1",
            items: [
              { id: "m1", role: "assistant", content: "这是一条用来测试取消行为的助手回复，内容足够长。" },
              { id: "m2", role: "assistant", content: "```js\nconst a = 1;\n```" },
            ],
          },
        },
      };
    },
  },
  log() {},
};

globalThis.window = {
  SnowAppPlugin: { React: null, icons: {}, api: fakeApi, locale: "zh-CN" },
  AudioContext: FakeAudioContext,
  speechSynthesis: { getVoices: () => [], speak() {}, cancel() {}, pause() {}, resume() {} },
};
globalThis.indexedDB = makeIdb();

const source = readFileSync(join(here, "..", "index.js"), "utf8");
const generated = join(tmpdir(), "mtts-round3-" + process.pid + ".mjs");
writeFileSync(generated, source + "\nexport { getSettings, updateSettings, loadSettings, engineState, stop, speak };\n", "utf8");
const mod = await import(pathToFileURL(generated).href);

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok || extra === undefined ? "" : "  → " + JSON.stringify(extra)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 1. 读盘期间改设置，不能冲掉已保存的 Key / 音色 ---------- */
console.log("\n[1] 设置读盘与用户修改的竞态");
mod.updateSettings({ autoRead: true });
await mod.loadSettings();
await sleep(450); // 等防抖写盘落地
const afterRace = mod.getSettings();
check("用户刚改的值生效", afterRace.autoRead === true, afterRace.autoRead);
check("已保存的 API Key 没有被默认值冲掉", afterRace.apiKey === "sk-saved", afterRace.apiKey);
check("已保存的音色没有被默认值冲掉", afterRace.voice === "苏打", afterRace.voice);
check("已保存的语速没有被默认值冲掉", afterRace.rate === 1.5, afterRace.rate);
check("写回存储的仍是完整设置", writes.length > 0 && writes[writes.length - 1].apiKey === "sk-saved", writes.slice(-1));

/* 准备后续播放测试 */
mod.updateSettings({ baseUrl: "https://x.invalid/v1", localMode: "off", sfx: false, range: "full" }, { persist: false });

function makeSignal() {
  const listeners = [];
  return {
    aborted: false,
    addEventListener(type, fn) { if (type === "abort") listeners.push(fn); },
    abort() { this.aborted = true; listeners.slice().forEach((fn) => fn()); },
  };
}
function hintOf(container) {
  const root = container.children[0];
  return root ? String(root.children[2].textContent || "") : "";
}

/* ---------- 2. 播放中按停止：不报错、不误报缺 Key ---------- */
console.log("\n[2] 插槽按钮：用户取消后的提示");
const c1 = makeElement("div");
const cleanup1 = mod.mountFooter(c1, fakeApi, { messageId: "m1" }, makeSignal());
const root1 = c1.children[0];
root1.children[0].listeners.click[0]();
await sleep(250);
check("点击后开始播放", mod.engineState.status === "playing", mod.engineState.status);
root1.children[1].listeners.click[0]();
await sleep(120);
const hint1 = hintOf(c1);
check("取消后不误报缺 Key", hint1.indexOf("Key") < 0, hint1);
check("取消后不残留错误提示", hint1 === "", hint1);
cleanup1();

/* ---------- 3. 正文只有代码块：提示「没有可朗读的文字」而不是缺 Key ---------- */
console.log("\n[3] 插槽按钮：正文清洗后为空");
const c2 = makeElement("div");
const cleanup2 = mod.mountFooter(c2, fakeApi, { messageId: "m2" }, makeSignal());
c2.children[0].children[0].listeners.click[0]();
await sleep(250);
const hint2 = hintOf(c2);
check("不误报缺 Key", hint2.indexOf("Key") < 0, hint2);
check("提示没有可朗读的文字", hint2.indexOf("没有可朗读的文字") >= 0, hint2);
cleanup2();
mod.stop();

/* ---------- 4. 已并入操作行后，轮询不再反复重排（避免 DOM 抖动） ---------- */
console.log("\n[4] 图标并入操作行后不再反复 append");
const wrapper = makeElement("div");
const host = makeElement("div");
const row = makeElement("div");
row.classList.add("ai-message-footer");
const container = makeElement("div");
host.appendChild(container);
wrapper.appendChild(host);
wrapper.appendChild(row);
const cleanup4 = mod.mountFooter(container, fakeApi, { messageId: "m1" }, makeSignal());
const before = row.appendCount;
intervalFn();
intervalFn();
check("轮询不会重复把图标搬进同一行", row.appendCount === before, { before, after: row.appendCount });
check("图标仍在行末尾", row.lastElementChild.getAttribute("data-snow-mimo-tts") === "footer");
cleanup4();

/* ---------- 5. speak 还没建会话时按停止：这次调用不该再开播 ---------- */
console.log("\n[5] 排队中的朗读被 stop 取消");
fetchCount = 0;
const stranded = mod.speak("按下停止后这段不应该再被朗读。", {});
mod.stop();
const strandedResult = await stranded;
await sleep(200);
check("排队中被停止的朗读返回 false", strandedResult === false, strandedResult);
check("排队中被停止的朗读不会发请求", fetchCount === 0, fetchCount);
check("引擎回到 idle", mod.engineState.status === "idle", mod.engineState.status);

try {
  unlinkSync(generated);
} catch (e) {}

console.log(failures === 0 ? "\n第三轮回归：ALL PASS" : "\n第三轮回归：" + failures + " 项失败");
process.exit(failures === 0 ? 0 : 1);
