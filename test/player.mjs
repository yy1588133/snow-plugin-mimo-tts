// 播放层自测：用仿真 AudioContext 验证 WebAudio 播放状态机
// 运行：node test/player.mjs
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/* ---------- 仿真 AudioContext ---------- */
class FakeAudioContext {
  constructor() {
    this.state = "running";
    this.currentTime = 0;
    this.destination = { name: "destination" };
    this.sources = [];
    this.gains = [];
    this.decoded = [];
    FakeAudioContext.last = this;
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  createBufferSource() {
    const ctx = this;
    const node = {
      buffer: null,
      playbackRate: { value: 1 },
      onended: null,
      started: null,
      stopped: false,
      connect(target) {
        this.target = target;
      },
      disconnect() {},
      start(when, offset) {
        this.started = { when, offset };
        ctx.sources.push(this);
      },
      stop() {
        this.stopped = true;
      },
    };
    return node;
  }
  createGain() {
    const gainNode = {
      gain: { value: 1 },
      connect(target) {
        this.target = target;
      },
      disconnect() {},
    };
    this.gains.push(gainNode);
    return gainNode;
  }
  decodeAudioData(buffer, onOk) {
    this.decoded.push(new Uint8Array(buffer.slice(0, 12)));
    onOk({ duration: 4 });
  }
}

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

const source = readFileSync(join(here, "..", "index.js"), "utf8");
const generated = join(tmpdir(), "mtts-player-" + process.pid + ".mjs");
writeFileSync(
  generated,
  source +
    "\nexport { CANCEL, createBufferPlayer, decodeAudioBlob, ensureWavBytes, getAudioCtx, playBlob, getSettings, updateSettings };\n",
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

/* ---------- 1. 裸 PCM 自动补 WAV 头 ---------- */
const pcm = new Uint8Array(4800).fill(7);
const fixed = mod.ensureWavBytes(pcm);
check("裸 PCM 补出 RIFF 头", String.fromCharCode(...fixed.subarray(0, 4)) === "RIFF", fixed.subarray(0, 4));
check("补头后长度 = 44 + 数据", fixed.length === 44 + pcm.length, fixed.length);
const untouched = mod.ensureWavBytes(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0]));
check("mp3 不被误加 WAV 头", !(untouched[0] === 0x52 && untouched[1] === 0x49), Array.from(untouched));
const pcmLikeMp3 = mod.ensureWavBytes(new Uint8Array([0xff, 0xe0, 0x00, 0x00, 0x10, 0x20]));
check(
  "0xFF 0xE? 开头的裸 PCM 仍补出 WAV 头",
  String.fromCharCode(...pcmLikeMp3.subarray(0, 4)) === "RIFF",
  Array.from(pcmLikeMp3.subarray(0, 4))
);
const realMp3 = mod.ensureWavBytes(new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0, 0]));
check("真正的 mp3 帧头不补头", realMp3[0] === 0xff && realMp3[1] === 0xfb, Array.from(realMp3.subarray(0, 4)));

/* ---------- 2. decodeAudioBlob 走 WebAudio，不碰 blob URL ---------- */
const wavHeader = new Uint8Array(44);
"RIFF".split("").forEach((c, i) => (wavHeader[i] = c.charCodeAt(0)));
"WAVE".split("").forEach((c, i) => (wavHeader[8 + i] = c.charCodeAt(0)));
const blob = new Blob([wavHeader, new Uint8Array(2000)], { type: "audio/wav" });
const buffer = await mod.decodeAudioBlob(blob);
check("decodeAudioBlob 返回 AudioBuffer", buffer && buffer.duration === 4, buffer);
check(
  "解码入参是 RIFF 数据",
  (() => {
    const seen = FakeAudioContext.last.decoded.at(-1);
    return String.fromCharCode(...seen.subarray(0, 4)) === "RIFF";
  })()
);

/* ---------- 3. 播放：开始 / 暂停 / 续播 / 跳转 / 自然结束 ---------- */
const ctx = mod.getAudioCtx();
const positions = [];
const built = mod.createBufferPlayer(buffer, {
  rate: 1,
  volume: 0.8,
  cancelError: mod.CANCEL,
  onPosition: (pos) => positions.push(pos),
});
await sleep(20);
check("播放后 context 里有 source", ctx.sources.length === 1, ctx.sources.length);
check("首次从 0 开始", ctx.sources[0].started.offset === 0, ctx.sources[0].started);

