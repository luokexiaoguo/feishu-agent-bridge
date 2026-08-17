# Feishu Agent Bridge · 飞书 Agent 桥接

[![License](https://img.shields.io/badge/License-BSD--3--Clause-blue)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D20.12-green)](https://nodejs.org/)

**[中文](README.md)** | **[English](README_EN.md)**

> 📄 **产品文档（飞书）**：[Feishu Agent Bridge · 飞书 Agent 桥接](https://jaz8yhfgl31.feishu.cn/docx/K9P7dFYcooghqkx8VFjcuh98nEe)

**Feishu Agent Bridge** 是一款将本地 CLI Agent（Claude Code / MiMo Code / OpenCode / Hermes Agent）安全、稳定地接入飞书 / Lark 的桥接工具。它基于 WebSocket 长连接，修复了原版 lark-channel-bridge 中"长回复容易中断"的缺陷，并把回复渲染为飞书**原生思考过程气泡（message_cot）**——推理可折叠展开、流式刷入，最终答案单独发出，与 dsh-lark 机器人的体验一致。

## ✨ 功能特性

- **长连接可靠收发**：WebSocket 长连接，自动重连、去重、逐会话串行化，零轮询开销。
- **长回复不中断**：mimo 静默误杀、断线杀 run、流式频率限制、启动死循环四大缺陷已全部修复。
- **原生思考过程气泡**：使用飞书 `message_cot`，推理过程可折叠展开、流式刷新，工具调用显示图标 / 名称 / 参数 / 输出。
- **最终答案单独发送**：回合结束时以普通消息发送结论，不混在过程气泡里。
- **每会话独立上下文**：每个聊天 / 话题独立会话，重启后自动恢复，`/new` 可原地重开。
- **多工作区与模型**：`/cd` `/ws` 切换工作区，`/model` 切换模型。
- **访问控制**：用户 / 群白名单、群聊 @ 才响应、管理员分级。
- **多人协作**：`/invite user` `/remove user` `/invite group` `/remove group` `/invite all group`。
- **跨平台常驻**：Windows（`.cmd` 启动器）、macOS（launchd）、Linux（systemd），每个 profile 独立 per-profile service。
- **Profile 管理**：`profile export` / `profile remove`（支持 `--purge --yes` / `--include-secrets --yes`）。
- **隐私安全**：凭据只存本地，对话上下文与 Agent 都在本机，数据不上传第三方。

## 🚀 快速开始

### 前提

- Node.js **>= 20.12**（推荐 22+）
- 至少一个已登录的本地 Agent：`claude`（Claude Code）、`mimo`（MiMo Code）或 `opencode`（OpenCode）

### 安装

```bash
# 从源码构建安装（包含全部修复）
git clone https://github.com/luokexiaoguo/feishu-agent-bridge.git
cd feishu-agent-bridge
npm i -g pnpm            # 若未安装 pnpm
pnpm install
pnpm build               # = pnpm build:web && tsup（dist/ 已提交，可跳过）
npm i -g .

# 或直接安装仓库内已构建产物
npm i -g /path/to/feishu-agent-bridge
```

### 首次运行

```bash
feishu-agent-bridge run
```

终端出现二维码 → 飞书扫码 → 选择或创建 **PersonalAgent 应用** → 选择要初始化的 agent → 配置写入 `~/.lark-channel/config.json`。已有应用可跳过创建：`feishu-agent-bridge run --app-id cli_xxx`。

### 后台常驻

```bash
feishu-agent-bridge start      # 后台常驻（Linux: systemd / macOS: launchd / Windows: .cmd）
feishu-agent-bridge status     # 查看状态
feishu-agent-bridge logs -f    # 查看日志
feishu-agent-bridge restart    # 重启
feishu-agent-bridge stop       # 停止
```

多机器人（一个应用对应一个 agent，各自独立）：

```bash
feishu-agent-bridge start --profile claude --agent claude
feishu-agent-bridge start --profile mimo --agent mimo
```

### 本地开发

```bash
pnpm test          # 全部测试（含依赖真实环境的 integration）
pnpm test:unit     # 仅单元测试（CI 使用）
pnpm typecheck     # 类型检查
pnpm build         # 构建 dist（= pnpm build:web && tsup）
```

## ⚙️ 配置

配置文件位于 `~/.lark-channel/config.json`：

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
    },
    "opencode": {
      "agentKind": "opencode",
      "opencode": {
        "binaryPath": "/path/to/opencode",
        "thinking": true
      },
      "preferences": { "cotMessages": "on" }
    }
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `preferences.cotMessages` | 思考过程气泡详细度：`on`（含工具参数 / 输出）、`simple`（仅工具标题）、`off`（关闭） |
| `preferences.disconnectRunGraceMs` | 断线 / 重启时等待进行中 run 结束的宽限（默认 **90000** 毫秒，`0` = 立即杀） |
| `preferences.runIdleTimeoutMinutes` | claude 全局空闲超时（`0` = 永不超时） |
| `mimo.idleSeconds` | mimo 静默判定"完成"的阈值秒数（默认 **180**，`0` = 禁用） |
| `mimo.thinking` | 转发 `--thinking`，让推理事件进入思考气泡 |
| `workspaces.default` | 该 profile 的默认工作目录（随时用 `/cd` 切换） |

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

## 💬 回复样式

- **cot（推荐）**：消息到达后立即出现原生 `message_cot` 思考气泡——可折叠展开，推理与工具调用流式刷入，最终答案以普通消息发出，没有多余的"正在思考"占位消息。
- **非 cot**：按 `messageReply` 使用 markdown 打字机卡片或纯文本。

## 🎛️ 命令

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

## 🧩 相对上游 v0.7.0 的修复

| # | 上游缺陷 | 修复 |
| --- | --- | --- |
| 1 | mimo 最后一条流式事件后 **25 秒**静默即 SIGTERM 杀进程，长回复 / 长思考被腰斩 | 默认放宽到 **180 秒**，可用 `mimo.idleSeconds` 配置（`0` = 完全禁用） |
| 2 | `disconnect()` 直接 `stopAll()`，断线 / 重启会杀掉所有进行中的 run | 改为优雅排空：`waitForIdle()` 等待（默认 **90 秒**，`disconnectRunGraceMs`） |
| 3 | 流式卡片 400ms 高频更新触发 API 频率限制 | 节流放宽到 **600ms** |
| 4 | 非交互模式下陈旧运行时锁导致启动死循环 | holder 进程已死时自动清理陈旧锁并重试 |
| 5 | cot 模式下仍发"正在思考…"占位消息 | cot 模式下不再发占位消息，气泡本身就是反馈 |
| 6 | mimo 默认不输出推理事件 | 配置 `mimo.thinking: true` 转发 `--thinking` |

## 📦 架构

```
┌──────────────┐   WebSocket（长连接）   ┌──────────────────────────────┐   spawn + 流式 JSON   ┌───────────────────┐
│ 飞书开放平台   │ ◄────────────────────► │          Bridge（Node）        │ ◄────────────────────► │  Claude Code /     │
│              │   自动重连 / 去重 / 串行化 │  @larksuite/channel 传输层      │   stream-json / JSONL │  MiMo Code (CLI)   │
└──────────────┘                        └───────────────┬──────────────┘                        └───────────────────┘
                                                        │ message_cot 事件流（推理 / 工具 / 文字）
                                                        ▼
                                             原生思考过程气泡 + 普通消息答案
```

- **传输层**：`@larksuite/channel`（与 dsh-lark 同源的 WebSocket SDK）。
- **Agent 层**：`AgentAdapter` 子进程适配器（`claude --include-partial-messages --output-format stream-json` / `mimo run --format json`）。
- **渲染层**：`message_cot`（AG-UI 事件）→ 飞书原生"思考过程"气泡。

## 🛠️ 会话与身份

- 每个聊天 / 话题保留独立会话，重启自动恢复；`/new` 原地重开。
- 多机器人共存时，每个 profile 使用独立的 `lark-cli identity policy`（lark-cli 身份策略）；当前 profile 的 lark-cli 目录（`profile-local lark-cli directory`，位于 `LARK_CHANNEL_HOME=<root>/profiles/<name>/lark-cli`）彼此隔离，身份互不串扰。
- 云文档评论按文档权限生效（Cloud-doc comments are document-scoped），与群 / 单聊的访问控制相互独立。

## 📄 变更与许可证

- 变更记录：[CHANGES.md](./CHANGES.md)
- 许可证：[BSD-3-Clause](./LICENSE)。本仓库派生自 [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)，保留上游许可证。
- 传输 SDK：[`@larksuite/channel`](https://www.npmjs.com/package/@larksuite/channel)