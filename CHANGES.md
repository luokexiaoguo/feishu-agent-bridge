# feishu-agent-bridge 0.7.1 — DSH-lark fork 变更说明

> 2026-08-16 由 DSH-lark 基于 lark-channel-bridge v0.7.0 源码改造，目标：修复「长回复容易嘎」的缺陷，对齐 dsh-lark-channel 的稳定性（长连接不断线、进行中的 run 不被误杀）。
> 传输层不变：仍基于 `@larksuite/channel`（WebSocket 长连接，与 dsh-lark-channel 同源）。
> 2026-08-17 CLI 更名为 `feishu-agent-bridge`（自有品牌）；新增 OpenCode / OpenClaw / Hermes 适配器。

## 修复：思考气泡"思考→撤回→再思考"（2026-08-20）

- **根因**：`consumeCotEvents`（src/bot/cot.ts）在每次推理区重开时都发 `REASONING_MESSAGE_START`，且 messageId 恒为 `reasoning-<runSeq>`。对照 dsh-lark 事件规范（`~/下载/air/dsh-lark-cot-eventspec.md`）：**REASONING_MESSAGE_START 只在 run 内首个 reasoning-delta 发一次**，推理区可多次开关（thinking → tool → thinking），重开只续发 CONTENT。同 messageId 重复 START 会让飞书客户端**拆除旧推理块重建**，UI 上即"先开始思考 → 撤回 → 再开始思考"。分段思考的 agent（如 claude 在 Windows 上）会频繁触发。
- **修复**：`reasoningStarted` 标志——START 仅 run 内首次；重开推理区只发 CONTENT（END 照常在工具调用前发）。
- **验证**：新增回归测试（思考→工具→思考→文本，START=1 / CONTENT=2 / END=2）；单测 476 全绿。

## 服务名统一为 feishu-agent-bridge.bot.*（2026-08-20）

- `src/daemon/paths.ts` 的 `SERVICE_NAME` 由 `lark-channel-bridge.bot` 改为 **`feishu-agent-bridge.bot`**——systemd unit 名 / launchd label / Windows task 名现在与仓库名、CLI 名完全一致（此前 CLI 已改名，但服务名仍用旧品牌，导致「仓库一个名、本机一个名」的割裂）。
- **升级动作（老机器）**：旧 unit（`lark-channel-bridge.bot.*.service`）需先 stop + disable，再用 `feishu-agent-bridge start --profile <name>` 重建新 unit（自动 enable）。配置 / 会话 / secrets 全部在 `~/.lark-channel/`，不受影响。
- 其余 `lark-channel-bridge` 字符串引用为**历史迁移路径 / 数据标识**（旧版 `~/.config/lark-channel-bridge` 数据迁移、`source: 'lark-channel-bridge'` 记录），保留不动以兼容旧数据。

## /compact 零配置兜底：复用当前 agent 做摘要（2026-08-20）

- 新增 `summarizeViaAgent`（`src/session/compact-llm.ts`）：没有专用摘要 LLM key 时，自动用当前 profile 的 agent（如 Claude Code）跑一次纯摘要任务（`adapter.run` + 纯摘要 prompt，不续会话、不注入 bridge 上下文），收集最终文本作为摘要。
- 摘要源优先级：`compaction.llm` 配置 / `LOCAL_DEEPSEEK_API_KEY` / `~/.hermes/.env` → **当前 agent 本体** → 都没有才提示配置。
- 超时保护：`Promise.race` 兜底，agent 挂起时 `stop()` 并在 `timeoutMs` 内报错返回，不会卡死 `/compact`。
- 收益：新电脑只要 agent 模型配好（能跑任务），`/compact` 就**零配置开箱即用**，无需任何额外 LLM key。
- 验证：真实 claude CLI 冒烟通过（5.8s 出摘要）；单测 490 全绿。

## /compact 全面原生透传（2026-08-20 二次改造）

- **原则**：`/compact` 是纯透传——桥只做飞书 ↔ CLI 的媒介，压缩由 agent 自己的命令完成。删除了摘要器中转层（会话历史记录 CompactStore、摘要 LLM、`<compacted_context>` 注入全部移除）。
- **各 agent 原生压缩命令（均已实测）**：
  - claude：`claude -p --resume <session> "/compact [焦点]"`
  - mimo：`mimo run --session <id> "/compact"`（实测输出"会话状态已压缩归档"，压缩后事实保留）
  - openclaw：`openclaw sessions compact <key>`（实测 "Compacted session"）
  - opencode / codex / hermes：headless CLI 无压缩命令（实测 opencode 把 `/compact` 当普通消息发给模型），不支持透传，`/compact` 返回明确提示
