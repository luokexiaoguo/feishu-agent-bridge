# Feishu Agent Bridge · 飞书 Agent 桥接（中文版）

> 完整文档见 [README.md](./README.md)（中英双语）。本文件为中文快速导读。
> Full documentation lives in [README.md](./README.md). This is the Chinese quick guide.

## 一句话 / TL;DR

把本地 Claude Code / MiMo Code 接入飞书 / Lark：WebSocket 长连接稳定收发，**长回复不中断**，
回复使用**飞书原生思考过程气泡（message_cot）**——推理可折叠展开、流式刷入，最终答案单独发出。

## 快速开始 / Quick start

```bash
npm i -g pnpm && pnpm install && pnpm build && npm i -g .
lark-channel-bridge run        # 扫码创建/绑定 PersonalAgent 应用
lark-channel-bridge start      # 后台常驻（每个 profile 独立 per-profile service）
```

## 关键配置 / Key config（`~/.lark-channel/config.json`）

```jsonc
{
  "profiles": {
    "claude": {
      "agentKind": "claude",
      "preferences": {
        "cotMessages": "on",           // 思考过程气泡：on / simple / off
        "disconnectRunGraceMs": 90000, // 断线时等 run 的宽限
        "runIdleTimeoutMinutes": 0
      },
      "workspaces": { "default": "/path/to/project" }
    },
    "mimo": {
      "agentKind": "mimo",
      "mimo": { "binaryPath": "/path/to/mimo", "thinking": true, "idleSeconds": 180 },
      "preferences": { "cotMessages": "on" }
    }
  }
}
```

- 工作区：`workspaces.default`（`/cd` 随时切换）。
- 权限模型：走 `"permissions"` 配置（含 `"defaultAccess": "full"` 与 `"maxAccess": "full"` 双档），
  替代已废弃的旧版 `sandbox` 配置。

## 本 fork 修复 / What's fixed（vs v0.7.0）

1. mimo 25s 静默杀进程 → 默认 **180s**（`mimo.idleSeconds`，`0` 禁用）
2. 断线时 `stopAll` 杀 run → `waitForIdle` 宽限 **90s**（`disconnectRunGraceMs`）
3. 流式更新 400ms → **600ms**（防频率限制）
4. 进程占用启动循环 → 自动清理陈旧锁
5. cot 模式下移除"⏳ 正在思考… 请稍候"占位消息
6. `mimo.thinking: true` 让推理进入思考区

## 会话与身份 / Sessions & identity

- 每个聊天独立会话，重启后自动恢复；`/new` 原地重开。
- 多机器人共存时，每个 profile 使用独立的 lark-cli 身份策略（lark-cli 身份策略）与
  独立的 profile-local lark-cli 目录（当前 profile 的 lark-cli 目录），互不串扰。
- 云文档评论按文档权限生效（Cloud-doc comments are document-scoped），与群/单聊的访问控制相互独立。

## 常用命令 / Commands

`/help` `/status` `/new` `/stop` `/cd` `/ws` `/model` `/config`
`/invite user|group|all group` `/remove user|group` `/reconnect [--wait]` `/doctor`

## 许可证 / License

BSD-3-Clause。上游：[zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)