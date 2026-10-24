// 第五轮回归：文本清洗残留（分隔线 / 引用式链接定义 / 汉字夹住的下划线斜体）+ 语言包完整性
// 运行：node test/round5.mjs
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "index.js"), "utf8");
const generated = join(tmpdir(), "mtts-round5-" + process.pid + ".mjs");
writeFileSync(
  generated,
  source +
    "\nexport { cleanText, splitSegments, describeMessage, prepareText };\n",
  "utf8"
);

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
    api: null,
    locale: "zh-CN",
  },
};

const mod = await import(pathToFileURL(generated).href);

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok || extra === undefined ? "" : "  → " + JSON.stringify(extra)));
}

/* ---------------- 1. 分隔线不再残留 ---------------- */
console.log("\n[1] markdown 分隔线");
const dashes = mod.cleanText("第一段。\n\n---\n\n第二段。");
check("--- 不残留", dashes.indexOf("---") < 0, dashes);
check("--- 两侧正文都在", dashes.indexOf("第一段。") >= 0 && dashes.indexOf("第二段。") >= 0, dashes);

const stars = mod.cleanText("上面\n\n***\n\n下面");
check("*** 不残留", stars.indexOf("***") < 0, stars);

const unders = mod.cleanText("上面\n\n___\n\n下面");
check("___ 不残留", unders.indexOf("___") < 0, unders);

const spaced = mod.cleanText("上面\n\n- - -\n\n下面");
check("- - - 不残留", spaced.indexOf("- -") < 0, spaced);

const mixed = mod.cleanText("* * *\n\n正文");
check("* * * 不残留", !/^\s*\*/.test(mixed), mixed);

const boldItalic = mod.cleanText("***重点*** 内容");
check("***重点*** 仍按强调清洗", boldItalic.indexOf("重点") >= 0 && boldItalic.indexOf("*") < 0, boldItalic);

/* ---------------- 2. 引用式链接定义行 ---------------- */
console.log("\n[2] 引用式链接");
const refdef = mod.cleanText("正文看这里 [文字][ref]\n\n[ref]: https://example.com/a\n下一段。");
check("定义行不残留方括号冒号", refdef.indexOf("[ref]") < 0 && refdef.indexOf("]:") < 0, refdef);
check("链接文字保留", refdef.indexOf("文字") >= 0, refdef);
check("定义行后面的正文还在", refdef.indexOf("下一段。") >= 0, refdef);

/* ---------------- 3. 汉字夹住的下划线斜体 ---------------- */
console.log("\n[3] 下划线斜体");
const cjkItalic = mod.cleanText("与_斜体文字_。");
check("汉字后的 _斜体_ 被清掉", cjkItalic.indexOf("_") < 0 && cjkItalic.indexOf("斜体文字") >= 0, cjkItalic);

const leadingItalic = mod.cleanText("_强调_中文");
check("行首 _强调_ 后接汉字被清掉", leadingItalic.indexOf("_") < 0 && leadingItalic.indexOf("强调") >= 0, leadingItalic);

const snake = mod.cleanText("变量 snake_case_name 保持不变");
check("snake_case 不被误伤", snake.indexOf("snake_case_name") >= 0, snake);

const mixedSnake = mod.cleanText("调用 a_b_中文 的函数");
check("ASCII 开头的标识符不被误伤", mixedSnake.indexOf("a_b_中文") >= 0, mixedSnake);

/* ---------------- 4. 原有行为不回归 ---------------- */
console.log("\n[4] 不回归");
const keep = mod.cleanText("C# 与 F# 以及 #1 编号，价格 $5。");
check("C# / F# / #1 保留", keep.indexOf("C#") >= 0 && keep.indexOf("F#") >= 0 && keep.indexOf("#1") >= 0, keep);
check("价格保留", keep.indexOf("$5") >= 0, keep);

const list = mod.cleanText("- 项目一\n- 项目二");
check("普通列表仍去符号", list.indexOf("- ") < 0, list);

const segs = mod.splitSegments(mod.cleanText("第一段。\n\n---\n\n第二段。"), 200, 90);
check("清洗后分段不丢字", segs.join("").replace(/\s+/g, "") === "第一段。第二段。", segs);

/* ---------------- 5. 语言包完整性 ---------------- */
console.log("\n[5] 语言包");
const en = JSON.parse(readFileSync(join(here, "..", "locales", "en.json"), "utf8"));
const zh = JSON.parse(readFileSync(join(here, "..", "locales", "zh-CN.json"), "utf8"));
const enKeys = Object.keys(en).sort();
const zhKeys = Object.keys(zh).sort();
check("en / zh 键集合一致", enKeys.join("|") === zhKeys.join("|"), {
  onlyEn: enKeys.filter((k) => !(k in zh)),
  onlyZh: zhKeys.filter((k) => !(k in en)),
});

// 静态 T("key", ...) 都要有译文；MODELS 的 labelKey / hint 是拼出来的，单独补上
const staticKeys = [...new Set([...source.matchAll(/\bT\(\s*"([^"]+)"/g)].map((m) => m[1]))];
const dynamicKeys = [
  "mixer.model.preset",
  "mixer.model.preset.hint",
  "mixer.model.design",
  "mixer.model.design.hint",
  "mixer.model.clone",
  "mixer.model.clone.hint",
  "voice.meta.default",
];
const allKeys = staticKeys.concat(dynamicKeys);
const missingEn = allKeys.filter((k) => !(k in en));
const missingZh = allKeys.filter((k) => !(k in zh));
check("代码用到的键都有英文", missingEn.length === 0, missingEn);
check("代码用到的键都有中文", missingZh.length === 0, missingZh);

const emptyEn = allKeys.filter((k) => k in en && !String(en[k]).trim());
check("英文译文不为空", emptyEn.length === 0, emptyEn);

// 插值占位符必须两边一致，否则某个语言会漏掉数字
const badPlaceholders = allKeys.filter((k) => {
  if (!(k in en) || !(k in zh)) return true;
  const pick = (s) => (String(s).match(/\{\{\s*[\w.]+\s*\}\}/g) || []).sort().join(",");
  return pick(en[k]) !== pick(zh[k]);
});
check("中英文占位符一致", badPlaceholders.length === 0, badPlaceholders);

/* ---------------- 6. 版本号三处一致 ---------------- */
console.log("\n[6] 版本号");
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(here, "..", "plugin.json"), "utf8"));
const fallback = (source.match(/const FALLBACK_VERSION = "([^"]+)"/) || [])[1];
check("plugin.json 与 package.json 版本一致", manifest.version === pkg.version, {
  plugin: manifest.version,
  package: pkg.version,
});
check("FALLBACK_VERSION 与 plugin.json 一致", fallback === manifest.version, {
  fallback,
  plugin: manifest.version,
});

try {
  unlinkSync(generated);
} catch (e) {
  /* 临时文件清理失败可忽略 */
}

console.log(failures === 0 ? "\n第五轮回归：ALL PASS" : "\n第五轮回归：" + failures + " 项失败");
process.exit(failures === 0 ? 0 : 1);
