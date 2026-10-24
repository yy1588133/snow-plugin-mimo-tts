/**
 * 消息结束插槽（plugin.json → contributions.messageFooters）离线测试。
 * 用最小假 DOM + 假插槽 api + 假引擎，验证：
 *   · 挂载契约：返回清理函数（不是 Promise），图标挂进插槽容器
 *   · 图标并入原生操作行（.ai-message-footer）末尾；那一行被重建后轮询能挂回去
 *   · 点击后用 messageId 取这条回复的正文并交给引擎
 *   · id 对不上时退回最后一条助手回复；正文为空 / 没有引擎时给短暂提示（不再要求先开面板）
 *   · 播放中图标变暂停、暂停后变继续、停止按钮只在本按钮发起的播放里出现
 *   · 卸载（abort / 清理函数）后把自己从行里摘掉、轮询停止
 *   · 有 preload 桥（window.snow）时插槽自己就是完整引擎：能联云、能读面板写的 Key
 */
import assert from "node:assert/strict";

/* ------------------------------ 最小 DOM ------------------------------ */
function makeElement(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    ownerDocument: null,
    listeners: Object.create(null),
    style: {},
    attributes: Object.create(null),
    classList: {
      _set: new Set(),
      add(name) {
        this._set.add(name);
      },
      remove(name) {
        this._set.delete(name);
      },
      contains(name) {
        return this._set.has(name);
      },
    },
    textContent: "",
    innerHTML: "",
    title: "",
    type: "",
    disabled: false,
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return name in this.attributes ? this.attributes[name] : null;
    },
    appendChild(child) {
      if (child.parentNode && child.parentNode !== this) child.parentNode.removeChild(child);
      if (this.children.indexOf(child) < 0) this.children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    addEventListener(type, fn) {
      (this.listeners[type] || (this.listeners[type] = [])).push(fn);
    },
    removeEventListener(type, fn) {
      const list = this.listeners[type];
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    querySelectorAll(selector) {
      const out = [];
      const name = String(selector).replace(/^\./, "");
      (function walk(parent) {
        parent.children.forEach((child) => {
          if (child.classList && child.classList.contains(name)) out.push(child);
          walk(child);
        });
      })(node);
      return out;
    },
  };
  Object.defineProperty(node, "parentElement", {
    get() {
      return this.parentNode;
    },
  });
  Object.defineProperty(node, "nextElementSibling", {
    get() {
      const parent = this.parentNode;
      if (!parent) return null;
      const i = parent.children.indexOf(this);
      return i >= 0 ? parent.children[i + 1] || null : null;
    },
  });
  Object.defineProperty(node, "lastChild", {
    get() {
      return this.children.length ? this.children[this.children.length - 1] : null;
    },
  });
  node.ownerDocument = doc;
  return node;
}

const doc = { createElement: makeElement };

function makeSignal() {
  const listeners = [];
  return {
    aborted: false,
    addEventListener(type, fn) {
      if (type === "abort") listeners.push(fn);
    },
    abort() {
      this.aborted = true;
      listeners.slice().forEach((fn) => fn());
    },
  };
}

function findButton(root) {
  return root.children.find((child) => child.tagName === "BUTTON");
}
function findStopButton(root) {
  return root.children.find((child) => child.tagName === "BUTTON" && child !== findButton(root));
}
function findHint(root) {
  return root.children.find((child) => child.tagName === "SPAN");
}

/** 还原宿主的真实结构：wrapper > [ display:contents 的 host > container ] , row(.ai-message-footer) */
function makeRowDom() {
  const wrapper = makeElement("div");
  const host = makeElement("div");
  const row = makeElement("div");
  row.classList.add("ai-message-footer");
  const stamp = makeElement("span");
  const actions = makeElement("div");
  actions.classList.add("ai-response-actions");
  row.appendChild(stamp);
  row.appendChild(actions);
  wrapper.appendChild(host);
  wrapper.appendChild(row);
  const container = makeElement("div");
  host.appendChild(container);
  return { wrapper, host, row, container };
}

