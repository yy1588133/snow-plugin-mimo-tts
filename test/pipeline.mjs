// 完整链路（离线版）：本地 HTTP 模拟 MiMo 接口，跑 speak → 分段合成 → 播放 → 拼接 → 落库
// 运行：node test/pipeline.mjs
import http from "node:http";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/* ---------- 本地模拟接口 ---------- */
function toneWav(seconds, sampleRate = 24000) {
  const count = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) data.writeInt16LE(Math.round(Math.sin((i / 8) * Math.PI) * 6000), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const requests = [];
let mode = "ok";
const server = http.createServer(function (req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", function () {
    const raw = Buffer.concat(chunks).toString("utf8");
    requests.push({ url: req.url, method: req.method, headers: req.headers, body: raw });
    const send = function (status, payload) {
      const buf = Buffer.from(JSON.stringify(payload), "utf8");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(buf);
    };
    if (mode === "slow") {
      setTimeout(function () {
        let parsedSlow = {};
        try { parsedSlow = JSON.parse(raw); } catch (e) {}
        const t = (parsedSlow.messages || []).filter((m) => m.role === "assistant").map((m) => m.content).join("");
        send(200, { choices: [{ message: { audio: { data: toneWav(Math.max(0.4, t.length * 0.02)).toString("base64") } } }] });
      }, 80);
      return;
    }
    if (mode === "quota") {
      send(429, { error: { message: "quota exceeded for today" } });
      return;
    }
    if (mode === "html") {
      res.writeHead(502, { "content-type": "text/html" });
      res.end("<html><body>bad gateway</body></html>");
      return;
    }
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch (e) {}
    const text = (parsed.messages || []).filter((m) => m.role === "assistant").map((m) => m.content).join("");
    send(200, {
      choices: [{ message: { audio: { data: toneWav(Math.max(0.4, text.length * 0.02)).toString("base64") } } }],
    });
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

/* ---------- 最小 IndexedDB 桩 ---------- */
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

/* ---------- 仿真 AudioContext：起播后立刻结束 ---------- */
class FakeAudioContext {
  constructor() {
    this.state = "running";
    this.currentTime = 0;
    this.destination = {};
    this.startedSources = 0;
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
      stop() {},
      start() {
        self.startedSources += 1;
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
    return { type: "sine", frequency: { value: 440 }, connect() {}, start() {}, stop() {} };
  }
  decodeAudioData(buffer, ok) {
    ok({ duration: 1 });
  }
}

/* ---------- 宿主 API 桩：net.fetch 走本机模拟服务 ---------- */
const store = new Map();
const fakeApi = {
  t: (key, options) => (options && options.defaultValue) || key,
  storage: {
    async getJson(k) {
      const raw = store.get(k);
      return raw ? JSON.parse(raw) : null;
    },
    async setJson(k, v) {
      store.set(k, JSON.stringify(v));
    },
  },
  net: {
    async fetch(url, options) {
      try {
        const res = await fetch(url, {
          method: options.method,
          headers: options.headers,
          body: options.body,
          signal: AbortSignal.timeout(options.timeoutMs || 30000),
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
  },
  log() {},
};

const localSpoken = [];
globalThis.window = {
  SpeechSynthesisUtterance: class {
    constructor(text) {
      this.text = text;
    }
  },
  SnowAppPlugin: { React: null, icons: {}, api: fakeApi, locale: "zh-CN", plugin: { id: "x", version: "1.0.2" } },
  AudioContext: FakeAudioContext,
  speechSynthesis: {
    getVoices: () => [{ lang: "zh-CN", name: "stub" }],
    speak(utter) {
      localSpoken.push(utter.text);
      setTimeout(() => utter.onend && utter.onend(), 5);
    },
    cancel() {},
    pause() {},
    resume() {},
  },
};
// 浏览器里 window 就是全局对象，Node 里要单独补一份裸标识符
globalThis.SpeechSynthesisUtterance = window.SpeechSynthesisUtterance;
globalThis.indexedDB = makeIdb();

/* ---------- 加载插件真实源码 ---------- */
const source = readFileSync(join(here, "..", "index.js"), "utf8");
const generated = join(tmpdir(), "mtts-pipeline-" + process.pid + ".mjs");
writeFileSync(generated, source + "\nexport { speak, stop, getSettings, updateSettings, listClips, clearClips, toastEmitter, engineState };\n", "utf8");
const mod = await import(pathToFileURL(generated).href);

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok || extra === undefined ? "" : "  → " + JSON.stringify(extra)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const base = {
  apiKey: "sk-test-123",
  baseUrl: "http://127.0.0.1:" + port + "/v1",
  model: "mimo-v2.5-tts",
  voice: "冰糖",
  instruction: "",
  range: "full",
  localMode: "off",
  sfx: false,
  rate: 1,
  volume: 1,
};
mod.updateSettings(base, { persist: false });
await mod.clearClips();

/* ---------- 1. 多段合成：请求体 / 播放 / 拼接 / 落库 ---------- */
console.log("\n[1] 多段合成完整链路");
const text = Array.from({ length: 12 }, (_, i) => `第${i + 1}句用来验证本地模拟的合成链路是否完整。`).join("");
requests.length = 0;
const ok = await mod.speak(text, { title: "pipeline" });
check("speak 返回 true", ok === true, ok);
check("至少发出一段请求", requests.length >= 2, requests.length);
check(
  "请求地址补全到 /chat/completions",
  requests.every((r) => /\/v1\/chat\/completions$/.test(r.url)),
  requests.map((r) => r.url)
);
check(
  "请求头带上 api-key",
  requests.every((r) => r.headers["api-key"] === "sk-test-123"),
  requests.map((r) => r.headers["api-key"])
);
const firstBody = JSON.parse(requests[0].body);
check("请求体是预置模型 + 音色", firstBody.model === "mimo-v2.5-tts" && firstBody.audio.voice === "冰糖", firstBody);
check(
  "正文放在 assistant 消息里",
  firstBody.messages.length === 1 && firstBody.messages[0].role === "assistant",
  firstBody.messages
);
check("每段文本都不超过上限", JSON.parse(requests[0].body).messages[0].content.length <= 90, firstBody.messages[0].content.length);

await sleep(600);
const clips = await mod.listClips();
check("落库一条历史", clips.length === 1, clips.length);
const clip = clips[0] || {};
check("拼接成完整 WAV", clip.whole === true, clip.whole);
check("音频是 WAV", !!clip.blob && clip.blob.type === "audio/wav", clip.blob && clip.blob.type);
check("时长覆盖所有分段", clip.durationMs > 3000, clip.durationMs);
check("字数为全文", clip.chars === text.length, { got: clip.chars, want: text.length });
check("记录模型与音色", clip.model === "mimo-v2.5-tts" && clip.voice === "冰糖", { model: clip.model, voice: clip.voice });
check("播放结束回到 idle", mod.engineState.status === "idle", mod.engineState.status);

/* ---------- 2. 云端失败 → 本地兜底，且不写历史 ---------- */
console.log("\n[2] 云端失败后本地兜底");
mode = "quota";
mod.updateSettings({ localMode: "fallback" }, { persist: false });
const toasts = [];
mod.toastEmitter.sub((t) => toasts.push(t.text));
requests.length = 0;
await mod.clearClips();
localSpoken.length = 0;
const fellBack = await mod.speak("云端失败时应该改用系统语音。", {});
check("兜底后仍算朗读成功", fellBack === true, fellBack);
check("确实走了本地语音", localSpoken.length === 1 && localSpoken[0].indexOf("云端失败") >= 0, localSpoken);
check("提示里带上了接口原因", toasts.some((t) => t.indexOf("quota exceeded") >= 0), toasts);
check("本地兜底不写音频历史", (await mod.listClips()).length === 0);

/* ---------- 3. 非 JSON 错误体也能给出可读原因 ---------- */
console.log("\n[3] 非 JSON 错误响应");
mode = "html";
mod.updateSettings({ localMode: "off" }, { persist: false });
const badResult = await mod.speak("这次应该失败。", {});
check("两路都不可用时返回 false", badResult === false, badResult);
check("错误提示包含状态或原文", toasts.some((t) => /502|bad gateway/.test(t)), toasts.slice(-2));

/* ---------- 4. 取消：停止后不再继续请求 ---------- */
console.log("\n[4] 朗读中途停止");
mode = "slow";
mod.updateSettings({ localMode: "off" }, { persist: false });
const longText = Array.from({ length: 20 }, (_, i) => `第${i + 1}段内容用于测试停止行为。`).join("");
requests.length = 0;
const pending = mod.speak(longText, {});
await sleep(30);
mod.stop();
const stoppedResult = await pending;
check("停止后 speak 返回 false", stoppedResult === false, stoppedResult);
await sleep(120);
const afterStop = requests.length;
await sleep(300);
check("停止后没有再发起新请求", requests.length === afterStop, { afterStop, now: requests.length });

await new Promise((resolve) => server.close(resolve));
try {
  unlinkSync(generated);
} catch (e) {}

console.log(failures === 0 ? "\n链路：ALL PASS" : "\n链路：" + failures + " 项失败");
process.exit(failures === 0 ? 0 : 1);
