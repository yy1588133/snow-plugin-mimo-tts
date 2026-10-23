// 自测：加载插件真实源码，验证核心纯函数。运行：node test/run.mjs
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "index.js"), "utf8");
const generated = join(tmpdir(), "mtts-module-" + process.pid + ".mjs");
const exported =
  "\nexport { cleanText, splitSegments, buildRequestBody, prepareText, applyRange, parseWav, concatWav, wavDuration, resolveEndpoint, base64ToBytes, bytesToBase64 };\n";
writeFileSync(generated, source + exported, "utf8");

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

function wavBytes(pcm, sampleRate = 24000) {
  const header = new ArrayBuffer(44);
  const dv = new DataView(header);
  const w = (o, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  dv.setUint32(4, 36 + pcm.length, true);
  w(8, "WAVE");
  w(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w(36, "data");
  dv.setUint32(40, pcm.length, true);
  return Buffer.concat([Buffer.from(header), Buffer.from(pcm)]);
}

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok || extra === undefined ? "" : "  → " + JSON.stringify(extra)));
}

const raw = [
  "# 标题",
  "",
  "这是**加粗**和 [链接](https://example.com) 以及 `inlineCode`。",
  "",
  "```js",
  "const secret = 1;",
  "```",
  "",
  "- 列表项一",
  "访问 https://foo.bar/baz 或 @@file:src/a.ts@@ 看看。",
].join("\n");
const cleaned = mod.cleanText(raw);
check("清洗：去掉代码块", !cleaned.includes("secret"), cleaned);
check("清洗：去掉行内代码", !cleaned.includes("inlineCode"), cleaned);
check("清洗：去掉裸网址", !cleaned.includes("https://"), cleaned);
check("清洗：去掉 chip 标记", !cleaned.includes("@@"), cleaned);
check("清洗：保留链接文字", cleaned.includes("链接"), cleaned);
check("清洗：去掉强调符号", cleaned.includes("加粗") && !cleaned.includes("**"), cleaned);

const longText = "第一句话在这里。第二句话也不长！第三句话带问号？".repeat(20);
const segs = mod.splitSegments(longText, 200, 90);
check("分句：段数大于 1", segs.length > 1, segs.length);
check("分句：首段不超 90 字", segs[0].length <= 90, segs[0].length);
check(
  "分句：其余段不超上限",
  segs.slice(1).every((s) => s.length <= 200),
  segs.map((s) => s.length)
);
check(
  "分句：内容不丢字",
  segs.join("").replace(/\s+/g, "") === longText.replace(/\s+/g, ""),
  { got: segs.join("").replace(/\s+/g, "").length, want: longText.replace(/\s+/g, "").length }
);

const preset = mod.buildRequestBody("你好", { model: "mimo-v2.5-tts", voice: "冰糖", instruction: "" }, "");
check("请求体：预置音色", preset.audio.voice === "冰糖" && preset.messages.length === 1);

const withStyle = mod.buildRequestBody("你好", { model: "mimo-v2.5-tts", voice: "苏打", instruction: "用开心的语气" }, "");
check(
  "请求体：语气指令走 user 且不朗读",
  withStyle.messages.length === 2 && withStyle.messages[0].role === "user" && withStyle.messages[1].role === "assistant"
);

const design = mod.buildRequestBody("你好", { model: "mimo-v2.5-tts-voicedesign", designPrompt: "温柔女声", instruction: "慢一点" }, "");
check(
  "请求体：音色设计合并描述",
  design.messages[0].role === "user" && design.messages[0].content.includes("温柔女声") && design.audio.voice === undefined
);

const clone = mod.buildRequestBody("你好", { model: "mimo-v2.5-tts-voiceclone", instruction: "" }, "QUJD");
check("请求体：复刻音色带 base64", clone.audio.voice === "QUJD");

const multi = "第一段内容。\n\n第二段内容。\n\n第三段内容。";
check("范围：首段", mod.applyRange(multi, "first", true) === "第一段内容。");
check("范围：智能自动读开头两段", mod.applyRange(multi, "smart", true) === "第一段内容。\n\n第二段内容。");
check("范围：智能手动读全文", mod.applyRange(multi, "smart", false) === multi);

const a = wavBytes(new Uint8Array(1000));
const b = wavBytes(new Uint8Array(2000));
const parsedA = mod.parseWav(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength));
check("WAV：解析采样率", parsedA && parsedA.fmt.sampleRate === 24000 && parsedA.data.byteLength === 1000);

const merged = await mod.concatWav([new Blob([a]), new Blob([b])]);
check("WAV：拼接为整体", merged.whole === true);
const mergedBuf = await merged.blob.arrayBuffer();
const parsedM = mod.parseWav(mergedBuf);
check("WAV：拼接后数据长度", parsedM && parsedM.data.byteLength === 3000);
check("WAV：时长换算", Math.round(mod.wavDuration(mergedBuf)) === 63, mod.wavDuration(mergedBuf));

check("接口地址：补 /chat/completions", mod.resolveEndpoint("https://api.xiaomimimo.com/v1") === "https://api.xiaomimimo.com/v1/chat/completions");
check("接口地址：完整端点不重复", mod.resolveEndpoint("https://x.cn/v1/chat/completions/") === "https://x.cn/v1/chat/completions");
check("base64：往返一致", mod.bytesToBase64(new Uint8Array([0, 1, 2, 250, 255])) === "AAEC+v8=");
check("base64：兼容 data URL", mod.base64ToBytes("data:audio/wav;base64,AAEC+v8=").length === 5);

try {
  unlinkSync(generated);
} catch (e) {
  /* 临时文件清理失败可忽略 */
}

console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILED");
process.exit(failures === 0 ? 0 : 1);
