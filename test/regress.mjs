// 回归测试：覆盖本轮修复的缺陷
// 运行：node test/regress.mjs
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

/* ---------- 仿真 AudioContext：每段起播后立刻结束 ---------- */
class FakeAudioContext {
  constructor() {
    this.state = "running";
    this.currentTime = 0;
    this.destination = {};
    this.started = 0;
    FakeAudioContext.last = this;
  }
  resume() {
    return Promise.resolve();
  }
  createBufferSource() {
    const node = {
      playbackRate: { value: 1 },
      onended: null,
      connect() {},
      disconnect() {},
      stop() {
        this.stopped = true;
        if (this.onended) this.onended();
      },
      start() {
        FakeAudioContext.last.started++;
        setTimeout(() => {
          if (this.onended) this.onended();
        }, 0);
      },
    };
    return node;
  }
  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }
  decodeAudioData(buffer, ok) {
    this.decoded = new Uint8Array(buffer.slice(0, 4));
    ok({ duration: 0.05 });
  }
}

/* ---------- 宿主 API 桩：可注入 fetch 行为 ---------- */
const store = new Map();
let fetchImpl = null;
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
      return fetchImpl(url, options);
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
  SnowAppPlugin: { React: null, icons: {}, api: fakeApi, locale: "zh-CN" },
  AudioContext: FakeAudioContext,
};
globalThis.indexedDB = makeIdb();

const source = readFileSync(join(here, "..", "index.js"), "utf8");
const generated = join(tmpdir(), "mtts-regress-" + process.pid + ".mjs");
writeFileSync(
  generated,
  source +
    "\nexport { splitSegments, splitSentences, safeSlice, cleanText, fmtRel, interpolate, removeInstructionPhrase, addClip, removeClip, clearClips, listClips, putSample, listSamples, clearSamples, runCloud, speak, toastEmitter, getSettings, updateSettings, CLIP_LIMIT, SAMPLE_LIMIT, CANCEL };\n",
  "utf8"
);
const mod = await import(pathToFileURL(generated).href);

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok || extra === undefined ? "" : "  → " + JSON.stringify(extra)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wavBase64 = () =>
  Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(32)]).toString("base64");
const jsonResponse = (obj, status) => ({
  ok: status === undefined ? true : status < 400,
  status: status || 200,
  statusText: "OK",
  headers: {},
  url: "https://api.example/v1/chat/completions",
  body: "",
  bodyBase64: Buffer.from(JSON.stringify(obj), "utf8").toString("base64"),
});

/* ---------- 1. 分句不丢前导标点 ---------- */
console.log("\n[1] 分句：开头标点不丢");
const lead = mod.splitSegments("……先来一句。再来一句。", 200, 90);
check("开头省略号保留", lead.join("").indexOf("……") === 0, lead);
const dot = mod.splitSegments("。开头就是标点。", 200, 90);
check("开头句号保留", dot.join("").indexOf("。") === 0, dot);
const noLoss = mod.splitSegments("第一句。第二句！第三句？", 200, 90).join("");
check("常规分句不丢字", noLoss.replace(/\s+/g, "") === "第一句。第二句！第三句？", noLoss);
const multi = mod.splitSentences("真的吗！？不会吧……");
check("连续标点收在同一句尾", multi.length === 2 && multi[0] === "真的吗！？" && multi[1].indexOf("不会吧") === 0, multi);

/* ---------- 2. 删除 / 清空后内存副本不复活 ---------- */
console.log("\n[2] 音频历史：删除与清空");
await mod.clearClips();
await mod.addClip({ id: "clip-a", createdAt: 1000, bytes: 10, blob: new Blob(["a"]) });
await mod.addClip({ id: "clip-b", createdAt: 2000, bytes: 10, blob: new Blob(["b"]) });
let clips = await mod.listClips();
check("写入两条", clips.length === 2, clips.length);
await mod.removeClip("clip-a");
clips = await mod.listClips();
check("删除后不复活", clips.length === 1 && clips[0].id === "clip-b", clips.map((c) => c.id));
await mod.clearClips();
clips = await mod.listClips();
check("清空后为空", clips.length === 0, clips.length);

