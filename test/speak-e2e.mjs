// 临时集成测试：真实接口 + 仿真 AudioContext，跑完整 speak() 链路
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const KEY = process.env.MIMO_KEY || (() => {
  const db = new DatabaseSync("C:/Users/yangyang/.snowapp/snowapp.db", { readOnly: true });
  const row = db
    .prepare("select value from app_plugin_values where plugin_id='com.snowai.mimo-tts' and key='settings.v1'")
    .get();
  return JSON.parse(row.value).apiKey;
})();

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
      get: (key) => request(() => map.get(key)),
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

/* ---------- 仿真 AudioContext：起播后立刻结束 ---------- */
class FakeAudioContext {
  constructor() {
    this.state = "running";
    this.currentTime = 0;
    this.destination = {};
    this.startedSources = 0;
    this.beeps = 0;
    FakeAudioContext.last = this;
  }
  resume() {
    return Promise.resolve();
  }
  createBufferSource() {
    const self = this;
    return {
      playbackRate: { value: 1 },
      onended: null,
      connect() {},
      disconnect() {},
      stop() {
        this.stopped = true;
      },
      start() {
        self.startedSources++;
        // 立刻模拟播完
        setTimeout(() => {
          if (this.onended) this.onended();
        }, 0);
      },
    };
  }
  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }
  createOscillator() {
    return {
      type: "sine",
      frequency: { value: 440 },
      connect() {},
      start() {},
      stop() {},
    };
  }
  decodeAudioData(buffer, ok) {
    this.decodedHeader = new Uint8Array(buffer.slice(0, 4));
    ok({ duration: 1.2 });
  }
}

/* ---------- 宿主 API 桩：真实网络 ---------- */
const fakeApi = {
  t: (key, options) => (options && options.defaultValue) || key,
  storage: {
    async getJson() {
      return null;
    },
    async setJson() {},
    async get() {
      return null;
    },
    async set() {},
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
        return {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          headers: {},
          url,
          body: "",
          bodyBase64: buf.toString("base64"),
        };
      } catch (err) {
        return { ok: false, status: 0, statusText: "", headers: {}, url, body: "", error: String(err && err.message) };
      }
    },
  },
  metadata: {
    async subscribe() {
      return { unsubscribe() {} };
    },
    async get() {
      return { generatedAt: Date.now(), domains: {}, denied: {}, withheld: {}, unknown: [] };
    },
  },
  log() {},
};

globalThis.window = {
  SnowAppPlugin: { React: null, icons: {}, api: fakeApi, locale: "zh-CN", plugin: { id: "x", version: "1.0.1" } },
  AudioContext: FakeAudioContext,
};
globalThis.indexedDB = makeIdb();

const source = readFileSync(join(here, "..", "index.js"), "utf8");
const generated = join(tmpdir(), "mtts-speak-" + process.pid + ".mjs");
writeFileSync(
  generated,
  source +
    "\nexport { speak, stop, listClips, updateSettings, getSettings, engineState, clearClips };\n",
  "utf8"
);
const mod = await import(pathToFileURL(generated).href);

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok || extra === undefined ? "" : "  → " + JSON.stringify(extra)));
}

mod.updateSettings({ apiKey: KEY, model: "mimo-v2.5-tts", voice: "冰糖", localMode: "off", sfx: true, range: "full", maxChars: 200 });
await mod.clearClips();

// 超过单段上限（200 字），强制走多段流水线
const text = Array.from(
  { length: 12 },
  (_, i) => `第${i + 1}句用来验证分段流水线是否正常，并且确认拼接后的音频完整。`
).join("");
console.log("\n[1] speak() 完整链路（多段）", "文本 " + text.length + " 字");
const t0 = Date.now();
const ok = await mod.speak(text, { title: "集成测试" });
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
check("speak 返回 true", ok === true, ok);
check("切成了多段", mod.engineState.segmentCount >= 2, mod.engineState.segmentCount);
check("每段都起播过", FakeAudioContext.last.startedSources >= mod.engineState.segmentCount, {
  started: FakeAudioContext.last.startedSources,
  segments: mod.engineState.segmentCount,
});
check("解码入参是 WAV", String.fromCharCode(...(FakeAudioContext.last.decodedHeader || [])) === "RIFF", FakeAudioContext.last.decodedHeader);
check("结束状态回到 idle", mod.engineState.status === "idle", mod.engineState.status);
check("错误字段为空", mod.engineState.error === "", mod.engineState.error);

console.log("\n[2] 历史落库");
// recordClip 是异步的，等它完成
await new Promise((r) => setTimeout(r, 800));
const clips = await mod.listClips();
check("写入一条历史", clips.length === 1, clips.length);
const clip = clips[0] || {};
check("文本与朗读内容一致", clip.text === text, clip.text && clip.text.slice(0, 20));
check("字数为全文", clip.chars === text.length, { got: clip.chars, want: text.length });
check("音频字节数合理", clip.bytes > 10000, clip.bytes);
check("时长为正", clip.durationMs > 0, clip.durationMs);
check("时长覆盖所有分段", clip.durationMs > 4000, clip.durationMs);
check("拼接完整（whole）", clip.whole === true, clip.whole);
check("音频是 WAV", !!clip.blob && clip.blob.type === "audio/wav", clip.blob && clip.blob.type);
check("模型与音色记录正确", clip.model === "mimo-v2.5-tts" && clip.voice === "冰糖", { model: clip.model, voice: clip.voice });
console.log(`  · 耗时 ${elapsed}s，音频 ${(clip.bytes / 1024).toFixed(0)} KB，时长 ${(clip.durationMs / 1000).toFixed(2)}s`);

console.log("\n[3] 停止后不留会话");
mod.stop();
check("stop 后 idle", mod.engineState.status === "idle", mod.engineState.status);

try {
  unlinkSync(generated);
} catch (e) {}

console.log(failures === 0 ? "\n集成：ALL PASS" : "\n集成：" + failures + " 项失败");
process.exit(failures === 0 ? 0 : 1);