/* ------------------------------ 宿主环境 ------------------------------ */
globalThis.document = doc;
globalThis.window = { SnowAppPlugin: {} };

let intervalFn = null;
globalThis.setInterval = (fn) => {
  intervalFn = fn;
  return 1;
};
globalThis.clearInterval = () => {
  intervalFn = null;
};

const { mountFooter } = await import("../index.js");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/* ------------------------------ 假引擎 ------------------------------ */
function makeEngine(initial) {
  const engine = {
    played: [],
    calls: [],
    state: Object.assign({ status: "idle", error: "" }, initial || {}),
    play(text, options) {
      this.played.push({ text: text, title: options && options.title });
      // 真实引擎每次播放都会换 startedAt：按钮用它判断「这是不是我发起的播放」
      this.state = Object.assign({}, this.state, {
        status: "playing",
        error: "",
        startedAt: (Number(this.state.startedAt) || 0) + 1,
      });
      return Promise.resolve(true);
    },
    pause() {
      this.calls.push("pause");
      this.state = Object.assign({}, this.state, { status: "paused" });
    },
    resume() {
      this.calls.push("resume");
      this.state = Object.assign({}, this.state, { status: "playing" });
    },
    stop() {
      this.calls.push("stop");
      this.state = Object.assign({}, this.state, { status: "idle" });
    },
    getState() {
      return Object.assign({}, this.state);
    },
    hasCloud() {
      return true;
    },
  };
  return engine;
}

function makeApi(items) {
  return {
    metadata: {
      get() {
        return Promise.resolve({ domains: { messages: { conversationId: "c1", items: items } } });
      },
    },
  };
}

const items = [
  { id: "m1", role: "assistant", content: "第一条回复" },
  { id: "m2", role: "assistant", content: "第二条回复" },
];

/* ------------------------------ 1. 挂载契约 ------------------------------ */
{
  const container = makeElement("div");
  const cleanup = mountFooter(container, makeApi(items), { messageId: "m2" }, makeSignal());
  assert.equal(typeof cleanup, "function", "mountFooter 必须返回清理函数，不能返回 Promise");
  assert.equal(container.children.length, 1, "插槽容器里应该有且只有一个根节点");
  const root = container.children[0];
  const button = findButton(root);
  assert.ok(button, "应该有朗读按钮");
  assert.equal(button.children[0].tagName, "SPAN", "按钮里只有图标，没有文字标签");
  assert.match(String(button.getAttribute("aria-label") || ""), /朗读/, "图标要有可读的 aria-label");
  assert.match(button.style.cssText, /width:26px/, "按钮尺寸要与原生操作按钮一致");
  assert.match(button.style.cssText, /border:0/, "原生操作按钮没有边框");
  cleanup();
  assert.equal(container.children.length, 0, "清理后容器应被清空");
  console.log("✓ mountFooter 挂载 / 纯图标按钮 / 返回清理函数");
}

/* ------------------------------ 2. 并入原生操作行末尾 ------------------------------ */
{
  const { row, container } = makeRowDom();
  const cleanup = mountFooter(container, makeApi(items), { messageId: "m2" }, makeSignal());
  const root = row.children[row.children.length - 1];
  assert.equal(root.getAttribute("data-snow-mimo-tts"), "footer", "图标应挂进 .ai-message-footer 的末尾");
  assert.equal(container.children.length, 0, "搬进行里之后插槽容器应为空");
  assert.equal(row.children[1].className, undefined, "原有的复制 / 分支那一组不动");

  // React 重建那一行：图标被丢掉，下一轮轮询要挂回去
  row.children = [];
  intervalFn();
  const back = row.children[row.children.length - 1];
  assert.equal(back && back.getAttribute("data-snow-mimo-tts"), "footer", "行被重建后轮询应把图标挂回末尾");

  cleanup();
  assert.equal(row.children.length, 0, "清理后图标应从行里摘掉");
  console.log("✓ 图标并入 .ai-message-footer 末尾，行被重建后能挂回去");
}

