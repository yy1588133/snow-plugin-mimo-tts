// 渲染冒烟测试：用极简 React 运行时把面板各页真实跑一遍，捕获组件级异常
// 运行：node test/smoke.mjs
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/* ---------- 极简 hooks 运行时 ---------- */
// 每次挂载用独立的状态数组：不同组件（以及卸载重挂）互不干扰
let cursor = 0;
let currentStore = [];
let effects = [];

const React = {
  createElement(type, props, ...children) {
    return {
      type,
      props: props || {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined),
    };
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

/**
 * 挂载一个组件，返回 { tree, store, cleanups }。
 * 传入上一次的 store 可以模拟 React 在 setState 之后的重渲染。
 */
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
  if (typeof node === "string" || typeof node === "number") {
    visit({ text: String(node) });
    return;
  }
  if (typeof node !== "object") return;
  visit(node);
  (node.children || []).forEach((n) => walk(n, visit));
}

function textOf(node) {
  const out = [];
  walk(node, (n) => {
    if (n && typeof n.text === "string") out.push(n.text);
  });
  return out.join(" ").replace(/\s+/g, " ").trim();
}

function findBy(node, predicate) {
  let found = null;
  walk(node, (n) => {
    if (!found && n && predicate(n)) found = n;
  });
  return found;
}

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
      put: (v) =>
        request(() => {
          map.set(v.id, Object.assign({}, v));
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

/* ---------- 宿主 API 桩 ---------- */
const stored = new Map();
const messageCreatedAt = (() => {
  const d = new Date(Date.now() - 5 * 60 * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
})();

const fakeApi = {
  t: (key, options) => (options && options.defaultValue) || key,
  storage: {
    async getJson(k) {
      const raw = stored.get(k);
      return raw ? JSON.parse(raw) : null;
    },
    async setJson(k, v) {
      stored.set(k, JSON.stringify(v));
    },
  },
  net: {
    async fetch() {
      return { ok: false, status: 0, error: "stub" };
    },
  },
  metadata: {
    async subscribe(domain, listener) {
      if (domain === "messages") {
        // 与宿主一致：createdAt 可能是数据库原样文本，而不是毫秒数
        listener({
          domains: {
            messages: {
              conversationId: "c1",
              live: { isStreaming: false },
              items: [
                { id: "u1", role: "user", content: "你好" },
                { id: "a1", role: "assistant", content: "这是**测试**回复。", createdAt: messageCreatedAt },
              ],
            },
          },
        });
      }
      return { unsubscribe() {} };
    },
  },
  log() {},
};

globalThis.window = {
  SnowAppPlugin: { React, icons: {}, api: fakeApi, locale: "zh-CN", plugin: { id: "x", version: "1.0.1" } },
  localStorage: { getItem: () => null, setItem: () => {} },
  speechSynthesis: {
    getVoices: () => [{ lang: "zh-CN" }],
    speak() {},
    cancel() {},
    pause() {},
    resume() {},
  },
  // 与真实浏览器一致：构造函数挂在 window 上
  SpeechSynthesisUtterance: class {
    constructor(text) {
      this.text = text;
    }
  },
};
globalThis.indexedDB = makeIdb();

/* ---------- 加载插件真实源码 ---------- */
const source = readFileSync(join(here, "..", "index.js"), "utf8");
const generated = join(tmpdir(), "mtts-smoke-" + process.pid + ".mjs");
writeFileSync(
  generated,
  source +
    "\nexport { Panel, MixerTab, StageTab, HistoryTab, SettingsTab, PlayerDock, Header, TabBar, getSettings, updateSettings };\n",
  "utf8"
);
const mod = await import(pathToFileURL(generated).href);

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok || extra === undefined ? "" : "  → " + JSON.stringify(extra)));
}

const baseSettings = () => Object.assign({}, mod.getSettings());
const set = (patch) => mod.updateSettings(patch, { persist: false });

function shot(name, fn, props) {
  try {
    const mounted = mount(fn, props);
    mounted.cleanups.forEach((c) => c());
    return mounted.tree;
  } catch (e) {
    failures++;
    console.log("FAIL  " + name + " 渲染抛错  → " + String((e && e.stack) || e));
    return null;
  }
}

/* ---------- 1. 各页都能渲染 ---------- */
check("Panel 可渲染", !!shot("Panel", mod.Panel, { api: fakeApi }));
check("默认导出（实例调度器）可渲染", !!shot("PanelEntry", mod.default, { api: fakeApi }));
const header = shot("Header", mod.Header, { settings: baseSettings(), state: { status: "idle" }, onToggleAuto() {} });
check("Header 显示品牌名", textOf(header).indexOf("语音朗读") >= 0, textOf(header));
const tabbar = shot("TabBar", mod.TabBar, { tab: "mixer", onChange() {} });
check("TabBar 四个标签", ["调音台", "播报台", "音频历史", "设置"].every((t) => textOf(tabbar).indexOf(t) >= 0));
shot("MixerTab(预设)", mod.MixerTab, { settings: baseSettings(), set, onOpenSettings() {} });
set({ model: "mimo-v2.5-tts-voicedesign" });
shot("MixerTab(设计)", mod.MixerTab, { settings: baseSettings(), set, onOpenSettings() {} });
set({ model: "mimo-v2.5-tts-voiceclone" });
shot("MixerTab(复刻)", mod.MixerTab, { settings: baseSettings(), set, onOpenSettings() {} });
shot("HistoryTab", mod.HistoryTab, {});
shot("SettingsTab", mod.SettingsTab, { settings: baseSettings(), set });
const dockProps = {
  state: { status: "playing", position: 3, duration: 12, segmentIndex: 1, segmentCount: 3, text: "预览", error: "" },
  settings: baseSettings(),
  onRate() {},
};
const dockPlaying = shot("PlayerDock(播放中)", mod.PlayerDock, dockProps);
check(
  "Dock 显示分段与时间",
  textOf(dockPlaying).indexOf("第 1 / 3 段") >= 0 && textOf(dockPlaying).indexOf("0:03 / 0:12") >= 0,
  textOf(dockPlaying)
);
const dockZero = shot("PlayerDock(第 0 段)", mod.PlayerDock, {
  state: { status: "buffering", position: 0, duration: 0, segmentIndex: 0, segmentCount: 3, text: "预览", error: "" },
  settings: baseSettings(),
  onRate() {},
});
check("分段索引从 1 开始显示", textOf(dockZero).indexOf("第 1 / 3 段") >= 0, textOf(dockZero));
shot("PlayerDock(错误)", mod.PlayerDock, {
  state: { status: "error", error: "boom", position: 0, duration: 0, segmentIndex: 0, segmentCount: 0, text: "" },
  settings: baseSettings(),
  onRate() {},
});

/* ---------- 2. 播报台：消息预览与时间 ---------- */
const stageProps = { api: fakeApi, state: { status: "idle" } };
const firstStage = mount(mod.StageTab, stageProps);
await new Promise((r) => setTimeout(r, 40));
const stageTree = mount(mod.StageTab, stageProps, firstStage.store).tree;
const stageText = textOf(stageTree);
check("播报台显示助手回复", stageText.indexOf("这是测试回复。") >= 0, stageText);
check("文本时间戳能显示成相对时间", stageText.indexOf("5 分钟前 · ") >= 0, stageText);
firstStage.cleanups.forEach((c) => c());

/* ---------- 3. 切标签后试听稿不丢 ---------- */
const draftMount = mount(mod.StageTab, stageProps);
const area = findBy(draftMount.tree, (n) => n.type === "textarea" && /is-tall/.test(String(n.props.className)));
check("找到试听输入框", !!area);
if (area) {
  area.props.onChange({ target: { value: "写了一半的试听稿" } });
  const remount = mount(mod.StageTab, stageProps);
  const area2 = findBy(remount.tree, (n) => n.type === "textarea" && /is-tall/.test(String(n.props.className)));
  check("重新挂载后草稿还在", area2 && area2.props.value === "写了一半的试听稿", area2 && area2.props.value);
  remount.cleanups.forEach((c) => c());
}
draftMount.cleanups.forEach((c) => c());

/* ---------- 4. 面板重开：同版本复用旧实例，版本变化才换新 ---------- */
const firstPlay = window.snowMimoTts.play;
const copy = function (suffix) {
  const file = join(tmpdir(), "mtts-smoke-" + suffix + "-" + process.pid + ".mjs");
  writeFileSync(file, source + "\nexport { Panel };\n", "utf8");
  return import(pathToFileURL(file).href).then(function (loaded) {
    return { loaded, file };
  });
};

const second = await copy("b");
check("同版本重开复用旧实例（不重建引擎）", window.snowMimoTts.play === firstPlay);
check("复用时不覆盖实例登记", window[ "__snowMimoTtsPanelVersion" ] === window.SnowAppPlugin.plugin.version);

window.SnowAppPlugin.plugin.version = "9.9.9";
const third = await copy("c");
check("版本变化后销毁旧实例并重新初始化", window.snowMimoTts.play !== firstPlay);
check("实例登记更新到新版本", window["__snowMimoTtsPanelVersion"] === "9.9.9");
unlinkSync(second.file);
unlinkSync(third.file);

console.log(failures === 0 ? "\n冒烟：ALL PASS" : "\n冒烟：" + failures + " 项失败");
try {
  unlinkSync(generated);
} catch (e) {}
process.exit(failures === 0 ? 0 : 1);