- 代码：`src/session/compact-llm.ts` 只保留 `runNativeCompact`（claude/mimo 走 adapter.run + sessionId）和 `compactOpenClawSession`（spawn `openclaw sessions list --json` 解析 key → `sessions compact <key>`，sessionId 由桥 sessionCatalog 记录）；`src/session/compact.ts` 删除；profile `compaction` 配置简化为 `enabled`（旧 `keepRounds`/`llm` 忽略兼容）。
- **修复事故**：此前一次文档更新脚本 `open(path,'w').write(open(path).read()...)` 先清空再读，把 README.md / README_EN.md 提交成了空文件（a9bcceb），已从父提交恢复并重新应用 /compact 文档，readme-contract 测试恢复全绿。
- 验证：claude E2E（种事实→压缩→保留）、mimo 真实冒烟（21s）、openclaw bash 实测；单测 475 全绿。

## Claude 原生 /compact 透传（2026-08-20）

- **修正此前调研错误**：Claude Code 的 `/compact` 不是只在 TUI 里可用——`claude -p --resume <session> "/compact"`（headless 模式）直接触发官方压缩（stderr 出现 `query_source: "compact"`、进程 exit 0；官方 Agent SDK 也支持以 prompt 发送 `/compact` 并返回 `compact_boundary`）。此前仅查 `claude --help` 文本就断言"headless 无手动压缩"，调研不彻底，已修正。
- **claude profile 的 `/compact` 改为原生透传**（`summarizeViaClaudeNative`，`src/session/compact-llm.ts`）：直接对当前 scope 的 claude 会话执行 `claude -p --resume <session> "/compact [焦点指令]"`，压缩是 Claude Code 官方语义（compact_boundary、保留重要上下文），随后续 run 自动携带压缩后上下文；压缩完成后清空桥侧对该 scope 的历史记录，避免双份摘要。参数 `args` 作为焦点指令（如 `focus on auth bug`）。
- 其他 agent（mimo/opencode/openclaw/codex/hermes）无原生压缩命令，保持桥摘要方案（`/compact [N]` = 保留最近 N 轮）。
- 验证：真实 E2E 闭环——建会话种下事实 → 原生 /compact → resume 提问，事实完整保留（52s 全流程）；单测 493 全绿。

## 新功能：/compact 上下文压缩（2026-08-19，全 agent 统一）

- **背景**：各 agent CLI（claude/codex/mimo/hermes/openclaw/opencode）的 headless 模式都没有统一的手动压缩入口（claude 的 `--autocompact` 仅自动、TUI 的 `/compact` 在 headless 下不可用）。桥此前不持有对话历史，无法提供压缩。
- **实现**：
  - 桥新增每会话对话记录（`src/session/compact.ts`，CompactStore）：每轮 user 消息 + assistant 最终回复落盘到 `<profileDir>/compact/<sha1(scope)>.json`（原子写、0600、单条 8k / 总量 2000 条上限），与 agent 类型无关。
  - 新指令 `/compact [N]`（`src/commands/index.ts`）：把「最近 N 轮（默认 20，N=0 全压）之前」的历史交给摘要 LLM，压成早期对话摘要；`/new` 会清空压缩记录。
  - 摘要 LLM（`src/session/compact-llm.ts`）：OpenAI 兼容 `POST {baseUrl}/chat/completions`，默认 `http://localhost:3000/v1` + `deepseek-v4-flash`（本机 new-api，与 hermes 玄策同源）；key 解析顺序：`compaction.llm.apiKey` → 环境变量 `LOCAL_DEEPSEEK_API_KEY` → `~/.hermes/.env`；都没有则 `/compact` 返回配置提示，**不影响其他功能**。
  - 注入：每次 run 时若存在摘要，在 prompt 顶部注入 `<compacted_context>` 块（`src/bot/channel.ts` + `src/agent/bridge-system-prompt.ts` 已加说明），agent 视为早期对话背景。注入发生在桥层，与 agent 无关 → **所有 agent 统一生效**。
- **配置**（profile config 的 `compaction` 字段，均有默认值，可整体省略）：
  ```jsonc
  { "profiles": { "claude": { "compaction": {
      "enabled": true, "keepRounds": 20,
      "llm": { "baseUrl": "https://.../v1", "model": "...", "apiKey": "sk-...", "timeoutMs": 30000 }
  } } } }
  ```
- **验证**：单测 484 全绿（新增 16 个覆盖 CompactStore / summarizeConversation / key 解析）；E2E 真调本地 new-api 冒烟通过（2.1s 出摘要、保留/移除轮数正确）。
- **可移植性**：代码与机器无关；仅默认 LLM 端点指向本机，其他机器部署需配置自己的 `compaction.llm`（README 已加说明）。

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