/* ------------------------------ 3. 按 messageId 取正文 ------------------------------ */
{
  const container = makeElement("div");
  const engine = makeEngine();
  window.snowMimoTts = engine;
  const cleanup = mountFooter(container, makeApi(items), { messageId: "m1" }, makeSignal());
  findButton(container.children[0]).listeners.click[0]();
  await flush();
  assert.equal(engine.played.length, 1, "点击一次应调用一次引擎");
  assert.equal(engine.played[0].text, "第一条回复", "应朗读 messageId 对应的那条回复");
  assert.ok(engine.played[0].title, "应带上播放标题");
  cleanup();
  console.log("✓ 点击按 messageId 取正文并交给引擎");
}

/* ------------------------------ 4. id 对不上退最后一条 ------------------------------ */
{
  const container = makeElement("div");
  const engine = makeEngine();
  window.snowMimoTts = engine;
  const cleanup = mountFooter(container, makeApi(items), { messageId: "gone" }, makeSignal());
  findButton(container.children[0]).listeners.click[0]();
  await flush();
  assert.equal(engine.played[0].text, "第二条回复", "id 匹配不上时应退回最后一条助手回复");
  cleanup();
  console.log("✓ messageId 缺失时退回最后一条助手回复");
}

/* ------------------------------ 5. 正文为空给短暂提示 ------------------------------ */
{
  const container = makeElement("div");
  const engine = makeEngine();
  window.snowMimoTts = engine;
  const cleanup = mountFooter(
    container,
    makeApi([{ id: "m3", role: "user", content: "只有用户消息" }]),
    { messageId: "m3" },
    makeSignal()
  );
  const root = container.children[0];
  findButton(root).listeners.click[0]();
  await flush();
  assert.equal(engine.played.length, 0, "没有助手正文时不应调用引擎");
  assert.match(String(findHint(root).textContent), /没读到这条回复的正文/, "应提示读不到正文");
  cleanup();
  console.log("✓ 没取到正文时提示而不是空播放");
}

/* ------------------------------ 6. 没有引擎时不再要求先开面板 ------------------------------ */
{
  const container = makeElement("div");
  delete window.snowMimoTts;
  const cleanup = mountFooter(container, makeApi(items), { messageId: "m2" }, makeSignal());
  const root = container.children[0];
  findButton(root).listeners.click[0]();
  await flush();
  const hint = String(findHint(root).textContent || "");
  assert.match(hint, /引擎/, "应说明引擎还没就绪");
  assert.doesNotMatch(hint, /打开.{0,4}面板/, "不应再出现「先打开面板」的说法");
  cleanup();
  console.log("✓ 没有引擎时提示引擎未就绪，不再要求先打开面板");
}

/* ------------------------------ 7. 播放 / 暂停 / 继续 / 停止 ------------------------------ */
{
  const container = makeElement("div");
  const engine = makeEngine();
  window.snowMimoTts = engine;
  const signal = makeSignal();
  mountFooter(container, makeApi(items), { messageId: "m2" }, signal);
  const root = container.children[0];
  const button = findButton(root);
  const stopButton = findStopButton(root);

  button.listeners.click[0]();
  await flush();
  intervalFn();
  assert.equal(root.getAttribute("data-state"), "playing");
  assert.match(String(button.getAttribute("aria-label")), /暂停/, "播放中应变成暂停");
  assert.notEqual(stopButton.style.display, "none", "播放中应出现停止按钮");

  button.listeners.click[0]();
  intervalFn();
  assert.deepEqual(engine.calls, ["pause"], "播放中再点应暂停");
  assert.match(String(button.getAttribute("aria-label")), /继续/, "暂停后应变成继续");

  button.listeners.click[0]();
  intervalFn();
  assert.deepEqual(engine.calls, ["pause", "resume"], "暂停后再点应继续");
  assert.match(String(button.getAttribute("aria-label")), /暂停/);

  stopButton.listeners.click[0]();
  intervalFn();
  assert.deepEqual(engine.calls, ["pause", "resume", "stop"], "停止按钮应调用引擎 stop");
  assert.match(String(button.getAttribute("aria-label")), /朗读/, "停止后回到朗读");
  assert.equal(stopButton.style.display, "none", "停止后停止按钮隐藏");

  signal.abort();
  assert.equal(container.children.length, 0, "signal abort 后容器应被清空");
  assert.equal(intervalFn, null, "signal abort 后轮询应停止");
  console.log("✓ 播放 / 暂停 / 继续 / 停止 状态跟随，abort 后清理");
}

