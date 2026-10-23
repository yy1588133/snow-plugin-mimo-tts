/*
 * 语音朗读 —— Snow App 面板插件（Xiaomi MiMo TTS）
 * =================================================
 * 复刻 dsh-plugin-xiaomi-mimo-tts 的朗读体验，接入 Xiaomi MiMo TTS：
 *   · 三种模型：预置音色（mimo-v2.5-tts）/ 音色设计（-voicedesign）/ 声音复刻（-voiceclone）
 *   · 分句流水线：边合成边播放，第一段出声快，长文不会一次顶满 5 MB 响应上限
 *   · 语气指令（user 消息，不朗读）+ 标签快捷拼装
 *   · 自动播报：监听 messages 实时域，助手回复结束后自动朗读（只播新事件，不补播旧记录）
 *   · 浏览器本地语音兜底（云端优先 / 本地优先 / 关闭）
 *   · 音频历史：IndexedDB 保存完整 WAV（多段自动拼接），可试听、下载
 *   · 对外接口：window.snowMimoTts.play(text) / stop() / pause() / resume()
 *
 * 数据与隐私：
 *   读取 messages 域（已在 plugin.json 声明），网络请求走 api.net.fetch（network 域）。
 *   API Key 存在插件私有存储，只在请求 api.xiaomimimo.com 时使用。
 *
 * 实现约定：无 JSX、无相对 import，全部用宿主注入的 React 实例创建元素。
 */

const host = typeof window !== "undefined" ? window.SnowAppPlugin || {} : {};
let RUNTIME_API = host.api || null;
const React = host.React || null;
const el = React ? React.createElement : null;
const HOOKS = React || {};
const useState = HOOKS.useState;
const useEffect = HOOKS.useEffect;
const useRef = HOOKS.useRef;
const useCallback = HOOKS.useCallback;
const useMemo = HOOKS.useMemo;

const DEFAULT_BASE = "https://api.xiaomimimo.com/v1";
const SETTINGS_KEY = "settings.v1";
const CLIP_LIMIT = 100;
const CLIP_BYTES_LIMIT = 100 * 1024 * 1024;
const SAMPLE_LIMIT = 10;
const SAMPLE_MAX_BYTES = 7 * 1024 * 1024; // base64 后约 9.3 MB，低于官方 10 MB 上限
const MAX_CHARS_PER_REQUEST = 200;
const FIRST_CHUNK_CHARS = 90;
const MAX_FETCH_BYTES = 5 * 1024 * 1024;
/** 单次朗读的文本上限：防止粘贴整本书时触发上百次请求、占满额度。
 * 按实测约 8 KB/字计算，6000 字≈48 MB 音频，再长的内容拼接时内存峰值会过高。 */
const MAX_READ_CHARS = 6000;
const UI_LOCALE = host.locale || "zh-CN";
const FALLBACK_VERSION = "1.0.3";

/** 版本号以宿主注入的 plugin.version 为准，避免和 plugin.json 脱节 */
function pluginVersion() {
  const injected =
    typeof window !== "undefined" && window.SnowAppPlugin && window.SnowAppPlugin.plugin
      ? window.SnowAppPlugin.plugin
      : null;
  return (injected && injected.version) || (host.plugin && host.plugin.version) || FALLBACK_VERSION;
}

const MODELS = [
  {
    id: "mimo-v2.5-tts",
    label: "预置音色",
    labelEn: "Preset",
    labelKey: "mixer.model.preset",
    icon: "Sparkles",
    hint: "开箱即用的 9 种精品音色",
    hintEn: "Nine ready-made premium voices",
  },
  {
    id: "mimo-v2.5-tts-voicedesign",
    label: "音色设计",
    labelEn: "Design",
    labelKey: "mixer.model.design",
    icon: "Wand2",
    hint: "用一句话描述你想要的音色",
    hintEn: "Describe the voice you want in one sentence",
  },
  {
    id: "mimo-v2.5-tts-voiceclone",
    label: "声音复刻",
    labelEn: "Clone",
    labelKey: "mixer.model.clone",
    icon: "Mic",
    hint: "上传 mp3 / wav 样本复刻音色",
    hintEn: "Upload an mp3 / wav sample to clone a voice",
  },
];

const VOICES = [
  { id: "mimo_default", name: "MiMo 默认", meta: "随集群而定", metaKey: "voice.meta.default", group: "default" },
  { id: "冰糖", name: "冰糖", meta: "中文 · 女声", group: "zh" },
  { id: "茉莉", name: "茉莉", meta: "中文 · 女声", group: "zh" },
  { id: "苏打", name: "苏打", meta: "中文 · 男声", group: "zh" },
  { id: "白桦", name: "白桦", meta: "中文 · 男声", group: "zh" },
  { id: "Mia", name: "Mia", meta: "English · Female", group: "en" },
  { id: "Chloe", name: "Chloe", meta: "English · Female", group: "en" },
  { id: "Milo", name: "Milo", meta: "English · Male", group: "en" },
  { id: "Dean", name: "Dean", meta: "English · Male", group: "en" },
];

const DESIGN_PRESETS = [
  { label: "温柔知性", text: "年轻女性，声音温柔知性，语速偏慢，尾音轻轻上扬，像深夜电台。" },
  { label: "沉稳播报", text: "中年男性，声音低沉平稳，吐字清晰，节奏克制，适合新闻播报。" },
  { label: "活泼少女", text: "少女音，语调活泼跳脱，语速偏快，句尾带一点笑意。" },
  { label: "磁性低音", text: "成年男性，气声较多的磁性低音，节奏舒缓，有故事感。" },
  { label: "英文旁白", text: "Young female voice, warm and clear, natural American English, gentle pacing." },
];

const STYLE_TAGS = [
  { tag: "开心", phrase: "用开心雀跃的语气" },
  { tag: "悲伤", phrase: "用低沉悲伤的语气" },
  { tag: "激动", phrase: "用激动的语气，语速稍快" },
  { tag: "温柔", phrase: "用温柔轻声的语气" },
  { tag: "高冷", phrase: "用冷淡克制的语气" },
  { tag: "活泼", phrase: "用活泼俏皮的语气" },
  { tag: "严肃", phrase: "用严肃认真的语气" },
  { tag: "笑声", phrase: "偶尔带一点笑意" },
  { tag: "喘气", phrase: "适当加入呼吸感" },
  { tag: "东北话", phrase: "用东北方言" },
  { tag: "四川话", phrase: "用四川方言" },
  { tag: "粤语", phrase: "用粤语" },
  { tag: "夹子音", phrase: "用甜软的夹子音" },
  { tag: "御姐音", phrase: "用成熟御姐音" },
  { tag: "大叔音", phrase: "用低沉大叔音" },
  { tag: "唱歌", phrase: "用唱歌的方式演绎" },
];

const DEFAULT_SETTINGS = {
  apiKey: "",
  baseUrl: DEFAULT_BASE,
  model: "mimo-v2.5-tts",
  voice: "冰糖",
  designPrompt: "",
  cloneSampleId: "",
  instruction: "",
  rate: 1,
  volume: 1,
  range: "smart",
  localMode: "fallback",
  autoRead: false,
  sfx: false,
  maxChars: MAX_CHARS_PER_REQUEST,
};

const SAMPLE_TEXT =
  "你好，我是雪。这段话用来试听当前的音色和语速，你可以随时修改它。";

/** 试听稿草稿：切到别的标签会卸载 StageTab，草稿留在模块里，
 * 用户去调音台换完音色再回来时不会发现辛苦输入的文字被示例文案顶掉 */
let stageDraft = SAMPLE_TEXT;

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function cx() {
  const out = [];
  for (let i = 0; i < arguments.length; i++) if (arguments[i]) out.push(arguments[i]);
  return out.join(" ");
}

function icon(name, size) {
  const icons = (typeof window !== "undefined" && window.SnowAppPlugin && window.SnowAppPlugin.icons) || null;
  const C = icons ? icons[name] : null;
  if (!C) return null;
  return el(C, { size: size || 14, "aria-hidden": "true" });
}

function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0 B";
  if (v < 1024) return Math.round(v) + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(0) + " KB";
  return (v / 1024 / 1024).toFixed(1) + " MB";
}

/** 按 UTF-16 安全截断：不在 emoji 的代理对中间切开，否则会产生半个字符 */
function safeSlice(text, max) {
  const s = String(text == null ? "" : text);
  if (!Number.isFinite(max) || max <= 0) return "";
  if (s.length <= max) return s;
  let end = Math.floor(max);
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

function fmtClock(sec) {
  const v = Number(sec);
  if (!Number.isFinite(v) || v < 0) return "0:00";
  const total = Math.floor(v);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ":" + (s < 10 ? "0" : "") + s;
}

/**
 * 时间戳归一化：兼容毫秒数、毫秒 / 秒数字符串、ISO 以及 "YYYY-MM-DD HH:mm:ss" 文本。
 * 宿主 messages 域的 createdAt 可能是数据库原样文本（不是毫秒数），
 * 直接 Number() 会得到 NaN，界面上就会只剩一个孤零零的「·」。
 */
function toMillis(ts) {
  if (typeof ts === "number") return Number.isFinite(ts) && ts > 0 ? ts : 0;
  const raw = String(ts == null ? "" : ts).trim();
  if (!raw) return 0;
  if (/^\d{12,}$/.test(raw)) return Number(raw);
  if (/^\d{9,11}$/.test(raw)) return Number(raw) * 1000;
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(raw) ? raw.replace(" ", "T") : raw;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function fmtRel(ts) {
  const ms = toMillis(ts);
  if (!ms) return "";
  const diff = Date.now() - ms;
  const d = new Date(ms);
  const pad = function (x) {
    return (x < 10 ? "0" : "") + x;
  };
  const day = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  // 时钟轻微偏差时不要把刚生成的记录当成「未来」；偏差更大（系统时间被回拨）时退回日期
  if (diff < 0) return diff > -60 * 1000 ? T("time.justNow", "刚刚") : day;
  if (diff < 60 * 1000) return T("time.justNow", "刚刚");
  if (diff < 60 * 60 * 1000) return T("time.minutesAgo", "{{n}} 分钟前", { n: Math.floor(diff / 60000) });
  if (diff < 24 * 60 * 60 * 1000) return T("time.hoursAgo", "{{n}} 小时前", { n: Math.floor(diff / 3600000) });
  return day;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 文案插值：把 {{name}} 换成 values 里的值；取不到的值原样保留，避免抛出 */
function interpolate(text, values) {
  const src = String(text == null ? "" : text);
  if (!values) return src;
  return src.replace(/\{\{\s*([\w.]+)\s*\}\}/g, function (match, name) {
    const v = values[name];
    return v === undefined || v === null ? match : String(v);
  });
}

/** 没有宿主 t() 时的兜底：直接用中文默认文案，但仍然要替换占位符 */
let T = function (key, def, values) {
  return interpolate(def || key, values);
};

function bindT(api) {
  if (!api || typeof api.t !== "function") return;
  T = function (key, def, values) {
    try {
      const text = api.t(key, { defaultValue: def, values: values });
      // 旧宿主可能只回默认文案、不做插值，这里再补一次（已插值过则是空操作）
      return interpolate(text || def || key, values);
    } catch (e) {
      return interpolate(def || key, values);
    }
  };
}

function makeEmitter() {
  const listeners = new Set();
  return {
    sub(fn) {
      listeners.add(fn);
      return function () {
        listeners.delete(fn);
      };
    },
    emit(value) {
      listeners.forEach(function (fn) {
        try {
          fn(value);
        } catch (e) {
          /* 单个订阅者失败不影响其他订阅者 */
        }
      });
    },
    count() {
      return listeners.size;
    },
  };
}

function base64ToBytes(input) {
  const clean = String(input || "")
    .replace(/^data:[^,]*,/, "")
    .replace(/\s+/g, "");
  if (!clean) return new Uint8Array(0);
  let bin;
  try {
    bin = atob(clean);
  } catch (e) {
    throw new Error("音频数据不是合法 base64（长度 " + clean.length + "），响应可能被截断");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  let out = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(out);
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8").decode(bytes);
  } catch (e) {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* 设置：插件私有存储（api.storage，失败回退 localStorage）             */
/* ------------------------------------------------------------------ */

const settingsEmitter = makeEmitter();
let cachedSettings = Object.assign({}, DEFAULT_SETTINGS);
let settingsLoaded = false;
let settingsLoadedWithStorage = false;
let settingsDirty = false;
let loadingPromise = null;
let saveTimer = 0;

function storageApi() {
  const api = RUNTIME_API || host.api;
  return api && api.storage ? api.storage : null;
}

async function readStoredSettings() {
  const st = storageApi();
  if (st && typeof st.getJson === "function") {
    try {
      return await st.getJson(SETTINGS_KEY);
    } catch (e) {
      return null;
    }
  }
  try {
    const raw = window.localStorage.getItem("snow.mimo-tts." + SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function writeStoredSettings(value) {
  const st = storageApi();
  if (st && typeof st.setJson === "function") {
    try {
      const pending = st.setJson(SETTINGS_KEY, value);
      if (pending && typeof pending.catch === "function") pending.catch(function () {});
    } catch (e) {
      /* 存储异常时保持内存态 */
    }
    return;
  }
  try {
    window.localStorage.setItem("snow.mimo-tts." + SETTINGS_KEY, JSON.stringify(value));
  } catch (e) {
    /* 存储不可用时保持内存态 */
  }
}

function loadSettings() {
  if (settingsLoaded) return Promise.resolve(cachedSettings);
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async function () {
    let hasStorage = false;
    try {
      hasStorage = !!storageApi();
      const saved = await readStoredSettings();
      if (saved && typeof saved === "object") {
        const merged = Object.assign({}, DEFAULT_SETTINGS, saved);
        merged.rate = clamp(merged.rate, 0.5, 2);
        merged.volume = clamp(merged.volume, 0, 1);
        // 读盘期间用户已经改过的设置优先，避免面板刚打开就被磁盘旧值覆盖
        cachedSettings = settingsDirty ? Object.assign({}, merged, cachedSettings) : merged;
      }
      settingsLoadedWithStorage = hasStorage;
    } catch (e) {
      // 读盘异常也要结束 loading 状态：否则 settingsLoaded 永远为 false，
      // 面板会一直停在默认值，而且每次调用都复用同一个失败 Promise
      settingsLoadedWithStorage = hasStorage;
    }
    settingsLoaded = true;
    settingsEmitter.emit(cachedSettings);
    return cachedSettings;
  })();
  return loadingPromise;
}

/**
 * 模块可能在宿主注入 api 之前就执行过（那时只能读 localStorage），
 * 面板挂载后再补读一次插件私有存储，否则已保存的 Key / 音色会显示成默认值。
 * 用 then 串行化，避免和进行中的首次读盘并发写 cachedSettings。
 */
function ensureSettingsFromStorage() {
  return loadSettings()
    .then(function () {
      if (settingsLoadedWithStorage || !storageApi()) return cachedSettings;
      settingsLoaded = false;
      loadingPromise = null;
      return loadSettings();
    })
    .catch(function () {
      return cachedSettings;
    });
}

function getSettings() {
  return cachedSettings;
}

function updateSettings(patch, options) {
  const opts = options || {};
  cachedSettings = Object.assign({}, cachedSettings, patch || {});
  settingsLoaded = true;
  settingsDirty = true;
  if (opts.silent) return cachedSettings;
  settingsEmitter.emit(cachedSettings);
  if (opts.persist === false) return cachedSettings;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    saveTimer = 0;
    writeStoredSettings(cachedSettings);
  }, 350);
  return cachedSettings;
}

/* ------------------------------------------------------------------ */
/* 文本处理：清洗、范围裁剪、分句                                       */
/* ------------------------------------------------------------------ */

function cleanText(raw) {
  let t = String(raw == null ? "" : raw);
  t = t.replace(/\r\n?/g, "\n");
  // 代码块 / 行内代码 / chip 标记
  t = t.replace(/```[\s\S]*?```/g, " ");
  t = t.replace(/~~~[\s\S]*?~~~/g, " ");
  t = t.replace(/`[^`\n]*`/g, " ");
  t = t.replace(/@@[A-Za-z]+:[^@]*@@/g, " ");
  // 图片与链接（链接保留文字）
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");
  // 裸网址
  t = t.replace(/https?:\/\/\S+/g, " ");
  // HTML 标签：先去掉注释，再只认「标签名 + 合法属性」的写法。
  // 旧实现用 `<[!?A-Za-z][^>]{0,400}>`，`a<b 且 b>c` 会被整段当成标签删掉，
  // 现在属性名必须是 ASCII 标识符，比较表达式不会被误伤。
  t = t.replace(/<!--[\s\S]*?-->/g, " ");
  t = t.replace(
    /<\/?(?:[A-Za-z][A-Za-z0-9:-]*|\?[A-Za-z][^>]{0,400}|![A-Za-z][^>]{0,400})(?:\s+[A-Za-z_:][-A-Za-z0-9_:.]*(?:\s*=\s*(?:"[^"]{0,200}"|'[^']{0,200}'|[^\s"'=<>`]{1,200}))?){0,16}\s*\/?>/g,
    " "
  );
  // 标题、列表、表格、引用
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  t = t.replace(/^[ \t]{0,3}>[ \t]?/gm, "");
  t = t.replace(/^[ \t]{0,3}[-*+][ \t]+/gm, "");
  t = t.replace(/^[ \t]{0,3}\d+[.)][ \t]+/gm, "");
  t = t.replace(/^[ \t]*\|.*\|[ \t]*$/gm, " ");
  t = t.replace(/^[ \t]*[-:| ]{4,}[ \t]*$/gm, " ");
  // 强调符号
  t = t.replace(/(\*\*|__|~~)(.*?)\1/g, "$2");
  t = t.replace(/(^|[\s(（])\*(?!\s)([^*\n]+)\*(?=[\s)）。，,.]|$)/g, "$1$2");
  t = t.replace(/(^|[\s(（])_(?!\s)([^_\n]+)_(?=[\s)）。，,.]|$)/g, "$1$2");
  // 残留符号与空白
  t = t.replace(/[*#`]+/g, " ");
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.replace(/\n{3,}/g, "\n\n");
  t = t.replace(/^[\s]+|[\s]+$/g, "");
  return t;
}

function firstParagraph(text) {
  const parts = String(text || "").split(/\n{2,}/);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (p) return p;
  }
  return "";
}

