// 随机化性质测试：固定种子生成 4000 组输入，检查清洗/分句/分段不丢字、不超限、不抛错
// 运行：node test/fuzz.mjs
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "index.js"), "utf8");
const cut = src.indexOf("/* ------------------------------------------------------------------ */\n/* 面板入口");
const tail = src.slice(src.indexOf("/* 模块加载即注册对外接口"));
const f = join(tmpdir(), "fuzz-" + Date.now() + ".mjs");
writeFileSync(
  f,
  src.slice(0, cut) +
    tail +
    "\nexport { cleanText, splitSentences, splitSegments, describeMessage, prepareText, removeInstructionPhrase, appendInstructionPhrase };\n",
  "utf8"
);
const m = await import(pathToFileURL(f).href);
unlinkSync(f);

let seed = 1234567;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const pool = [
  "中", "文", "字", "。", "！", "？", "；", "…", "，", "、", "\n", " ", "\t",
  "a", "B", "z", "3", "0", ".", "!", "?", "1", ":", "-", "+", "%",
  "*", "#", "`", "~", "_", "(", ")", "[", "]", "|", "<", ">", '"', "'", "/",
  "http://x.com", "https://example.com/a?b=1", "@@file:a/b@@",
  "😀", "👨‍👩‍👧‍👦", "ﬁ",
];

const joinNoSpace = (s) => s.replace(/\s/g, "");

let fails = 0;
const bad = (msg, input) => {
  fails++;
  if (fails <= 12) console.log("FAIL " + msg + "\n  input=" + JSON.stringify(input));
};

for (let iter = 0; iter < 4000; iter++) {
  let input = "";
  const n = Math.floor(rnd() * 260);
  for (let i = 0; i < n; i++) input += pick(pool);

  let clean;
  let segs;
  let sentences;
  let desc;
  try {
    clean = m.cleanText(input);
    sentences = m.splitSentences(clean);
    segs = m.splitSegments(clean, 200, 90);
    desc = m.describeMessage(input);
    m.prepareText(input, "smart", true);
    m.removeInstructionPhrase(input, "用温柔轻声的语气");
    m.appendInstructionPhrase(input, "用开心的语气");
  } catch (e) {
    bad("抛出异常: " + (e && e.message), input);
    continue;
  }

  // 1. 分段不丢字（忽略空白）
  if (joinNoSpace(segs.join("")) !== joinNoSpace(clean)) {
    bad("分段丢字/多字", input);
    // 打印首个差异
    const a = joinNoSpace(clean);
    const b = joinNoSpace(segs.join(""));
    let k = 0;
    while (k < a.length && k < b.length && a[k] === b[k]) k++;
    console.log("  clean[" + k + "]=" + JSON.stringify(a.slice(k, k + 20)) + " segs=" + JSON.stringify(b.slice(k, k + 20)));
  }

  // 2. 每段不超过上限（首段 firstLimit=90）
  for (const s of segs) {
    if (s.length > 200) bad("段超上限 " + s.length, input);
  }
  if (segs.length && segs[0].length > 90) bad("首段超 firstLimit " + segs[0].length, input);

  // 3. 不产生孤立代理对
  for (const s of segs) {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const nx = s.charCodeAt(i + 1);
        if (!(nx >= 0xdc00 && nx <= 0xdfff)) bad("孤立高位代理对", input);
        else i++;
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        bad("孤立低位代理对", input);
      }
    }
  }

  // 4. 纯汉字文本不被清洗吞掉
  if (/^[\u4e00-\u9fff。，]+$/.test(input) && input.length) {
    if (joinNoSpace(clean) !== joinNoSpace(input)) bad("纯中文被改写", input);
  }

  // 5. 汉字 + URL + 汉字：只在没有其它 markdown / chip / 标签结构的输入上验证，
  //    否则被删掉的那段汉字本来就该删（代码块 / chip 里），属于误报。
  if (input.indexOf("http") >= 0 && !/[@<>\[\]*`#~_]/.test(input)) {
    const hanBefore = input.match(/^([\u4e00-\u9fff]+)/);
    const hanAfter = input.match(/([\u4e00-\u9fff]+)[^]*$/);
    if (hanBefore && clean.indexOf(hanBefore[1]) < 0) bad("URL 前的汉字丢失", input);
    if (hanAfter && clean.indexOf(hanAfter[1]) < 0) bad("URL 后的汉字丢失", input);
  }

  // 6. 首段不能是纯标点
  if (segs.length > 1 && !/[^。！？!?；;…\n]/.test(segs[0])) {
    bad("首段只有标点", input);
  }

  // 7. 字数不为负
  if (!(desc.chars >= 0)) bad("字数异常", input);
}

// 定点检查：临界合并是否超限
const edge = "a".repeat(89) + " b".repeat(60);
const es = m.splitSegments(m.cleanText(edge), 200, 90);
if (es.some((s) => s.length > 200) || es[0].length > 90) {
  bad("临界英文合并超限", edge);
  console.log("  lens=" + JSON.stringify(es.map((s) => s.length)));
}

console.log(fails ? "\nfuzz FAILED " + fails : "\nfuzz ALL PASS（4000 组随机输入）");
process.exit(fails ? 1 : 0);