/* ---------- 3. 裁剪按时间保留最新 ---------- */
console.log("\n[3] 音频历史：裁剪顺序");
await mod.clearClips();
// 故意让主键顺序与 createdAt 顺序相反
for (let i = 0; i < mod.CLIP_LIMIT + 5; i++) {
  await mod.addClip({
    id: "k" + String(1000 - i).padStart(6, "0"),
    createdAt: 1000 + i,
    bytes: 1,
    blob: new Blob(["x"]),
  });
}
clips = await mod.listClips();
check("保留条数等于上限", clips.length === mod.CLIP_LIMIT, clips.length);
check("保留的是最新 100 条", clips[0].createdAt === 1000 + mod.CLIP_LIMIT + 4, clips[0].createdAt);
check("最旧的 5 条被裁掉", clips.every((c) => c.createdAt >= 1005), clips.map((c) => c.createdAt).slice(-3));
await mod.clearClips();

/* ---------- 4. 预取失败必须抛真实错误，不能被当作 blob ---------- */
console.log("\n[4] 分句流水线：预取失败的报错");
const longText = "第一句话在这里。第二句话在这。第三句话在这。".repeat(12);
let call = 0;
fetchImpl = async () => {
  call++;
  if (call === 1) {
    return jsonResponse({ choices: [{ message: { audio: { data: wavBase64() } } }] });
  }
  return jsonResponse({ error: { message: "quota exceeded" } }, 429);
};
const session = { canceled: false, segments: null, playedSegments: 0 };
const settings = Object.assign({}, mod.getSettings(), { apiKey: "sk-test", model: "mimo-v2.5-tts", maxChars: 60 });
let pipelineError = null;
try {
  await mod.runCloud(longText, settings, session);
} catch (err) {
  pipelineError = err;
}
check("抛出的是错误对象", !!pipelineError, String(pipelineError));
check("错误信息是接口给的原因", String(pipelineError && pipelineError.message).indexOf("quota") >= 0, String(pipelineError && pipelineError.message));
check("不是 arrayBuffer 类型错误", String(pipelineError && pipelineError.message).indexOf("arrayBuffer") < 0, String(pipelineError && pipelineError.message));
check("已播段数被记录（续读用）", session.playedSegments === 1, session.playedSegments);
check("分段文本随会话带上", Array.isArray(session.segments) && session.segments.length > 1, session.segments && session.segments.length);

/* ---------- 5. 设置：读盘不覆盖用户刚改的值 ---------- */
console.log("\n[5] 设置：读盘与内存修改的竞态");
mod.updateSettings({ autoRead: true });
check("内存修改立即生效", mod.getSettings().autoRead === true, mod.getSettings().autoRead);

/* ---------- 6. 截断与分句不切断 emoji ---------- */
console.log("\n[6] 代理对（emoji）边界");
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
check("safeSlice 不产生孤立代理项（奇数位）", !LONE.test(mod.safeSlice("😀😀😀", 1)), JSON.stringify(mod.safeSlice("😀😀😀", 1)));
check("safeSlice 不产生孤立代理项（中间位）", !LONE.test(mod.safeSlice("😀😀😀", 3)), JSON.stringify(mod.safeSlice("😀😀😀", 3)));
check("safeSlice 正常截断中文", mod.safeSlice("你好世界", 2) === "你好", mod.safeSlice("你好世界", 2));
const emojiSegs = mod.splitSegments("😀".repeat(200), 60, 60);
check("分句按码点切", emojiSegs.every((s) => Array.from(s).length <= 60), emojiSegs.map((s) => Array.from(s).length));
check("分句不切断 emoji", emojiSegs.every((s) => !LONE.test(s)), emojiSegs.length);
check("分句不丢 emoji", emojiSegs.join("").length === 200 * 2, emojiSegs.join("").length);