ctx.currentTime = 1;
built.player.pause();
const pausedAt = built.player.position();
check("暂停后位置冻结在 1s", Math.abs(pausedAt - 1) < 0.001, pausedAt);
ctx.currentTime = 2.5;
check("暂停期间位置不变", Math.abs(built.player.position() - pausedAt) < 0.001, built.player.position());

built.player.resume();
check("续播新建 source 并从暂停点开始", ctx.sources.length === 2 && Math.abs(ctx.sources[1].started.offset - 1) < 0.001, {
  count: ctx.sources.length,
  offset: ctx.sources[1] && ctx.sources[1].started.offset,
});

built.player.seek(0.5);
check("跳到 50% = 2s", Math.abs(built.player.position() - 2) < 0.001, built.player.position());
check("跳转时旧 source 已停止", ctx.sources[1].stopped === true);

built.player.setVolume(0.3);
check("音量实时生效", Math.abs(ctx.gains.at(-1).gain.value - 0.3) < 0.001, ctx.gains.at(-1).gain.value);

built.player.setRate(1.5);
check("改倍速不重建 source（避免拖动时断音）", ctx.sources.length === 3, ctx.sources.length);
check("倍速已写入正在播放的节点", ctx.sources[2].playbackRate.value === 1.5, ctx.sources[2].playbackRate.value);
check("改倍速后位置不跳变", Math.abs(built.player.position() - 2) < 0.001, built.player.position());

ctx.sources.at(-1).onended();
let ended = false;
try {
  await built.promise;
  ended = true;
} catch (e) {
  ended = false;
}
check("自然结束 resolve", ended);

/* ---------- 4. stop 触发 CANCEL ---------- */
const second = mod.createBufferPlayer(buffer, { cancelError: mod.CANCEL });
let cancelReason = null;
second.promise.catch((e) => {
  cancelReason = e;
});
await sleep(10);
second.player.stop();
await sleep(10);
check("stop 以 CANCEL 结束", cancelReason === mod.CANCEL, cancelReason);

/* ---------- 5. AudioContext 只创建一次，后续复用 ---------- */
const reusedA = mod.getAudioCtx();
const reusedB = mod.getAudioCtx();
check("复用同一个 AudioContext", reusedA === reusedB && reusedA === ctx, { same: reusedA === reusedB });

/* ---------- 6. 分段之间沿用最新的语速 / 音量 ---------- */
mod.updateSettings({ rate: 1.6, volume: 0.4 }, { persist: false });
const liveSession = { canceled: false };
mod.playBlob(blob, liveSession, { rate: 1, volume: 1 }).catch(() => {});
await sleep(30);
const liveSource = ctx.sources.at(-1);
const liveGain = ctx.gains.at(-1);
check("下一段沿用最新语速", Math.abs(liveSource.playbackRate.value - 1.6) < 0.001, liveSource.playbackRate.value);
check("下一段沿用最新音量", Math.abs(liveGain.gain.value - 0.4) < 0.001, liveGain.gain.value);
if (liveSession.abort) liveSession.abort();
await sleep(10);
check("停止后不再持有播放器", liveSession.player === null, liveSession.player);

/* ---------- 7. 改倍速失败时必须停掉旧源，不能留下两路声音 ---------- */
const rebuilt = mod.createBufferPlayer(buffer, { rate: 1 });
rebuilt.promise.catch(() => {});
await sleep(10);
const oldSource = ctx.sources.at(-1);
Object.defineProperty(oldSource, "playbackRate", {
  get() {
    // 真实浏览器里 playbackRate 是 AudioParam；这里用带 setter 的对象模拟「写入失败」
    return {
      get value() {
        return 1;
      },
      set value(v) {
        throw new Error("rate locked");
      },
    };
  },
});
rebuilt.player.setRate(1.8);
await sleep(10);
check("改倍速失败时旧源被停止", oldSource.stopped === true, oldSource.stopped);
check("改倍速失败后重建了新源", ctx.sources.at(-1) !== oldSource, ctx.sources.length);
rebuilt.player.stop();
await sleep(10);

try {
  unlinkSync(generated);
} catch (e) {}

console.log(failures === 0 ? "\n播放层：ALL PASS" : "\n播放层：" + failures + " 项失败");
process.exit(failures === 0 ? 0 : 1);
