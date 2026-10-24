// 第六轮回归：本轮修掉的文本清洗残留、API Key 空白、坏设置 / 坏记录容错
// 运行：node test/round6.mjs
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "index.js"), "utf8");
const generated = join(tmpdir(), "mtts-round6-" + process.pid + ".mjs");
writeFileSync(
  generated,
  source +
    "\nexport { cleanText, splitSegments, fmtBytes, fmtRel, normalizeKey, buildWavHeader, pickLocalVoice, loadSettings, getSettings, listClips, listSamples };\n",
  "utf8"
);

/* ---------------- 宿主桩：带一份「被写坏」的设置 ---------------- */
const stored = {
  "settings.v1": JSON.stringify({
    apiKey: "  sk-a\nb\t ",
    baseUrl: 12345,
    model: "not-a-model",
    voice: 42,
    rate: 9,
    volume: -1,
    maxChars: 9999,
    range: "weird",
    localMode: "???",
    autoRead: "yes",
    sfx: 1,
  }),
};

globalThis.window = {
  SnowAppPlugin: {
    React: {
      createElement() {},
      useState() {},
      useEffect() {},
      useRef() {},
      useCallback() {},
      useMemo() {},
    },
    icons: {},
    locale: "zh-CN",
    plugin: { id: "com.snowai.mimo-tts", version: "1.2.4" },
    api: {
      t: (key, options) => (options && options.defaultValue) || key,
      storage: {
        async getJson(key) {
          const raw = stored[key];
          return raw ? JSON.parse(raw) : null;
        },
        async setJson(key, value) {
          stored[key] = JSON.stringify(value);
        },
      },
      net: {
        async fetch() {
          return { ok: false, status: 0, error: "stub" };
        },
      },
      log() {},
    },
  },
  localStorage: { getItem: () => null, setItem: () => {} },
  // 本地语音兜底：带一个损坏的 null 项，验证挑选时不会抛错
  speechSynthesis: {
    getVoices() {
      return [{ lang: "zh-CN", name: "中文" }, { lang: "en-US", name: "English" }, null];
    },
  },
};

const mod = await import(pathToFileURL(generated).href);

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok || extra === undefined ? "" : "  → " + JSON.stringify(extra)));
}

/* ---------------- 1. 链接 / 图片里的成对括号 ---------------- */
console.log("\n[1] markdown 链接");
const link = mod.cleanText("看 [文档](https://example.com/a_(b)) 这里。");
check("链接不残留右括号", link.indexOf(")") < 0, link);
check("链接文字保留", link.indexOf("文档") >= 0, link);

const image = mod.cleanText("图片 ![截图](https://x/y_(1).png) 结束。");
check("图片整段丢弃", image.indexOf(".png") < 0 && image.indexOf(")") < 0, image);
check("图片两侧正文都在", image.indexOf("图片") >= 0 && image.indexOf("结束") >= 0, image);

const nestedLabel = mod.cleanText("看 [标题 [内嵌] 文字](https://x/y) 结束。");
check("链接标题里的方括号不影响匹配", nestedLabel.indexOf("文字") >= 0 && nestedLabel.indexOf("https") < 0, nestedLabel);

const normalLink = mod.cleanText("看 [文档](https://x/y) 和 [另一篇][ref]。");
check("普通链接行为不变", normalLink.indexOf("文档") >= 0 && normalLink.indexOf("另一篇") >= 0, normalLink);

/* ---------------- 2. 嵌套引用 / setext / 任务列表 ---------------- */
console.log("\n[2] 块级标记");
const quote = mod.cleanText(">> 嵌套引用的一句话");
check("嵌套引用不残留 >", quote.indexOf(">") < 0, quote);

const quoteSpaced = mod.cleanText("> > 带空格的嵌套引用");
check("带空格的嵌套引用不残留 >", quoteSpaced.indexOf(">") < 0, quoteSpaced);

const setextH1 = mod.cleanText("一级标题\n===\n正文。");
check("setext 一级标题下划线不残留", setextH1.indexOf("===") < 0, setextH1);
check("setext 标题文字保留", setextH1.indexOf("一级标题") >= 0, setextH1);