function openingParagraphs(text, count) {
  const parts = String(text || "")
    .split(/\n{2,}/)
    .map(function (p) {
      return p.trim();
    })
    .filter(Boolean);
  if (parts.length <= count) return parts.join("\n\n");
  return parts.slice(0, count).join("\n\n");
}

/** 按朗读范围裁剪：smart（自动播报只读开头）/ full / first */
function applyRange(clean, range, isAuto) {
  if (!clean) return "";
  if (range === "first") return firstParagraph(clean) || clean;
  if (range === "smart" && isAuto) {
    const head = openingParagraphs(clean, 2);
    return head || clean;
  }
  return clean;
}

function prepareText(raw, range, isAuto) {
  return applyRange(cleanText(raw), range, isAuto);
}

/**
 * 按句末标点 / 换行切成句子，标点跟着前一句走。
 * 旧实现用 `[^。！？…]+[标点]*` 匹配，开头连续标点（"……先来"、"。开头"）会被整段吃掉，
 * 既丢字，也让"已播到哪里"的字符计数越算越偏。
 * 英文句点也参与断句：否则整段英文会被当成一句，按字数硬切时把单词切成两半。
 */
const SENTENCE_MARKS = "。！？!?；;…\n";

/** 判断某个位置是否是句末标点；英文句点要求后面是空白或结尾，避免切断 3.14 / a.ts */
function isSentenceMark(src, i) {
  const ch = src[i];
  if (!ch) return false;
  if (SENTENCE_MARKS.indexOf(ch) >= 0) return true;
  if (ch !== ".") return false;
  const next = src[i + 1];
  return next === undefined || /\s/.test(next);
}

function splitSentences(text) {
  const src = String(text || "");
  const out = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    if (!isSentenceMark(src, i)) continue;
    // 连续标点（"……"、"！？"）作为一个整体收在句尾
    let j = i + 1;
    while (j < src.length && isSentenceMark(src, j)) j++;
    const piece = src.slice(start, j).trim();
    if (piece) out.push(piece);
    start = j;
    i = j - 1;
  }
  const tail = src.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * 合并相邻句子。
 * splitSentences 会 trim 掉句子两端的空白，直接拼接会把英文句号后的空格吃掉
 * （"Hello world.This is a test."），TTS 会把两句连成一个词。
 * 这里只在「前一句以 ASCII 词尾结束、下一句以 ASCII 词首开始」时补一个空格，
 * 中文标点 / 中文开头保持原样，不引入多余空格。
 */
