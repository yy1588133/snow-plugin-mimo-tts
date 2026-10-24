// 第四轮回归：文本清洗不再吞字、分句/分段边界、字数统计、音频历史试听状态机
// 运行：node test/round4.mjs
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "index.js"), "utf8");
const generated = join(tmpdir(), "mtts-round4-" + process.pid + ".mjs");
writeFileSync(
  generated,
  source + "\nexport { cleanText, splitSentences, splitSegments, describeMessage, HistoryTab, previewPlayer };\n",
  "utf8"
);

/* ---------- 极简 hooks 运行时 ---------- */
let cursor = 0;
let currentStore = [];
let effects = [];

const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined) };
  },
  useState(init) {
    const store = currentStore;
    const idx = cursor++;
    if (!(idx in store)) store[idx] = typeof init === "function" ? init() : init;
    return [
      store[idx],
      (v) => {
        store[idx] = typeof v === "function" ? v(store[idx]) : v;
      },
    ];
  },
  useRef(init) {
    const store = currentStore;
    const idx = cursor++;
    if (!(idx in store)) store[idx] = { current: init };
    return store[idx];
  },
  useCallback(fn) {
    cursor++;
    return fn;
  },
  useMemo(fn) {
    cursor++;
    return fn();
  },
  useEffect(fn) {
    cursor++;
    effects.push(fn);
  },
};

function mount(fn, props, store) {
  const prevStore = currentStore;
  const prevEffects = effects;
  currentStore = store || [];
  effects = [];
  cursor = 0;
  try {
    const tree = fn(props);
    const cleanups = [];
    for (const e of effects) {
      const c = e();
      if (typeof c === "function") cleanups.push(c);
    }
    return { tree, store: currentStore, cleanups };
  } finally {
    currentStore = prevStore;
    effects = prevEffects;
  }
}

function walk(node, visit) {
  if (node === null || node === undefined || node === false) return;
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, visit));
    return;
  }
  if (typeof node === "string" || typeof node === "number") return;
  if (typeof node !== "object") return;
  visit(node);
  (node.children || []).forEach((n) => walk(n, visit));
}

function findBy(node, predicate) {
  let found = null;
  walk(node, (n) => {
    if (!found && n && predicate(n)) found = n;
  });
  return found;
}

