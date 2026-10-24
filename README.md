# 语音朗读（MiMo TTS）· Snow App 插件

把 Xiaomi MiMo TTS 接进 Snow App：**每条助手回复的操作行末尾都有一个朗读图标**（和「分支」「复制」同一排）、实时自动播报，预置 / 设计 / 复刻三种音色，分句流水线播放，本地语音兜底，音频历史可回放可下载。

复刻自 [dsh-plugin-xiaomi-mimo-tts](https://github.com/ppy-web/dsh-plugin-xiaomi-mimo-tts) 的使用方式，按 Snow App 的面板插件规范重写（无构建步骤、单文件 ESM + 宿主主题变量）。

## 安装

1. 打开 Snow App 侧边栏底部的 **插件** 页面，切到 **插件市场**。
2. 搜索「语音朗读」或 `com.snowai.mimo-tts`，点 **安装**。
3. 装好后从顶栏 **加号菜单 → 插件 → 语音朗读**，或右侧面板的插件入口打开。

市场安装会按索引里的 SHA-256 校验 Release 资产；插件本体由本仓库的 Release 分发，安装后默认启用。

## 开发

改完代码请把 `plugin.json` 的 `version` 加一：宿主每次打开面板都会重新 import 一份模块，插件为了让「关掉面板后播放继续、重开还能接管」成立，会在版本号相同的重开里复用上一个模块实例；只有版本号变了才销毁旧实例、加载新代码。发版时同步更新 `package.json` 与 `index.js` 的 `FALLBACK_VERSION`，再按新版本打包 zip、发 Release、更新市场索引条目。

本地测试：`npm test` 跑全部离线套件；需要真实接口的端到端测试见文末。

## 首次使用

1. 打开面板 → **设置** → 填 MiMo API Key（存插件私有存储，只发往 `api.xiaomimimo.com`）。
2. 回到 **调音台** 选模型与音色。
3. **播报台** 里点「朗读」试听，或直接点回复操作行末尾（分支 / 复制那一排）的朗读图标。
4. 需要自动播报时，打开头部右侧的「自动播报」开关。

## 功能对照

| 能力 | 说明 |
| --- | --- |
| 回复操作行朗读图标 | `contributions.messageFooters` 挂在已结束的助手回复下方；挂载后把图标并进宿主的 `.ai-message-footer`（时间 / 分支 / 复制那一排）末尾：26×26、无边框、hover 浅底，与原生按钮同尺寸同色。点一下读这条回复，播放中变暂停、可停止 |
| 三种模型 | `mimo-v2.5-tts` 预置 9 音色 / `-voicedesign` 自然语言描述音色 / `-voiceclone` 上传 mp3·wav 复刻 |
| 分句流水线 | 长文按句切段（≤200 字/段），播第一段时后台合成下一段，首音延迟低且不会顶到 5 MB 响应上限；云端中途失败改用本地语音时从断点续读，不重复已播内容 |
| 语气指令 | 16 个标签（情绪 / 方言 / 人设）一键拼装，也可自由编辑；走 `user` 消息，不会被朗读 |
| 朗读范围 | 智能（自动播报只读开头两段，手动读全文）/ 全文 / 首段 |
| 自动播报 | 监听 `messages` 实时域，助手回复结束后自动朗读；只播新事件，切会话重新取基线，不补播旧记录；正在朗读其他内容时不抢断 |
| 播放控制 | 0.5×–2.0× 语速、音量、暂停/继续、停止、进度条点击跳转（当前段） |
| 本地语音兜底 | 云端优先 / 本地优先 / 关闭；云端失败自动改用系统语音并提示原因 |
| 音频历史 | IndexedDB 保存完整 WAV（多段自动拼接，格式不一致时保留首段并标注），上限 100 条 / 100 MB，可试听、下载、删除 |
| 操作音效 | WebAudio 合成的提示音，默认关闭 |
| 文本过滤 | 自动剔除代码块、行内代码、URL（含 `<自动链接>`）、markdown 链接/图片（URL 里带括号也能正确配对）、HTML 标签与实体、`@@file:…@@` 等 chip、嵌套引用、setext 标题下划线、任务列表标记与反斜杠转义 |

## 面板结构

- **调音台**：模型分段控件 → 音色网格 / 音色描述 / 样本上传 → 语气标签 → 语速音量滑杆。
- **播报台**：试听文本框（含字数）、当前会话最近 8 条助手回复的逐条朗读。
- **音频历史**：按时间倒序，显示音色 / 字数 / 体积，行内试听、下载、删除。
- **设置**：API Key、接口地址（可填兼容中转）、朗读范围、本地语音策略、音效、数据清理。
- **播放 Dock**：有播放任务时吸底显示，含状态、分段进度、时间、文本预览、暂停/停止、语速快选。

## 对外接口

```js
window.snowMimoTts.play("欢迎回来");        // 朗读一段文本（会中断当前朗读）
window.snowMimoTts.pause();
window.snowMimoTts.resume();
window.snowMimoTts.stop();
window.snowMimoTts.getState();               // { status, text, segmentIndex, ... }
window.snowMimoTts.getSettings();            // 当前设置副本（不含 API Key，只给 hasApiKey）
window.snowMimoTts.subscribe(fn);            // 订阅引擎状态，返回退订函数
window.snowMimoTts.hasCloud();               // 当前实例能不能联云（宿主 api 或 preload 桥，任一即可）
```

模块在**第一次加载时就成立**（不必先开面板）：插槽入口拿不到 `net` / `storage`，但会用宿主 preload 的 `window.snow.requestPluginHttp` / `getPluginValues` 拼出等价的 `net` / `storage`，所以引擎从第一条回复起就是完整版。之后打开面板会复用同一个实例，不会出现第二个播放引擎。实例一直活到应用重启或插件版本变化。

## 隐私

`plugin.json` 声明了两个域：

- `messages`：读当前会话的助手回复正文（用于朗读）。未声明时播报台显示拒绝提示，而不是静默失败。
- `network`：请求 MiMo 接口（面板走 `api.net.fetch`，插槽走等价的 `window.snow.requestPluginHttp`，两者都是宿主主进程转发）。密钥不写入日志、不外发第三方。

音频与复刻样本只存在本机 IndexedDB / 插件存储。

## 已知边界

- **图标并入哪一行是靠 DOM 位置判断的**：宿主把插槽容器放在 `.ai-message-footer`（时间 / 分支 / 复制那一排）的前一个兄弟位，插件从「容器父节点」的 `nextElementSibling` 找到那一行，把图标 append 进去当最后一个子节点；每 600 ms 校正一次，React 重建该行时会自动挂回去。那一行不存在时（例如宿主没给 `onFork`）退回插槽容器里独立一排，功能不变。宿主没有为「并入操作行」提供正式插槽，所以这是位置推断：宿主大改聊天 DOM 时只需调 `footerRow()`。
- **插槽照样能联云**：宿主的插槽 api 是读取子集（没有 `net` / `storage`），但模块跑在主渲染进程里，preload 已经把这些能力挂在 `window.snow` 上（`api.net.fetch` 本身就是 `requestPluginHttp` 的一层薄封装，私有存储就是 `getPluginValues` / `setPluginValue`）。插件启动时用这层桥拼出完整引擎，并把面板实例一并登记，之后打开面板复用同一份，不会多出第二个 AudioContext、也不会把正在播的声音变成孤儿。前提是宿主版本带 `window.snow.requestPluginHttp`；更老的宿主才会退回本地语音。
- **只有最新一条回复有图标**：插槽 v1 默认只挂在当前会话最新一条已结束的助手回复上，新的用户消息进来时它会隐藏（历史回复请用面板的「播报台」）。宿主若支持贡献项的 `taskHistory: true`，可把 `plugin.json` 里那条贡献加上该字段来挂满每条回复，但该能力尚未确认正式发行版本，默认不开。
- **播放走 WebAudio，不是 `<audio>` 元素**：宿主主窗口的 CSP 是 `default-src 'self'` 且没有声明 `media-src`，`blob:` 不在白名单里，`<audio src="blob:...">` 会被浏览器拒绝加载（控制台报 `Refused to load media from 'blob:...' ... "default-src 'self'"`，元素上表现为 `MediaError 4`，也就是旧版误报的「音频解码失败」）。现在音频字节经 `AudioContext.decodeAudioData` 解码后直接播放，不受这条策略影响；只有环境完全没有 WebAudio 时才退回元素路径。
- **自动播报要先点过面板**：Chromium 的自动播放策略要求一次用户手势才允许出声。没有手势时 WebAudio 会停在 `suspended`，插件会明确报「系统还没有允许出声」，而不是静默播完。
- **单次朗读上限 6000 字**：再长的内容会被截断（手动朗读时提示）。TTS 音频约 8 KB/字，6000 字≈48 MB，继续加长会让分段合成、拼接和本地存储的内存峰值失控。
- **试听与朗读互斥**：两条音频共用一份输出，开始朗读会停掉历史试听，反之亦然。
- **不是 SSE 流式**：`api.net.fetch` 会缓冲整个响应，拿不到逐块音频，所以用「分句流水线」近似实时出声；首段仍需等一次完整往返（通常 1–3 秒）。
- **语速会轻微变调**：用 `playbackRate` 实现，无法做音高补偿。
- **自动播报仍由面板那一份负责**：插槽入口拿到的 `api.metadata` 是「受生命周期约束的读取子集」，订阅随插槽卸载被宿主取消，metadata 还会默认注入该挂载的会话 id，只适合读当前这条回复。因此插槽那份模块启动时**不**建立 `messages` 常驻订阅（否则会占住 `watcher`，导致之后面板复用同一实例时自动播报永久静默），监听器仍由面板挂载时的 `startWatcher()` 用面板 api 建立。
- **本地语音依赖系统 TTS**：`speechSynthesis` 若无可用音色会直接报错，并回退到云端（按策略）。
- **复刻样本存 base64**：单文件上限 7 MB，最多保留 10 个；每次朗读只解析一次，分段共用。

## 自测

```
npm test               # 依次跑下面十三个离线测试
node test/run.mjs      # 纯函数：清洗 / 分句 / 请求体 / WAV 工具 / base64
node test/player.mjs   # 播放层：仿真 AudioContext 验暂停、续播、跳转、倍速、结束、取消、段间合成空档里的暂停
node test/regress.mjs  # 回归：分句不丢标点、历史删除/裁剪、预取失败报错、设置竞态、emoji 边界
node test/round2.mjs   # 回归：英文句间空格、比较符号、缺 Key 提示去重、样本摘要、拼接时长、本地兜底
node test/round3.mjs   # 回归：设置读盘竞态不冲掉已保存的 Key、插槽按钮取消/空正文的提示、操作行图标不反复重排
node test/round4.mjs   # 回归：裸链接不吞正文、C#/F# 不被清洗、未闭合代码块、首段纯标点、emoji 分段上限、字数统计、试听结束复位
node test/round5.mjs   # 回归：分隔线 / 引用式链接定义 / 汉字下划线斜体清洗，以及中英文语言包完整性
node test/round6.mjs   # 回归：带括号的链接与图片、嵌套引用、setext 标题、任务列表、HTML 实体、坏设置 / 坏记录容错
node test/fuzz.mjs     # 随机化性质测试：4000 组输入验分段不丢字、不超限、不产生半个 emoji
node test/errors.mjs   # 错误路径：401 / 500 / 空响应 / 非 JSON / 缺音频 / 网络错误 / 超限，以及错误后恢复
node test/smoke.mjs    # 冒烟：极简 React 运行时把面板各页渲染一遍（无需真实宿主）
node test/pipeline.mjs # 链路：本地 HTTP 模拟接口，跑合成 → 播放 → 拼接 → 落库 → 兜底 → 停止
node test/footer.mjs   # 操作行朗读图标：假 DOM 验并进 .ai-message-footer 末尾、取正文、状态跟随、卸载清理、preload 桥建完整引擎
node test/autoread-e2e.mjs  # 自动播报（需 $env:MIMO_KEY）：流式中不播、结束后只播一次、切会话不补播
node test/speak-e2e.mjs  # 完整链路（需 $env:MIMO_KEY）：合成 → 播放 → 拼接 → 落库
node test/api-e2e.mjs  # 真实接口（需 $env:MIMO_KEY），验证三种模型返回合法 WAV
```

覆盖文本清洗（含分隔线 / 引用式链接 / 汉字下划线斜体）、分句不丢字（含英文句间空格）、三种模型的请求体、朗读范围裁剪、WAV 解析/拼接/时长、接口地址归一化、base64 往返、播放状态机、面板渲染与实例复用、中英文语言包完整性、合成链路与本地兜底。
