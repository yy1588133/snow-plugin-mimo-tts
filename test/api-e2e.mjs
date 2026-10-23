// 端到端测试：真实 MiMo 接口 + 插件自身代码路径
// 运行：$env:MIMO_KEY="sk-..."; node test/api-e2e.mjs
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const KEY = process.env.MIMO_KEY || "";
if (!KEY) {
  console.error("缺少环境变量 MIMO_KEY");
  process.exit(2);
}

/* ---------- 最小 IndexedDB 桩：让插件的历史/样本代码真实跑起来 ---------- */
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
    if (!map) throw new Error("缺少对象仓库 " + name);
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

/* ---------- 宿主 API 桩：net.fetch 走真实网络，返回体与宿主同构 ---------- */
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
    async get(key) {
      return store.get(key) || null;
    },
    async set(key, value) {
      store.set(key, value);
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
};

globalThis.window = {
  SnowAppPlugin: { React: null, icons: {}, api: fakeApi, locale: "zh-CN" },
};
globalThis.indexedDB = makeIdb();

/* ---------- 加载插件真实源码 ---------- */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "index.js"), "utf8");
const generated = join(tmpdir(), "mtts-e2e-" + process.pid + ".mjs");
writeFileSync(
  generated,
  source +
    "\nexport { synthesizeSegment, buildRequestBody, splitSegments, concatWav, wavDuration, parseWav, putSample, listSamples, addClip, listClips, updateSettings, getSettings };\n",
  "utf8"
);
const mod = await import(pathToFileURL(generated).href);

/* ---------- 测试工具 ---------- */
let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok || extra === undefined ? "" : "  → " + JSON.stringify(extra)));
}

function toneWav(seconds, freq = 440, sampleRate = 24000) {
  const count = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 8000), i * 2);
  }
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

const baseSettings = Object.assign({}, mod.getSettings(), {
  apiKey: KEY,
  baseUrl: "https://api.xiaomimimo.com/v1",
  rate: 1,
  volume: 1,
  instruction: "",
});