/* ---------- IndexedDB 桩（可预置历史） ---------- */
function makeIdb(seed) {
  const stores = new Map();
  stores.set("clips", new Map());
  stores.set("samples", new Map());
  for (const clip of seed || []) stores.get("clips").set(clip.id, clip);
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
      put: (v) =>
        request(() => {
          map.set(v.id, v);
          return v.id;
        }),
      delete: (k) =>
        request(() => {
          map.delete(k);
        }),
      clear: () =>
        request(() => {
          map.clear();
        }),
    };
  };
  const db = {
    objectStoreNames: { contains: (n) => stores.has(n) },
    createObjectStore: (n) => {
      stores.set(n, new Map());
      return { createIndex() {} };
    },
    transaction: () => ({ objectStore: (name) => storeApi(name) }),
    close() {},
  };
  return {
    open() {
      const req = {};
      queueMicrotask(() => {
        req.result = db;
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}

/* ---------- AudioContext 桩 ---------- */
class FakeAudioContext {
  constructor() {
    this.state = "running";
    this.currentTime = 0;
    this.destination = { name: "destination" };
    this.sources = [];
    FakeAudioContext.last = this;
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  createBufferSource() {
    const ctx = this;
    return {
      buffer: null,
      playbackRate: { value: 1 },
      onended: null,
      started: undefined,
      connect() {},
      disconnect() {},
      start(when, offset) {
        this.started = offset;
        ctx.sources.push(this);
      },
      stop() {
        this.stopped = true;
      },
    };
  }
  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }
  decodeAudioData(buffer, ok) {
    this.decoded = buffer.byteLength;
    ok({ duration: 1 });
  }
}

/* ---------- WAV 字节 ---------- */
function wavBlob(pcmBytes) {
  const header = new Uint8Array(44);
  const dv = new DataView(header.buffer);
  const w = (o, s) => {
    for (let i = 0; i < s.length; i++) header[o + i] = s.charCodeAt(i);
  };
  w(0, "RIFF");
  dv.setUint32(4, 36 + pcmBytes, true);
  w(8, "WAVE");
  w(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, 24000, true);
  dv.setUint32(28, 48000, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w(36, "data");
  dv.setUint32(40, pcmBytes, true);
  return new Blob([header, new Uint8Array(pcmBytes)], { type: "audio/wav" });
}

/* ---------- 宿主桩 ---------- */
const clip = {
  id: "c1",
  createdAt: Date.now(),
  text: "这是测试音频",
  chars: 6,
  voice: "冰糖",
  bytes: 2048,
  durationMs: 1000,
  whole: true,
  blob: wavBlob(2000),
};

const fakeApi = {
  t: (key, options) => (options && options.defaultValue) || key,
  storage: {
    async getJson() {
      return null;
    },
    async setJson() {},
  },
  net: {
    async fetch() {
      return { ok: false, status: 0, error: "stub" };
    },
  },
  metadata: {
    async subscribe() {
      return { unsubscribe() {} };
    },
  },
  log() {},
};

globalThis.window = {
  SnowAppPlugin: { React, icons: {}, api: fakeApi, locale: "zh-CN", plugin: { version: "1.0.1" } },
  localStorage: { getItem: () => null, setItem: () => {} },
  speechSynthesis: { getVoices: () => [], speak() {}, cancel() {}, pause() {}, resume() {} },
  SpeechSynthesisUtterance: class {
    constructor(text) {
      this.text = text;
    }
  },
  AudioContext: FakeAudioContext,
};
globalThis.indexedDB = makeIdb([clip]);

const mod = await import(pathToFileURL(generated).href);

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok || extra === undefined ? "" : "  → " + JSON.stringify(extra)));
}
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ---------- 文本清洗 ---------- */
check(
  "裸链接不吞掉后面的中文句子",
  mod.cleanText("详见 https://example.com/path。下一句在这里。").indexOf("下一句在这里") >= 0,
  mod.cleanText("详见 https://example.com/path。下一句在这里。")
);
check(
  "裸链接不吞掉后面的中文逗号分句",
  mod.cleanText("详见 https://example.com/path，然后继续。").indexOf("然后继续") >= 0,
  mod.cleanText("详见 https://example.com/path，然后继续。")
);
check(
  "URL 后面的空格正文保留",
  mod.cleanText("见 https://example.com/a?x=1&y=2 这段说明。").indexOf("这段说明") >= 0
);
check(
  "URL 紧贴汉字时不吞正文",
  mod.cleanText("打开 https://example.com然后点击下载").indexOf("然后点击下载") >= 0,
  mod.cleanText("打开 https://example.com然后点击下载")
);
check(
  "URL 紧贴汉字时不吞后续句子",
  mod.cleanText("版本 https://x.com更新了，请查看。").indexOf("更新了") >= 0,
  mod.cleanText("版本 https://x.com更新了，请查看。")
);
check(
  "中文域名只删协议头、不吞正文",
  mod.cleanText("访问 https://例子.com看详情").indexOf("看详情") >= 0,
  mod.cleanText("访问 https://例子.com看详情")
);
check(
  "带 query 的 URL 后面的正文保留",
  mod.cleanText("见 https://x.com/a?b=1&c=2然后继续").indexOf("然后继续") >= 0,
  mod.cleanText("见 https://x.com/a?b=1&c=2然后继续")
);
check("C# / F# 不被当成 markdown 吃掉", mod.cleanText("我主要用 C# 和 F# 开发").indexOf("C#") >= 0);
check("标题标记仍然清理", mod.cleanText("### 标题\n正文").indexOf("###") < 0);
check("未闭合代码块不进入朗读文本", mod.cleanText("说明：\n```js\nconst a = 1;").indexOf("const a") < 0);
check("未闭合代码块保留前面的正文", mod.cleanText("说明：\n```js\nconst a = 1;").indexOf("说明") >= 0);
check("完整代码块仍然删除", mod.cleanText("前\n```js\nconst a = 1;\n```\n后").indexOf("const a") < 0);
check("链接文字仍保留", mod.cleanText("见 [文档](https://x.com) 说明").indexOf("文档") >= 0);
check("标点前的多余空格收掉", mod.cleanText("详见 https://x.com。下一句").indexOf(" 。") < 0, mod.cleanText("详见 https://x.com。下一句"));

/* ---------- 分句 ---------- */
const leading = mod.splitSentences("。开头就是标点。");
check("开头纯标点不单独成段", leading.length === 1 && leading[0] === "。开头就是标点。", leading);
check("正常中文分句不变", JSON.stringify(mod.splitSentences("你好。我是雪！")) === JSON.stringify(["你好。", "我是雪！"]));
check("省略号成句仍然正常", JSON.stringify(mod.splitSentences("等等……先来。")) === JSON.stringify(["等等……", "先来。"]));
const onlyMarks = mod.splitSentences("。。。");
check("全标点文本不丢内容", onlyMarks.length === 1 && onlyMarks[0] === "。。。", onlyMarks);

/* ---------- 分段 ---------- */
const emojiSegs = mod.splitSegments("😀".repeat(150), 200, 90);
check("emoji 首段 UTF-16 不超过 firstLimit", emojiSegs[0].length <= 90, emojiSegs.map((s) => s.length));
check("emoji 每段 UTF-16 不超过上限", emojiSegs.every((s) => s.length <= 200), emojiSegs.map((s) => s.length));
check(
  "emoji 不被拆成半个代理对",
  emojiSegs.every((s) => Array.from(s).every((ch) => ch === "😀")),
  emojiSegs.map((s) => s.length)
);
const longSegs = mod.splitSegments("啊".repeat(450), 200, 90);
check("长句首段压到 firstLimit", longSegs[0].length === 90, longSegs.map((s) => s.length));
check("长句后续段放宽到 limit", longSegs.slice(1).every((s) => s.length <= 200 && s.length > 90), longSegs.map((s) => s.length));
check("分段不丢字", longSegs.join("").length === 450, longSegs.join("").length);
const mixed = mod.splitSegments("中文😀混合".repeat(80), 200, 90);
check("混合文本每段不超上限", mixed.every((s) => s.length <= 200), mixed.map((s) => s.length));

/* ---------- 字数统计 ---------- */
check("超长文本字数按全文统计", mod.describeMessage("字".repeat(5000)).chars === 5000, mod.describeMessage("字".repeat(5000)).chars);
check("预览仍然截断", mod.describeMessage("字".repeat(5000)).preview.length <= 111);

/* ---------- 音频历史试听状态机 ---------- */
const first = mount(mod.HistoryTab, {});
await tick();
await tick();
check("历史列表读到一条记录", Array.isArray(first.store[0]) && first.store[0].length === 1, first.store[0] && first.store[0].length);

const second = mount(mod.HistoryTab, {}, first.store);
const playBtn = findBy(second.tree, (n) => n.props && n.props.title === "试听" && typeof n.props.onClick === "function");
check("列表里能拿到试听按钮", !!playBtn);
if (playBtn) {
  playBtn.props.onClick();
  check("点击后立即进入播放态", second.store[2] === "c1", second.store[2]);
  await tick();
  await tick();
  const ctx = FakeAudioContext.last;
  check("试听创建了一路播放源", !!ctx && ctx.sources.length === 1, ctx && ctx.sources.length);
  if (ctx && ctx.sources[0] && typeof ctx.sources[0].onended === "function") {
    ctx.sources[0].onended();
    await tick();
    await tick();
    check("自然播完后按钮复位为未播放", second.store[2] === "", second.store[2]);
  } else {
    check("播放源带 onended 回调", false);
  }
  check("播完后预览播放器已释放", mod.previewPlayer === null, String(mod.previewPlayer));
}

console.log(failures ? "\n第四轮回归：FAILED " + failures : "\n第四轮回归：ALL PASS");
process.exit(failures ? 1 : 0);
