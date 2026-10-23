// 第二轮回归：句间空格 / 比较符号 / 提示去重 / 样本摘要 / 拼接时长 / 分段索引
// 运行：node test/round2.mjs
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

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
      get: (key) => request(() => map.get(key)),
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

/* ---------- 宿主 API 桩（带本地语音） ---------- */
const subscriptions = {};
const fakeApi = {
  t: (key, options) => (options && options.defaultValue) || key,
  storage: { async getJson() { return null; }, async setJson() {} },
  net: {
    async fetch() {
      return { ok: false, status: 0, error: "stub network" };
    },
  },
  metadata: {
    async subscribe(domain, listener) {
      subscriptions[domain] = listener;
      return {
        unsubscribe() {
          delete subscriptions[domain];
        },
      };
    },
  },
  log() {},
};

globalThis.window = {
  SnowAppPlugin: { React: null, icons: {}, api: fakeApi, locale: "zh-CN" },
  speechSynthesis: {
    getVoices: () => [{ lang: "zh-CN" }],
    speak(utter) {
      setTimeout(() => {
        if (utter.onend) utter.onend();
      }, 0);
    },
    cancel() {},
    pause() {},
    resume() {},
  },
  // 与真实浏览器一致：构造函数挂在 window 上（playLocal 也从这里取）
  SpeechSynthesisUtterance: class {
    constructor(text) {
      this.text = text;
    }
  },
};
globalThis.indexedDB = makeIdb();

const source = readFileSync(join(here, "..", "index.js"), "utf8");
const generated = join(tmpdir(), "mtts-round2-" + process.pid + ".mjs");
writeFileSync(
  generated,
  source +
    "\nexport { splitSegments, cleanText, appendInstructionPhrase, speak, toastEmitter, engineEmitter, startWatcher, updateSettings, getSettings, concatWav, putSample, listSamples, clearSamples, fmtRel, parseWav };\n",
  "utf8"
);
const mod = await import(pathToFileURL(generated).href);

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok || extra === undefined ? "" : "  → " + JSON.stringify(extra)));
}

function wavBytes(pcm, sampleRate = 24000) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}

/* ---------- 1. 英文合并保留句间空格 ---------- */
console.log("\n[1] 句子合并的空格");
const en = mod.splitSegments("Hello world. This is a test. Another one.", 200, 90);
check("英文句号后保留空格", en.join("").indexOf("world. This") >= 0, en);
check("英文三句不丢字", en.join("").replace(/\s+/g, " ").trim() === "Hello world. This is a test. Another one.", en);
const zh = mod.splitSegments("第一句。第二句！第三句？", 200, 90);
check("中文句间不插入空格", zh.join("") === "第一句。第二句！第三句？", zh);
const mixed = mod.splitSegments("英文结束. 中文开始。结束。", 200, 90);
check("中文标点后不补空格", mixed.join("").indexOf("开始。结束。") >= 0, mixed);

/* ---------- 2. 比较符号与 HTML 标签 ---------- */
console.log("\n[2] 文本清洗的边界");
const cmp = mod.cleanText("判断 a<b 且 b>c 就交换");
check("无空格比较符号保留", cmp.indexOf("a<b") >= 0 && cmp.indexOf("b>c") >= 0, cmp);
const html = mod.cleanText('<div class="box" data-x="1">正文</div>');
check("带属性的真实标签被剔除", html.indexOf("正文") >= 0 && html.indexOf("div") < 0, html);
const comment = mod.cleanText("前<!-- 注释 -->后");
check("HTML 注释被剔除", comment.indexOf("注释") < 0 && comment.indexOf("前") >= 0, comment);
const xml = mod.cleanText('<?xml version="1.0"?>正文');
check("XML 声明被剔除", xml.indexOf("xml") < 0 && xml.indexOf("正文") >= 0, xml);
const br = mod.cleanText("第一行<br/>第二行");
check("自闭合标签被剔除", br.indexOf("br") < 0 && br.indexOf("第一行") >= 0, br);

/* ---------- 3. 语气标签追加 ---------- */
console.log("\n[3] 语气标签追加");
check("句号结尾不会出现「。，」", mod.appendInstructionPhrase("慢点。", "用开心雀跃的语气") === "慢点，用开心雀跃的语气");
check("空指令直接等于短语", mod.appendInstructionPhrase("", "用开心雀跃的语气") === "用开心雀跃的语气");
check("普通指令追加逗号", mod.appendInstructionPhrase("慢点", "用温柔轻声的语气") === "慢点，用温柔轻声的语气");
check("逗号结尾不重复", mod.appendInstructionPhrase("慢点，", "用温柔轻声的语气") === "慢点，用温柔轻声的语气");

/* ---------- 4. WAV 拼接直接给出时长 ---------- */
console.log("\n[4] 拼接时长");
const a = wavBytes(new Uint8Array(1000));
const b = wavBytes(new Uint8Array(2000));
const merged = await mod.concatWav([new Blob([a]), new Blob([b])]);
check("多段拼接为整体", merged.whole === true);
check("多段时长 = 数据 / 字节率", Math.round(merged.durationMs) === 63, merged.durationMs);
const single = await mod.concatWav([new Blob([a])]);
check("单段也返回时长", Math.round(single.durationMs) === 21, single.durationMs);
check("空列表时长为 0", (await mod.concatWav([])).durationMs === 0);