/* ------------------------------ 8. 有 preload 桥：插槽自己就是完整引擎 ------------------------------ */
{
  delete window.snowMimoTts;
  delete window.__snowMimoTtsPanel;
  delete window.__snowMimoTtsPanelVersion;
  window.SnowAppPlugin = {};

  const requests = [];
  const stored = { "settings.v1": JSON.stringify({ apiKey: "sk-test", voice: "冰糖" }) };
  window.snow = {
    requestPluginHttp(options) {
      requests.push(options);
      return Promise.resolve({ ok: true, status: 200, headers: {}, body: "{}", error: null });
    },
    getPluginValues(pluginId) {
      assert.equal(pluginId, "com.snowai.mimo-tts", "桥应读本插件的私有存储");
      return Promise.resolve(
        Object.keys(stored).map((key) => ({ key: key, value: stored[key] }))
      );
    },
    setPluginValue(pluginId, key, value) {
      stored[key] = value;
      return Promise.resolve(true);
    },
    deletePluginValue(pluginId, key) {
      delete stored[key];
      return Promise.resolve(true);
    },
  };

  await import("../index.js?boot=bridge");
  assert.ok(window.snowMimoTts, "插槽入口也要暴露 window.snowMimoTts");
  assert.equal(window.snowMimoTts.hasCloud(), true, "有 preload 桥就算能联云，不该再降级成本地语音");
  assert.equal(typeof window.__snowMimoTtsPanel, "function", "桥模式登记面板实例：面板复用它，不会出现第二个引擎");

  await new Promise((resolve) => setTimeout(resolve, 30));
  const settings = window.snowMimoTts.getSettings();
  assert.equal(settings.hasApiKey, true, "插槽入口要能读到面板写进私有存储的 Key");
  assert.equal(settings.voice, "冰糖", "音色设置也要一并读到");
  assert.equal(requests.length, 0, "只是启动，不该发出请求");
  console.log("✓ 有 preload 桥时插槽本身就是完整引擎（联云 + 读面板的 Key）");
}

/* ------------------------------ 9. 已有完整引擎不被插槽拆掉 ------------------------------ */
{
  const good = makeEngine();
  let disposed = 0;
  window.snowMimoTts = good;
  window.SnowAppPlugin = {};
  window.__snowMimoTtsDispose = () => {
    disposed += 1;
  };
  delete window.__snowMimoTtsPanelVersion; // 版本读不到 → 走「非复用」分支
  await import("../index.js?boot=bridge2");
  assert.equal(disposed, 0, "插槽入口不得销毁旧引擎");
  assert.equal(window.snowMimoTts, good, "插槽入口不得覆盖已经在跑的引擎");
  console.log("✓ 插槽入口不销毁、不覆盖已有完整引擎");
}

