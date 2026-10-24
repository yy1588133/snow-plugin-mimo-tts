// 错误路径测试：各种异常响应下 speak 的提示文案与状态恢复
// 运行：node test/errors.mjs
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "index.js"), "utf8");
const cut = src.indexOf("/* ------------------------------------------------------------------ */\n/* 面板入口");
const tail = src.slice(src.indexOf("/* 模块加载即注册对外接口"));
const f = join(tmpdir(), "err-" + Date.now() + ".mjs");
writeFileSync(f, src.slice(0, cut) + tail + "\nexport { speak, stop, engineState };\n", "utf8");

function wav(pcm) {
  const b = new Uint8Array(44 + pcm);
  const dv = new DataView(b.buffer);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  w(0, "RIFF"); dv.setUint32(4, 36 + pcm, true); w(8, "WAVE"); w(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 24000, true); dv.setUint32(28, 48000, true); dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true); w(36, "data"); dv.setUint32(40, pcm, true);
  return b;
}
const goodBody = Buffer.from(JSON.stringify({ choices: [{ message: { audio: { data: Buffer.from(wav(2400)).toString("base64") } } }] }));

class FakeAudioContext {
  constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; this.sources = []; }
  resume() { return Promise.resolve(); }
  createBufferSource() { const ctx = this; return { buffer: null, playbackRate: { value: 1 }, onended: null, connect() {}, disconnect() {}, start(w, o) { this.started = o; ctx.sources.push(this); }, stop() {} }; }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  decodeAudioData(buf, ok) { setTimeout(() => ok({ duration: 1 }), 0); }
}

let responder = async () => ({ ok: true, status: 200, bodyBase64: goodBody.toString("base64") });

const stored = new Map();
stored.set("settings.v1", JSON.stringify({ apiKey: "k", localMode: "off", range: "full", sfx: false }));

const stores = new Map([["clips", new Map()], ["samples", new Map()]]);
const req = (run) => { const r = {}; queueMicrotask(() => { try { r.result = run(); if (r.onsuccess) r.onsuccess(); } catch (e) { r.error = e; if (r.onerror) r.onerror(); } }); return r; };
const storeApi = (n) => { const map = stores.get(n); return { getAll: () => req(() => Array.from(map.values())), get: (k) => req(() => map.get(k)), put: (v) => req(() => { map.set(v.id, v); return v.id; }), delete: (k) => req(() => { map.delete(k); }), clear: () => req(() => { map.clear(); }) }; };
const db = { objectStoreNames: { contains: (n) => stores.has(n) }, createObjectStore: (n) => { stores.set(n, new Map()); return { createIndex() {} }; }, transaction: () => ({ objectStore: (n) => storeApi(n) }), close() {} };
globalThis.indexedDB = { open() { const r = {}; queueMicrotask(() => { r.result = db; if (r.onupgradeneeded) r.onupgradeneeded(); if (r.onsuccess) r.onsuccess(); }); return r; } };

const fakeApi = {
  t: (k, o) => (o && o.defaultValue) || k,
  storage: { async getJson(k) { const r = stored.get(k); return r ? JSON.parse(r) : null; }, async setJson() {} },
  net: { fetch: (url, opts) => responder(url, opts) },
  metadata: { async subscribe() { return { unsubscribe() {} }; } },
  log() {},
};
globalThis.window = {
  SnowAppPlugin: { React: null, icons: {}, api: fakeApi, locale: "zh-CN", plugin: { version: "1.0.1" } },
  localStorage: { getItem: () => null, setItem: () => {} },
  speechSynthesis: { getVoices: () => [], speak() {}, cancel() {}, pause() {}, resume() {} },
  SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
  AudioContext: FakeAudioContext,
};

const mod = await import(pathToFileURL(f).href);
unlinkSync(f);

let failures = 0;
const check = (name, cond, extra) => {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok || extra === undefined ? "" : "  → " + JSON.stringify(extra)));
};
const b64 = (s) => Buffer.from(s).toString("base64");

async function run(name, response, expectText) {
  mod.stop();
  responder = async () => response;
  const ok = await mod.speak("测试一句话。");
  const err = mod.engineState.error || "";
  check(name + " → 返回 false", ok === false, ok);
  check(name + " → 状态 error", mod.engineState.status === "error", mod.engineState.status);
  check(name + " → 提示包含「" + expectText + "」", err.indexOf(expectText) >= 0, err);
}

await run("HTTP 401 + JSON 错误", { ok: false, status: 401, bodyBase64: b64(JSON.stringify({ error: { message: "invalid api key" } })) }, "invalid api key");
await run("HTTP 500 + 纯文本", { ok: false, status: 500, bodyBase64: b64("upstream exploded") }, "upstream exploded");
await run("200 + 空响应体", { ok: true, status: 200, bodyBase64: "" }, "没有返回响应体");
await run("200 + 非 JSON", { ok: true, status: 200, bodyBase64: b64("not json") }, "不是合法 JSON");
await run("200 + 没有音频字段", { ok: true, status: 200, bodyBase64: b64(JSON.stringify({ choices: [{ message: {} }] })) }, "没有音频数据");
await run("网络层错误", { ok: false, status: 0, error: "ECONNREFUSED" }, "ECONNREFUSED");

// 超出 5 MB 响应上限：base64 里塞 5MB+ 的 'A'
mod.stop();
responder = async () => ({ ok: true, status: 200, bodyBase64: "A".repeat(7 * 1024 * 1024) });
const tooBig = await mod.speak("测试一句话。");
check("超限响应 → 返回 false", tooBig === false);
check("超限响应 → 提示上限", (mod.engineState.error || "").indexOf("上限") >= 0, mod.engineState.error);

// 错误之后还能恢复
mod.stop();
responder = async () => ({ ok: true, status: 200, bodyBase64: goodBody.toString("base64") });
const p = mod.speak("恢复测试。");
await new Promise((r) => setTimeout(r, 20));
check("错误后能恢复播放", mod.engineState.status === "playing", mod.engineState.status);
check("恢复后错误信息清空", !mod.engineState.error, mod.engineState.error);
mod.stop();
await p;

console.log(failures ? "\n错误路径：FAILED " + failures : "\n错误路径：ALL PASS");
process.exit(failures ? 1 : 0);
