# Feishu Agent Bridge

Bridge your local CLI coding agents (Claude Code, MiMo Code, and more) into Feishu / Lark — safely and reliably.

This is a **stabilization fork** of [`lark-channel-bridge` v0.7.0](https://github.com/zarazhangrui/lark-coding-agent-bridge): it fixes the "long replies get killed" family of bugs and switches replies to Feishu's native thinking-process (CoT) bubbles, matching the dsh-lark bot style.

---

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

---

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

---

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

---

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

A QR code renders in your terminal → scan with Feishu → pick or create a **PersonalAgent app** → choose the agent → config is written to `~/.lark-channel/config.json`.

To skip app creation, pass `--app-id`: `lark-channel-bridge run --app-id cli_xxx`

### Background service

Each profile runs as its own **per-profile service** (systemd unit on Linux, launchd plist on macOS, `.cmd` wrapper on Windows):

```bash
lark-channel-bridge start
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

---

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

Agent capabilities are gated by the `"permissions"` block instead of the legacy `sandbox` config
(legacy `sandbox` is deprecated and must not be used):

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

---

## Reply modes

- **CoT (recommended)**: a native `message_cot` thinking bubble appears immediately — collapsible, with reasoning and tool calls streaming in — and the final answer is delivered as a plain message. No redundant "thinking…" placeholder. `Cloud-doc comments are document-scoped` (they follow document permissions, independent of chat access control).
- **Non-CoT**: markdown typewriter card (legacy style) or plain text, per `messageReply`.

## Identity & sessions

- Each chat/topic keeps its own session; resumed automatically after restart; `/new` starts fresh in place.
- When several bots share a machine, each profile uses its own **lark-cli identity policy** and its own **profile-local lark-cli directory** (`LARK_CHANNEL_HOME=<root>/profiles/<name>/lark-cli`), so identities never cross-talk.

---

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

---

## Verification & FAQ

**Long-reply check**: send a task that demands a long output (e.g. "write a 3000-word article"). Confirm: no interruption after >30s pauses, the bubble completes, the final answer arrives.

| Symptom | Diagnosis |
| --- | --- |
| No thinking bubble (fell back to old style) | Check logs for `cot create-failed` → the app lacks `message_cot` permission; grant it in the developer console |
| Process keeps restarting / "already running" | The fork auto-cleans stale locks; if still stuck: `lark-channel-bridge ps` + `kill <id>` |
| Long replies still interrupted | Look for `run-grace-expired` / `idle-finish` in logs; raise `disconnectRunGraceMs` / `mimo.idleSeconds` |
| Agent produces nothing | Confirm the agent CLI is logged in; run `/doctor` |

**Rollback to upstream v0.7.0**: install `lark-channel-bridge@0.7.0` from npm (it does not include these fixes).

---

## License

[BSD-3-Clause](./LICENSE). Derived from [lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) by zarazhangrui; upstream license retained.

## Related

- Upstream: [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)
- Transport SDK: [`@larksuite/channel`](https://www.npmjs.com/package/@larksuite/channel)