const setextH2 = mod.cleanText("二级标题\n---\n正文。");
check("setext 二级标题下划线不残留", setextH2.indexOf("---") < 0, setextH2);

const tasks = mod.cleanText("- [ ] 待办一\n- [x] 已完成\n- 普通项");
check("任务列表方括号不残留", tasks.indexOf("[") < 0 && tasks.indexOf("]") < 0, tasks);
check("任务列表文字保留", tasks.indexOf("待办一") >= 0 && tasks.indexOf("已完成") >= 0, tasks);
check("普通列表项仍正常", tasks.indexOf("普通项") >= 0, tasks);

/* ---------------- 3. HTML 实体 / markdown 转义 / 自动链接 ---------------- */
console.log("\n[3] 实体与转义");
const entities = mod.cleanText("A&nbsp;B &amp; C &#39;引号&#39; &#x1F600;");
check("&nbsp; 不再被逐字母念", entities.indexOf("&nbsp") < 0 && entities.indexOf("A B") >= 0, entities);
check("&amp; 解码为 &", entities.indexOf("&amp") < 0 && entities.indexOf("&") >= 0, entities);
check("数字实体解码", entities.indexOf("#39") < 0 && entities.indexOf("'引号'") >= 0, entities);
check("十六进制实体解码", entities.indexOf("&#x") < 0 && entities.indexOf("😀") >= 0, entities);

const escaped = mod.cleanText("这是 \\*不斜体\\* 和 \\_下划线\\_");
check("反斜杠转义不残留", escaped.indexOf("\\") < 0, escaped);
check("转义后的文字保留", escaped.indexOf("不斜体") >= 0 && escaped.indexOf("下划线") >= 0, escaped);

