# Feishu Agent Bridge · 飞书 Agent 桥接（中文版）

本仓库的主文档是**中英双语切换**的 [README.md](./README.md)：

- 打开仓库即可看到 **🇨🇳 中文版**（默认展示）
- 顶部有切换按钮，一键跳转 **🇬🇧 English** 版本

本文件仅为纯中文的独立索引页，方便直接访问。

## 快速了解

将本地的 Claude Code / MiMo Code 等命令行 Agent 安全、稳定地接入飞书 / Lark。
本仓库是 lark-channel-bridge v0.7.0 的稳定化改造版：修复"长回复容易中断"的系列缺陷，
回复样式切换为飞书**原生思考过程气泡（message_cot）**——推理可折叠展开、流式刷入，最终答案单独发出。

关键修复：mimo 静默误杀（默认 180 秒）、断线不再杀进行中的 run（宽限 90 秒）、
流式更新降频、陈旧锁自动清理、cot 模式下移除"正在思考"占位消息。

## 常见配置

```jsonc
{
  "profiles": {
    "claude": {
      "agentKind": "claude",
      "preferences": {
        "cotMessages": "on",           // on / simple / off
        "disconnectRunGraceMs": 90000,
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

- 权限模型走 `"permissions"`（含 `"defaultAccess"` 与 `"maxAccess"` 双档），替代旧版 `sandbox` 配置。
- 多机器人共存时，每个 profile 使用独立的 lark-cli 身份策略；当前 profile 的 lark-cli 目录彼此隔离。
- 云文档评论按文档权限生效，与群 / 单聊访问控制相互独立。

## 更多

- 完整双语文档（含架构、安装、命令、FAQ）：**[README.md](./README.md)**
- 变更记录：[CHANGES.md](./CHANGES.md)
- 许可证：[BSD-3-Clause](./LICENSE)