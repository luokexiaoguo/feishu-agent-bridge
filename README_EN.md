# Feishu Agent Bridge

[![License](https://img.shields.io/badge/License-BSD--3--Clause-blue)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D20.12-green)](https://nodejs.org/)

**[中文](README.md)** | **[English](README_EN.md)**

> 📄 **Product doc (Feishu):** [Feishu Agent Bridge · 飞书 Agent 桥接](https://jaz8yhfgl31.feishu.cn/docx/K9P7dFYcooghqkx8VFjcuh98nEe)

**Feishu Agent Bridge** bridges your local CLI coding agents (Claude Code / MiMo Code / Codex / Codex / Codex / OpenCode / OpenClaw / Hermes Agent) into Feishu / Lark — safely and reliably. Built on WebSocket long connections, it fixes the "long replies get killed" family of bugs from the original lark-channel-bridge, and renders replies as Feishu's **native thinking-process bubbles (message_cot)** — collapsible reasoning that streams in live, with the final answer sent separately, matching the dsh-lark bot experience.

## ✨ Features

- **Reliable transport**: WebSocket long connection with auto-reconnect, dedup and per-chat serialization — zero polling.
- **Long replies never get killed**: four upstream defects (MiMo silence kill, disconnect kills in-flight runs, stream rate limits, startup lock loop) are all fixed.
- **Native thinking-process bubble**: built on Feishu `message_cot` — collapsible reasoning streams in live; tool calls show icon / name / args / output.
- **Final answer sent separately**: the conclusion goes out as a plain message when the turn completes.
- **Per-chat sessions**: independent context per chat / topic, auto-resumed after restart, `/new` starts fresh in place.
- **Workspaces & models**: `/cd` `/ws` switch workspaces, `/model` switches models.
- **Access control**: user / group allowlists, @mention-only in groups, admin tiers.
- **Collaboration**: `/invite user` `/remove user` `/invite group` `/remove group` `/invite all group`.
- **Cross-platform daemon**: Windows (`.cmd` launcher), macOS (launchd), Linux (systemd); each profile is its own per-profile service.
- **Profile management**: `profile export` / `profile remove` (`--purge --yes` / `--include-secrets --yes`).
- **Privacy**: credentials stay local; conversations and agents run on your machine — nothing is uploaded to third parties.

## 🤖 Agent Capability Comparison

Different agents use different adapters, so the reply experience (especially **live reasoning streaming**) varies:

| Agent | Adapter | Live reasoning | Live tool calls | Notes |
|---|---|---|---|---|
| **claude** | `claude -p` + stream-json | ✅ Live stream | ✅ Live display | `--autocompact auto` on by default |
| **mimo** | `mimo run --format json` | ✅ Live stream | ✅ Live display | Native `compaction.auto` on by default |
| **codex** | `codex exec --json` | ✅ Live stream | ✅ Live display | Built-in, ready to use |
| **opencode** | `opencode run --format json` | ✅ Live stream | ✅ Live display | Requires opencode account & provider config |
| **openclaw** | `openclaw agent --json` | ✅ Fully adapted (one-shot Q&A, full final answer) | ✅ Fully adapted (tool results returned) | Live streaming reasoning upgrade in progress (ACP route) |
| **hermes** | `hermes acp` (ACP protocol) | ✅ Fully adapted (complete ACP event stream) | ✅ Fully adapted (complete tool-call events) | Adapter code complete; pilot to resume — same CoT experience as claude |

> All six agents are fully adapted: claude / mimo / codex / opencode emit structured event streams (stream-json / JSONL) — reasoning and tool calls push to the Feishu CoT bubble in real time.  
> openclaw currently uses `agent --json` (one-shot Q&A) — final answer and tool results are delivered; live streaming reasoning is being upgraded via ACP.  
> hermes is ACP-based with a complete event stream; the adapter code is ready and the pilot can resume to offer claude-grade streaming CoT.

## 🚀 Quick Start

### Prerequisites

- Node.js **>= 20.12** (22+ recommended)
- At least one logged-in local agent: `claude` (Claude Code), `mimo` (MiMo Code), or `opencode` (OpenCode)

### Install

```bash
# From source (includes all fixes)
git clone https://github.com/luokexiaoguo/feishu-agent-bridge.git
cd feishu-agent-bridge
npm i -g pnpm            # if not installed
pnpm install
pnpm build               # = pnpm build:web && tsup (dist/ is committed, can skip)
npm i -g .

# Or install the prebuilt artifacts in the repo
npm i -g /path/to/feishu-agent-bridge
```

### First run

```bash
feishu-agent-bridge run
```

A QR code renders in your terminal → scan with Feishu → pick or create a **PersonalAgent app** → choose the agent → config is written to `~/.lark-channel/config.json`. To skip app creation, pass `--app-id`: `feishu-agent-bridge run --app-id cli_xxx`.

### Background service

```bash
feishu-agent-bridge start      # daemonize (Linux: systemd / macOS: launchd / Windows: .cmd)
feishu-agent-bridge status
feishu-agent-bridge logs -f
feishu-agent-bridge restart
feishu-agent-bridge stop
```

Multiple bots, one per app/agent:

```bash
feishu-agent-bridge start --profile claude --agent claude
feishu-agent-bridge start --profile mimo --agent mimo
```

### Development

```bash
pnpm test          # everything (incl. integration, needs live envs)
pnpm test:unit     # unit tests only (used by CI)
pnpm typecheck     # type check
pnpm build         # build dist (= pnpm build:web && tsup)
```

## ⚙️ Configuration

Config lives in `~/.lark-channel/config.json`:

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

| Field | Description |
| --- | --- |
| `preferences.cotMessages` | CoT bubble verbosity: `on` (incl. tool args/output), `simple` (tool titles only), `off` (disable) |
| `preferences.disconnectRunGraceMs` | Grace for in-flight runs on disconnect (default **90000** ms, `0` = kill immediately) |
| `preferences.runIdleTimeoutMinutes` | Global idle timeout for claude runs (`0` = never time out) |
| `mimo.idleSeconds` | MiMo silence threshold in seconds (default **180**, `0` disables) |
| `mimo.thinking` | Forward `--thinking` so reasoning reaches the CoT bubble |
| `workspaces.default` | The profile's default working directory (switch anytime with `/cd`) |

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

## 💬 Reply Modes

- **CoT (recommended)**: a native `message_cot` thinking bubble appears immediately — collapsible, with reasoning and tool calls streaming in — and the final answer is delivered as a plain message. No redundant "thinking…" placeholder.
- **Non-CoT**: markdown typewriter card or plain text, per `messageReply`.

## 🎛️ Commands (slash commands, press Enter to run)

### ⚙️ Preferences
- `/config` — Form: reply mode, tool display, concurrency cap, @mention requirement
- `/model` — Open config form to switch model (Claude / MiMo / OpenCode / OpenClaw catalog)
- `/timeout` — Run idle timeout: `/timeout 15` (15 min auto-kill), `/timeout off`, `/timeout default`
- `/account` — View current app; `/account change` hot-swap appId / secret

### 🗂️ Sessions
- `/new` (or `/reset`) — Clear the current session
- `/new chat [name]` — Create a new group chat (auto-invites you + bot), inherits current cwd
- `/resume [N]` — List recent N sessions, restore with one click
- `/status` — Current cwd / session / agent status card
- `/help` — Command cheat sheet card

### 📁 Workspace & Working Directory
- `/cd <path>` — Switch working directory (resets session)
- `/ws list` — List all named workspaces (card + buttons)
- `/ws save <name>` — Save the current cwd as a named workspace
- `/ws use <name>` — Switch to a named workspace
- `/ws remove <name>` — Delete a named workspace

### ⏹️ Run Control
- `/stop` — Stop the current run (same as the ⏹ button)
- `/reconnect` — Force WebSocket reconnect (use after a network hiccup)

### 🧭 Process Management
- `/ps` — List all local bot processes, highlight the one replying
- `/exit <id|#>` — Terminate a process (self = graceful exit; other = SIGTERM)

### 🩺 Diagnostics
- `/doctor [description]` — Feed recent logs + your issue description to the agent for self-diagnosis

### 📎 Other
- `/doc` — Create / update Feishu docs
- `/invite user` `/invite group` `/invite all group` — Invite the bot into chats / groups
- `/remove user` `/remove group` — Remove users / groups
- `/meeting` — Meeting management

## 🧩 What this fork fixes (vs upstream v0.7.0)

| # | Upstream bug | Fix |
| --- | --- | --- |
| 1 | MiMo's 25-second silence heuristic SIGTERM'd the child mid-generation → long replies got cut off | Default raised to **180s**, configurable via `mimo.idleSeconds` (`0` disables) |
| 2 | `disconnect()` called `stopAll()`, killing every in-flight run on reconnect / restart | Graceful drain: `waitForIdle()` waits (default **90s**, `disconnectRunGraceMs`) |
| 3 | 400ms stream-card updates hit API rate limits | Throttle relaxed to **600ms** |
| 4 | Stale runtime-lock startup loop in non-interactive mode | Auto-clean stale locks and retry when the holder process is dead |
| 5 | CoT mode still posted a "thinking…" placeholder above the bubble | No placeholder in CoT mode — the bubble is the feedback |
| 6 | MiMo emitted no reasoning events | `mimo.thinking: true` forwards `--thinking` |

## 📦 Architecture

```
┌──────────────┐   WebSocket (long-lived)   ┌──────────────────────────────┐   spawn + stream JSON   ┌───────────────────┐
│  Feishu/Lark  │ ◄────────────────────────► │          Bridge (Node)         │ ◄────────────────────► │  Claude Code /     │
│  Open Platform│    auto-reconnect / dedup   │  @larksuite/channel transport  │    stream-json / JSONL │  MiMo Code (CLI)   │
└──────────────┘                             └───────────────┬──────────────┘                        └───────────────────┘
                                                             │ message_cot events (reasoning / tools / text)
                                                             ▼
                                           Native thinking-process bubble + plain-message answer
```

- **Transport**: `@larksuite/channel` (the same WebSocket SDK dsh-lark uses).
- **Agent layer**: `AgentAdapter` subprocess adapters (`claude --include-partial-messages --output-format stream-json` / `mimo run --format json`).
- **Render layer**: `message_cot` (AG-UI events) → Feishu's native thinking-process bubble.

## 🛠️ Sessions & Identity

- Each chat / topic keeps its own session; resumed automatically after restart; `/new` starts fresh in place.
- When several bots share a machine, each profile uses its own **lark-cli identity policy** and its own **profile-local lark-cli directory** (`LARK_CHANNEL_HOME=<root>/profiles/<name>/lark-cli`), so identities never cross-talk.
- `Cloud-doc comments are document-scoped` (they follow document permissions, independent of chat access control).

## 📄 Changelog & License

- Changelog: [CHANGES.md](./CHANGES.md)
- License: [BSD-3-Clause](./LICENSE). Derived from [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge); upstream license retained.
- Transport SDK: [`@larksuite/channel`](https://www.npmjs.com/package/@larksuite/channel)