/* ---------- 5. 样本列表不带 base64 ---------- */
console.log("\n[5] 复刻样本摘要");
await mod.clearSamples();
await mod.putSample({
  id: "s1",
  name: "a.wav",
  mime: "audio/wav",
  size: 10,
  bytes: 10,
  base64: "QUJDREVGR0g=",
  createdAt: 1,
});
const samples = await mod.listSamples();
check("列表返回摘要", samples.length === 1 && samples[0].id === "s1" && samples[0].name === "a.wav");
check("列表不含 base64", !("base64" in samples[0]), Object.keys(samples[0]));
await mod.clearSamples();

/* ---------- 6. 时间显示 ---------- */
console.log("\n[6] 相对时间");
check("未来时间不显示空白", mod.fmtRel(Date.now() + 5 * 60 * 1000).length > 0, mod.fmtRel(Date.now() + 5 * 60 * 1000));
check("刚刚仍然正常", mod.fmtRel(Date.now() - 5 * 1000) === "刚刚", mod.fmtRel(Date.now() - 5 * 1000));
check("分钟仍然正常", mod.fmtRel(Date.now() - 5 * 60 * 1000) === "5 分钟前", mod.fmtRel(Date.now() - 5 * 60 * 1000));

/* ---------- 7. 缺 Key 的提示只出现一次 ---------- */
console.log("\n[7] 缺 Key 的提示");
mod.updateSettings({ localMode: "off", apiKey: "", sfx: false, autoRead: false }, { persist: false });
const toasts = [];
mod.toastEmitter.sub((t) => toasts.push(t.kind + ":" + t.text));
const offResult = await mod.speak("这是测试文本。", {});
check("关闭本地语音时返回 false", offResult === false);
check("缺 Key 只提示一次", toasts.filter((t) => t.indexOf("API Key") >= 0).length === 1, toasts);

/* ---------- 8. 云端优先 + 没 Key：自动播报回退本地 ---------- */
console.log("\n[8] 没 Key 时自动播报走本地");
mod.updateSettings({ localMode: "fallback", apiKey: "", sfx: false, autoRead: true }, { persist: false });
toasts.length = 0;
const autoResult = await mod.speak("自动播报应该回退到本地语音。", { auto: true });
check("自动播报仍然成功", autoResult === true);
check("自动播报不弹缺 Key 提示", toasts.filter((t) => t.indexOf("API Key") >= 0).length === 0, toasts);

/* ---------- 9. 自动播报：流式中不播，结束后只播一次 ---------- */
console.log("\n[9] 自动播报的流式判断");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await mod.startWatcher();
await sleep(30);
check("已订阅 messages", typeof subscriptions.messages === "function");

const oldMessage = { id: "m-old", role: "assistant", content: "这是早就存在的旧回复。", createdAt: Date.now() - 60000 };
const states = [];
mod.engineEmitter.sub((s) => states.push(s.status + ":" + s.provider));

// 首次快照：建立基线，不补播
subscriptions.messages({ domains: { messages: { conversationId: "c1", live: { isStreaming: false }, items: [oldMessage] } } });
await sleep(40);
check("首次快照不补播", !states.some((s) => s.indexOf("local") >= 0), states);

// 流式中内容增长：不朗读
subscriptions.messages({
  domains: {
    messages: {
      conversationId: "c1",
      live: { isStreaming: true },
      items: [oldMessage, { id: "m-new", role: "assistant", content: "流式中的第一句。", createdAt: Date.now() }],
    },
  },
});
await sleep(40);
check("流式中不朗读", !states.some((s) => s.indexOf("local") >= 0), states);

// 流式结束：朗读一次
subscriptions.messages({
  domains: {
    messages: {
      conversationId: "c1",
      live: { isStreaming: false },
      items: [oldMessage, { id: "m-new", role: "assistant", content: "流式中的第一句。这是定稿的第二句。", createdAt: Date.now() }],
    },
  },
});
await sleep(60);
check("结束后自动朗读", states.some((s) => s.indexOf("local") >= 0), states);
const playsAfterFinal = states.filter((s) => s.indexOf("local") >= 0).length;

// 同一快照重复推送：不再朗读
subscriptions.messages({
  domains: {
    messages: {
      conversationId: "c1",
      live: { isStreaming: false },
      items: [oldMessage, { id: "m-new", role: "assistant", content: "流式中的第一句。这是定稿的第二句。", createdAt: Date.now() }],
    },
  },
});
await sleep(60);
check("同一回复不重复播报", states.filter((s) => s.indexOf("local") >= 0).length === playsAfterFinal, states);

try {
  unlinkSync(generated);
} catch (e) {}

console.log(failures === 0 ? "\n第二轮回归：ALL PASS" : "\n第二轮回归：" + failures + " 项失败");
process.exit(failures === 0 ? 0 : 1);
