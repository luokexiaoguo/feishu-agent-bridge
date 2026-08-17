# feishu-agent-bridge 0.7.1 — DSH-lark fork 变更说明

> 2026-08-16 由 DSH-lark 基于 lark-channel-bridge v0.7.0 源码改造，目标：修复「长回复容易嘎」的缺陷，对齐 dsh-lark-channel 的稳定性（长连接不断线、进行中的 run 不被误杀）。
> 传输层不变：仍基于 `@larksuite/channel`（WebSocket 长连接，与 dsh-lark-channel 同源）。
> 2026-08-17 CLI 更名为 `feishu-agent-bridge`（自有品牌）；新增 OpenCode / OpenClaw / Hermes 适配器。

## 新增适配器：OpenClaw（2026-08-17）

- 新 `agentKind: 'openclaw'`，`src/agent/openclaw/`（adapter + argv），走 `openclaw agent --json` 单轮模式（spawn `openclaw agent --agent <id> -m <prompt> --json`，解析 result.payloads 为最终答案）。
- 现状：`agent --json` 只返回最终文本（无流式推理/工具事件）→ cot 气泡显示最终答案（无思考区/工具区）。完整流式需 ACP 路线（`openclaw acp`，与 hermes 同协议，需 gateway scope 审批，待后续）。
- 配置示例：
  ```jsonc
  { "profiles": { "openclaw-test": {
      "agentKind": "openclaw",
      "openclaw": { "binaryPath": "/path/to/openclaw", "agentId": "main" },
      "preferences": { "cotMessages": "on" }
  } } }
  ```
- 真实冒烟通过（spawn openclaw agent → 最终文本解析正常）。

## 待办增强（排期，未实现）

- **敏感操作确认卡片**：把 agent 的高危操作（如危险命令）转发为飞书确认卡片，用户点按钮批准/拒绝（参照 dsh-lark 的审批卡片）。
- **每群自定义 system prompt**：per-chat 覆盖 agent 的系统提示词（高级群配置，参照 openclaw-lark 的 group settings）。


## 新增适配器：OpenCode（2026-08-17）

- 新 `agentKind: 'opencode'`，`src/agent/opencode/`（adapter + argv + jsonl 翻译器），支持 `opencode run --format json` JSONL 事件流（text / reasoning / tool_use / step_finish / error）。
- 特性：`--thinking` 推理进思考气泡、`--session` 会话恢复、`--dangerously-skip-permissions` 权限映射、`--dir` 工作区；opencode 在会话 idle 后自行退出，无需 idle 启发式。
- 注册：capability / models / profile-schema / agent-runtime / preflight / catalog / registry / locks / commands / meeting / CLI 选项 / web 控制台。
- 配置示例：
  ```jsonc
  { "profiles": { "opencode": {
      "agentKind": "opencode",
      "opencode": { "binaryPath": "/path/to/opencode", "thinking": true },
      "preferences": { "cotMessages": "on" }
  } } }
  ```
- 测试：11 个单测（argv + jsonl 翻译器）；真实端到端冒烟验证（spawn → JSONL 解析 → sessionId/error 事件）。

## 修复内容

### 1. mimo 适配器 25s idle 误杀（最严重的"长回复中断"根因）
- 原逻辑：mimo 最后一条流式事件后静默 **25 秒**即 SIGTERM 子进程（为等 checkpoint-writer 退出而设）。长回复生成中一旦停顿超过 25s（长思考 / 工具执行 / 大块缓冲），回复被腰斩。
- 修复：默认静默窗口 **25s → 180s**；新增 profile 配置 `mimo.idleSeconds`（0 = 完全禁用该启发式）。
- 文件：`src/agent/mimo/adapter.ts`、`src/runtime/agent-runtime.ts`、`src/config/profile-schema.ts`。

### 2. 断线/重启时杀掉进行中的 run
- 原逻辑：`channel.disconnect()` 里 `activeRuns.stopAll()` —— WS 一断（DNS 抖动、keepalive 触发重连、手动 /reconnect 等）所有进行中的长 run 全部被杀。
- 修复：disconnect 先 `waitForIdle()`（默认宽限 **90s**，可配 `preferences.disconnectRunGraceMs`，0 = 恢复旧行为），等 run 自然结束（结果仍能发出）才断连接；超时才兜底 stopAll。
- 新增 `ActiveRuns.waitForIdle()`：以「run 事件流完成（handle 移除）」为完成信号，而非子进程退出（mimo 子进程本来就不主动退出）。
- 文件：`src/bot/channel.ts`、`src/bot/active-runs.ts`、`src/config/schema.ts`。

