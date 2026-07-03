# Claude State Bar

> ℹ️ **本仓库基于 [cometso/claudeStateBar](https://github.com/comonetso/claudeStateBar) 汉化定制版，仅供个人使用。**
>
> 在原版基础上新增了**简体中文**界面翻译（设置面板、状态栏、工作流面板、QuickPick 菜单、提示音面板、所有 toast/模态确认框均已完整汉化），其余功能与原版一致。感谢原作者 [Blueming](https://github.com/comonetso/claudeStateBar) 与核心上下文监控作者 [Ed Zisk (@ezoosk)](https://github.com/ezoosk)。

🇬🇧 English: [README.en.md](README.en.md) · 🇰🇷 한국어: [README.ko.md](README.ko.md)

---

**在 VS Code 状态栏中一站式查看 Claude Code 上下文用量 + Claude.ai 套餐用量（5 小时会话 & 周用量）—— 附带实时工作流/代理查看面板、提示音提醒、Remote‑SSH 支持、Telegram 重置提醒，以及支持简体中文/英文/韩文的设置面板。**

---

## 一条状态栏，两层信息

Claude State Bar 在同一个悬浮 tooltip 中合并展示两类互补信息，并清晰分区：

### 🧠 claudeContext — Claude Code 上下文监控
读取 Claude Code 的本地会话日志（`~/.claude/projects/*.jsonl`），为每个活跃会话显示：
- **实时上下文使用率 %**（已用 token / 模型上限）
- **逐会话监控** — 每个 Claude Code 会话拥有独立的状态栏条目
- **按模型识别上限** — Opus 4.x / ID 含 `1m` 的模型 → 1,000,000 token；其他 → 200,000（可配置）
- **模型 + effort + 速度** — 如 `Opus 4.7 · xHigh⁺ · ⚡fast`（见 [Effort 等级显示](#️-effort-等级显示)）
- **颜色分级告警** — 正常 / 警告（≥50%）/ 危险（≥75%）背景色
- **两级空闲处理** — 会话在 `idleTimeout`（默认 180 秒）后变暗，`hideAfter` 后完全隐藏
- **幽灵会话检测** — `/clear` 或标签关闭后隐藏陈旧会话；有新活动时自动恢复
- **紧凑模式 & 自定义简称** — `my-cool-project → MCP`、`typescript → Tscript`
- **实时活动指示** — Claude 思考（🤔）或回复时显示已用秒数

### 📊 claudeState — Claude.ai 套餐用量
直接从 claude.ai 拉取你的**账户级套餐用量**（无需 SDK、无需额外服务）：
- **5 小时会话额度 %** 及重置倒计时（合并进首个会话条目）
- **周用量 %**，tooltip 中附带 **Sonnet / Opus** 分模型明细
- **会话重置检测** → 5 小时窗口重置时可选触发 **Telegram** 通知
- 凭据（Session Key、Bot Token）通过 VS Code SecretStorage **加密存储**

---

## 🌐 Remote‑SSH 支持

通过 **Remote‑SSH** 工作？Claude State Bar 作为 **UI（本地）扩展** 运行，可同时完成两件事：

- **套餐用量**从你的**本地机器**经 Electron 网络栈拉取 —— 能通过 Cloudflare 的机器人挑战。（从远程/无头主机用原生 Node `https` 会收到 Cloudflare `403`；AWS EC2 等云/数据中心 IP 无论 TLS 指纹如何均被拦截。）
- **Token 计数**通过 `vscode.workspace.fs` 从**远程**主机的 `~/.claude/projects` 读取 —— VS Code 会透明地经 SSH 连接路由。远程 home 目录自动检测（`/root`，否则 `/home/*`）。

**本地安装一次 —— 所有 Remote‑SSH 窗口自动生效。** 由于这是 `ui` 类型扩展，你无需在每台服务器上重复安装。

在 Remote‑SSH 窗口中，你能**同时看到远程会话的 token 用量和你的套餐用量**。若某主机确实无法访问 claude.ai，状态栏会如实显示"此环境无法查看套餐用量"，而非误导性的"已过期"错误。

---

## 🎬 工作流 & Task 代理查看面板

从会话 QuickPick 菜单打开 **Workflow Viewer**，即可在一个实时 WebView 面板中查看每个活跃的 Claude Code 工作流及 Task（Agent 工具）子代理：

- **工作流进度** — 每个工作流显示为卡片，含阶段、运行中/已完成代理、各代理摘要、耗时与实时活动
- **完整结果展开** — 长篇最终报告折叠进 `▶ summary` 开关，便于完整阅读且不杂乱
- **角色标签** — 自动从 prompt 头部提取每个代理的角色，你会看到 "Lens A: Bug Detection" 而非 "agent-1"
- **Task（Agent 工具）子代理** — 通过 Claude Code Agent 工具派生的子代理单独展示，按**起始时间分批**（间隔 5 分钟 = 新一批）
- **按批 🗑 清理** — 删除某批已完成的 task 代理日志，同时不影响仍在运行的代理
- **展开态持久化** — 展开的 `<details>` 面板在实时刷新中保持展开
- **字号控制** — `A−` / `A+` 按钮调节面板字号
- **多语言界面** — 完整 简体中文 / English / 한국어 切换，与设置面板一致

---

## 🎚️ Effort 等级显示

状态栏与 tooltip 会显示 Claude Code 当前的 effort 等级：

| `effortLevel` 值 | 状态栏 | 含义 |
|---|---|---|
| `xhigh` | `xHigh⁺` | xhigh 已持久化到磁盘。若曾启用 ultracode（`/ultracode`），其 dynamic‑workflows 组件仅运行时存在、与普通 xhigh 不可区分 —— `⁺` 标记此近似值。 |
| `ultracode` / `ultra` | `🚀 Ultra` | 在运行时检测到会话级 ultracode 标志时显示。 |
| `high` / `medium` / `low` / `max` | 原样显示 | 标准 effort 等级 |

附加速度指示：
- **⚡** — `/fast` 模式已启用
- **💭** — 最近一次回复包含 `thinking` 块（扩展思考）

---

## 🔔 提示音提醒

Claude State Bar 为关键事件播放可配置的 WAV 提示音：

| 事件 | 默认提示音 | 设置项 |
|---|---|---|
| 上下文达到警告阈值 | `Ring01.wav` | `soundWarning` / `soundWarningGain` |
| 上下文达到危险阈值 | `Ring02.wav` | `soundDanger` / `soundDangerGain` |
| Claude 完成回复（`end_turn`） | `tada.wav` | `soundCompletion` / `soundCompletionGain` |
| Claude 暂停提问 | `Speech On.wav` | `soundQuestion` / `soundQuestionGain` |
| 所有工作流 / task 代理子代理完成 | `Ring06.wav` | `soundWorkflow` / `soundWorkflowGain` / `workflowCompleteBeep` |

所有提示音路径均可替换为你自己的 WAV 文件。增益可调 50%–5000%（超过约 300% 可能失真）。使用命令面板中的 **`Claude State Bar: Test Beep Sound`** 预览。

**工作流完成提示音门控** —— 仅当扩展在当前会话中观察到工作流从 running → done 时才触发提示音。VS Code 启动时已完成的陈旧工作流会被静默基线化。

---

## 🖱️ 合并 tooltip

悬停任意会话条目，将显示一个分为两段、带颜色分隔、清晰标注的 tooltip：

```
my-project (a1b2c3d4)
──────── claudeState ────────
📊 会话: 30% — 5:40 PM (3小时27分后)
📅 周用量: 20% — 3:00 PM (周六)
Sonnet: 4%  Opus: —%
──────── claudeContext ────────
🤖 模型: claude-opus-4-7
🎚️ Effort: xHigh⁺
📊 上下文用量: 4%
| 缓存读取 | 8K |  | 缓存创建 | 28K |  | 合计 | 37K / 1.0M |
🕐 最后更新: 2:10:58 PM
点击打开菜单 (隐藏 / 恢复 / 设置)
```

---

## ⚙️ 设置面板（webview，中文/英文/韩文）

从命令面板打开 **`Claude State Bar: Open Settings Panel`**，即可在一个面板中完成所有配置，支持运行时 **简体中文 / English / 한국어** 切换。它收集 Org ID、Session Key、刷新间隔、Telegram Bot Token（自动检测 Chat ID）、提示音设置（含预览）以及上下文监控选项。敏感值存入加密的 SecretStorage；其余与 VS Code 设置同步。

### 如何获取凭据
- **Org ID** — claude.ai → 开发者工具 → Network → 任意 `/api/organizations/{UUID}/…` 请求
- **Session Key** — claude.ai → 开发者工具 → Application → Cookies → `sessionKey`

---

## 🔔 Telegram 会话重置提醒（可选）

在设置中填入 Telegram Bot Token，给你的机器人发送任意消息，点击 **"绑定我的 Telegram"**（自动检测 Chat ID），此后每次 Claude 5 小时会话窗口重置时你都会收到通知。

---

## 🧹 僵尸状态栏项清理

当 VS Code 在窗口打开期间更新扩展时，旧实例的状态栏条目可能残留为无响应的"僵尸"像素。Claude State Bar 通过两种方式处理：

1. **版本变更检测** — 激活时若版本与上次不同，会弹出一次性"重载窗口以清除陈旧项？"提示。
2. **QuickPick 清理** — 会话菜单始终包含 **🗑 清理过期/僵尸项（重载窗口）** 选项。

---

## 配置

所有配置键前缀为 `claudeContextBar.*` 或 `claudeState.*`。

### 核心显示

| 设置项 | 默认值 | 说明 |
|---------|---------|-------------|
| `claudeContextBar.autoColor` | `true` | 为每个项目分配独特柔和色 |
| `claudeContextBar.baseColor` | `White` | 关闭自动配色时的基础色 |
| `claudeContextBar.contextLimitDefault` | `200000` | 标准模型上下文上限 |
| `claudeContextBar.contextLimitOpus` | `1000000` | 1M 上下文模型上限（Opus 4.x） |
| `claudeContextBar.warningThreshold` | `50` | 触发黄色警告背景的百分比 |
| `claudeContextBar.dangerThreshold` | `75` | 触发红色危险背景的百分比 |
| `claudeContextBar.refreshInterval` | `30` | 刷新间隔（秒） |
| `claudeContextBar.idleTimeout` | `180` | 会话**变暗**前的秒数 |
| `claudeContextBar.hideAfter` | `86400` | 会话**隐藏**前的秒数（≥ idleTimeout） |
| `claudeContextBar.scope` | `workspace` | `workspace`（仅当前文件夹）或 `all` |
| `claudeContextBar.showModel` | `true` | 在百分比旁显示模型名 |
| `claudeContextBar.compactMode` | `false` | 缩短项目名 |
| `claudeContextBar.shortNames` | `{}` | 自定义简称，如 `{"my-project":"MP"}` |
| `claudeContextBar.autoCleanupOldVersions` | `true` | 激活时自动删除旧安装版本 |

### 提示音

| 设置项 | 默认值 | 说明 |
|---------|---------|-------------|
| `claudeContextBar.soundWarning` | `""` | 警告阈值提示音 WAV 路径（空 = 内置） |
| `claudeContextBar.soundWarningGain` | `100` | 警告音增益 %（50–5000） |
| `claudeContextBar.soundDanger` | `""` | 危险阈值提示音路径 |
| `claudeContextBar.soundDangerGain` | `100` | 危险音增益 % |
| `claudeContextBar.soundCompletion` | `""` | 回复完成（`end_turn`）提示音路径 |
| `claudeContextBar.soundCompletionGain` | `100` | 完成音增益 % |
| `claudeContextBar.completionBeepSettleMs` | `3000` | 触发完成音前的 settle 窗口（毫秒） |
| `claudeContextBar.soundQuestion` | `""` | 提问暂停提示音路径 |
| `claudeContextBar.soundQuestionGain` | `100` | 提问音增益 % |
| `claudeContextBar.soundWorkflow` | `""` | 工作流/全部代理完成提示音路径 |
| `claudeContextBar.soundWorkflowGain` | `100` | 工作流完成音增益 % |
| `claudeContextBar.workflowCompleteBeep` | `true` | 全部工作流/task 代理完成时触发提示音 |
| `claudeContextBar.detectStuckToolUse` | `false` | 启发式：tool_use 在 `stuckToolUseThresholdSec` 内无后续则提示 |
| `claudeContextBar.stuckToolUseThresholdSec` | `90` | 触发卡住启发式的 tool_use 静默秒数 |

### 套餐用量

| 设置项 | 默认值 | 说明 |
|---------|---------|-------------|
| `claudeState.orgId` | `""` | claude.ai 组织 ID |
| `claudeState.language` | `en` | 设置面板语言（`en` / `ko` / `zh`） |
| `claudeState.refreshIntervalSec` | `300` | 套餐用量轮询间隔（秒） |

（Session Key、Bot Token 和 Chat ID 存于 SecretStorage，而非 settings.json。）

---

## 环境要求

- VS Code 1.74.0+
- [Claude Code](https://www.anthropic.com/claude-code) 正在运行并将会话日志写入 `~/.claude/projects/`
- 使用套餐用量功能需 claude.ai 账户（Org ID + Session Key）

## 工作原理

除可选的 claude.ai 套餐用量拉取与 Telegram 外，无其他网络调用。上下文监控纯靠 `vscode.workspace.fs` 磁盘读取 Claude Code 的 JSONL 日志（本地或远程）。套餐用量通过 Electron 的 Chromium 网络栈调用 claude.ai usage 端点（以通过 Cloudflare），并提供原生 `https` 回退。工作流查看器直接从磁盘读取 `~/.claude/projects/<slug>/<uuid>/subagents/`。

---

## 致谢与声明

本仓库为 **[cometso/claudeStateBar](https://github.com/cometso/claudeStateBar) 的汉化定制版，仅个人使用**。

- 原扩展作者：[Blueming](https://github.com/comonetso/claudeStateBar) —— 在原核心基础上增加了 Claude.ai 套餐用量、Remote‑SSH 支持、Telegram 通知、webview 设置面板、工作流/代理查看器、提示音提醒等。
- 原始上下文监控核心作者：[Ed Zisk (@ezoosk)](https://github.com/ezoosk)。

本定制版仅在上游基础上新增简体中文界面翻译，未改动原有功能逻辑。

## 许可证

MIT © 2026 Blueming. 原核心 © 2025 Ed Zisk.