/* ------------------------------ 10. 插槽入口不建立常驻订阅 ------------------------------ */
{
  // 插槽 api 的订阅随挂载失效：拿它建自动播报订阅，会让之后面板复用同一实例时 watcher
  // 已被占住、永远不再订阅（自动播报静默）。这里断言插槽入口启动时不订阅 messages。
  delete window.snowMimoTts;
  delete window.__snowMimoTtsPanel;
  delete window.__snowMimoTtsPanelVersion;
  delete window.__snowMimoTtsDispose;
  let subscribeCalls = 0;
  const footerApi = {
    t: (key, options) => (options && options.defaultValue) || key,
    log() {},
    metadata: {
      subscribe() {
        subscribeCalls += 1;
        return Promise.resolve({ unsubscribe() {} });
      },
      get() {
        return Promise.resolve({ domains: {} });
      },
      domains() {
        return [];
      },
    },
  };
  window.snow = {
    requestPluginHttp() {
      return Promise.resolve({ ok: false, error: "stub" });
    },
    getPluginValues() {
      return Promise.resolve([]);
    },
    setPluginValue() {
      return Promise.resolve(true);
    },
    deletePluginValue() {
      return Promise.resolve(true);
    },
  };
  window.SnowAppPlugin = { api: footerApi };
  await import("../index.js?boot=footerapi");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(subscribeCalls, 0, "插槽入口不应建立随挂载失效的 messages 订阅");
  assert.ok(window.snowMimoTts, "插槽入口仍要建完整引擎");
  console.log("✓ 插槽入口不建立常驻订阅（自动播报仍由面板负责）");
}

/* ------------------------------ 11. 旧错误提示不因别的状态变化再次弹出 ------------------------------ */
{
  const container = makeElement("div");
  const engine = makeEngine();
  engine.play = function () {
    this.played.push("x");
    // 引擎压根没开始（纯代码 / 纯链接）：状态仍是 idle，startedAt 不变
    return Promise.resolve(false);
  };
  window.snowMimoTts = engine;
  const cleanup = mountFooter(container, makeApi(items), { messageId: "m2" }, makeSignal());
  const root = container.children[0];
  const hint = findHint(root);
  findButton(root).listeners.click[0]();
  await flush();
  assert.match(String(hint.textContent), /没有可朗读的文字/, "首次失败应给出提示");
  hint.textContent = ""; // 模拟 4.2s 后提示自动收起
  engine.state = Object.assign({}, engine.state, { status: "playing" }); // 别处开始朗读
  intervalFn();
  assert.equal(String(hint.textContent || ""), "", "几秒前的旧错误不应再次弹出");
  cleanup();
  console.log("✓ 旧错误提示不会因别的状态变化再次弹出");
}

/* ------------------------------ 12. 别处开始的播放不被按钮抢占 ------------------------------ */
{
  const container = makeElement("div");
  const engine = makeEngine();
  window.snowMimoTts = engine;
  const cleanup = mountFooter(container, makeApi(items), { messageId: "m2" }, makeSignal());
  const root = container.children[0];
  const button = findButton(root);
  const stopButton = findStopButton(root);

  button.listeners.click[0]();
  await flush();
  intervalFn();
  assert.equal(root.getAttribute("data-state"), "playing", "自己发起的播放应显示为播放中");

  // 面板 / 自动播报接管：状态同样是 playing，但 startedAt 已换
  engine.state = Object.assign({}, engine.state, { status: "playing", startedAt: 999 });
  intervalFn();
  assert.equal(root.getAttribute("data-state"), "idle", "别处开始的播放不该点亮本按钮");
  assert.equal(stopButton.style.display, "none", "别处开始的播放不该显示停止按钮");

  button.listeners.click[0]();
  await flush();
  assert.deepEqual(engine.calls, [], "点按钮不该暂停别人的朗读");
  assert.equal(engine.played.length, 2, "点按钮应开始自己的朗读");
  cleanup();
  console.log("✓ 别处开始的播放不被按钮抢占");
}

/* ------------------------------ 13. 取正文期间按停止，不再自己响起来 ------------------------------ */
{
  const container = makeElement("div");
  const engine = makeEngine();
  window.snowMimoTts = engine;
  const cleanup = mountFooter(container, makeApi(items), { messageId: "m2" }, makeSignal());
  const root = container.children[0];
  findButton(root).listeners.click[0](); // 进入取正文的 pending 状态
  findStopButton(root).listeners.click[0](); // 立刻停止
  await flush();
  assert.equal(engine.played.length, 0, "取正文期间停止后不应再开播");
  assert.equal(root.getAttribute("data-state"), "idle", "停止后按钮回到空闲");
  cleanup();
  console.log("✓ 取正文期间按停止不会延迟开播");
}

console.log("\nfooter: 全部通过");
process.exit(0);
