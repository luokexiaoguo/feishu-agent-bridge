# Feishu Agent Bridge · 飞书 Agent 桥接

<p align="center">
  <a href="#cn"><kbd>🇨🇳 中文版</kbd></a> &nbsp;·&nbsp; <a href="#en"><kbd>🇬🇧 English</kbd></a>
</p>

---

<a id="cn"></a>

# 🇨🇳 中文版

将本地的 Claude Code / MiMo Code 等命令行 Agent 安全、稳定地接入飞书 / Lark。

本仓库是 [`lark-channel-bridge` v0.7.0](https://github.com/zarazhangrui/lark-coding-agent-bridge) 的**稳定化改造版**：
修复了"长回复容易中断"的系列缺陷，并把回复样式切换为飞书**原生思考过程气泡（message_cot）**，与 dsh-lark 机器人的表现一致。

## 特性

| | |
| --- | --- |
| **长连接可靠收发** | WebSocket 长连接，自动重连、去重、逐会话串行化 |
| **长回复不中断** | 修复上游 4 个致命缺陷（见下文） |
| **原生思考过程气泡** | message_cot：可折叠展开，推理内容流式刷入 |
| **工具调用进气泡** | 显示图标 / 名称 / 参数 / 输出 |
| **最终答案单独发出** | 回合结束时以普通消息发送 |
| **每会话独立上下文** | 重启后自动恢复，可继续对话 |
| **多工作区与模型** | `/cd` `/ws` 切换工作区，`/model` 切换模型 |
| **访问控制** | 用户 / 群白名单、群聊 @ 才响应、管理员分级 |
| **多人协作** | `/invite user` `/remove user` `/invite group` `/remove group` `/invite all group` 管理成员与访问 |
| **跨平台常驻** | Windows（`.cmd` 启动器）、macOS（launchd）、Linux（systemd） |
| **Profile 管理** | `profile export` / `profile remove`（`--purge --yes` / `--include-secrets --yes`） |
| **一条命令上手** | 扫码创建 / 绑定 PersonalAgent 应用，自动注册后台服务 |

## 相对上游 v0.7.0 的修复

| # | 上游缺陷 | 修复 |
| --- | --- | --- |
| 1 | mimo 最后一条流式事件后 **25 秒**静默即 SIGTERM 杀进程，长回复 / 长思考被腰斩 | 默认放宽到 **180 秒**，可用 `mimo.idleSeconds` 配置（`0` = 完全禁用） |
| 2 | `disconnect()` 直接 `stopAll()`，任何断线 / 重启都会杀掉所有进行中的 run | 改为优雅排空：`waitForIdle()` 等待（默认 **90 秒**，`disconnectRunGraceMs`），最终回复照常发出后再断开 |
| 3 | 流式卡片 400ms 高频更新触发 API 频率限制 | 节流放宽到 **600ms** |
| 4 | 非交互模式下陈旧运行时锁导致启动死循环（反复报"进程占用"） | holder 进程已死时自动清理陈旧锁并重试 |
| 5 | cot 模式下仍发"正在思考…"占位消息，与思考气泡重复 | cot 模式下不再发占位消息，气泡本身就是反馈 |
| 6 | mimo 默认不输出推理事件 | 配置 `mimo.thinking: true` 转发 `--thinking`，让推理进入思考区 |

变更细节见 [CHANGES.md](./CHANGES.md)。

## 架构

```
┌──────────────┐   WebSocket（长连接）   ┌──────────────────────────────┐   spawn + 流式 JSON   ┌───────────────────┐
│ 飞书开放平台   │ ◄────────────────────► │          Bridge（Node）        │ ◄────────────────────► │  Claude Code /     │
│              │   自动重连 / 去重 / 串行化 │  @larksuite/channel 传输层      │   stream-json / JSONL │  MiMo Code (CLI)   │
└──────────────┘                        └───────────────┬──────────────┘                        └───────────────────┘
                                                        │ message_cot 事件流（推理 / 工具 / 文字）
                                                        ▼
                                             原生思考过程气泡 + 普通消息答案
```

- **传输层**：`@larksuite/channel`（与 dsh-lark 同源的 WebSocket SDK），零轮询、自动重连。
- **Agent 层**：`AgentAdapter` 子进程适配器（`claude --include-partial-messages --output-format stream-json` / `mimo run --format json`），把 token 级事件翻译成统一事件流。
- **渲染层**：`message_cot`（AG-UI 事件：`REASONING_*` / `TOOL_CALL_*` / `TEXT_MESSAGE_*`）→ 飞书原生"思考过程"气泡；最终答案以普通文本消息发出。

## 快速开始

### 前提

- Node.js **>= 20.12**（推荐 22+）
- 至少一个已登录的本地 Agent：`claude`（Claude Code）或 `mimo`（MiMo Code）

### 安装

```bash
# 从源码构建安装（包含全部修复）
git clone https://github.com/luokexiaoguo/feishu-agent-bridge.git
cd feishu-agent-bridge
npm i -g pnpm            # 若未安装 pnpm
pnpm install
pnpm build               # = pnpm build:web && tsup（dist/ 已提交，可跳过）
npm i -g .

# 或直接使用仓库内已构建产物
npm i -g /path/to/feishu-agent-bridge
```

### 首次运行

```bash
lark-channel-bridge run
```

终端出现二维码 → 飞书扫码 → 选择或创建 **PersonalAgent 应用** → 选择要初始化的 agent → 配置写入 `~/.lark-channel/config.json`。已有应用可跳过创建：`lark-channel-bridge run --app-id cli_xxx`。

### 后台常驻

每个 profile 对应一个独立的 per-profile service（Linux 为 systemd 单元，macOS 为 launchd，Windows 为 `.cmd` 包装）：

```bash
lark-channel-bridge start      # 后台常驻
lark-channel-bridge status     # 查看状态
lark-channel-bridge logs -f    # 查看日志
lark-channel-bridge restart    # 重启
lark-channel-bridge stop       # 停止
```

多机器人（一个应用对应一个 agent，各自独立）：

```bash
lark-channel-bridge start --profile claude --agent claude
lark-channel-bridge start --profile mimo --agent mimo
```

### 本地开发

```bash
pnpm test          # 全部测试（含依赖真实环境的 integration）
pnpm test:unit     # 仅单元测试（CI 使用）
pnpm typecheck     # 类型检查
pnpm build         # 构建 dist（= pnpm build:web && tsup）
```

## 配置（`~/.lark-channel/config.json`）

```jsonc
{
  "profiles": {
    "claude": {
      "agentKind": "claude",
      "accounts": { "app": { "id": "cli_xxx", "secret": { "source": "exec", "provider": "bridge", "id": "app-cli_xxx" } } },
      "preferences": {
        "cotMessages": "on",           // on=详细 / simple=简报 / off=关闭
        "messageReply": "markdown",
        "runIdleTimeoutMinutes": 0,    // claude 全局空闲超时（分钟，0 = 不超时）
        "disconnectRunGraceMs": 90000  // 断线时等待进行中 run 的宽限（0 = 立即杀，旧行为）
      },
      "access": { "allowedUsers": [], "allowedChats": [], "requireMentionInGroup": true },
      "workspaces": { "default": "/path/to/project" }
    },
    "mimo": {
      "agentKind": "mimo",
      "mimo": {
        "binaryPath": "/path/to/mimo",
        "thinking": true,              // 转发 --thinking，让推理进入思考区
        "idleSeconds": 180             // 静默收尾阈值（秒，0 = 禁用）
      },
      "preferences": { "cotMessages": "on" }
    }
  }
}
```

- `workspaces.default`：该 profile 的默认工作目录（随时用 `/cd` 切换）。
- `preferences.cotMessages`：思考过程气泡详细度——`on`（含工具参数 / 输出）、`simple`（仅工具标题）、`off`（关闭，退回卡片）。
- `preferences.disconnectRunGraceMs`：断线 / 重启时等待进行中 run 结束的宽限（默认 **90000** 毫秒；`0` = 立即杀）。
- `preferences.runIdleTimeoutMinutes`：claude 全局空闲超时（0 = 永不超时）。
- `mimo.idleSeconds`：mimo 静默判定"完成"的阈值秒数（默认 **180**；`0` = 禁用该启发式）。
- `mimo.thinking`：转发 `--thinking`，让推理事件进入思考气泡。

> 真实凭据（App Secret）只存于本地配置 / secret provider，绝不出现在本仓库。

### 权限模型

Agent 能力使用 `"permissions"` 配置（双档），替代已废弃的旧版 `sandbox` 配置（旧版 `sandbox` 已弃用，请勿再使用）：

```jsonc
{
  "profiles": { "claude": {
    "permissions": {
      "defaultAccess": "full",
      "maxAccess": "full"
    }
  }}
}
```

- `defaultAccess`：每次运行的默认授权档位。
- `maxAccess`：本 profile 允许授予的最高档位。
- 两者共同决定 Agent 可执行操作的上限。不要使用旧版 `sandbox` 字段。

## 回复样式

- **cot（推荐）**：消息到达后立即出现原生 `message_cot` 思考气泡——可折叠展开，推理与工具调用流式刷入，最终答案以普通消息发出。没有多余的"正在思考"占位消息。云文档评论按文档权限生效（评论内 @ 机器人按文档权限门控，与群 / 单聊访问控制相互独立）。
- **非 cot**：按 `messageReply` 使用 markdown 打字机卡片（旧版样式）或纯文本。

## 会话与身份

- 每个聊天 / 话题保留独立会话，重启自动恢复；`/new` 原地重开。
- 一台机器多个机器人共存时，每个 profile 使用独立的 lark-cli 身份策略；当前 profile 的 lark-cli 目录（`LARK_CHANNEL_HOME=<root>/profiles/<name>/lark-cli`）彼此隔离，身份互不串扰。

## 命令

| 命令 | 用途 |
| --- | --- |
| `/help` `/status` | 帮助 / 状态（含上下文与 token 用量） |
| `/new` | 原地重开新会话（清空上下文） |
| `/stop` | 停止当前任务 |
| `/cd <path>` `/ws` | 切换 / 管理工作区 |
| `/model` | 模型选择卡片 |
| `/config` | 实时调整偏好（cot 模式、工具显示等） |
| `/invite user` `/invite group` `/invite all group` | 邀请机器人进群协作 |
| `/remove user` `/remove group` | 移出用户 / 群 |
| `/reconnect` `/exit` | 重连 / 退出（`/reconnect --wait` 等当前 run 结束再重连） |
| `/doctor` | 自检（连接、agent、会话健康） |

## 验证与常见问题

**长回复验证**：发送一个要求长输出的任务（如"写一篇 3000 字长文"），确认：停顿超过 30 秒不中断、思考气泡完整、最终答案正常送达。

| 现象 | 排查 |
| --- | --- |
| 没有思考气泡（退回旧样式） | 日志查 `cot create-failed` → 应用缺 `message_cot` 接口权限，到开放平台补授权 |
| 进程反复重启 / 报"进程占用" | 本 fork 会自动清理陈旧锁；仍出现则 `lark-channel-bridge ps` + `kill <id>` |
| 长回复仍中断 | 查 `run-grace-expired` / `idle-finish` 日志；调大 `disconnectRunGraceMs` / `mimo.idleSeconds` |
| Agent 无输出 | 确认 Agent CLI 已登录；运行 `/doctor` 自检 |

**回滚到上游 v0.7.0**：直接安装 npm 包 `lark-channel-bridge@0.7.0`（不包含本 fork 的修复）。

## 许可证

[BSD-3-Clause](./LICENSE)。本仓库派生自 [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)，保留上游许可证。

## 关联

- 上游原版：[zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)
- 传输 SDK：[`@larksuite/channel`](https://www.npmjs.com/package/@larksuite/channel)

---

<a id="en"></a>

# 🇬🇧 English Version

Bridge your local CLI coding agents (Claude Code, MiMo Code, and more) into Feishu / Lark — safely and reliably.

This is a **stabilization fork** of [`lark-channel-bridge` v0.7.0](https://github.com/zarazhangrui/lark-coding-agent-bridge): it fixes the "long replies get killed" family of bugs and switches replies to Feishu's native thinking-process (CoT) bubbles, matching the dsh-lark bot style.

<p align="center"><a href="#cn"><kbd>⬆ 中文版</kbd></a></p>

## Features

| | |
| --- | --- |
| **Reliable transport** | WebSocket long connection with auto-reconnect, dedup and per-chat serialization |
| **Long replies never get killed** | 4 upstream defects fixed (see below) |
| **Native thinking-process bubble** | `message_cot` — collapsible, reasoning streams in live |
| **Tool calls inside the bubble** | icon / name / args / output |
| **Final answer as a plain message** | sent separately when the turn completes |
| **Per-chat sessions** | independent context, resume after restart |
| **Workspaces & models** | `/cd` `/ws` switch workspaces, `/model` switches models |
| **Access control** | user/group allowlists, @mention-only in groups, admin tiers |
| **Collaboration** | `/invite user` `/remove user` `/invite group` `/remove group` `/invite all group` manage members & access |
| **Cross-platform daemon** | Windows (`.cmd` launcher), macOS (launchd), Linux (systemd) |
| **Profile management** | `profile export` / `profile remove` (`--purge --yes` / `--include-secrets --yes`) |
| **One-command onboarding** | QR scan creates/binds a PersonalAgent app, then runs as a background service |

## What this fork fixes (vs upstream v0.7.0)

| # | Upstream bug | Fix |
| --- | --- | --- |
| 1 | MiMo's 25-second silence heuristic SIGTERM'd the child mid-generation → long replies / long thinking got cut off. | Default raised to **180s**, configurable via `mimo.idleSeconds` (`0` disables). |
| 2 | `disconnect()` called `stopAll()`, killing every in-flight run on any reconnect/restart. | Graceful drain: `waitForIdle()` waits (default **90s**, `disconnectRunGraceMs`), final replies are delivered, then the channel tears down. |
| 3 | 400ms stream-card updates hit API rate limits. | Throttle relaxed to **600ms**. |
| 4 | Stale runtime-lock startup loop in non-interactive mode (thousands of "already running" errors). | Auto-clean stale locks and retry when the holder process is dead. |
| 5 | CoT mode still posted a "thinking…" placeholder above the bubble. | No placeholder in CoT mode — the bubble itself is the feedback. |
| 6 | MiMo emitted no reasoning events. | `mimo.thinking: true` forwards `--thinking`. |

Change details: [CHANGES.md](./CHANGES.md).

## Architecture

```
┌──────────────┐   WebSocket (long-lived)   ┌──────────────────────────────┐   spawn + stream JSON   ┌───────────────────┐
│  Feishu/Lark  │ ◄────────────────────────► │          Bridge (Node)         │ ◄────────────────────► │  Claude Code /     │
│  Open Platform│    auto-reconnect / dedup   │  @larksuite/channel transport  │    stream-json / JSONL │  MiMo Code (CLI)   │
└──────────────┘                             └───────────────┬──────────────┘                        └───────────────────┘
                                                             │ message_cot events (reasoning / tools / text)
                                                             ▼
                                           Native thinking-process bubble + plain-message answer
```

- **Transport**: `@larksuite/channel` (the same WebSocket SDK dsh-lark uses) — no polling, auto-reconnect.
- **Agent layer**: `AgentAdapter` subprocess adapters (`claude --include-partial-messages --output-format stream-json` / `mimo run --format json`) translate token-level events into one unified event stream.
- **Render layer**: `message_cot` (AG-UI events: `REASONING_*` / `TOOL_CALL_*` / `TEXT_MESSAGE_*`) → Feishu's native thinking-process bubble; the final answer goes out as a plain text message.

## Quick start

### Prerequisites

- Node.js **>= 20.12** (22+ recommended)
- At least one logged-in local agent: `claude` (Claude Code) or `mimo` (MiMo Code)

### Install

```bash
# From source (includes all fixes)
git clone https://github.com/luokexiaoguo/feishu-agent-bridge.git
cd feishu-agent-bridge
npm i -g pnpm            # if not installed
pnpm install
pnpm build               # = pnpm build:web && tsup (dist/ is already committed, can skip)
npm i -g .

# Or just install the prebuilt artifacts in the repo
npm i -g /path/to/feishu-agent-bridge
```

### First run

```bash
lark-channel-bridge run
```

A QR code renders in your terminal → scan with Feishu → pick or create a **PersonalAgent app** → choose the agent → config is written to `~/.lark-channel/config.json`. To skip app creation, pass `--app-id`: `lark-channel-bridge run --app-id cli_xxx`.

### Background service

Each profile runs as its own **per-profile service** (systemd unit on Linux, launchd plist on macOS, `.cmd` wrapper on Windows):

```bash
lark-channel-bridge start      # daemonize
lark-channel-bridge status
lark-channel-bridge logs -f
lark-channel-bridge restart
lark-channel-bridge stop
```

Multiple bots, one per app/agent:

```bash
lark-channel-bridge start --profile claude --agent claude
lark-channel-bridge start --profile mimo --agent mimo
```

### Development

```bash
pnpm test          # everything (incl. integration, needs live envs)
pnpm test:unit     # unit tests only (used by CI)
pnpm typecheck     # type check
pnpm build         # build dist (= pnpm build:web && tsup)
```

## Configuration (`~/.lark-channel/config.json`)

```jsonc
{
  "profiles": {
    "claude": {
      "agentKind": "claude",
      "accounts": { "app": { "id": "cli_xxx", "secret": { "source": "exec", "provider": "bridge", "id": "app-cli_xxx" } } },
      "preferences": {
        "cotMessages": "on",           // on=detailed / simple=brief / off
        "messageReply": "markdown",
        "runIdleTimeoutMinutes": 0,    // claude run-level idle timeout (0 = none)
        "disconnectRunGraceMs": 90000  // grace for in-flight runs on disconnect (0 = old immediate kill)
      },
      "access": { "allowedUsers": [], "allowedChats": [], "requireMentionInGroup": true },
      "workspaces": { "default": "/path/to/project" }
    },
    "mimo": {
      "agentKind": "mimo",
      "mimo": {
        "binaryPath": "/path/to/mimo",
        "thinking": true,              // forward --thinking so reasoning shows
        "idleSeconds": 180             // silence threshold before finishing (0 = disable)
      },
      "preferences": { "cotMessages": "on" }
    }
  }
}
```

- `workspaces.default`: the profile's default working directory (switch anytime with `/cd`).
- `preferences.cotMessages`: CoT bubble verbosity — `on` (includes tool args/output), `simple` (tool titles only), `off` (disable, fall back to cards).
- `preferences.disconnectRunGraceMs`: how long a disconnect waits for in-flight runs (default **90000** ms; `0` = kill immediately, the old behavior).
- `preferences.runIdleTimeoutMinutes`: global idle timeout for claude runs (0 = never time out).
- `mimo.idleSeconds`: MiMo silence threshold in seconds (default **180**; `0` disables the idle-finish heuristic).
- `mimo.thinking`: forward `--thinking` so reasoning events reach the CoT bubble.

> Real credentials (App Secret) live only in local config / secret providers — never in this repo.

### Permission model

Agent capabilities are gated by the `"permissions"` block instead of the legacy `sandbox` config (legacy `sandbox` is deprecated and must not be used):

```jsonc
{
  "profiles": { "claude": {
    "permissions": {
      "defaultAccess": "full",
      "maxAccess": "full"
    }
  }}
}
```

- `defaultAccess` is the default authorization tier for each run.
- `maxAccess` is the highest tier this profile may grant.
- Together they bound what the agent can do. Do not use the legacy `sandbox` field.

## Reply modes

- **CoT (recommended)**: a native `message_cot` thinking bubble appears immediately — collapsible, with reasoning and tool calls streaming in — and the final answer is delivered as a plain message. No redundant "thinking…" placeholder. `Cloud-doc comments are document-scoped` (they follow document permissions, independent of chat access control).
- **Non-CoT**: markdown typewriter card (legacy style) or plain text, per `messageReply`.

## Identity & sessions

- Each chat/topic keeps its own session; resumed automatically after restart; `/new` starts fresh in place.
- When several bots share a machine, each profile uses its own **lark-cli identity policy** and its own **profile-local lark-cli directory** (`LARK_CHANNEL_HOME=<root>/profiles/<name>/lark-cli`), so identities never cross-talk.

## Commands

| Command | Purpose |
| --- | --- |
| `/help` `/status` | Help / status (context & token usage) |
| `/new` | New session in place (clear context) |
| `/stop` | Stop the current run |
| `/cd <path>` `/ws` | Switch / manage workspaces |
| `/model` | Model picker card |
| `/config` | Live preference toggles (CoT mode, tool display, …) |
| `/invite user` `/invite group` `/invite all group` | Invite the bot into chats / groups |
| `/remove user` `/remove group` | Remove users / groups |
| `/reconnect` `/exit` | Reconnect / exit (`/reconnect --wait` waits for the current run) |
| `/doctor` | Self-diagnostics (connection, agent, sessions) |

## Verification & FAQ

**Long-reply check**: send a task that demands a long output (e.g. "write a 3000-word article"). Confirm: no interruption after >30s pauses, the bubble completes, the final answer arrives.

| Symptom | Diagnosis |
| --- | --- |
| No thinking bubble (fell back to old style) | Check logs for `cot create-failed` → the app lacks `message_cot` permission; grant it in the developer console |
| Process keeps restarting / "already running" | The fork auto-cleans stale locks; if still stuck: `lark-channel-bridge ps` + `kill <id>` |
| Long replies still interrupted | Look for `run-grace-expired` / `idle-finish` in logs; raise `disconnectRunGraceMs` / `mimo.idleSeconds` |
| Agent produces nothing | Confirm the agent CLI is logged in; run `/doctor` |

**Rollback to upstream v0.7.0**: install `lark-channel-bridge@0.7.0` from npm (it does not include these fixes).

## License

[BSD-3-Clause](./LICENSE). Derived from [lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) by zarazhangrui; upstream license retained.

## Related

- Upstream: [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)
- Transport SDK: [`@larksuite/channel`](https://www.npmjs.com/package/@larksuite/channel)