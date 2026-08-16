# Feishu Agent Bridge · 飞书 Agent 桥接

> 让 Claude Code / MiMo Code 等本地 CLI Agent 安全、稳定地接入飞书 / Lark。
> Bridge your local CLI coding agents (Claude Code, MiMo Code, …) into Feishu / Lark — reliably.

本仓库是 [lark-channel-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) v0.7.0 的**稳定化改造版（fork）**：
修复了"长回复容易中断"的系列缺陷，并将回复样式对齐"飞书原生思考过程气泡 + 流式输出"，与 DeepSeek Harness 的 dsh-lark 机器人保持一致。
This is a stabilization fork of `lark-channel-bridge` v0.7.0: it fixes the "long replies get killed" family of bugs and switches replies to Feishu's native thinking-process (CoT) bubbles, matching the dsh-lark bot style.

---

## ✨ 特性 / Features

| 中文 | English |
| --- | --- |
| 长连接稳定收发（WebSocket + 自动重连、去重、串行化） | Reliable WebSocket transport with auto-reconnect, dedup and per-chat serialization |
| **长回复不中断**（修复原版 4 个致命缺陷） | **Long replies never get killed** (4 upstream defects fixed) |
| **原生思考过程气泡**（message_cot，可折叠展开、推理流式刷入） | **Native thinking-process bubble** (message_cot, collapsible, reasoning streams in) |
| 工具调用在气泡内显示图标 / 名称 / 参数 / 输出 | Tool calls shown inside the bubble with icon / name / args / output |
| 最终答案作为普通消息单独发出 | Final answer sent as a plain message |
| 每会话独立上下文，重启后 `resume` 续聊 | Per-chat sessions, resume after restart |
| 多工作区 `/cd` `/ws`，模型 `/model` 切换 | Multi-workspace via `/cd` `/ws`, model switching via `/model` |
| 用户 / 群白名单、@ 才响应、管理员分级 | User/group allowlists, @mention-only in groups, admin tiers |
| 一条命令扫码创建飞书应用并后台常驻 | One-command QR onboarding + built-in daemon (systemd / launchd) |

---

## 🆕 相对上游 v0.7.0 的改进 / What this fork fixes

| # | 上游缺陷 Upstream bug | 修复 Fix |
| --- | --- | --- |
| 1 | mimo 最后一条流式事件后 **25 秒**静默即 SIGTERM 杀进程 → 长回复 / 长思考被腰斩。MiMo's 25s silence heuristic killed long replies mid-generation. | 默认放宽到 **180s**，可配 `mimo.idleSeconds`（`0` = 完全禁用）。Default raised to **180s**, configurable via `mimo.idleSeconds` (`0` disables). |
| 2 | 断线 / 重启时 `disconnect()` 直接 `stopAll()` 杀掉所有进行中的 run。Disconnect killed every in-flight run. | 改为 `waitForIdle()` **宽限 90s**（可配 `preferences.disconnectRunGraceMs`），run 自然跑完、结果照常发出后才断。Graceful drain (default 90s, `disconnectRunGraceMs`). |
| 3 | 流式卡片 400ms 高频更新易触发 API 频率限制。400ms stream updates hit rate limits. | 节流放宽到 **600ms**。Throttle relaxed to **600ms**. |
| 4 | 进程占用报错导致非交互启动死循环（曾刷 2400+ 次）。Stale-lock startup loop in non-interactive mode. | holder 进程已死时**自动清理陈旧锁并重试**。Auto-clean stale locks when the holder is dead. |
| 5 | cot（message_cot）模式下仍发"⏳ 正在思考… 请稍候"占位消息，与思考气泡重复噪音。Redundant "thinking…" placeholder above the CoT bubble. | **cot 模式下不再发占位消息**，只保留原生思考气泡。No placeholder in CoT mode — the bubble is the feedback. |
| 6 | mimo 默认不输出推理事件，思考区为空。MiMo emitted no reasoning events. | profile 支持 `mimo.thinking: true` 开启推理流。`mimo.thinking: true` forwards `--thinking`. |