/* ---------- 7. 文案插值 / 时间戳 / 语气标签 ---------- */
console.log("\n[7] 文案插值、时间戳与语气标签");
check("兜底文案仍会插值", mod.interpolate("出错了：{{msg}}", { msg: "boom" }) === "出错了：boom", mod.interpolate("出错了：{{msg}}", { msg: "boom" }));
check("缺失的占位符原样保留", mod.interpolate("{{a}}-{{b}}", { a: 1 }) === "1-{{b}}", mod.interpolate("{{a}}-{{b}}", { a: 1 }));

const publicSettings = window.snowMimoTts.getSettings();
check(
  "对外接口不返回 API Key",
  !("apiKey" in publicSettings) && typeof publicSettings.hasApiKey === "boolean",
  publicSettings
);

const localStamp = (ms) => {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
check("文本时间戳能解析成相对时间", mod.fmtRel(localStamp(Date.now() - 5 * 60 * 1000)) === "5 分钟前", mod.fmtRel(localStamp(Date.now() - 5 * 60 * 1000)));
check("毫秒数字符串能解析", mod.fmtRel(String(Date.now() - 2 * 60 * 1000)) === "2 分钟前", mod.fmtRel(String(Date.now() - 2 * 60 * 1000)));
check("无法解析的时间戳返回空串", mod.fmtRel("not a date") === "" && mod.fmtRel(0) === "", [mod.fmtRel("not a date"), mod.fmtRel(0)]);

check(
  "独立成段的标签整段移除",
  mod.removeInstructionPhrase("先温柔一点，用开心雀跃的语气，慢点", "用开心雀跃的语气") === "先温柔一点，慢点",
  mod.removeInstructionPhrase("先温柔一点，用开心雀跃的语气，慢点", "用开心雀跃的语气")
);
check(
  "追加的标签能完全去掉",
  mod.removeInstructionPhrase("用开心雀跃的语气", "用开心雀跃的语气") === "",
  mod.removeInstructionPhrase("用开心雀跃的语气", "用开心雀跃的语气")
);
check(
  "嵌在句子里的标签也能去掉（不再卡住）",
  mod.removeInstructionPhrase("用温柔轻声的语气说话，语速慢点", "用温柔轻声的语气") === "说话，语速慢点",
  mod.removeInstructionPhrase("用温柔轻声的语气说话，语速慢点", "用温柔轻声的语气")
);

/* ---------- 8. 英文句点断句 / 比较符号不被当标签 ---------- */
console.log("\n[8] 英文断句与 HTML 标签识别");
const en = mod.splitSentences("Hello world. This is a test. 3.14 is pi.");
check("英文句号参与断句", en.length === 3 && en[0] === "Hello world." && en[2] === "3.14 is pi.", en);
check("小数点与文件名不被切断", mod.splitSentences("打开 a.ts 写入 3.14").length === 1, mod.splitSentences("打开 a.ts 写入 3.14"));
const cmp = mod.cleanText("如果 a < b 且 b > c 就交换");
check("比较符号保留", cmp.indexOf("a < b") >= 0 && cmp.indexOf("b > c") >= 0, cmp);
const html = mod.cleanText('<div class="box">正文</div>');
check("真正的 HTML 标签仍被剔除", html.indexOf("正文") >= 0 && html.indexOf("div") < 0, html);

/* ---------- 9. 复刻样本：上传新样本不挤掉当前选中的 ---------- */
console.log("\n[9] 复刻样本上限与选中项");
await mod.clearSamples();
mod.updateSettings({ cloneSampleId: "s-old" }, { persist: false });
for (let i = 0; i < mod.SAMPLE_LIMIT; i++) {
  await mod.putSample({
    id: i === 0 ? "s-old" : "s" + i,
    name: "a.wav",
    mime: "audio/wav",
    size: 1,
    base64: "AA==",
    createdAt: 1000 + i,
  });
}
await mod.putSample({ id: "s-new", name: "b.wav", mime: "audio/wav", size: 1, base64: "AA==", createdAt: 5000 });
const keptSamples = await mod.listSamples();
check("样本数量不超过上限", keptSamples.length === mod.SAMPLE_LIMIT, keptSamples.length);
check("当前选中的样本还在", keptSamples.some((s) => s.id === "s-old"), keptSamples.map((s) => s.id));
check("新样本已写入", keptSamples.some((s) => s.id === "s-new"), keptSamples.map((s) => s.id));
check("最旧的未选中样本被挤掉", !keptSamples.some((s) => s.id === "s1"), keptSamples.map((s) => s.id));

await mod.putSample({ id: "s-new", name: "b2.wav", mime: "audio/wav", size: 1, base64: "AA==", createdAt: 6000 });
const replacedSamples = await mod.listSamples();
check(
  "覆盖已有样本不会挤掉别人",
  replacedSamples.length === mod.SAMPLE_LIMIT && replacedSamples.some((s) => s.id === "s2"),
  replacedSamples.map((s) => s.id)
);
await mod.clearSamples();
mod.updateSettings({ cloneSampleId: "" }, { persist: false });

/* ---------- 10. IndexedDB 不可用：内存兜底队列的删除与清空 ---------- */
console.log("\n[10] 内存兜底：删除与清空算成功");
const savedIdb = globalThis.indexedDB;
globalThis.indexedDB = undefined;
let threw = false;
try {
  await mod.addClip({ id: "mem-1", createdAt: 1, bytes: 10, blob: new Blob(["m"]) });
} catch (e) {
  threw = true;
}
check("写库失败会抛错（走内存兜底）", threw);
let memList = await mod.listClips();
check("内存兜底记录仍可见", memList.length === 1 && memList[0].id === "mem-1", memList.map((c) => c.id));
check("删除内存记录返回成功", (await mod.removeClip("mem-1")) === true);
memList = await mod.listClips();
check("删除后列表为空", memList.length === 0, memList.length);
try {
  await mod.addClip({ id: "mem-2", createdAt: 2, bytes: 10, blob: new Blob(["n"]) });
} catch (e) {}
check("清空内存记录返回成功", (await mod.clearClips()) === true);
memList = await mod.listClips();
check("清空后列表为空", memList.length === 0, memList.length);
globalThis.indexedDB = savedIdb;

/* ---------- 11. 自动播报遇到空文本不弹警告 ---------- */
console.log("\n[11] 自动播报的空文本提示");
const toasts = [];
mod.toastEmitter.sub((t) => toasts.push(t.text));
const onlyCode = "```js\nconst a = 1;\n```";
const autoResult = await mod.speak(onlyCode, { auto: true });
check("自动播报遇到纯代码不朗读", autoResult === false);
check("自动播报不弹『没有可朗读的文字』", toasts.length === 0, toasts);
const manualResult = await mod.speak(onlyCode, {});
check(
  "手动朗读纯代码仍会提示",
  manualResult === false && toasts.some((t) => t.indexOf("没有可朗读") >= 0),
  toasts
);

/* ---------- 12. 兜底链路：提示要说清是哪一路失败了 ---------- */
console.log("\n[12] 本地优先失败时的提示文案");
mod.updateSettings({ localMode: "primary", apiKey: "", sfx: false }, { persist: false });
toasts.length = 0;
const failedBoth = await mod.speak("测试本地失败提示。", {});
check("两路都失败时返回 false", failedBoth === false);
check(
  "本地失败提示的是「本地语音不可用」，不是「云端合成失败」",
  toasts.some((t) => t.indexOf("本地语音不可用") >= 0 && t.indexOf("云端合成失败") < 0),
  toasts
);
check(
  "随后说明改用了云端",
  toasts.some((t) => t.indexOf("本地语音不可用") >= 0 && t.indexOf("改用 MiMo 云端语音") >= 0),
  toasts
);

try {
  unlinkSync(generated);
} catch (e) {}

console.log(failures === 0 ? "\n回归：ALL PASS" : "\n回归：" + failures + " 项失败");
process.exit(failures === 0 ? 0 : 1);