async function synth(label, settings, text) {
  const started = Date.now();
  try {
    const blob = await mod.synthesizeSegment(text, settings);
    const buf = Buffer.from(await blob.arrayBuffer());
    const parsed = mod.parseWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const duration = mod.wavDuration(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    console.log(
      `  · ${label}: ${((Date.now() - started) / 1000).toFixed(1)}s, ${(buf.length / 1024).toFixed(0)} KB, ` +
        `${(duration / 1000).toFixed(2)}s 音频, ${parsed ? parsed.fmt.sampleRate + "Hz/" + parsed.fmt.channels + "ch" : "非 WAV"}`
    );
    return { blob, buf, parsed, duration };
  } catch (err) {
    console.log(`  · ${label}: 失败 → ${err && err.message}`);
    return { error: err };
  }
}

/* ---------- 1. 预置音色 ---------- */
console.log("\n[1] 预置音色 mimo-v2.5-tts / 冰糖");
const r1 = await synth("冰糖", Object.assign({}, baseSettings, { model: "mimo-v2.5-tts", voice: "冰糖" }), "你好，我是雪。语音朗读插件已经接上小米 MiMo 了。");
check("返回音频", r1.blob && r1.blob.size > 20000, r1.error && r1.error.message);
check("是合法 WAV", !!r1.parsed);
check("采样率 24kHz 单声道", r1.parsed && r1.parsed.fmt.sampleRate === 24000 && r1.parsed.fmt.channels === 1, r1.parsed && r1.parsed.fmt);
check("时长合理（2–20 秒）", r1.duration > 2000 && r1.duration < 20000, r1.duration);

/* ---------- 2. 英文音色 + 语气指令 ---------- */
console.log("\n[2] 英文音色 Chloe + 语气指令");
const r2 = await synth(
  "Chloe + 指令",
  Object.assign({}, baseSettings, { model: "mimo-v2.5-tts", voice: "Chloe", instruction: "用轻快兴奋的语气" }),
  "All tests passed. The plugin is wired to the real speech API."
);
check("英文音色可用", r2.blob && r2.blob.size > 20000, r2.error && r2.error.message);
check("指令不影响音频合法性", !!r2.parsed);

/* ---------- 3. 音色设计 ---------- */
console.log("\n[3] 音色设计 mimo-v2.5-tts-voicedesign");
const r3 = await synth(
  "音色设计",
  Object.assign({}, baseSettings, {
    model: "mimo-v2.5-tts-voicedesign",
    designPrompt: "年轻女性，声音温柔知性，语速偏慢，尾音轻轻上扬。",
    instruction: "",
  }),
  "这段声音是按描述现场设计出来的，没有用任何预置音色。"
);
check("音色设计可用", r3.blob && r3.blob.size > 20000, r3.error && r3.error.message);

/* ---------- 4. 声音复刻（用第 1 步的音频当样本） ---------- */
console.log("\n[4] 声音复刻 mimo-v2.5-tts-voiceclone");
let r4 = { error: new Error("无可用样本") };
if (r1.blob) {
  const sampleBase64 = Buffer.from(await r1.blob.arrayBuffer()).toString("base64");
  const saved = await mod.putSample({
    id: "e2e-sample",
    name: "e2e.wav",
    mime: "audio/wav",
    size: sampleBase64.length,
    base64: sampleBase64,
    createdAt: Date.now(),
  });
  check("样本写入 IndexedDB", !!saved);
  const samples = await mod.listSamples();
  check("样本可读回", samples.length === 1 && samples[0].id === "e2e-sample");
  r4 = await synth(
    "复刻音色",
    Object.assign({}, baseSettings, { model: "mimo-v2.5-tts-voiceclone", cloneSampleId: "e2e-sample", instruction: "" }),
    "这句话是用刚才那段音频复刻出来的声音念的。"
  );
  check("声音复刻可用", r4.blob && r4.blob.size > 20000, r4.error && r4.error.message);
} else {
  check("声音复刻可用", false, "缺少样本（第 1 步失败）");
}

/* ---------- 5. 分句流水线 + WAV 拼接 + 历史落盘 ---------- */
console.log("\n[5] 分句流水线 / 拼接 / 历史");
const longText =
  "这是一段用来测试长文本分句流水线的文字。第一句用来确认切句正常。" +
  "第二句稍微长一点点，看看合并逻辑会不会把同段句子拼到两百字以内。" +
  "第三句带一个问号，看看标点切分有没有问题？" +
  "第四句带感叹号，语气应该更明显！" +
  "第五句继续补充内容，让整段文字超过四百字，从而稳定切出三段以上。" +
  "第六句讲的是拼接：每段单独合成之后要能拼回一个完整的 WAV，头信息必须重写正确。" +
  "第七句讲的是时长：拼接后的总时长应当等于各段时长之和，误差不能超过几十毫秒。" +
  "第八句讲的是历史：只保存一条记录，而不是每段一条。" +
  "第九句用来确认标点被保留在段尾，不会被吃掉。" +
  "第十句收尾，用来确认最后一段不会被丢掉。";
const segments = mod.splitSegments(longText, 200, 90);
console.log(`  · 切分为 ${segments.length} 段：${segments.map((s) => s.length).join(" / ")} 字`);
check("切分结果不为空", segments.length > 0);
check("首段不超过 90 字（首音更快）", segments[0].length <= 90, segments[0].length);
check("后续段不超过 200 字", segments.slice(1).every((s) => s.length <= 200));
check("分句后不丢字", segments.join("").replace(/\s+/g, "") === longText.replace(/\s+/g, ""), {
  got: segments.join("").length,
  want: longText.length,
});

const blobs = [];
for (let i = 0; i < segments.length; i++) {
  const part = await synth("第 " + (i + 1) + " 段", Object.assign({}, baseSettings, { model: "mimo-v2.5-tts", voice: "茉莉" }), segments[i]);
  if (!part.blob) {
    check("第 " + (i + 1) + " 段合成成功", false, part.error && part.error.message);
    break;
  }
  blobs.push(part.blob);
}
check("所有分段都合成成功", blobs.length === segments.length, { got: blobs.length, want: segments.length });

if (blobs.length) {
  const merged = await mod.concatWav(blobs);
  check("拼接结果为整体", merged.whole === true, merged.whole);
  const mergedBuf = Buffer.from(await merged.blob.arrayBuffer());
  const mergedDuration = mod.wavDuration(mergedBuf.buffer.slice(mergedBuf.byteOffset, mergedBuf.byteOffset + mergedBuf.byteLength));
  const sumDuration = blobs.length
    ? await Promise.all(
        blobs.map(async (b) => {
          const buf = Buffer.from(await b.arrayBuffer());
          return mod.wavDuration(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        })
      ).then((list) => list.reduce((a, b) => a + b, 0))
    : 0;
  check("拼接时长等于各段之和", Math.abs(mergedDuration - sumDuration) < 50, { mergedDuration: Math.round(mergedDuration), sumDuration: Math.round(sumDuration) });

  await mod.addClip({
    id: "e2e-clip",
    createdAt: Date.now(),
    text: longText.slice(0, 200),
    chars: longText.length,
    model: "mimo-v2.5-tts",
    voice: "茉莉",
    provider: "mimo",
    bytes: merged.blob.size,
    durationMs: mergedDuration,
    whole: merged.whole,
    blob: merged.blob,
  });
  const clips = await mod.listClips();
  check("历史写入并可按时间读回", clips.length === 1 && clips[0].id === "e2e-clip", clips.map((c) => c.id));
  check("历史保存了完整音频体积", clips[0] && clips[0].bytes === merged.blob.size);
}

/* ---------- 6. 错误路径：坏 Key 不应崩溃 ---------- */
console.log("\n[6] 错误路径");
const bad = await synth("错误 Key", Object.assign({}, baseSettings, { apiKey: "sk-invalid-key-for-test", model: "mimo-v2.5-tts" }), "test");
check("坏 Key 抛出可读错误", !!bad.error && typeof bad.error.message === "string" && bad.error.message.length > 0, bad.error && bad.error.message);
check("错误信息不是空泛的 undefined", bad.error && bad.error.message !== "undefined" && bad.error.message !== "null");

const missing = await synth("缺少 Key", Object.assign({}, baseSettings, { apiKey: "" }), "test");
check("缺少 Key 返回 MISSING_KEY", missing.error && missing.error.message === "MISSING_KEY", missing.error && missing.error.message);

const badModel = await synth("不存在的模型", Object.assign({}, baseSettings, { model: "mimo-not-exist" }), "test");
check("错误模型返回可读错误", !!badModel.error && badModel.error.message.length > 0, badModel.error && badModel.error.message);

/* ---------- 7. 响应体积上限 ---------- */
console.log("\n[7] 单段体积与上限");
if (r1.blob) {
  const perChar = r1.blob.size / "你好，我是雪。语音朗读插件已经接上小米 MiMo 了。".length;
  const estimate = perChar * 200;
  console.log(`  · 约 ${(perChar / 1024).toFixed(1)} KB/字，200 字预估 ${(estimate / 1024 / 1024).toFixed(2)} MB（宿主上限 5 MB）`);
  check("200 字分段不会顶到 5MB 上限", estimate < 5 * 1024 * 1024, Math.round(estimate));
}

try {
  unlinkSync(generated);
} catch (e) {}

console.log(failures === 0 ? "\n端到端：ALL PASS" : "\n端到端：" + failures + " 项失败");
process.exit(failures === 0 ? 0 : 1);