> 变更细节见 [CHANGES.md](./CHANGES.md)。

---

## 🏗️ 架构 / Architecture

```
┌──────────────┐   WebSocket(长连接)   ┌─────────────────────────────┐   spawn + 流式 JSON   ┌───────────────────┐
│ 飞书开放平台   │ ◄────────────────────► │        Bridge（Node）        │ ◄────────────────────► │  Claude Code /     │
│  Feishu/Lark  │  自动重连/去重/串行化    │  @larksuite/channel 传输层     │   stream-json / JSONL │  MiMo Code (CLI)   │
└──────────────┘                        └──────────────┬──────────────┘                       └───────────────────┘
                                                       │ message_cot 事件流（思考区/工具/文字）
                                                       ▼
                                           飞书原生思考过程气泡 + 普通消息答案
```

- **传输层**：`@larksuite/channel`（与 dsh-lark-channel 同源的 WebSocket SDK），轮询零开销、断线自动重连。
- **Agent 层**：`AgentAdapter` 子进程适配器，`claude --include-partial-messages --output-format stream-json` / `mimo run --format json`，把 token 级事件翻译成统一事件流。
- **渲染层**：`message_cot`（AG-UI 事件：`REASONING_*` / `TOOL_CALL_*` / `TEXT_MESSAGE_*`）→ 飞书原生"思考过程"气泡；最终答案走普通文本消息。

---

## 🚀 快速开始 / Quick start

### 前提 / Prerequisites

- Node.js **>= 20.12**（推荐 22+）
- 至少一个已登录的本地 Agent：`claude`（Claude Code）或 `mimo`（MiMo Code）

### 安装 / Install

```bash
# 方式 A：从源码构建安装（推荐，包含全部修复）
git clone https://github.com/luokexiaoguo/feishu-agent-bridge.git
cd feishu-agent-bridge
npm i -g pnpm   # 若未安装 pnpm
pnpm install
pnpm build      # = pnpm build:web && tsup（dist/ 已含构建产物，可跳过）
npm i -g .

# 方式 B：直接使用仓库内已构建产物
npm i -g /path/to/feishu-agent-bridge
```

### 首次运行 / First run

```bash
lark-channel-bridge run
```

终端出现二维码 → 飞书扫码 → 选择或创建 **PersonalAgent 应用** → 选择要初始化的 agent → 自动写入配置（`~/.lark-channel/config.json`）。
A QR code appears → scan with Feishu → pick or create a **PersonalAgent app** → choose the agent → config is written to `~/.lark-channel/config.json`.

已有应用可跳过创建：`lark-channel-bridge run --app-id cli_xxx`

### 后台常驻 / Background service

```bash
lark-channel-bridge start            # systemd / launchd，关机自启
lark-channel-bridge status
lark-channel-bridge logs -f
lark-channel-bridge restart
lark-channel-bridge stop
```

多 profile（一个应用一个 agent，各自独立）：

```bash
lark-channel-bridge start --profile claude --agent claude
lark-channel-bridge start --profile mimo --agent mimo
```

---

## ⚙️ 配置 / Configuration（`~/.lark-channel/config.json`）

```jsonc
{
  "profiles": {
    "claude": {
      "agentKind": "claude",
      "accounts": { "app": { "id": "cli_xxx", "secret": { "source": "exec", "provider": "bridge", "id": "app-cli_xxx" } } },
      "preferences": {
        "cotMessages": "on",          // on=detailed / simple=brief / off
        "messageReply": "markdown",
        "runIdleTimeoutMinutes": 0,   // claude run 级空闲超时（0=禁用）
        "disconnectRunGraceMs": 90000 // 断线时等待进行中 run 的宽限（0=立即杀，旧行为）
      },
      "access": { "allowedUsers": [], "allowedChats": [], "requireMentionInGroup": true }
    },
    "mimo": {
      "agentKind": "mimo",
      "mimo": {
        "binaryPath": "/path/to/mimo",
        "thinking": true,             // 让推理进入思考区
        "idleSeconds": 180            // mimo 静默收尾阈值（0=禁用）
      },
      "preferences": { "cotMessages": "on" }
    }
  }
}
```