function joinSegment(buf, next) {
  if (!buf) return next;
  const prev = buf.charAt(buf.length - 1);
  const head = next.charAt(0);
  const tailIsWord = /[A-Za-z0-9)\]}"'’”.,!?;:]/.test(prev);
  const headIsWord = /[A-Za-z0-9([{"'‘“]/.test(head);
  return tailIsWord && headIsWord ? buf + " " + next : buf + next;
}

/**
 * 分句：先按句末标点切，再把短句合并到 maxChars 以内。
 * firstChars 用于首段限长——首段越短，第一声越快出来（200 字约合 30 秒语音，
 * 一次合成要十几秒；压到 90 字能把首音延迟砍到 4–5 秒）。
 */
function splitSegments(text, maxChars, firstChars) {
  const limit = clamp(maxChars || MAX_CHARS_PER_REQUEST, 60, 400);
  const firstLimit = firstChars ? clamp(firstChars, 40, limit) : limit;
  const sentences = splitSentences(text);
  const out = [];
  let buf = "";
  const currentLimit = function () {
    return out.length === 0 ? firstLimit : limit;
  };
  const flush = function () {
    const t = buf.trim();
    if (t) out.push(t);
    buf = "";
  };
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i].trim();
    if (!s) continue;
    const cap = currentLimit();
    if (s.length > cap) {
      const points = Array.from(s);
      if (points.length > cap) {
        flush();
        // 按码点切，避免把 emoji 的代理对拆到相邻两段
        for (let k = 0; k < points.length; k += cap) {
          const t = points.slice(k, k + cap).join("").trim();
          if (t) out.push(t);
        }
        continue;
      }
    }
    if ((buf + s).length > currentLimit()) flush();
    buf = joinSegment(buf, s);
  }
  flush();
  return out.length ? out : [String(text || "").trim()].filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* WAV 工具：解析 / 拼头 / 合并 / 时长                                  */
/* ------------------------------------------------------------------ */

function parseWav(buffer) {
  const dv = new DataView(buffer);
  if (dv.byteLength < 44) return null;
  if (dv.getUint32(0, false) !== 0x52494646) return null; // RIFF
  if (dv.getUint32(8, false) !== 0x57415645) return null; // WAVE
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= dv.byteLength) {
    const id = dv.getUint32(off, false);
    const size = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (id === 0x666d7420 && start + 16 <= dv.byteLength) {
      // 'fmt '
      fmt = {
        audioFormat: dv.getUint16(start, true),
        channels: dv.getUint16(start + 2, true),
        sampleRate: dv.getUint32(start + 4, true),
        byteRate: dv.getUint32(start + 8, true),
        blockAlign: dv.getUint16(start + 12, true),
        bits: dv.getUint16(start + 14, true),
      };
    } else if (id === 0x64617461 && start <= dv.byteLength) {
      // 'data'
      const len = Math.min(size, dv.byteLength - start);
      data = new Uint8Array(buffer, start, len);
    }
    off = start + size + (size % 2);
  }
  if (!fmt || !data) return null;
  return { fmt: fmt, data: data };
}

function buildWavHeader(fmt, dataLength) {
  const header = new ArrayBuffer(44);
  const dv = new DataView(header);
  const writeStr = function (offset, str) {
    for (let i = 0; i < str.length; i++) dv.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  dv.setUint32(4, 36 + dataLength, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, fmt.audioFormat || 1, true);
  dv.setUint16(22, fmt.channels || 1, true);
  dv.setUint32(24, fmt.sampleRate || 24000, true);
  dv.setUint32(28, fmt.byteRate || (fmt.sampleRate || 24000) * 2, true);
  dv.setUint16(32, fmt.blockAlign || 2, true);
  dv.setUint16(34, fmt.bits || 16, true);
  writeStr(36, "data");
  dv.setUint32(40, dataLength, true);
  return header;
}

/** 按格式与数据长度换算毫秒；byteRate 缺失或为 0 时返回 0 */
function durationOf(fmt, dataBytes) {
  if (!fmt || !(fmt.byteRate > 0) || !(dataBytes > 0)) return 0;
  return (dataBytes / fmt.byteRate) * 1000;
}

/** 把同格式的多段 WAV 合并成一个；格式不一致时返回首段并标记 partial */
async function concatWav(blobs) {
  const list = (blobs || []).filter(Boolean);
  if (!list.length) return { blob: null, whole: false, durationMs: 0 };
  if (list.length === 1) {
    let durationMs = 0;
    try {
      durationMs = wavDuration(await list[0].arrayBuffer());
    } catch (e) {}
    return { blob: list[0], whole: true, durationMs: durationMs };
  }
  try {
    const buffers = await Promise.all(
      list.map(function (b) {
        return b.arrayBuffer();
      })
    );
    const parsed = buffers.map(parseWav);
    const base = parsed[0];
    const same = parsed.every(function (p) {
      return (
        p &&
        base &&
        p.fmt.sampleRate === base.fmt.sampleRate &&
        p.fmt.channels === base.fmt.channels &&
        p.fmt.bits === base.fmt.bits &&
        p.fmt.audioFormat === base.fmt.audioFormat
      );
    });
    if (!same) return { blob: list[0], whole: false, durationMs: 0 };
    let total = 0;
    parsed.forEach(function (p) {
      total += p.data.byteLength;
    });
    const parts = [buildWavHeader(base.fmt, total)];
    parsed.forEach(function (p) {
      parts.push(p.data);
    });
    return {
      blob: new Blob(parts, { type: "audio/wav" }),
      whole: true,
      // 时长随拼接一起算好，调用方不必再把整段音频读回内存
      durationMs: durationOf(base.fmt, total),
    };
  } catch (e) {
    return { blob: list[0], whole: false, durationMs: 0 };
  }
}

function wavDuration(buffer) {
  try {
    const parsed = parseWav(buffer);
    if (!parsed) return 0;
    return durationOf(parsed.fmt, parsed.data.byteLength);
  } catch (e) {
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/* IndexedDB：音频历史与复刻样本                                        */
/* ------------------------------------------------------------------ */

const DB_NAME = "snow-mimo-tts";
const DB_VERSION = 1;
const historyEmitter = makeEmitter();
const samplesEmitter = makeEmitter();

function openDb() {
  return new Promise(function (resolve, reject) {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function () {
      const db = req.result;
      if (!db.objectStoreNames.contains("clips")) {
        const store = db.createObjectStore("clips", { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains("samples")) {
        db.createObjectStore("samples", { keyPath: "id" });
      }
    };
    req.onsuccess = function () {
      resolve(req.result);
    };
    req.onerror = function () {
      reject(req.error || new Error("open db failed"));
    };
  });
}

function idbRequest(req) {
  return new Promise(function (resolve, reject) {
    req.onsuccess = function () {
      resolve(req.result);
    };
    req.onerror = function () {
      reject(req.error || new Error("idb request failed"));
    };
  });
}

async function idbAll(storeName) {
  const db = await openDb();
  try {
    return await idbRequest(db.transaction(storeName, "readonly").objectStore(storeName).getAll());
  } finally {
    db.close();
  }
}

async function idbPut(storeName, value) {
  const db = await openDb();
  try {
    await idbRequest(db.transaction(storeName, "readwrite").objectStore(storeName).put(value));
  } finally {
    db.close();
  }
}

async function idbDelete(storeName, key) {
  const db = await openDb();
  try {
    await idbRequest(db.transaction(storeName, "readwrite").objectStore(storeName).delete(key));
  } finally {
    db.close();
  }
}

async function idbGet(storeName, key) {
  const db = await openDb();
  try {
    return await idbRequest(db.transaction(storeName, "readonly").objectStore(storeName).get(key));
  } finally {
    db.close();
  }
}

async function idbClear(storeName) {
  const db = await openDb();
  try {
    await idbRequest(db.transaction(storeName, "readwrite").objectStore(storeName).clear());
  } finally {
    db.close();
  }
}

/**
 * 音频历史。
 * IndexedDB 在个别宿主环境（自定义协议 / 受限分区）可能不可用，这时退回内存队列，
 * 保证本次会话内仍能试听、下载，并把真实错误暴露到界面上，而不是静默丢数据。
 */
let clipMemory = [];
let storageError = "";

/** 内存兜底队列的体积上限。IndexedDB 不可用时全靠它兜底，
 * 长文音频一条就可能 40 MB 以上，只按条数（20）限流会把几百 MB 钉在内存里。 */
const CLIP_MEMORY_BYTES_LIMIT = 64 * 1024 * 1024;

/** 内存兜底队列里删掉一条：否则 IndexedDB 删除成功后，这条会从内存里「复活」 */
function dropClipFromMemory(id) {
  clipMemory = clipMemory.filter(function (clip) {
    return clip.id !== id;
  });
}

function pushClipMemory(entry) {
  clipMemory.push(entry);
  let bytes = 0;
  clipMemory.forEach(function (clip) {
    bytes += (clip && clip.bytes) || 0;
  });
  while (clipMemory.length > 20 || (clipMemory.length > 1 && bytes > CLIP_MEMORY_BYTES_LIMIT)) {
    const dropped = clipMemory.shift();
    bytes -= (dropped && dropped.bytes) || 0;
  }
}

async function listClips() {
  let persisted = [];
  try {
    persisted = await idbAll("clips");
    storageError = "";
  } catch (err) {
    storageError = String((err && err.message) || err || "IndexedDB 不可用");
  }
  const seen = new Set(
    persisted.map(function (clip) {
      return clip.id;
    })
  );
  const merged = persisted.concat(
    clipMemory.filter(function (clip) {
      return !seen.has(clip.id);
    })
  );
  return merged.sort(function (a, b) {
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

/**
 * 裁剪历史：按 createdAt 从新到旧保留，超出条数 / 体积上限的才删。
 * 之前直接按主键顺序取前 N 条，主键是「时间戳36进制+随机」，跨秒取整时顺序不保证，
 * 可能把新记录删掉、留下旧记录。
 */
async function pruneClips() {
  try {
    const all = (await idbAll("clips")).sort(function (a, b) {
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    let bytes = 0;
    const keep = [];
    for (let i = 0; i < all.length; i++) {
      const clip = all[i];
      const size = (clip && clip.bytes) || 0;
      if (keep.length >= CLIP_LIMIT) break;
      if (keep.length > 0 && bytes + size > CLIP_BYTES_LIMIT) break;
      bytes += size;
      keep.push(clip);
    }
    const keepIds = new Set(
      keep.map(function (c) {
        return c.id;
      })
    );
    for (let i = 0; i < all.length; i++) {
      if (keepIds.has(all[i].id)) continue;
      await idbDelete("clips", all[i].id);
      dropClipFromMemory(all[i].id);
    }
  } catch (e) {
    /* 清理失败不影响主流程 */
  }
}

async function addClip(entry) {
  try {
    await idbPut("clips", entry);
  } catch (err) {
    // 写库失败时用内存兜底，保证本次会话仍能试听；错误交给调用方提示
    pushClipMemory(entry);
    historyEmitter.emit();
    throw err;
  }
  // 已落库就不必再留内存副本，避免同一段音频在内存里存两份
  dropClipFromMemory(entry.id);
  await pruneClips();
  historyEmitter.emit();
  return entry;
}

/** 返回是否真的删掉了：失败时调用方需要如实提示，而不是假装成功 */
async function removeClip(id) {
  const wasMemoryOnly = clipMemory.some(function (clip) {
    return clip.id === id;
  });
  dropClipFromMemory(id);
  let ok = true;
  try {
    await idbDelete("clips", id);
  } catch (e) {
    ok = false;
  }
  // IndexedDB 不可用时这条本来只活在内存兜底队列里：删掉内存副本就等于删掉了
  if (!ok && wasMemoryOnly) ok = true;
  historyEmitter.emit();
  return ok;
}

async function clearClips() {
  const hadMemory = clipMemory.length > 0;
  clipMemory = [];
  let ok = true;
  try {
    await idbClear("clips");
  } catch (e) {
    ok = false;
  }
  // 列表本来就只来自内存兜底（storageError 非空）时，清内存就算清空成功
  if (!ok && hadMemory && storageError) ok = true;
  // 正在试听的音频来自被清掉的记录，一并停掉
  stopPreview();
  historyEmitter.emit();
  return ok;
}

async function listSamples() {
  try {
    const all = (await idbAll("samples")) || [];
    // 列表只需要摘要：单个样本 base64 可达 9 MB，10 个一起反序列化会把内存顶满；
    // 完整样本由 getSample 按主键单独取
    return all
      .map(function (sample) {
        if (!sample) return sample;
        return {
          id: sample.id,
          name: sample.name,
          mime: sample.mime,
          size: sample.size,
          bytes: sample.bytes,
          createdAt: sample.createdAt,
        };
      })
      .sort(function (a, b) {
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
  } catch (e) {
    return [];
  }
}

async function putSample(sample) {
  const all = await listSamples();
  const exists = all.some(function (s) {
    return s.id === sample.id;
  });
  // 覆盖已有样本不会让数量增长，不需要挤掉别人
  if (!exists && all.length >= SAMPLE_LIMIT) {
    // 当前选中的样本不能被上传新样本挤掉，否则设置里的音色会突然失效
    const selected = getSettings().cloneSampleId;
    let oldest = null;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].id !== selected) {
        oldest = all[i];
        break;
      }
    }
    if (!oldest && all.length) oldest = all[all.length - 1];
    if (oldest) await idbDelete("samples", oldest.id);
  }
  await idbPut("samples", sample);
  samplesEmitter.emit();
  return sample;
}

async function removeSample(id) {
  let ok = true;
  try {
    await idbDelete("samples", id);
  } catch (e) {
    ok = false;
  }
  samplesEmitter.emit();
  return ok;
}

async function clearSamples() {
  let ok = true;
  try {
    await idbClear("samples");
  } catch (e) {
    ok = false;
  }
  samplesEmitter.emit();
  return ok;
}

/**
 * 按主键直接取样本。
 * 旧实现走 listSamples() 把所有样本读出来再遍历——10 个样本的 base64 加起来可能 90 MB，
 * 复刻模式下每次朗读都为此反序列化一遍，启动明显变慢。
 */
async function getSample(id) {
  if (!id) return null;
  try {
    return (await idbGet("samples", id)) || null;
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 音效（WebAudio 合成，无资源文件）                                    */
/* ------------------------------------------------------------------ */

let sharedAudioCtx = null;

/**
 * 复用同一个 AudioContext。
 * 注意：宿主主窗口的 CSP 是 `default-src 'self'` 且没有 media-src，
 * `blob:` 不在白名单里，所以 <audio src="blob:..."> 会被拦下来。
 * WebAudio 解码内存里的 ArrayBuffer 不经过资源加载，不受这条策略约束。
 */
function getAudioCtx() {
  if (sharedAudioCtx && sharedAudioCtx.state !== "closed") return sharedAudioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try {
    sharedAudioCtx = new Ctx();
  } catch (e) {
    return null;
  }
  return sharedAudioCtx;
}

/**
 * 确保 AudioContext 处于 running。
 * 自动播报没有用户手势时，Chromium 会让它停在 suspended（播放进度照走但没声音），
 * 这里短暂等待一次 resume 结果，避免"看起来播了其实没出声"。
 */
function ensureAudioRunning(ctx, waitMs) {
  if (!ctx || ctx.state === "running") return Promise.resolve(true);
  let resumed = null;
  try {
    resumed = ctx.resume ? ctx.resume() : null;
  } catch (e) {}
  return new Promise(function (resolve) {
    // resume() 的 promise 回调和轮询定时器可能同时走到这里，用 done 收敛成单次结算
    let done = false;
    const finish = function (value) {
      if (done) return;
      done = true;
      resolve(value);
    };
    const deadline = Date.now() + (waitMs || 600);
    const tick = function () {
      if (done) return;
      if (ctx.state === "running") {
        finish(true);
        return;
      }
      if (Date.now() >= deadline) {
        finish(false);
        return;
      }
      setTimeout(tick, 50);
    };
    if (resumed && typeof resumed.then === "function") resumed.then(tick, tick);
    else tick();
  });
}

function beep(kind) {
  const settings = getSettings();
  if (!settings.sfx) return;
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      const p = ctx.resume();
      if (p && typeof p.catch === "function") p.catch(function () {});
    }
    const t0 = ctx.currentTime;
    const notes = kind === "error" ? [340, 250] : kind === "done" ? [620, 830] : [520];
    notes.forEach(function (freq, i) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const at = t0 + i * 0.085;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.1, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.18);
    });
  } catch (e) {
    /* 音效失败静默 */
  }
}

/* ------------------------------------------------------------------ */
/* MiMo 客户端                                                          */
/* ------------------------------------------------------------------ */

/**
 * 归一化接口地址。
 * 带 query / hash 的地址不能直接拼后缀（会变成 `...?k=1/chat/completions`），
 * 这里只处理路径部分，query 与 hash 原样保留在后面。
 */
function resolveEndpoint(baseUrl) {
  const raw = String(baseUrl || DEFAULT_BASE).trim() || DEFAULT_BASE;
  const m = raw.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  if (!m) return raw;
  let path = m[1].replace(/\/+$/, "");
  const query = m[2] || "";
  const hash = m[3] || "";
  if (!/\/chat\/completions$/i.test(path)) path += "/chat/completions";
  return path + query + hash;
}

function extractApiError(bytes, status) {
  const text = decodeUtf8(bytes || new Uint8Array(0));
  if (!text) return "请求失败（HTTP " + status + "）";
  try {
    const json = JSON.parse(text);
    const rawError = json && json.error;
    const msg =
      (rawError && (typeof rawError === "string" ? rawError : rawError.message || rawError.code)) ||
      (json && json.message) ||
      (json && json.detail) ||
      "";
    if (msg) return String(msg);
  } catch (e) {
    /* 非 JSON 错误体直接展示前 200 字 */
  }
  return text.slice(0, 200);
}

function buildRequestBody(text, settings, cloneBase64) {
  const model = settings.model || "mimo-v2.5-tts";
  const instruction = String(settings.instruction || "").trim();
  const messages = [];

  if (model === "mimo-v2.5-tts-voicedesign") {
    const design = String(settings.designPrompt || "").trim() || "自然、清晰的中性声音。";
    messages.push({ role: "user", content: instruction ? design + " " + instruction : design });
  } else if (instruction) {
    messages.push({ role: "user", content: instruction });
  }
  messages.push({ role: "assistant", content: text });

  const audio = { format: "wav" };
  if (model === "mimo-v2.5-tts") audio.voice = settings.voice || "mimo_default";
  if (model === "mimo-v2.5-tts-voiceclone") audio.voice = cloneBase64 || "";

  return { model: model, messages: messages, audio: audio, stream: false };
}

/** 复刻样本音色字段：必须是 data URL（官方要求前缀），并归一化 MIME */
function sampleToVoice(sample) {
  const rawMime = String((sample && sample.mime) || "").toLowerCase();
  const name = String((sample && sample.name) || "").toLowerCase();
  let mime = "";
  if (rawMime.indexOf("wav") >= 0 || /\.wav$/.test(name)) mime = "audio/wav";
  else if (rawMime.indexOf("mpeg") >= 0 || rawMime.indexOf("mp3") >= 0 || /\.mp3$/.test(name)) mime = "audio/mpeg";
  if (!mime) return "";
  const base64 = String((sample && sample.base64) || "").replace(/^data:[^,]*,/, "");
  if (!base64) return "";
  return "data:" + mime + ";base64," + base64;
}

/**
 * 解析复刻样本 → data URL。
 * 分句流水线里每段都调用一次 synthesizeSegment，样本（base64 后可达 9 MB）
 * 只解析一次、随所有分段复用，避免每段都重读 IndexedDB 并重复上传。
 */
async function resolveCloneVoice(settings) {
  if (!settings || settings.model !== "mimo-v2.5-tts-voiceclone") return "";
  const sample = await getSample(settings.cloneSampleId);
  if (!sample || !sample.base64) throw new Error("还没有可用的复刻样本");
  const voice = sampleToVoice(sample);
  if (!voice) throw new Error("复刻只支持 mp3 / wav 格式的样本");
  return voice;
}

async function synthesizeSegment(text, settings, cloneVoice) {
  const api = RUNTIME_API || host.api;
  if (!api || !api.net || typeof api.net.fetch !== "function") {
    throw new Error("当前宿主不支持 api.net.fetch（需要较新的 Snow App 版本）");
  }
  const key = String(settings.apiKey || "").trim();
  if (!key) throw new Error("MISSING_KEY");

  const voice = cloneVoice === undefined ? await resolveCloneVoice(settings) : cloneVoice || "";

  const body = JSON.stringify(buildRequestBody(text, settings, voice));
  const res = await api.net.fetch(resolveEndpoint(settings.baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": key },
    body: body,
    timeoutMs: 120000,
    responseType: "arraybuffer",
  });

  if (!res || res.error) throw new Error((res && res.error) || "网络请求失败");

  const raw = base64ToBytes(res.bodyBase64 || "");
  if (!res.ok) throw new Error(extractApiError(raw, res.status));
  if (raw.byteLength > MAX_FETCH_BYTES) throw new Error("音频超过单次响应上限，请调小分段字数");
  if (!raw.byteLength) {
    throw new Error("宿主没有返回响应体，请确认 Snow App 支持 api.net.fetch 的 responseType: arraybuffer");
  }

  let json = null;
  try {
    json = JSON.parse(decodeUtf8(raw));
  } catch (e) {
    throw new Error("响应不是合法 JSON（HTTP " + res.status + "）");
  }
  const b64 =
    json &&
    json.choices &&
    json.choices[0] &&
    json.choices[0].message &&
    json.choices[0].message.audio &&
    json.choices[0].message.audio.data;
  if (!b64) {
    const msg =
      (json && json.error && json.error.message) || (json && json.message) || "响应里没有音频数据";
    throw new Error(msg);
  }
  const bytes = ensureWavBytes(base64ToBytes(b64));
  return new Blob([bytes], { type: "audio/wav" });
}

/* ------------------------------------------------------------------ */
/* 播放引擎（模块级单例：面板关闭后仍可继续播报）                        */
/* ------------------------------------------------------------------ */

const engineEmitter = makeEmitter();
const toastEmitter = makeEmitter();

let engineState = {
  status: "idle", // idle | buffering | playing | paused | error
  title: "",
  text: "",
  provider: "", // mimo | local
  position: 0,
  duration: 0,
  segmentIndex: 0,
  segmentCount: 0,
  charCount: 0,
  error: "",
  startedAt: 0,
};

let currentSession = null;
let sessionSeq = 0;
const CANCEL = { cancel: true };

/**
 * 历史试听是模块级单例：试听和朗读共用一套音频输出，
 * 两边各自持有 player 时会出现两段声音同时播放。
 */
let previewPlayer = null;
let previewToken = 0;

function stopPreview() {
  previewToken += 1;
  const player = previewPlayer;
  previewPlayer = null;
  if (player) {
    try {
      player.stop();
    } catch (e) {}
  }
}

function emitEngine(patch) {
  engineState = Object.assign({}, engineState, patch);
  engineEmitter.emit(engineState);
}

function pushToast(text, kind) {
  const toast = { id: uid(), text: text, kind: kind || "info" };
  // 面板没打开时没人接 toast（自动播报失败就静默了），至少写进宿主日志便于排查
  if (!toastEmitter.count()) {
    const api = RUNTIME_API || host.api;
    if (api && typeof api.log === "function") {
      try {
        api.log("[mimo-tts][" + (kind || "info") + "]", text);
      } catch (e) {}
    }
  }
  toastEmitter.emit(toast);
}

function isCancel(err) {
  return err === CANCEL || (err && err.cancel === true);
}

const PCM_FALLBACK_FMT = {
  audioFormat: 1,
  channels: 1,
  sampleRate: 24000,
  byteRate: 48000,
  blockAlign: 2,
  bits: 16,
};

function looksLikeWav(bytes) {
  return (
    !!bytes &&
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  );
}

function looksLikeCompressedAudio(bytes) {
  if (!bytes || bytes.length < 4) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true; // ID3
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    // 只认帧头字段合法的 mp3：裸 PCM 的第一个采样也可能是 0xFF 0xE?，
    // 仅凭两字节判断会把 PCM 当成 mp3，于是不补 WAV 头，解码必失败
    const version = (bytes[1] >> 3) & 0x03;
    const layer = (bytes[1] >> 1) & 0x03;
    const bitrate = (bytes[2] >> 4) & 0x0f;
    const sampleRate = (bytes[2] >> 2) & 0x03;
    return version !== 0x01 && layer !== 0x00 && bitrate !== 0x0f && sampleRate !== 0x03;
  }
  if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return true; // OggS
  return false;
}

/** 接口若返回裸 PCM16（无 RIFF 头），补一个标准 WAV 头再交给解码器 */
function ensureWavBytes(bytes) {
  const raw = bytes || new Uint8Array(0);
  if (!raw.length || looksLikeWav(raw) || looksLikeCompressedAudio(raw)) return raw;
  const header = new Uint8Array(buildWavHeader(PCM_FALLBACK_FMT, raw.length));
  const out = new Uint8Array(header.length + raw.length);
  out.set(header, 0);
  out.set(raw, header.length);
  return out;
}

async function decodeAudioBlob(blob) {
  const ctx = getAudioCtx();
  if (!ctx) throw new Error("当前环境不支持 WebAudio 解码");
  const bytes = ensureWavBytes(new Uint8Array(await blob.arrayBuffer()));
  const copy = bytes.slice().buffer;
  try {
    return await new Promise(function (resolve, reject) {
      let settled = false;
      const done = function (buffer) {
        if (settled) return;
        settled = true;
        resolve(buffer);
      };
      const fail = function (err) {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error("格式不受支持"));
      };
      const maybe = ctx.decodeAudioData(copy, done, fail);
      if (maybe && typeof maybe.then === "function") maybe.then(done, fail);
    });
  } catch (e) {
    throw new Error("音频解码失败：" + String((e && e.message) || "格式不受支持"));
  }
}

/**
 * 基于 AudioBuffer 的播放器：可暂停、续播、拖动、改倍速与音量。
 * options: { rate, volume, cancelError, onPosition(position, duration) }
 */
function createBufferPlayer(buffer, options) {
  const opts = options || {};
  const ctx = getAudioCtx();
  if (!ctx) throw new Error("当前环境不支持 WebAudio 播放");
  if (ctx.state === "suspended") {
    const resumed = ctx.resume();
    if (resumed && typeof resumed.catch === "function") resumed.catch(function () {});
  }

  const total = Number.isFinite(buffer.duration) ? buffer.duration : 0;
  let rate = clamp(opts.rate === undefined ? 1 : opts.rate, 0.5, 2);
  let volume = clamp(opts.volume === undefined ? 1 : opts.volume, 0, 1);
  let source = null;
  let gain = null;
  let offset = 0;
  let startedAt = 0;
  let paused = false;
  let settled = false;
  let ticker = 0;
  let finishResolve = function () {};
  let finishReject = function () {};

  function currentPosition() {
    if (!source || paused) return Math.min(offset, total);
    return Math.min(offset + (ctx.currentTime - startedAt) * rate, total);
  }

  function notify() {
    if (typeof opts.onPosition === "function") opts.onPosition(currentPosition(), total);
  }

  function stopTicker() {
    if (ticker) {
      clearInterval(ticker);
      ticker = 0;
    }
  }

  function startTicker() {
    stopTicker();
    ticker = setInterval(function () {
      if (settled || paused) return;
      notify();
    }, 120);
  }

  function dropSource() {
    if (source) {
      source.__mimoManualStop = true;
      try {
        source.onended = null;
        source.stop();
      } catch (e) {}
      try {
        source.disconnect();
      } catch (e) {}
      source = null;
    }
    if (gain) {
      try {
        gain.disconnect();
      } catch (e) {}
      gain = null;
    }
  }

  function settle(fn, value) {
    if (settled) return;
    settled = true;
    stopTicker();
    dropSource();
    try {
      fn(value);
    } catch (e) {}
  }

  function startAt(from) {
    // 先收掉可能存在的旧源：setRate 失败后重建时若不断开，旧节点会继续出声，且再也停不掉
    dropSource();
    const startFrom = Math.max(0, Math.min(from, total));
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = volume;
    node.connect(g);
    g.connect(ctx.destination);
    node.__mimoManualStop = false;
    node.onended = function () {
      if (node.__mimoManualStop) return;
      settle(finishResolve);
    };
    try {
      node.start(0, startFrom);
    } catch (e) {
      settle(finishReject, e || new Error("播放失败"));
      return;
    }
    source = node;
    gain = g;
    offset = startFrom;
    startedAt = ctx.currentTime;
    paused = false;
    startTicker();
  }

  const promise = new Promise(function (resolve, reject) {
    finishResolve = resolve;
    finishReject = reject;
    startAt(0);
  });

  const player = {
    duration: total,
    position: currentPosition,
    pause: function () {
      if (settled || paused) return;
      const pos = currentPosition();
      paused = true;
      stopTicker();
      dropSource();
      offset = pos;
      notify();
    },
    resume: function () {
      if (settled || !paused) return;
      startAt(offset);
    },
    seek: function (ratio) {
      if (settled) return;
      const wasPaused = paused;
      const pos = clamp(ratio, 0, 1) * total;
      stopTicker();
      dropSource();
      offset = pos;
      paused = wasPaused;
      if (wasPaused) notify();
      else startAt(pos);
    },
    setRate: function (value) {
      if (settled) return;
      const next = clamp(value, 0.5, 2);
      if (next === rate) return;
      // 先把旧速率下的已播位置结算下来，再用新速率续播
      const pos = currentPosition();
      offset = pos;
      startedAt = ctx.currentTime;
      rate = next;
      if (source) {
        // 直接改 playbackRate 是实时的，不会像重建 source 那样在拖动滑块时断音
        try {
          source.playbackRate.value = next;
        } catch (e) {
          startAt(pos);
          return;
        }
      }
      notify();
    },
    setVolume: function (value) {
      volume = clamp(value, 0, 1);
      if (gain) {
        try {
          gain.gain.value = volume;
        } catch (e) {}
      }
    },
    stop: function () {
      if (settled) return;
      settle(opts.cancelError ? finishReject : finishResolve, opts.cancelError);
    },
  };

  return { promise: promise, player: player };
}

/**
 * 播放每一段时都重新取一次语速 / 音量。
 * speak() 开头会快照 settings，但分段流水线每段都新建播放器：
 * 沿用旧快照会让用户在播放中调好的语速、音量在下一段突然弹回原值。
 */
function liveAudioOptions(fallback) {
  const live = getSettings() || {};
  const pick = function (key) {
    if (typeof live[key] === "number" && Number.isFinite(live[key])) return live[key];
    if (fallback && typeof fallback[key] === "number" && Number.isFinite(fallback[key])) return fallback[key];
    return 1;
  };
  return { rate: pick("rate"), volume: pick("volume") };
}

/** AudioContext 不可用时的最后手段：元素播放（宿主 CSP 可能拦截 blob:） */
function playBlobViaElement(blob, session, settings) {
  return new Promise(function (resolve, reject) {
    let url = "";
    let audio = null;
    let settled = false;
    const finish = function (fn, value) {
      if (settled) return;
      settled = true;
      if (audio) {
        audio.onended = null;
        audio.onerror = null;
        audio.ontimeupdate = null;
      }
      // 停止 / 结束时把会话对元素的引用也断掉，避免 stopInternal 再去操作已释放的 audio
      if (session.audio === audio) session.audio = null;
      if (url) {
        try {
          URL.revokeObjectURL(url);
        } catch (e) {}
      }
      fn(value);
    };

    try {
      const live = liveAudioOptions(settings);
      url = URL.createObjectURL(blob);
      audio = new Audio(url);
      audio.volume = clamp(live.volume, 0, 1);
      audio.playbackRate = clamp(live.rate, 0.5, 2);
      session.audio = audio;
      session.abort = function () {
        try {
          audio.pause();
        } catch (e) {}
        finish(reject, CANCEL);
      };
      audio.ontimeupdate = function () {
        if (!audio) return;
        emitEngine({
          position: audio.currentTime || 0,
          duration: Number.isFinite(audio.duration) ? audio.duration : engineState.duration,
        });
      };
      audio.onended = function () {
        session.audio = null;
        finish(resolve);
      };
      audio.onerror = function () {
        session.audio = null;
        const mediaError = audio && audio.error ? "（MediaError " + audio.error.code + "）" : "";
        finish(reject, new Error("音频解码失败" + mediaError));
      };
      const started = audio.play();
      if (started && typeof started.then === "function") {
        started.then(
          function () {
            emitEngine({
              status: "playing",
              duration: Number.isFinite(audio.duration) ? audio.duration : engineState.duration,
            });
          },
          function (err) {
            finish(reject, err || new Error("播放被拒绝"));
          }
        );
      } else {
        emitEngine({ status: "playing" });
      }
    } catch (e) {
      finish(reject, e);
    }
  });
}

/**
 * 播放一段云端音频。
 * 走 WebAudio 解码内存字节，而不是 <audio src="blob:...">：
 * 宿主主窗口 CSP 是 `default-src 'self'` 且未声明 media-src，blob: 会被拒绝加载，
 * 元素路径在真实应用里必然触发 onerror（表现为“音频解码失败”）。
 */
function playBlob(blob, session, settings) {
  const ctx = getAudioCtx();
  if (!ctx) return playBlobViaElement(blob, session, settings);

  return decodeAudioBlob(blob).then(async function (buffer) {
    if (session.canceled) throw CANCEL;
    const audible = await ensureAudioRunning(ctx, 600);
    if (session.canceled) throw CANCEL;
    if (!audible) throw new Error("系统还没有允许出声，请先点击一次面板再试");
    const live = liveAudioOptions(settings);
    const built = createBufferPlayer(buffer, {
      rate: live.rate,
      volume: live.volume,
      cancelError: CANCEL,
      onPosition: function (position, duration) {
        emitEngine({ position: position, duration: duration });
      },
    });
    session.audio = null;
    session.player = built.player;
    session.abort = function () {
      built.player.stop();
    };
    emitEngine({ status: "playing", position: 0, duration: buffer.duration || 0 });
    return built.promise.then(
      function () {
        session.player = null;
        session.abort = null;
      },
      function (err) {
        session.player = null;
        session.abort = null;
        throw err;
      }
    );
  });
}

function pickLocalVoice(text) {
  const synth = window.speechSynthesis;
  if (!synth || typeof synth.getVoices !== "function") return null;
  const voices = synth.getVoices() || [];
  if (!voices.length) return null;
  const wantZh = /[\u4e00-\u9fff]/.test(String(text || ""));
  if (wantZh) {
    for (let i = 0; i < voices.length; i++) {
      if (/^zh/i.test(voices[i].lang || "")) return voices[i];
    }
  }
  return voices[0];
}

function playLocal(text, session, settings) {
  return new Promise(function (resolve, reject) {
    const synth = window.speechSynthesis;
    // 检查与构造必须来自同一个入口：只查 window.SpeechSynthesisUtterance 却用裸全局 new，
    // 在 window 被包装 / 沙箱化的环境里会误判「系统未提供本地语音」，然后直接走失败分支
    const Utterance = window.SpeechSynthesisUtterance;
    if (!synth || typeof Utterance !== "function") {
      reject(new Error("系统未提供本地语音"));
      return;
    }
    const utter = new Utterance(text);
    const live = liveAudioOptions(settings);
    utter.rate = clamp(live.rate, 0.5, 2);
    utter.volume = clamp(live.volume, 0, 1);
    const voice = pickLocalVoice(text);
    if (voice) utter.voice = voice;
    session.utterance = utter;
    session.abort = function () {
      try {
        synth.cancel();
      } catch (e) {}
      reject(CANCEL);
    };
    utter.onend = function () {
      resolve();
    };
    utter.onerror = function (event) {
      if (event && (event.error === "interrupted" || event.error === "canceled")) {
        resolve();
        return;
      }
      reject(new Error("本地语音播放失败"));
    };
    try {
      synth.speak(utter);
      emitEngine({ status: "playing", provider: "local", duration: 0, position: 0 });
    } catch (e) {
      reject(e);
    }
  });
}

async function runCloud(clean, settings, session) {
  const segments = splitSegments(clean, settings.maxChars, FIRST_CHUNK_CHARS);
  // 调用方可能是外部脚本，clean 非空但分句结果为空时不要带着 segments[0] undefined 往下走
  if (!segments.length) throw new Error("没有可朗读的文字");
  session.segments = segments;
  session.playedSegments = 0;
  emitEngine({ segmentCount: segments.length, provider: "mimo" });
  const cloneVoice = await resolveCloneVoice(settings);
  const collected = [];
  let nextPromise = synthesizeSegment(segments[0], settings, cloneVoice);

  for (let i = 0; i < segments.length; i++) {
    let blob;
    try {
      blob = await nextPromise;
    } catch (err) {
      throw err;
    }
    // 预取失败时这里拿到的是 Error 对象（不是 Blob），继续当音频用只会得到
    // 一句「blob.arrayBuffer is not a function」，所以先认出来再抛
    if (blob instanceof Error) throw blob;
    if (!blob || typeof blob.arrayBuffer !== "function") throw new Error("音频数据无效");
    if (session.canceled) throw CANCEL;
    collected.push(blob);
    if (i + 1 < segments.length) {
      // 预取下一段：播放当前段时后台合成
      nextPromise = synthesizeSegment(segments[i + 1], settings, cloneVoice).catch(function (e) {
        return e instanceof Error ? e : new Error(String(e));
      });
    }
    emitEngine({ segmentIndex: i + 1, position: 0, duration: 0 });
    await playBlob(blob, session, settings);
    if (session.canceled) throw CANCEL;
    // 记录已播段数：云端中途失败改用本地语音时从这里续读，而不是从头念
    session.playedSegments = i + 1;
  }
  return collected;
}

async function recordClip(clean, blobs, settings) {
  try {
    const merged = await concatWav(blobs);
    if (!merged.blob) return;
    // 拼接时已经算好时长：长文音频可达几十 MB，这里不再整段读回内存
    const duration = merged.durationMs || 0;
    await addClip({
      id: uid(),
      createdAt: Date.now(),
      text: safeSlice(clean, 4000),
      chars: clean.length,
      model: settings.model,
      voice:
        settings.model === "mimo-v2.5-tts"
          ? settings.voice
          : settings.model === "mimo-v2.5-tts-voicedesign"
          ? T("history.voice.design", "设计音色")
          : T("history.voice.clone", "复刻音色"),
      provider: "mimo",
      bytes: merged.blob.size,
      durationMs: duration,
      whole: merged.whole,
      blob: merged.blob,
    });
  } catch (e) {
    const message = String((e && e.message) || e || "未知错误");
    if (!storageError) storageError = message;
    const api = RUNTIME_API || host.api;
    if (api && typeof api.log === "function") {
      api.log("clip persist failed:", message);
    }
    pushToast("音频历史未能写入本地库：" + message + "（本次仍可在列表中试听）", "warn");
  }
}

async function speak(rawText, options) {
  const opts = options || {};
  if (moduleDisposed) return false;
  const settings = Object.assign({}, getSettings());
  let clean = prepareText(rawText, settings.range, !!opts.auto);
  if (!clean) {
    // 自动播报遇到纯代码 / 纯链接的回复是常事，别每次都弹一条警告
    if (!opts.auto) pushToast(T("toast.empty", "没有可朗读的文字"), "warn");
    return false;
  }
  if (clean.length > MAX_READ_CHARS) {
    clean = safeSlice(clean, MAX_READ_CHARS);
    // 自动播报是后台行为，不为截断再弹一条提示打断用户；手动朗读时明确告知
    if (!opts.auto) pushToast("文本较长，本次只朗读前 " + MAX_READ_CHARS + " 字", "warn");
  }

  stopPreview();
  stopInternal();

  const session = {
    id: ++sessionSeq,
    canceled: false,
    audio: null,
    player: null,
    utterance: null,
    abort: null,
    segments: null,
    playedSegments: 0,
  };
  currentSession = session;

  emitEngine({
    status: "buffering",
    title: opts.title || (opts.auto ? T("app.autoRead", "自动播报") : ""),
    text: safeSlice(clean, 300),
    provider: "",
    position: 0,
    duration: 0,
    segmentIndex: 0,
    segmentCount: 0,
    charCount: clean.length,
    error: "",
    startedAt: Date.now(),
  });

  const mode = settings.localMode || "fallback";
  const order = mode === "primary" ? ["local", "mimo"] : mode === "fallback" ? ["mimo", "local"] : ["mimo"];
  let lastError = null;

  for (let i = 0; i < order.length; i++) {
    if (session.canceled || moduleDisposed) return false;
    const provider = order[i];
    try {
      if (provider === "mimo") {
        const blobs = await runCloud(clean, settings, session);
        if (session.canceled || moduleDisposed) return false;
        emitEngine({ status: "idle", position: 0, duration: 0 });
        currentSession = null;
        beep("done");
        recordClip(clean, blobs, settings);
        return true;
      }
      // 云端已经播完若干段后失败：本地语音从断点续读，不把听过的再念一遍
      const done = session.playedSegments || 0;
      const rest = done > 0 && session.segments ? session.segments.slice(done).join(" ") : clean;
      if (rest.trim()) await playLocal(rest, session, settings);
      if (session.canceled || moduleDisposed) return false;
      emitEngine({ status: "idle", position: 0, duration: 0 });
      currentSession = null;
      beep("done");
      return true;
    } catch (err) {
      if (isCancel(err) || session.canceled || moduleDisposed) return false;
      lastError = err;
      const message = err && err.message ? err.message : String(err);
      if (message === "MISSING_KEY" && provider === "mimo") {
        lastError = new Error(T("toast.noKey", "请先在设置里填入 MiMo API Key"));
        // 还有兜底路径时才提示「缺 Key」并继续；没有兜底就留给末尾统一报错，
        // 否则同一条消息会以 warn + error 弹两遍。自动播报不打扰用户，交给末尾统一收口
        if (i + 1 < order.length && !opts.auto) pushToast(T("toast.noKey", "请先在设置里填入 MiMo API Key"), "warn");
      } else if (i + 1 < order.length) {
        const failed = provider === "mimo" ? "云端合成失败" : "本地语音不可用";
        const next = order[i + 1] === "mimo" ? "改用 MiMo 云端语音" : "改用系统本地语音";
        pushToast(failed + "，" + next + "（" + message + "）", "warn");
      }
    }
  }

  const message = lastError && lastError.message ? lastError.message : "未知错误";
  emitEngine({ status: "error", error: message, provider: "", position: 0, duration: 0 });
  currentSession = null;
  beep("error");
  pushToast(T("toast.err", "出错了：{{msg}}", { msg: message }), "error");
  return false;
}

function stopInternal() {
  const session = currentSession;
  currentSession = null;
  if (!session) {
    try {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    } catch (e) {}
    return;
  }
  session.canceled = true;
  if (session.abort) {
    try {
      session.abort();
    } catch (e) {}
  }
  if (session.audio) {
    try {
      session.audio.pause();
      session.audio.removeAttribute("src");
    } catch (e) {}
  }
  try {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  } catch (e) {}
}

function stop() {
  stopInternal();
  emitEngine({ status: "idle", position: 0, duration: 0, segmentIndex: 0, segmentCount: 0, provider: "" });
}

function pause() {
  const session = currentSession;
  if (!session) return;
  if (session.player) {
    try {
      session.player.pause();
      emitEngine({ status: "paused", position: session.player.position() });
    } catch (e) {}
    return;
  }
  if (session.audio) {
    try {
      session.audio.pause();
      emitEngine({ status: "paused" });
    } catch (e) {}
    return;
  }
  if (session.utterance && window.speechSynthesis) {
    try {
      window.speechSynthesis.pause();
      emitEngine({ status: "paused" });
    } catch (e) {}
  }
}

function resume() {
  const session = currentSession;
  if (!session) return;
  if (session.player) {
    try {
      session.player.resume();
      emitEngine({ status: "playing" });
    } catch (e) {}
    return;
  }
  if (session.audio) {
    const playing = session.audio.play();
    if (playing && typeof playing.then === "function") {
      playing.then(
        function () {
          emitEngine({ status: "playing" });
        },
        function () {}
      );
    } else {
      emitEngine({ status: "playing" });
    }
    return;
  }
  if (session.utterance && window.speechSynthesis) {
    try {
      window.speechSynthesis.resume();
      emitEngine({ status: "playing" });
    } catch (e) {}
  }
}

function seek(ratio) {
  const session = currentSession;
  if (!session) return;
  if (session.player) {
    try {
      session.player.seek(ratio);
    } catch (e) {}
    return;
  }
  if (!session.audio) return;
  const duration = session.audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  try {
    session.audio.currentTime = clamp(ratio, 0, 1) * duration;
    emitEngine({ position: session.audio.currentTime });
  } catch (e) {}
}

function setLiveRate(rate) {
  const session = currentSession;
  if (session && session.player) {
    try {
      session.player.setRate(rate);
    } catch (e) {}
  }
  if (session && session.audio) {
    try {
      session.audio.playbackRate = clamp(rate, 0.5, 2);
    } catch (e) {}
  }
  if (session && session.utterance) {
    // 本地语音无法热改语速，下次生效
  }
}

function setLiveVolume(volume) {
  const session = currentSession;
  if (session && session.player) {
    try {
      session.player.setVolume(volume);
    } catch (e) {}
  }
  if (session && session.audio) {
    try {
      session.audio.volume = clamp(volume, 0, 1);
    } catch (e) {}
  }
}

/* ------------------------------------------------------------------ */
/* 自动播报：监听当前会话消息                                            */
/* ------------------------------------------------------------------ */

let watcher = null;
/** 本模块实例是否已被新版本接管：被销毁后不再启动新的播放 */
let moduleDisposed = false;

function lastAssistantMessage(items) {
  if (!Array.isArray(items)) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item && item.role === "assistant" && typeof item.content === "string" && item.content.trim()) {
      return item;
    }
  }
  return null;
}

/**
 * 播报去重指纹：只看 id 会漏掉「同一条消息被重新生成/补全」的情况，
 * 再把内容长度带上，内容变了就当作新内容。
 */
function messageKey(msg) {
  if (!msg) return "";
  const content = String(msg.content || "");
  // 长度 + 结尾片段：既能发现流式增长，也能发现「同 id 重新生成成等长但不同内容」
  return String(msg.id || "") + ":" + content.length + ":" + content.slice(-16);
}

function handleMessages(response) {
  if (!watcher || moduleDisposed) return;
  const domain = response && response.domains ? response.domains.messages : null;
  if (!domain) return;
  const conversationId = domain.conversationId || null;
  const last = lastAssistantMessage(domain.items);
  const live = domain.live || null;

  if (!conversationId) return;

  if (watcher.conversationId !== conversationId) {
    watcher.conversationId = conversationId;
    watcher.spokenKey = messageKey(last);
    watcher.baseline = true;
    return;
  }

  if (!watcher.baseline) {
    watcher.baseline = true;
    watcher.spokenKey = messageKey(last);
    return;
  }

  const isStreaming = !!(live && (live.isStreaming || live.isPaused || live.isAborting));
  // 流式期间只更新基线之外的状态：回复还没定稿，此时朗读会把半句话念出来
  if (isStreaming) return;
  if (!last) return;
  const key = messageKey(last);
  if (watcher.spokenKey === key) return;

  watcher.spokenKey = key;

  const settings = getSettings();
  if (!settings.autoRead) return;
  // 只要还有一条可用路径就继续：没 Key 但允许本地语音时，speak 会自动回退到本地；
  // 旧逻辑在「云端优先 + 没填 Key」时直接放弃，自动播报明明可以用本地语音却完全沉默
  if (!settings.apiKey && settings.localMode === "off") return;
  // 用户正在朗读别的文本时不要抢断，这条留着不补播
  if (
    engineState.status === "playing" ||
    engineState.status === "buffering" ||
    engineState.status === "paused"
  ) {
    return;
  }
  speak(last.content, { auto: true, title: T("app.autoRead", "自动播报") }).catch(function () {});
}

async function startWatcher() {
  if (watcher || moduleDisposed) return;
  const api = RUNTIME_API || host.api;
  if (!api || !api.metadata || typeof api.metadata.subscribe !== "function") return;
  // 插件重装 / 热更新会重新执行模块：先把上一份订阅挂掉，否则同一个回复会被播两遍
  if (typeof window !== "undefined" && window.__snowMimoTtsWatch) {
    try {
      window.__snowMimoTtsWatch.unsubscribe();
    } catch (e) {}
    window.__snowMimoTtsWatch = null;
  }
  watcher = { conversationId: null, spokenKey: "", baseline: false, subscription: null };
  try {
    const sub = await api.metadata.subscribe("messages", handleMessages);
    watcher.subscription = sub;
    if (typeof window !== "undefined") window.__snowMimoTtsWatch = sub;
  } catch (e) {
    watcher = null;
    // 订阅失败会让自动播报永久静默，至少把原因写进宿主日志，便于用户排查隐私域声明
    try {
      if (api && typeof api.log === "function") {
        api.log("[mimo-tts] messages subscribe failed:", (e && e.message) || e);
      }
    } catch (err) {}
  }
}

/* ------------------------------------------------------------------ */
/* 对外接口：window.snowMimoTts                                        */
/* ------------------------------------------------------------------ */

function exposeGlobalApi() {
  if (typeof window === "undefined") return;
  window.snowMimoTts = {
    play(text, options) {
      return speak(text, options || {});
    },
    stop: stop,
    pause: pause,
    resume: resume,
    getState() {
      return Object.assign({}, engineState);
    },
    getSettings() {
      // 不要把密钥暴露到 window 上：同一渲染进程里的任何脚本都能读到
      const snapshot = Object.assign({}, getSettings());
      snapshot.hasApiKey = !!snapshot.apiKey;
      delete snapshot.apiKey;
      return snapshot;
    },
    version: pluginVersion(),
  };
}

/* ------------------------------------------------------------------ */
/* 通用 UI 组件                                                        */
/* ------------------------------------------------------------------ */

function useEngine() {
  const [snapshot, setSnapshot] = useState(engineState);
  useEffect(function () {
    const unsub = engineEmitter.sub(function (next) {
      setSnapshot(next);
    });
    setSnapshot(Object.assign({}, engineState));
    return unsub;
  }, []);
  return snapshot;
}

function useSettingsState() {
  const [snapshot, setSnapshot] = useState(function () {
    return Object.assign({}, getSettings());
  });
  useEffect(function () {
    let alive = true;
    loadSettings().then(function (value) {
      if (alive) setSnapshot(Object.assign({}, value));
    });
    const unsub = settingsEmitter.sub(function (next) {
      setSnapshot(Object.assign({}, next));
    });
    return function () {
      alive = false;
      unsub();
    };
  }, []);
  return snapshot;
}

function Section(props) {
  return el(
    "div",
    { className: "mtts-section" },
    el(
      "div",
      { className: "mtts-section-head" },
      el("span", { className: "mtts-section-title" }, props.title),
      props.right ? el("span", { className: "mtts-section-right" }, props.right) : null
    ),
    props.children
  );
}

function Card(props) {
  return el(
    "div",
    { className: cx("mtts-card", props.className) },
    props.title
      ? el(
          "div",
          { className: "mtts-card-head" },
          el("span", { className: "mtts-card-title" }, props.title),
          props.right || null
        )
      : null,
    props.children
  );
}

function Segmented(props) {
  const items = props.items || [];
  return el(
    "div",
    { className: cx("mtts-seg", props.compact && "is-compact"), role: "tablist" },
    items.map(function (item) {
      const active = props.value === item.id;
      return el(
        "button",
        {
          key: item.id,
          type: "button",
          role: "tab",
          "aria-selected": active ? "true" : "false",
          className: cx("mtts-seg-item", active && "is-active"),
          onClick: function () {
            props.onChange(item.id);
          },
          title: item.hint || undefined,
        },
        item.icon && active ? icon(item.icon, 13) : null,
        el("span", null, item.label)
      );
    })
  );
}

function Switch(props) {
  return el(
    "label",
    { className: cx("mtts-switch", props.disabled && "is-disabled") },
    el("input", {
      type: "checkbox",
      checked: !!props.checked,
      disabled: !!props.disabled,
      onChange: function (event) {
        props.onChange(event.target.checked);
      },
    }),
    el("span", { className: "mtts-switch-track" }, el("span", { className: "mtts-switch-thumb" })),
    props.label ? el("span", { className: "mtts-switch-label" }, props.label) : null
  );
}

function Slider(props) {
  return el(
    "div",
    { className: "mtts-slider" },
    el(
      "div",
      { className: "mtts-slider-head" },
      el("span", { className: "mtts-slider-label" }, props.label),
      el("span", { className: "mtts-slider-value" }, props.display)
    ),
    el("input", {
      type: "range",
      min: props.min,
      max: props.max,
      step: props.step,
      value: props.value,
      onChange: function (event) {
        props.onChange(Number(event.target.value));
      },
      "aria-label": props.label,
    })
  );
}

function ToastStack(props) {
  const toasts = props.toasts || [];
  // 容器常驻（靠 CSS :empty 隐藏）：aria-live 区域如果按需插入，
  // 部分屏幕阅读器不会朗读后插入的内容。空容器不占 flex gap。
  return el(
    "div",
    { className: "mtts-toasts", "aria-live": "polite" },
    toasts.map(function (toast) {
      return el(
        "div",
        { key: toast.id, className: cx("mtts-toast", "is-" + (toast.kind || "info")) },
        icon(toast.kind === "error" ? "AlertTriangle" : toast.kind === "warn" ? "Info" : "CheckCircle2", 14),
        el("span", null, toast.text)
      );
    })
  );
}

/* ------------------------------------------------------------------ */
/* 头部 + 标签栏                                                       */
/* ------------------------------------------------------------------ */

function Header(props) {
  const settings = props.settings;
  const ready = !!settings.apiKey || settings.localMode === "primary";
  const state = props.state;
  const busy = state.status === "playing" || state.status === "buffering" || state.status === "paused";
  return el(
    "div",
    { className: "mtts-head" },
    el(
      "div",
      { className: "mtts-brand" },
      el(
        "span",
        { className: cx("mtts-brand-icon", busy && "is-busy") },
        icon("AudioLines", 18) || el("span", null, "♪")
      ),
      el(
        "div",
        { className: "mtts-brand-text" },
        el("div", { className: "mtts-brand-title" }, T("app.title", "语音朗读")),
        el(
          "div",
          { className: "mtts-brand-sub" },
          el("span", { className: cx("mtts-dot", ready ? "is-ok" : "is-warn") }),
          ready ? T("app.subtitle.ready", "MiMo TTS 已就绪") : T("app.subtitle.nokey", "尚未配置 API Key")
        )
      )
    ),
    el(
      "div",
      { className: "mtts-head-actions" },
      busy
        ? el(
            "span",
            { className: "mtts-eq", "aria-hidden": "true" },
            el("span", null),
            el("span", null),
            el("span", null),
            el("span", null)
          )
        : null,
      el(Switch, {
        checked: !!settings.autoRead,
        onChange: function (value) {
          props.onToggleAuto(value);
        },
        label: T("app.autoRead", "自动播报"),
      })
    )
  );
}

function TabBar(props) {
  const tabs = [
    { id: "mixer", label: T("tab.mixer", "调音台"), icon: "SlidersHorizontal" },
    { id: "stage", label: T("tab.stage", "播报台"), icon: "Mic" },
    { id: "history", label: T("tab.history", "音频历史"), icon: "History" },
    { id: "settings", label: T("tab.settings", "设置"), icon: "Settings2" },
  ];
  return el(
    "div",
    { className: "mtts-tabs", role: "tablist" },
    tabs.map(function (tab) {
      const active = props.tab === tab.id;
      return el(
        "button",
        {
          key: tab.id,
          type: "button",
          role: "tab",
          "aria-selected": active ? "true" : "false",
          className: cx("mtts-tab", active && "is-active"),
          onClick: function () {
            props.onChange(tab.id);
          },
        },
        icon(tab.icon, 14),
        el("span", null, tab.label)
      );
    })
  );
}

/* ------------------------------------------------------------------ */
/* 播放 Dock                                                           */
/* ------------------------------------------------------------------ */

function PlayerDock(props) {
  const state = props.state;
  if (state.status === "idle") return null;
  const pct = state.duration > 0 ? clamp((state.position / state.duration) * 100, 0, 100) : 0;
  const isPaused = state.status === "paused";
  const isError = state.status === "error";
  const label = isError
    ? T("dock.error", "播放失败")
    : isPaused
    ? T("dock.paused", "已暂停")
    : state.status === "buffering"
    ? T("dock.buffering", "正在合成…")
    : T("dock.playing", "正在朗读");

  return el(
    "div",
    { className: cx("mtts-dock", isError && "is-error") },
    el(
      "div",
      { className: "mtts-dock-row" },
      el("span", { className: "mtts-dock-label", title: state.error || undefined }, label),
      state.segmentCount > 1
        ? el(
            "span",
            { className: "mtts-dock-seg" },
            T("dock.segment", "第 {{i}} / {{n}} 段", { i: Math.max(1, state.segmentIndex || 1), n: state.segmentCount })
          )
        : null,
      el("span", { className: "mtts-dock-spacer" }),
      el("span", { className: "mtts-dock-time" }, fmtClock(state.position) + " / " + fmtClock(state.duration))
    ),
    el(
      "div",
      {
        className: "mtts-progress",
        role: "slider",
        tabIndex: 0,
        "aria-label": T("dock.seek", "播放进度"),
        "aria-valuemin": 0,
        "aria-valuemax": 100,
        "aria-valuenow": Math.round(pct),
        onClick: function (event) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (!rect.width) return;
          seek((event.clientX - rect.left) / rect.width);
        },
        onKeyDown: function (event) {
          // 键盘也要能拖动进度：左右 / 上下方向键各走 5%
          const current = state.duration > 0 ? clamp(state.position / state.duration, 0, 1) : 0;
          if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
            event.preventDefault();
            seek(clamp(current - 0.05, 0, 1));
          } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
            event.preventDefault();
            seek(clamp(current + 0.05, 0, 1));
          }
        },
      },
      el("div", { className: "mtts-progress-fill", style: { width: pct + "%" } })
    ),
    el("div", { className: "mtts-dock-text", title: state.text }, state.text),
    el(
      "div",
      { className: "mtts-dock-actions" },
      isError || state.status === "buffering"
        ? null
        : el(
            "button",
            {
              type: "button",
              className: "mtts-btn is-icon",
              onClick: function () {
                if (isPaused) resume();
                else pause();
              },
              title: isPaused ? T("dock.resume", "继续") : T("dock.pause", "暂停"),
            },
            icon(isPaused ? "Play" : "Pause", 15)
          ),
      el(
        "button",
        {
          type: "button",
          className: "mtts-btn is-icon",
          onClick: stop,
          title: T("dock.stop", "停止"),
        },
        icon("Square", 14)
      ),
      el(
        "div",
        { className: "mtts-speed-chips" },
        [0.8, 1, 1.2, 1.5].map(function (rate) {
          const active = Math.abs(Number(props.settings.rate) - rate) < 0.01;
          return el(
            "button",
            {
              key: rate,
              type: "button",
              className: cx("mtts-speed-chip", active && "is-active"),
              onClick: function () {
                props.onRate(rate);
              },
            },
            rate + "×"
          );
        })
      )
    )
  );
}

/* ------------------------------------------------------------------ */
/* 调音台                                                              */
/* ------------------------------------------------------------------ */

function SetupCallout(props) {
  return el(
    "div",
    { className: "mtts-callout" },
    el("span", { className: "mtts-callout-icon" }, icon("KeyRound", 16)),
    el(
      "div",
      { className: "mtts-callout-body" },
      el("div", { className: "mtts-callout-title" }, T("setup.title", "还差一步就能开口")),
      el("div", { className: "mtts-callout-desc" }, T("setup.desc", "填入小米 MiMo 的 API Key 即可使用云端音色；也可以先把本地语音设为首选。"))
    ),
    el(
      "button",
      { type: "button", className: "mtts-btn is-primary", onClick: props.onAction },
      T("setup.action", "去填 API Key")
    )
  );
}

function VoiceGrid(props) {
  const value = props.value;
  return el(
    "div",
    { className: "mtts-voice-grid" },
    VOICES.map(function (voice) {
      const active = value === voice.id;
      return el(
        "button",
        {
          key: voice.id,
          type: "button",
          className: cx("mtts-voice", active && "is-active"),
          onClick: function () {
            props.onChange(voice.id);
          },
        },
        el("span", { className: "mtts-voice-name" }, voice.name),
        el("span", { className: "mtts-voice-meta" }, voice.metaKey ? T(voice.metaKey, voice.meta) : voice.meta),
        active ? el("span", { className: "mtts-voice-check" }, icon("Check", 12)) : null
      );
    })
  );
}

function DesignPanel(props) {
  const settings = props.settings;
  return el(
    "div",
    { className: "mtts-stack is-tight" },
    el(
      "div",
      { className: "mtts-chip-row" },
      DESIGN_PRESETS.map(function (preset) {
        return el(
          "button",
          {
            key: preset.label,
            type: "button",
            className: "mtts-chip",
            onClick: function () {
              props.onChange(preset.text);
            },
          },
          preset.label
        );
      })
    ),
    el("textarea", {
      className: "mtts-textarea",
      rows: 3,
      value: settings.designPrompt,
      placeholder: T("mixer.design.placeholder", "例如：年轻女性，声音温柔知性，语速偏慢，尾音轻轻上扬。"),
      onChange: function (event) {
        props.onChange(event.target.value);
      },
    }),
    el("div", { className: "mtts-hint" }, T("mixer.design.hint", "用自然语言描述想要的音色，模型会据此生成声音。"))
  );
}

function ClonePanel(props) {
  const [samples, setSamples] = useState([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const refresh = useCallback(function () {
    listSamples().then(setSamples);
  }, []);

  useEffect(
    function () {
      refresh();
      const unsub = samplesEmitter.sub(refresh);
      return unsub;
    },
    [refresh]
  );

  const handleFile = function (event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    const name = String(file.name || "").toLowerCase();
    const type = String(file.type || "").toLowerCase();
    const isWav = type.indexOf("wav") >= 0 || /\.wav$/.test(name);
    const isMp3 = type.indexOf("mpeg") >= 0 || type.indexOf("mp3") >= 0 || /\.mp3$/.test(name);
    if (!isWav && !isMp3) {
      pushToast("复刻只支持 mp3 / wav 格式的样本", "error");
      return;
    }
    if (file.size > SAMPLE_MAX_BYTES) {
      pushToast("样本超过 7 MB，请换一段更短的音频", "error");
      return;
    }
    setBusy(true);
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const result = String(reader.result || "");
        const base64 = result.split(",")[1] || "";
        if (!base64) {
          setBusy(false);
          pushToast("读取文件失败：内容为空", "error");
          return;
        }
        putSample({
          id: uid(),
          name: file.name || "sample",
          mime: isWav ? "audio/wav" : "audio/mpeg",
          size: file.size,
          bytes: file.size,
          base64: base64,
          createdAt: Date.now(),
        })
          .then(
            function (sample) {
              props.onPick(sample.id);
              pushToast(T("toast.cloneLoaded", "样本已保存"), "info");
            },
            function (err) {
              // 失败时也要给出可读原因；err 可能没有 message，不能直接取 .message
              const reason = (err && err.message) || String(err || "未知错误");
              pushToast(T("toast.err", "出错了：{{msg}}", { msg: reason }), "error");
            }
          )
          .then(
            function () {
              setBusy(false);
            },
            function () {
              setBusy(false);
            }
          );
      } catch (err) {
        setBusy(false);
        pushToast(T("toast.err", "出错了：{{msg}}", { msg: (err && err.message) || String(err) }), "error");
      }
    };
    reader.onerror = function () {
      setBusy(false);
      pushToast("读取文件失败", "error");
    };
    reader.readAsDataURL(file);
  };

  return el(
    "div",
    { className: "mtts-stack is-tight" },
    el(
      "div",
      { className: "mtts-inline" },
      el(
        "button",
        {
          type: "button",
          className: "mtts-btn",
          disabled: busy,
          onClick: function () {
            if (fileRef.current) fileRef.current.click();
          },
        },
        icon("Upload", 14),
        busy ? "读取中…" : T("mixer.clone.upload", "上传样本")
      ),
      el("input", {
        ref: fileRef,
        type: "file",
        accept: "audio/mpeg,audio/wav,audio/x-wav,audio/mp3,.mp3,.wav",
        style: { display: "none" },
        onChange: handleFile,
      }),
      el("span", { className: "mtts-hint is-inline" }, samples.length ? samples.length + " 个样本" : "")
    ),
    samples.length
      ? el(
          "div",
          { className: "mtts-sample-list" },
          samples.map(function (sample) {
            const active = props.settings.cloneSampleId === sample.id;
            return el(
              "div",
              { key: sample.id, className: cx("mtts-sample", active && "is-active") },
              el(
                "button",
                {
                  type: "button",
                  className: "mtts-sample-main",
                  onClick: function () {
                    props.onPick(sample.id);
                  },
                },
                icon("Mic", 13),
                el("span", { className: "mtts-sample-name" }, sample.name),
                el("span", { className: "mtts-sample-meta" }, fmtBytes(sample.size || sample.bytes))
              ),
              active ? el("span", { className: "mtts-sample-flag" }, icon("Check", 12)) : null,
              el(
                "button",
                {
                  type: "button",
                  className: "mtts-icon-btn",
                  title: T("history.delete", "删除"),
                  onClick: function () {
                    removeSample(sample.id).then(function (ok) {
                      if (!ok) {
                        pushToast("删除失败：本地存储不可用", "error");
                        return;
                      }
                      if (props.settings.cloneSampleId === sample.id) props.onPick("");
                    });
                  },
                },
                icon("Trash2", 13)
              )
            );
          })
        )
      : el("div", { className: "mtts-empty is-small" }, T("mixer.clone.empty", "还没有样本，上传一段音频后即可复刻。")),
    el("div", { className: "mtts-hint" }, T("mixer.clone.hint", "支持 mp3 / wav，建议 10–30 秒清晰人声，单文件不超过 7 MB。样本只保存在本机。"))
  );
}

/**
 * 从语气指令里移除一个标签短语。
 * 旧实现按分隔符切段后只删「整段完全等于短语」的那段：
 * 手写指令把短语裹进句子里（"用温柔轻声的语气说话"）时，标签显示为选中却怎么点都去不掉。
 * 现在：独立成段就整段删；嵌在句子里就只删短语本身，再收拢残留的分隔符。
 */
function removeInstructionPhrase(instruction, phrase) {
  const src = String(instruction || "");
  const target = String(phrase || "");
  if (!target || src.indexOf(target) < 0) return src;
  const parts = src.split(/[，,、；;]/);
  const isStandalone = parts.some(function (part) {
    return part.trim() === target;
  });
  if (isStandalone) {
    return parts
      .filter(function (part) {
        return part.trim() !== target;
      })
      .map(function (part) {
        return part.trim();
      })
      .filter(Boolean)
      .join("，");
  }
  return src
    .split(target)
    .join("")
    .replace(/[，,、；;]{2,}/g, "，")
    .replace(/^[\s，,、；;。]+/, "")
    .replace(/[\s，,、；;。]+$/, "")
    .trim();
}

/** 追加语气标签：先收掉末尾标点再加一个「，」，避免出现「慢点。，用开心雀跃的语气」 */
function appendInstructionPhrase(instruction, phrase) {
  const src = String(instruction == null ? "" : instruction).trim();
  const tag = String(phrase == null ? "" : phrase);
  if (!src) return tag;
  if (!tag) return src;
  return src.replace(/[\s，,。.；;、]+$/, "") + "，" + tag;
}

function InstructionPanel(props) {
  const settings = props.settings;
  const instruction = String(settings.instruction || "");
  const toggleTag = function (phrase) {
    if (instruction.indexOf(phrase) >= 0) {
      props.onChange(removeInstructionPhrase(instruction, phrase));
      return;
    }
    props.onChange(appendInstructionPhrase(instruction, phrase));
  };
  return el(
    "div",
    { className: "mtts-stack is-tight" },
    el(
      "div",
      { className: "mtts-chip-row" },
      STYLE_TAGS.map(function (item) {
        const active = instruction.indexOf(item.phrase) >= 0;
        return el(
          "button",
          {
            key: item.tag,
            type: "button",
            className: cx("mtts-chip", active && "is-active"),
            onClick: function () {
              toggleTag(item.phrase);
            },
          },
          item.tag
        );
      })
    ),
    el("textarea", {
      className: "mtts-textarea",
      rows: 2,
      value: instruction,
      placeholder: T("mixer.instruction.placeholder", "留空则使用模型默认语气，例如：用轻松一点的语气，语速稍快。"),
      onChange: function (event) {
        props.onChange(event.target.value);
      },
    }),
    el("div", { className: "mtts-hint" }, T("mixer.instruction.hint", "指令通过 user 消息下发，不会被朗读；效果因模型与文本而异。"))
  );
}

function MixerTab(props) {
  const settings = props.settings;
  const set = props.set;
  const model = settings.model;
  // 优先用当前 api 的语言：面板重开复用旧实例时，模块里的 UI_LOCALE 可能还是上一次的值
  const locale = (props.api && props.api.locale) || UI_LOCALE;
  const english = /^en\b/i.test(String(locale || ""));
  const modelItems = MODELS.map(function (item) {
    return {
      id: item.id,
      label: T(item.labelKey, english ? item.labelEn : item.label),
      icon: item.icon,
      hint: T(item.labelKey + ".hint", english ? item.hintEn : item.hint),
    };
  });
  return el(
    "div",
    { className: "mtts-stack" },
    !settings.apiKey && settings.localMode !== "primary"
      ? el(SetupCallout, { onAction: props.onOpenSettings })
      : null,
    el(
      Section,
      { title: T("mixer.model", "模型") },
      el(Segmented, {
        value: model,
        items: modelItems,
        onChange: function (value) {
          set({ model: value });
        },
      })
    ),
    model === "mimo-v2.5-tts"
      ? el(
          Section,
          { title: T("mixer.voice", "音色"), right: T("mixer.voice.hint", "同一音色的表现会随文本与语气指令变化") },
          el(VoiceGrid, {
            value: settings.voice,
            onChange: function (value) {
              set({ voice: value });
            },
          })
        )
      : null,
    model === "mimo-v2.5-tts-voicedesign"
      ? el(
          Section,
          { title: T("mixer.design", "音色描述") },
          el(DesignPanel, {
            settings: settings,
            onChange: function (value) {
              set({ designPrompt: value });
            },
          })
        )
      : null,
    model === "mimo-v2.5-tts-voiceclone"
      ? el(
          Section,
          { title: T("mixer.clone", "声音样本") },
          el(ClonePanel, {
            settings: settings,
            onPick: function (id) {
              set({ cloneSampleId: id });
            },
          })
        )
      : null,
    el(
      Section,
      { title: T("mixer.instruction", "语气指令") },
      el(InstructionPanel, {
        settings: settings,
        onChange: function (value) {
          set({ instruction: value });
        },
      })
    ),
    el(
      Section,
      { title: T("mixer.playback", "播放") },
      el(
        "div",
        { className: "mtts-card" },
        el(Slider, {
          label: T("mixer.rate", "语速"),
          display: Number(settings.rate).toFixed(2) + "×",
          min: 0.5,
          max: 2,
          step: 0.05,
          value: settings.rate,
          onChange: function (value) {
            set({ rate: value });
            setLiveRate(value);
          },
        }),
        el(Slider, {
          label: T("mixer.volume", "音量"),
          display: Math.round(Number(settings.volume) * 100) + "%",
          min: 0,
          max: 1,
          step: 0.05,
          value: settings.volume,
          onChange: function (value) {
            set({ volume: value });
            setLiveVolume(value);
          },
        }),
        el("div", { className: "mtts-hint" }, T("mixer.rateHint", "调整语速会轻微改变音高，这是音频流加速的固有表现。"))
      )
    )
  );
}

/* ------------------------------------------------------------------ */
/* 播报台                                                              */
/* ------------------------------------------------------------------ */

/** 列表里的一条消息：一次清洗同时得到预览和可朗读字数 */
function describeMessage(content) {
  const clean = cleanText(safeSlice(content, 4000));
  const flat = clean.replace(/\n+/g, " ");
  return {
    preview: flat.length > 110 ? safeSlice(flat, 110) + "…" : flat,
    chars: clean.length,
  };
}

function StageTab(props) {
  const api = props.api;
  const [text, setText] = useState(stageDraft);
  const [messages, setMessages] = useState([]);
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(true);
  const lastSignatureRef = useRef("");

  // 每 200ms 的流式推送都会改变签名，但 8 条里通常只有最后一条在增长。
  // 按「id + 长度 + 尾片段」缓存清洗结果，避免每次都把 8×4000 字全量跑一遍正则。
  const descCacheRef = useRef(new Map());
  const describeCached = function (item) {
    const cache = descCacheRef.current;
    const key = item.id + ":" + item.content.length + ":" + item.content.slice(-16);
    const hit = cache.get(key);
    if (hit) return hit;
    const info = describeMessage(item.content);
    cache.set(key, info);
    return info;
  };
  const pruneDescribeCache = function (keys) {
    const cache = descCacheRef.current;
    cache.forEach(function (value, key) {
      if (!keys.has(key)) cache.delete(key);
    });
  };

  useEffect(function () {
    let alive = true;
    let subscription = null;
    const onData = function (response) {
      if (!alive) return;
      const domain = response && response.domains ? response.domains.messages : null;
      if (!domain) {
        setDenied(true);
        setLoading(false);
        return;
      }
      setDenied(false);
      setLoading(false);
      const items = Array.isArray(domain.items) ? domain.items : [];
      const picked = [];
      for (let i = items.length - 1; i >= 0 && picked.length < 8; i--) {
        const item = items[i];
        if (item && item.role === "assistant" && typeof item.content === "string" && item.content.trim()) {
          picked.push(item);
        }
      }
      // 流式期间 live 域每 200ms 推一次：先比签名，没变化就不清洗、不重渲染。
      // 长度 + 结尾片段：既能发现流式增长，也能发现「同 id 重新生成成等长但不同内容」
      const signature = picked
        .map(function (item) {
          return item.id + ":" + item.content.length + ":" + item.content.slice(-16);
        })
        .join("|");
      if (lastSignatureRef.current === signature) return;
      lastSignatureRef.current = signature;
      setMessages(
        picked.map(function (item) {
          const info = describeCached(item);
          return {
            id: item.id,
            preview: info.preview,
            chars: info.chars,
            when: fmtRel(item.createdAt),
            content: item.content,
          };
        })
      );
      pruneDescribeCache(
        new Set(
          picked.map(function (item) {
            return item.id + ":" + item.content.length + ":" + item.content.slice(-16);
          })
        )
      );
    };
    (async function () {
      try {
        const sub = await api.metadata.subscribe("messages", onData);
        if (!alive) {
          if (sub && sub.unsubscribe) sub.unsubscribe();
          return;
        }
        subscription = sub;
      } catch (e) {
        if (alive) {
          setDenied(true);
          setLoading(false);
        }
      }
    })();
    return function () {
      alive = false;
      if (subscription && subscription.unsubscribe) subscription.unsubscribe();
    };
  }, [api]);

  // 字数只用于展示：超长文本跳过清洗统计，避免每敲一个键都跑一遍全量正则
  const charCount = useMemo(
    function () {
      return text.length > 5000 ? text.length : cleanText(text).length;
    },
    [text]
  );
  const busy = props.state.status !== "idle";

  return el(
    "div",
    { className: "mtts-stack" },
    el(
      Card,
      {
        title: T("stage.preview", "试听"),
        right: el(
          "span",
          { className: "mtts-muted" },
          T("stage.chars", "{{n}} 字", { n: charCount })
        ),
      },
      el("textarea", {
        className: "mtts-textarea is-tall",
        rows: 4,
        value: text,
        placeholder: T("stage.previewPlaceholder", "输入要试听的文字…"),
        onChange: function (event) {
          stageDraft = event.target.value;
          setText(stageDraft);
        },
      }),
      el(
        "div",
        { className: "mtts-inline" },
        el(
          "button",
          {
            type: "button",
            className: "mtts-btn is-primary",
            onClick: function () {
              speak(text, { title: T("stage.preview", "试听") }).catch(function () {});
            },
          },
          icon("Play", 14),
          T("stage.play", "朗读")
        ),
        busy
          ? el(
              "button",
              {
                type: "button",
                className: "mtts-btn",
                onClick: stop,
              },
              icon("Square", 13),
              T("stage.stop", "停止")
            )
          : null
      )
    ),
    el(
      Card,
      { title: T("stage.messages", "当前会话") },
      denied
        ? el("div", { className: "mtts-empty" }, T("stage.messages.denied", "读取会话正文被拒绝：请在插件隐私声明中允许「会话消息」。"))
        : loading
        ? el("div", { className: "mtts-empty" }, "…")
        : messages.length
        ? el(
            "div",
            { className: "mtts-msg-list" },
            messages.map(function (message) {
              return el(
                "div",
                { key: message.id, className: "mtts-msg" },
                el(
                  "div",
                  { className: "mtts-msg-body" },
                  el("div", { className: "mtts-msg-text" }, message.preview),
                  el(
                    "div",
                    { className: "mtts-msg-meta" },
                    (message.when ? message.when + " · " : "") + message.chars + " 字"
                  )
                ),
                el(
                  "button",
                  {
                    type: "button",
                    className: "mtts-icon-btn is-strong",
                    title: T("stage.read", "朗读这条"),
                    onClick: function () {
                      speak(message.content, { title: T("stage.read", "朗读这条") }).catch(function () {});
                    },
                  },
                  icon("Volume2", 15)
                )
              );
            })
          )
        : el("div", { className: "mtts-empty" }, T("stage.messages.empty", "当前会话还没有可朗读的助手回复。"))
    )
  );
}

/* ------------------------------------------------------------------ */
/* 历史                                                                */
/* ------------------------------------------------------------------ */

function HistoryTab() {
  const [clips, setClips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [playingId, setPlayingId] = useState("");
  const [note, setNote] = useState("");

  const refresh = useCallback(function () {
    listClips().then(function (list) {
      setClips(list);
      setNote(storageError);
      setLoading(false);
    });
  }, []);

  useEffect(
    function () {
      refresh();
      const unsub = historyEmitter.sub(refresh);
      return function () {
        unsub();
        // 离开历史页时把试听停掉，避免声音在后台继续
        stopPreview();
      };
    },
    [refresh]
  );

  useEffect(function () {
    const unsub = engineEmitter.sub(function (state) {
      // 朗读一旦开始，试听必然已被 stopPreview 停掉；同步清掉列表里的播放态
      if (state.status === "playing" || state.status === "buffering") setPlayingId("");
    });
    return unsub;
  }, []);

  const playClip = function (clip) {
    if (!clip || !clip.blob) return;
    // 先接管：停掉上一次试听和正在进行的朗读，保证只有一路音频
    stopPreview();
    stop();
    setPlayingId(clip.id);
    const token = previewToken;
    const settings = getSettings();
    decodeAudioBlob(clip.blob)
      .then(function (buffer) {
        // 解码期间用户可能又点了别的条目或离开，这次结果作废
        if (token !== previewToken) return;
        const built = createBufferPlayer(buffer, {
          rate: settings.rate,
          volume: settings.volume,
        });
        previewPlayer = built.player;
        const clear = function () {
          if (previewPlayer === built.player) previewPlayer = null;
          if (token === previewToken) setPlayingId("");
        };
        built.promise.then(clear, clear);
      })
      .catch(function (err) {
        if (token !== previewToken) return;
        setPlayingId("");
        pushToast("试听失败：" + String((err && err.message) || err), "error");
      });
  };

  const stopClip = function () {
    stopPreview();
    setPlayingId("");
  };

  const download = function (clip) {
    if (!clip || !clip.blob) return;
    const url = URL.createObjectURL(clip.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mimo-tts-" + (clip.createdAt || Date.now()) + ".wav";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 4000);
  };

  if (loading) return el("div", { className: "mtts-empty" }, "…");
  if (!clips.length) {
    return el(
      "div",
      { className: "mtts-stack is-tight" },
      el("div", { className: "mtts-empty" }, T("history.empty", "还没有朗读记录。成功合成的音频会自动存到这里。")),
      note ? el("div", { className: "mtts-note is-warn" }, "本地音频库不可用：" + note) : null
    );
  }

  return el(
    "div",
    { className: "mtts-stack" },
    note ? el("div", { className: "mtts-note is-warn" }, "本地音频库不可用：" + note + "，列表中的记录仅保留在内存里。") : null,
    el(
      "div",
      { className: "mtts-inline is-between" },
      el("span", { className: "mtts-muted" }, T("history.count", "{{n}} 条", { n: clips.length })),
      el(
        "button",
        {
          type: "button",
          className: "mtts-btn is-ghost",
          onClick: function () {
            if (playingId) stopClip();
            clearClips().then(function (ok) {
              pushToast(ok ? T("toast.cleared", "已清空") : "清空失败：本地音频库不可用", ok ? "info" : "error");
            });
          },
        },
        icon("Trash2", 13),
        T("history.clear", "清空历史")
      )
    ),
    el(
      "div",
      { className: "mtts-clip-list" },
      clips.map(function (clip) {
        const isPlaying = playingId === clip.id;
        return el(
          "div",
          { key: clip.id, className: cx("mtts-clip", isPlaying && "is-playing") },
          el(
            "div",
            { className: "mtts-clip-head" },
            el("span", { className: "mtts-clip-time" }, fmtRel(clip.createdAt)),
            clip.whole === false
              ? el("span", { className: "mtts-tag is-warn" }, T("history.partial", "仅首段"))
              : null
          ),
          el("div", { className: "mtts-clip-text", title: clip.text }, clip.text || ""),
          el(
            "div",
            { className: "mtts-clip-foot" },
            el(
              "span",
              { className: "mtts-clip-meta" },
              T("history.meta", "{{voice}} · {{chars}} 字 · {{size}}", {
                voice: clip.voice || "MiMo",
                chars: clip.chars || 0,
                size: fmtBytes(clip.bytes || 0),
              })
            ),
            el("span", { className: "mtts-dock-spacer" }),
            el(
              "button",
              {
                type: "button",
                className: "mtts-icon-btn",
                title: isPlaying ? T("stage.stop", "停止") : T("history.play", "试听"),
                onClick: function () {
                  if (isPlaying) {
                    stopClip();
                  } else {
                    playClip(clip);
                  }
                },
              },
              icon(isPlaying ? "Square" : "Play", 14)
            ),
            el(
              "button",
              {
                type: "button",
                className: "mtts-icon-btn",
                title: T("history.download", "下载"),
                onClick: function () {
                  download(clip);
                },
              },
              icon("Download", 14)
            ),
            el(
              "button",
              {
                type: "button",
                className: "mtts-icon-btn",
                title: T("history.delete", "删除"),
                onClick: function () {
                  if (playingId === clip.id) stopClip();
                  removeClip(clip.id).then(function (ok) {
                    if (!ok) pushToast("删除失败：本地音频库不可用", "error");
                  });
                },
              },
              icon("Trash2", 14)
            )
          )
        );
      })
    )
  );
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

function SettingsTab(props) {
  const settings = props.settings;
  const set = props.set;
  const [showKey, setShowKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState(settings.apiKey || "");
  const [savedFlash, setSavedFlash] = useState(false);
  const flashTimer = useRef(0);

  useEffect(
    function () {
      setKeyDraft(settings.apiKey || "");
    },
    [settings.apiKey]
  );

  // 组件卸载后不要再 setState（切标签 / 关面板时也会走到这里）
  useEffect(function () {
    return function () {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  const commitKey = function (force) {
    const next = keyDraft.trim();
    const cur = String(settings.apiKey || "").trim();
    if (next !== cur) set({ apiKey: next });
    // 输入框里残留的首尾空格提交后收掉，避免界面和实际保存值不一致
    if (next !== keyDraft) setKeyDraft(next);
    // 失焦时没改动就不折腾存储，也不闪「已保存」；手动点保存 / 回车总是给反馈
    if (!force && next === cur) return;
    setSavedFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(function () {
      flashTimer.current = 0;
      setSavedFlash(false);
    }, 1200);
  };

  return el(
    "div",
    { className: "mtts-stack" },
    el(
      Card,
      { title: T("settings.key", "API Key") },
      el(
        "div",
        { className: "mtts-inline" },
        el("input", {
          className: "mtts-input",
          type: showKey ? "text" : "password",
          value: keyDraft,
          spellCheck: false,
          autoComplete: "off",
          placeholder: T("settings.keyPlaceholder", "粘贴 MiMo API Key"),
          onChange: function (event) {
            setKeyDraft(event.target.value);
          },
          onBlur: function () {
            commitKey(false);
          },
          onKeyDown: function (event) {
            if (event.key === "Enter") {
              event.preventDefault();
              commitKey(true);
            }
          },
        }),
        el(
          "button",
          {
            type: "button",
            className: "mtts-btn is-icon",
            title: showKey ? T("settings.hide", "隐藏") : T("settings.show", "显示"),
            onClick: function () {
              setShowKey(!showKey);
            },
          },
          icon(showKey ? "EyeOff" : "Eye", 15)
        )
      ),
      el(
        "div",
        { className: "mtts-inline" },
        el(
          "button",
          { type: "button", className: "mtts-btn is-primary", onClick: function () { commitKey(true); } },
          icon("Save", 13),
          savedFlash ? T("toast.saved", "已保存") : T("settings.save", "保存")
        ),
        el(
          "button",
          {
            type: "button",
            className: "mtts-btn is-ghost",
            onClick: function () {
              setKeyDraft("");
              set({ apiKey: "" });
            },
          },
          T("settings.clearKey", "清除")
        ),
        el("span", { className: "mtts-muted" }, settings.apiKey ? T("settings.configured", "已配置") : T("settings.notConfigured", "未配置"))
      ),
      el("div", { className: "mtts-hint" }, T("settings.keyHint", "Key 只保存在本机插件存储，用于请求 api.xiaomimimo.com。"))
    ),
    el(
      Card,
      { title: T("settings.baseUrl", "接口地址") },
      el("input", {
        className: "mtts-input",
        type: "text",
        value: settings.baseUrl,
        spellCheck: false,
        onChange: function (event) {
          set({ baseUrl: event.target.value });
        },
        onBlur: function () {
          if (!String(settings.baseUrl || "").trim()) set({ baseUrl: DEFAULT_BASE });
        },
      }),
      el("div", { className: "mtts-hint" }, T("settings.baseUrlHint", "默认 https://api.xiaomimimo.com/v1，可改为兼容中转地址。"))
    ),
    el(
      Card,
      { title: T("settings.range", "朗读范围") },
      el(Segmented, {
        compact: true,
        value: settings.range,
        items: [
          { id: "smart", label: T("settings.range.smart", "智能") },
          { id: "full", label: T("settings.range.full", "全文") },
          { id: "first", label: T("settings.range.first", "首段") },
        ],
        onChange: function (value) {
          set({ range: value });
        },
      }),
      el("div", { className: "mtts-hint" }, T("settings.range.hint", "智能：自动播报只读开头两段，手动朗读读全文；全文：都读全文；首段：都只读第一段。"))
    ),
    el(
      Card,
      { title: T("settings.local", "本地语音") },
      el(Segmented, {
        compact: true,
        value: settings.localMode,
        items: [
          { id: "fallback", label: T("settings.local.fallback", "云端优先") },
          { id: "primary", label: T("settings.local.primary", "本地优先") },
          { id: "off", label: T("settings.local.off", "关闭") },
        ],
        onChange: function (value) {
          set({ localMode: value });
        },
      }),
      el("div", { className: "mtts-hint" }, T("settings.local.hint", "云端失败时可回退浏览器自带语音；本地语音不应用语气指令。"))
    ),
    el(
      Card,
      { title: T("settings.sfx", "操作音效") },
      el(Switch, {
        checked: !!settings.sfx,
        onChange: function (value) {
          set({ sfx: value });
          if (value) beep("done");
        },
        label: T("settings.sfxHint", "播放开始 / 结束与失败时发出轻提示音。"),
      })
    ),
    el(
      Card,
      { title: T("settings.data", "数据") },
      el(
        "div",
        { className: "mtts-inline" },
        el(
          "button",
          {
            type: "button",
            className: "mtts-btn is-ghost",
            onClick: function () {
              clearClips().then(function (ok) {
                pushToast(ok ? T("toast.cleared", "已清空") : "清空失败：本地音频库不可用", ok ? "info" : "error");
              });
            },
          },
          icon("Trash2", 13),
          T("settings.clearHistory", "清空音频历史")
        ),
        el(
          "button",
          {
            type: "button",
            className: "mtts-btn is-ghost",
            onClick: function () {
              clearSamples().then(function (ok) {
                if (ok) set({ cloneSampleId: "" });
                pushToast(ok ? T("toast.cleared", "已清空") : "清空失败：本地存储不可用", ok ? "info" : "error");
              });
            },
          },
          icon("Eraser", 13),
          T("settings.clearSamples", "清空复刻样本")
        )
      )
    ),
    el(
      Card,
      { title: T("settings.about", "关于") },
      el("div", { className: "mtts-hint" }, T("settings.aboutText", "复刻 dsh-plugin-xiaomi-mimo-tts 的朗读体验，接入 Xiaomi MiMo TTS。云端合成按服务商政策计费，TTS 系列当前限时免费。")),
      el(
        "div",
        { className: "mtts-about-foot" },
        el("span", { className: "mtts-tag" }, T("settings.version", "版本 {{v}}", { v: pluginVersion() })),
        el("span", { className: "mtts-tag" }, "window.snowMimoTts")
      )
    )
  );
}

/* ------------------------------------------------------------------ */
/* 面板入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 宿主的 PluginPanelContent 每次打开面板都会重新 import 一份模块（新的 blob URL），
 * 模块级状态（播放器、AudioContext、设置缓存、自动播报订阅）都会重建：
 *   · 旧实例里还在放的音频成了没人能暂停 / 停止的孤儿，Dock 却显示空闲；
 *   · 每次重开还会多留一个 AudioContext（浏览器对同时存在的上下文有数量限制）。
 * 所以同版本重开时直接复用旧实例的面板组件（引擎、看门狗、window.snowMimoTts 都还是那一份）；
 * 只有版本号变了（插件更新）才销毁旧实例、让新代码接管。
 * 维护提醒：改了插件代码记得同时升 plugin.json 的 version，否则面板重开仍会跑旧实例。
 */
const INSTANCE_PANEL_KEY = "__snowMimoTtsPanel";
const INSTANCE_VERSION_KEY = "__snowMimoTtsPanelVersion";
const INSTANCE_DISPOSE_KEY = "__snowMimoTtsDispose";
const previousPanel =
  typeof window !== "undefined" && typeof window[INSTANCE_PANEL_KEY] === "function"
    ? window[INSTANCE_PANEL_KEY]
    : null;
const previousVersion = typeof window !== "undefined" ? window[INSTANCE_VERSION_KEY] || "" : "";
const previousDispose =
  typeof window !== "undefined" && typeof window[INSTANCE_DISPOSE_KEY] === "function"
    ? window[INSTANCE_DISPOSE_KEY]
    : null;
const reusePreviousPanel = !!previousPanel && previousVersion === pluginVersion();

/** 销毁本模块实例：停播放 / 停试听 / 关 AudioContext / 退订自动播报 */
function disposeModule() {
  moduleDisposed = true;
  // 设置保存有 350 ms 防抖：插件更新换实例时若还挂着定时器，旧实例会带着未落盘的修改一起消失
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = 0;
    try {
      writeStoredSettings(cachedSettings);
    } catch (e) {}
  }
  try {
    stopPreview();
  } catch (e) {}
  try {
    stopInternal();
  } catch (e) {}
  if (sharedAudioCtx) {
    try {
      const closing = sharedAudioCtx.close();
      if (closing && typeof closing.catch === "function") closing.catch(function () {});
    } catch (e) {}
    sharedAudioCtx = null;
  }
  const sub = watcher && watcher.subscription;
  watcher = null;
  if (sub && typeof sub.unsubscribe === "function") {
    try {
      sub.unsubscribe();
    } catch (e) {}
  }
  if (typeof window !== "undefined" && window.__snowMimoTtsWatch === sub) {
    window.__snowMimoTtsWatch = null;
  }
  if (typeof window !== "undefined" && window.snowMimoTts) {
    try {
      delete window.snowMimoTts;
    } catch (e) {}
  }
}

function Panel(props) {
  const api = props.api || host.api;
  bindT(api);
  RUNTIME_API = api || RUNTIME_API;
  const [tab, setTab] = useState("mixer");
  const [toasts, setToasts] = useState([]);
  const settings = useSettingsState();
  const state = useEngine();

  useEffect(
    function () {
      startWatcher();
      loadSettings();
      ensureSettingsFromStorage();
    },
    []
  );

  useEffect(function () {
    const timers = [];
    const unsub = toastEmitter.sub(function (toast) {
      setToasts(function (list) {
        return list.concat([toast]).slice(-4);
      });
      timers.push(
        setTimeout(function () {
          setToasts(function (list) {
            return list.filter(function (item) {
              return item.id !== toast.id;
            });
          });
        }, 3200)
      );
    });
    return function () {
      unsub();
      timers.forEach(function (id) {
        clearTimeout(id);
      });
    };
  }, []);

  const set = useCallback(function (patch, options) {
    updateSettings(patch, options);
  }, []);

  return el(
    "div",
    { className: "mtts-root" },
    el(Header, {
      settings: settings,
      state: state,
      onToggleAuto: function (value) {
        set({ autoRead: value });
        if (value && !getSettings().apiKey && getSettings().localMode !== "primary") {
          pushToast(T("toast.noKey", "请先在设置里填入 MiMo API Key"), "warn");
        }
        if (value) startWatcher();
      },
    }),
    el(TabBar, { tab: tab, onChange: setTab }),
    el(ToastStack, { toasts: toasts }),
    el(
      "div",
      { className: "mtts-body" },
      tab === "mixer"
        ? el(MixerTab, {
            api: api,
            settings: settings,
            set: set,
            onOpenSettings: function () {
              setTab("settings");
            },
          })
        : null,
      tab === "stage" ? el(StageTab, { api: api, state: state }) : null,
      tab === "history" ? el(HistoryTab, null) : null,
      tab === "settings" ? el(SettingsTab, { settings: settings, set: set }) : null
    ),
    el(PlayerDock, {
      state: state,
      settings: settings,
      onRate: function (rate) {
        set({ rate: rate });
        setLiveRate(rate);
      },
    })
  );
}

/** 面板入口：同版本重开复用旧实例，否则用本次加载的新实现 */
export default function PanelEntry(props) {
  if (reusePreviousPanel) return el(previousPanel, props);
  return el(Panel, props);
}

/* 模块加载即注册对外接口与自动播报监听（面板打开过一次后保持后台运行）。
 * 复用旧实例时不重复初始化：旧实例的引擎、订阅和 window.snowMimoTts 都还在。 */
try {
  if (!reusePreviousPanel) {
    // 旧实例（版本已变）先停掉，否则它还在放的声音没人能控制
    if (previousDispose) {
      try {
        previousDispose();
      } catch (e) {}
    }
    bindT(host.api);
    exposeGlobalApi();
    loadSettings().then(function () {
      startWatcher();
    });
    if (typeof window !== "undefined") {
      window[INSTANCE_PANEL_KEY] = Panel;
      window[INSTANCE_VERSION_KEY] = pluginVersion();
      window[INSTANCE_DISPOSE_KEY] = disposeModule;
    }
  }
} catch (e) {
  /* 宿主环境不完整时静默，等待面板挂载再初始化 */
}