### 3. 流式卡片更新频率过高
- 原逻辑：`streamThrottleMs: 400`，长回复时高频调用 cardkit element-update API，易触发频率限制导致流中断。
- 修复：**400ms → 600ms**。
- 文件：`src/bot/channel.ts`。

### 4. 「已有 bridge 进程占用」启动循环（stderr 曾刷 2400+ 次）
- 原逻辑：非交互模式下若 runtime lock 被占（holder 进程已死但锁/meta 残留），直接抛错退出 → systemd Restart 循环。
- 修复：冲突时若 holder pid 已不存在（`isAlive` 为 false），自动清理 stale 锁文件 + meta 文件后重试，不再报错。
- 文件：`src/cli/commands/start.ts`。

### 5. cot 思考气泡更新失败（HTTP 400，气泡中断 + 残留半截消息）
- 现象：`message_cot` 创建成功，但更新时 `COT HTTP 400` → 思考气泡停止 + 发送"更新失败"降级通知，且留下一条流式残留消息（2026-08-17 用户实测截图确认）。
- 根因：`TOOL_CALL_ARGS` 事件把 `JSON.stringify(evt.input)` **原样**写入（工具参数一大，如读文件 / 目录列表），单事件 content 超过 message_cot 的 **4096 字符上限** → API 400。
- 修复：`TOOL_CALL_ARGS` 的 delta 用 `truncateCot(..., COT_TOOL_OUTPUT_MAX)` 截断（1200）；同时 `CotClient.request` 在非 2xx 时**输出 API 错误 body**（原只抛 "COT HTTP 400"，无法诊断）。
- 文件：`src/bot/cot.ts`。

## 配置项（均为可选，向后兼容）

```jsonc
// profile 配置（~/.lark-channel/config.json 的 profiles.<name> 下）
{
  "mimo": { "idleSeconds": 180 },          // 0 = 禁用 mimo idle 收尾（默认 180）
  "preferences": {
    "disconnectRunGraceMs": 90000          // 断线时等 run 的宽限（默认 90000，0 = 立即杀）
  }
}
```

## 部署位置

- 改造源码：`/home/luoke/下载/air/lcb-fixed/`（含 node_modules，可独立构建）
- 原版备份：`/home/luoke/下载/air/lcb-backup/`
- 已替换全局包：`/home/luoke/.npm-global/lib/node_modules/lark-channel-bridge/`（dist 为 0.7.1-lcb-fixed 构建产物）
- 服务：`lark-channel-bridge.bot.claude.service` / `lark-channel-bridge.bot.mimo.service`（已重启生效）

## 回滚

```bash
# 用备份恢复全局包并重启服务
cp -rL /home/luoke/下载/air/lcb-backup/dist/* /home/luoke/.npm-global/lib/node_modules/lark-channel-bridge/dist/
cp /home/luoke/下载/air/lcb-backup/package.json /home/luoke/.npm-global/lib/node_modules/lark-channel-bridge/package.json
systemctl --user restart lark-channel-bridge.bot.claude.service lark-channel-bridge.bot.mimo.service
```

## 重建

```bash
cd /home/luoke/下载/air/lcb-fixed
./node_modules/.bin/tsup          # 产出 dist/cli.js + dist/index.js
# 覆盖全局包后重启服务
```

## 验证方法

1. 飞书里给 claude/mimo bot 发一个明确要求"输出超长内容"的任务（如：写一篇 3000 字长文 / 分章节逐一展开）。
2. 观察：中途停顿 >25s 不应再中断；回复应流式打完并正常结束。
3. `feishu-agent-bridge ps` 应显示版本 `0.7.1-lcb-fixed`。
4. 日志关注点：不再出现 `idle-finish`（静默 25s 触发）、`run-grace-expired`（90s 超时才出现且属兜底）、`已有 bridge 进程占用`。