const multiply = mod.cleanText("结果是 2*3 而不是 2 * 3。");
check("乘号不被当成强调残留删掉", multiply.indexOf("2*3") >= 0 && multiply.indexOf("2 * 3") >= 0, multiply);
const emphasis = mod.cleanText("**加粗** 与 ***粗斜体*** 与 `代码`");
check("成对强调仍被清干净", !/\*|`/.test(emphasis) && emphasis.indexOf("加粗") >= 0 && emphasis.indexOf("粗斜体") >= 0, emphasis);

const autolink = mod.cleanText("见 <https://example.com/a> 这里。");
check("自动链接不残留尖括号", autolink.indexOf("<") < 0 && autolink.indexOf(">") < 0, autolink);
check("自动链接两侧正文都在", autolink.indexOf("见") >= 0 && autolink.indexOf("这里") >= 0, autolink);

/* ---------------- 4. 清洗结果仍能正常分段 ---------------- */
console.log("\n[4] 分段不丢字");
const rich = [
  "## 标题",
  "",
  "- [x] 完成 **重点** 和 [链接](https://x/a_(b))",
  "",
  "> 引用一句 &amp; 另一句",
  "",
  "正文结尾。",
].join("\n");
const cleaned = mod.cleanText(rich);
const segs = mod.splitSegments(cleaned, 200, 90);
check("清洗后没有残留标记", !/[>#*]|\[|\]/.test(cleaned), cleaned);
check("分段后不丢正文", segs.join("").replace(/\s+/g, "").indexOf("引用一句&另一句") >= 0, segs);
check("首段不超 90", segs[0].length <= 90, segs.map((s) => s.length));

/* ---------------- 5. 小工具边界 ---------------- */
console.log("\n[5] 工具函数");
check("fmtBytes 1023.6 不进位成 1024 B", mod.fmtBytes(1023.6) === "1 KB", mod.fmtBytes(1023.6));
check("fmtBytes 1023 B 保持", mod.fmtBytes(1023) === "1023 B", mod.fmtBytes(1023));
check("fmtBytes 0 显示 0 B", mod.fmtBytes(0) === "0 B", mod.fmtBytes(0));
check("normalizeKey 去掉所有空白", mod.normalizeKey(" sk-a\nb\t ") === "sk-ab", mod.normalizeKey(" sk-a\nb\t "));
check("normalizeKey 处理 null", mod.normalizeKey(null) === "", mod.normalizeKey(null));
check("超出 Date 范围的时间戳不显示 NaN", mod.fmtRel("999999999999999999999") === "", mod.fmtRel("999999999999999999999"));
check("正常毫秒时间戳仍显示刚刚", mod.fmtRel(Date.now()) === "刚刚", mod.fmtRel(Date.now()));
check("英文正文挑英文音色", mod.pickLocalVoice("hello world").lang === "en-US", mod.pickLocalVoice("hello world"));
check("中文正文挑中文音色", mod.pickLocalVoice("你好").lang === "zh-CN", mod.pickLocalVoice("你好"));
check("中英混排优先中文音色", mod.pickLocalVoice("你好 world").lang === "zh-CN", mod.pickLocalVoice("你好 world"));
check("坏音色项不影响挑选", mod.pickLocalVoice("") && mod.pickLocalVoice("").lang === "zh-CN");

const extHeader = new Uint8Array(
  mod.buildWavHeader({ audioFormat: 0xfffe, channels: 1, sampleRate: 24000, bits: 16 }, 100)
);
check("EXTENSIBLE 头回退为 PCM", new DataView(extHeader.buffer).getUint16(20, true) === 1);
const pcmHeader = new Uint8Array(
  mod.buildWavHeader({ audioFormat: 1, channels: 2, sampleRate: 44100, bits: 16 }, 100)
);
const pcmDv = new DataView(pcmHeader.buffer);
check(
  "普通 PCM 头保留原字段",
  pcmDv.getUint16(20, true) === 1 && pcmDv.getUint16(22, true) === 2 && pcmDv.getUint32(24, true) === 44100
);

/* ---------------- 6. 坏设置被归一化 ---------------- */
console.log("\n[6] 设置归一化");
await mod.loadSettings();
const s = mod.getSettings();
check("未知模型回默认", s.model === "mimo-v2.5-tts", s.model);
check("非法朗读范围回默认", s.range === "smart", s.range);
check("非法本地语音模式回默认", s.localMode === "fallback", s.localMode);
check("API Key 去掉换行与空格", s.apiKey === "sk-ab", s.apiKey);
check("语速夹到上限", s.rate === 2, s.rate);
check("音量夹到下限", s.volume === 0, s.volume);
check("分段字数夹到上限", s.maxChars === 400, s.maxChars);
check("非布尔的 autoRead 归为 false", s.autoRead === false, s.autoRead);
check("非布尔的 sfx 归为 false", s.sfx === false, s.sfx);
check("非字符串的音色回默认", s.voice === "冰糖", s.voice);
check("非字符串的 baseUrl 回默认", s.baseUrl === "https://api.xiaomimimo.com/v1", s.baseUrl);

/* ---------------- 7. 坏 IndexedDB 记录不让列表消失 ---------------- */
console.log("\n[7] 坏记录容错");
const rows = {
  clips: [null, "broken", { id: "c1", createdAt: 3, chars: 2, bytes: 10 }],
  samples: [null, 0, { id: "s1", name: "a.wav", size: 10, createdAt: 2 }],
};
globalThis.indexedDB = {
  open() {
    const req = {};
    queueMicrotask(() => {
      req.result = {
        objectStoreNames: { contains: () => true },
        transaction(name) {
          return {
            objectStore() {
              return {
                getAll() {
                  const r = {};
                  queueMicrotask(() => {
                    r.result = rows[name].slice();
                    if (r.onsuccess) r.onsuccess();
                  });
                  return r;
                },
              };
            },
          };
        },
        close() {},
      };
      if (req.onsuccess) req.onsuccess();
    });
    return req;
  },
};

const clips = await mod.listClips();
check("坏音频记录被跳过，好记录保留", clips.length === 1 && clips[0].id === "c1", clips.map((c) => c && c.id));
const samples = await mod.listSamples();
check("坏样本记录被跳过，好记录保留", samples.length === 1 && samples[0].id === "s1", samples.map((x) => x && x.id));

try {
  unlinkSync(generated);
} catch (e) {
  /* 临时文件清理失败可忽略 */
}

console.log(failures === 0 ? "\n第六轮回归：ALL PASS" : "\n第六轮回归：" + failures + " 项失败");
process.exit(failures === 0 ? 0 : 1);