**新增 / 关键配置项：**

| 字段 | 说明 | English |
| --- | --- | --- |
| `preferences.cotMessages` | 思考过程气泡模式：`on`（含工具参数/输出）、`simple`（仅工具标题）、`off`（关闭，退回卡片） | CoT bubble verbosity: `on` / `simple` / `off` |
| `mimo.idleSeconds` | mimo 最后事件后静默多少秒判定"完成"并收尾进程。**默认 180**；`0` = 禁用（等待自然退出） | MiMo silence threshold; default **180**; `0` disables |
| `preferences.disconnectRunGraceMs` | 断线/重启时等进行中 run 结束的宽限毫秒。默认 **90000**；`0` = 立即杀（旧行为） | Grace ms for in-flight runs on disconnect; default **90000** |
| `mimo.thinking` | 转发 `--thinking`，让推理进入思考区 | Forward `--thinking` so reasoning appears |
| `preferences.runIdleTimeoutMinutes` | claude 全局空闲超时（分钟），0 = 不超时 | Claude global idle timeout, 0 = none |

> 真实凭据（App Secret）只存于 `~/.lark-channel/config.json`（或 secret provider），**不入仓库、不入代码**。
> Secrets live only in local config / secret providers — never in this repo.

---

## 💬 回复样式 / Reply modes

- **cot（推荐，默认）**：`message_cot` 原生思考气泡——先出现"思考过程"（可折叠展开），推理与工具调用流式刷入，完成后最终答案以普通消息发出。与 dsh-lark 机器人行为一致，且**没有**多余的"正在思考"占位消息。
- 非 cot：markdown 打字机卡片（原版样式）或纯文本。

---

## 🎛️ 命令 / Commands

| 命令 | 用途 |
| --- | --- |
| `/help` `/status` | 帮助 / 状态（含上下文、token 统计） |
| `/new` | 原地开新会话（清上下文） |
| `/stop` | 停止当前任务 |
| `/cd <path>` `/ws` | 切换 / 管理工作区 |
| `/model` | 模型选择卡片 |
| `/config` | 实时调整偏好（cot 模式、工具显示等） |
| `/reconnect` `/exit` | 重连 / 退出（`/reconnect --wait` 等当前 run 结束再重连） |
| `/doctor` | 自检（连接、agent、会话健康） |

---

## 🧪 验证与常见问题 / Verification & FAQ

**长回复验证：** 发一个要求长输出的任务（如"写 3000 字长文"），确认：中途停顿 >30s 不中断、思考气泡完整、最终答案正常送达。

| 现象 | 排查 |
| --- | --- |
| 没有思考气泡（退回旧样式） | 日志查 `cot create-failed` → 应用缺 `message_cot` 接口权限，到开放平台补授权 |
| 进程反复重启 / 报"进程占用" | fork 已自动清理陈旧锁；仍出现则 `lark-channel-bridge ps` + `kill <id>` |
| 长回复仍中断 | 查 `run-grace-expired` / `idle-finish` 日志；调大 `disconnectRunGraceMs` / `mimo.idleSeconds` |
| agent 无输出 | 确认 CLI 已登录；`/doctor` 自检 |

**回滚到上游 v0.7.0：** 上游 npm 包 `lark-channel-bridge@0.7.0` 原样安装即可（不包含本 fork 修复）。

---

## 📄 许可证 / License

[BSD-3-Clause](./LICENSE)。本仓库为 [lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)（原作者 zarazhangrui）的派生改造，保留上游许可证。
BSD-3-Clause. Derived from [lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) by zarazhangrui; upstream license retained.

## 🔗 关联 / Related

- 上游原版：[zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)
- 传输 SDK：[`@larksuite/channel`](https://www.npmjs.com/package/@larksuite/channel)