// src/core/logger.ts
import { AsyncLocalStorage } from "async_hooks";
import { createWriteStream, mkdirSync } from "fs";
import { open, readdir, rm, stat } from "fs/promises";
import { join } from "path";

// src/core/telemetry.ts
var noop = {
  emit() {
  },
  recordError() {
  },
  recordMetric() {
  },
  flush() {
  },
  close() {
  }
};
var active = noop;
function telemetry() {
  return active;
}

// src/core/logger.ts
var DEFAULT_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.LARK_CHANNEL_LOG_DAYS ?? 30) || 30
);
var loggerOptions = {
  retentionDays: DEFAULT_RETENTION_DAYS,
  now: () => /* @__PURE__ */ new Date()
};
var STDOUT_INFO_ALLOWLIST = /* @__PURE__ */ new Set([
  "ws.connected",
  "ws.reconnecting",
  "ws.reconnected",
  "intake.enter",
  "intake.command",
  "run.started",
  "run.completed",
  "run.failed",
  "cot.created",
  "cot.completed",
  "outbound.sent",
  "outbound.markdown-stream-fallback",
  "card.final"
]);
var als = new AsyncLocalStorage();
var stream = null;
var currentDate = "";
function todayKey() {
  return formatLocalDateKey(loggerOptions.now());
}
function logsDir() {
  return loggerOptions.logsDir;
}
function logFileName(dateKey) {
  return `bridge-${dateKey}.jsonl`;
}
function getStream() {
  const dir = logsDir();
  if (!dir) return null;
  const today = todayKey();
  if (stream && currentDate === today) return stream;
  if (stream) {
    try {
      stream.end();
    } catch {
    }
  }
  try {
    mkdirSync(dir, { recursive: true });
    stream = createWriteStream(join(dir, logFileName(today)), { flags: "a" });
    currentDate = today;
    return stream;
  } catch {
    return null;
  }
}
var RESERVED_KEYS = /* @__PURE__ */ new Set([
  "ts",
  "level",
  "phase",
  "event",
  "traceId",
  "chatId",
  "msgId"
]);
var TELEMETRY_ENVELOPE_KEYS = /* @__PURE__ */ new Set([
  "ts",
  "level",
  "phase",
  "event",
  "traceId",
  "chatId",
  "msgId"
]);
var RAW_PAYLOAD_KEYS = /* @__PURE__ */ new Set([
  "prompt",
  "stdout",
  "stderr",
  "env",
  "environment",
  "proxy"
]);
var RESOURCE_ID_KEYS = /* @__PURE__ */ new Set(["fileKey", "sourceFileKey"]);
var ID_KEYS = /* @__PURE__ */ new Set([
  "chatId",
  "senderId",
  "sender",
  "openId",
  "operatorId",
  "userId",
  "msgId",
  "messageId",
  "sourceMessageId",
  "sessionId",
  "threadId",
  "docToken",
  "fileToken",
  "fileKey",
  "sourceFileKey",
  "commentId",
  "rootCommentId",
  "replyId",
  "reactionId",
  "scope",
  "appId"
]);
var MAX_LOG_STRING_CHARS = 4096;
var CREDENTIAL_JSON_FIELD_RE = /("(?:secret|app_secret|appSecret|token|access_token|tenant_access_token|app_access_token|authorization)"\s*:\s*")[^"]*(")/gi;
var ESCAPED_CREDENTIAL_JSON_FIELD_RE = /(\\\"(?:secret|app_secret|appSecret|token|access_token|tenant_access_token|app_access_token|authorization)\\\"\s*:\s*\\\")[^\\]*(\\\")/gi;
var RESOURCE_JSON_FIELD_RE = /("(?:fileKey|sourceFileKey|file_key|source_file_key|imageKey|image_key|mediaKey|media_key)"\s*:\s*")[^"]*(")/gi;
var ESCAPED_RESOURCE_JSON_FIELD_RE = /(\\\"(?:fileKey|sourceFileKey|file_key|source_file_key|imageKey|image_key|mediaKey|media_key)\\\"\s*:\s*\\\")[^\\]*(\\\")/gi;
var LOCAL_LOG_SANITIZE = { redactIds: false };
var EXTERNAL_SANITIZE = { redactIds: true };
function sanitizeLogEntry(entry, options = EXTERNAL_SANITIZE) {
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    out[key] = sanitizeLogValue(key, value, options);
  }
  return out;
}
function sanitizeLogValue(key, value, options = EXTERNAL_SANITIZE) {
  const normalizedKey = key.startsWith("_") ? key.slice(1) : key;
  if (value === void 0) return void 0;
  if (RAW_PAYLOAD_KEYS.has(normalizedKey)) return "[REDACTED]";
  if (/token|secret|authorization/i.test(normalizedKey)) return "[REDACTED]";
  if (/attachment.*path|media.*path|^(cwd|cwdRealpath|path|absPath)$/i.test(normalizedKey)) {
    return "[REDACTED_PATH]";
  }
  if (RESOURCE_ID_KEYS.has(normalizedKey)) return "[REDACTED_RESOURCE]";
  if (options.redactIds && ID_KEYS.has(normalizedKey)) return redactId(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(key, item, options));
  }
  if (value && typeof value === "object") {
    const nested = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      nested[nestedKey] = sanitizeLogValue(nestedKey, nestedValue, options);
    }
    return nested;
  }
  if (typeof value === "string") {
    const redacted = redactDiagnosticText(value);
    if (redacted.length > MAX_LOG_STRING_CHARS) {
      return `${redacted.slice(0, MAX_LOG_STRING_CHARS)}...[truncated]`;
    }
    return redacted;
  }
  return value;
}
function redactId(value) {
  if (typeof value !== "string") return value;
  if (value.length <= 6) return value;
  return `...${value.slice(-6)}`;
}
function emit(level, phase, event, fields = {}) {
  const ctx = als.getStore() ?? {};
  const entry = sanitizeLogEntry({
    ts: formatLocalTimestamp(loggerOptions.now()),
    level,
    phase,
    event,
    ...ctx
  }, LOCAL_LOG_SANITIZE);
  for (const [k, v] of Object.entries(fields)) {
    if (RESERVED_KEYS.has(k)) {
      entry[`_${k}`] = sanitizeLogValue(`_${k}`, v, LOCAL_LOG_SANITIZE);
    } else {
      entry[k] = sanitizeLogValue(k, v, LOCAL_LOG_SANITIZE);
    }
  }
  const externalEntry = sanitizeLogEntry(entry, EXTERNAL_SANITIZE);
  const telemetrySafe = telemetryPayloadFromEntry(externalEntry);
  const s = getStream();
  if (s) {
    try {
      s.write(`${JSON.stringify(entry)}
`);
    } catch {
    }
  }
  try {
    telemetry().emit({
      level,
      phase,
      event,
      fields: telemetrySafe.fields,
      ctx: telemetrySafe.ctx,
      ts: String(entry.ts)
    });
  } catch {
  }
  if (level === "error") {
    try {
      telemetry().recordError(telemetrySafe.fields.err ?? `${phase}.${event}`, {
        phase,
        event,
        ...telemetrySafe.ctx,
        ...telemetrySafe.fields
      });
    } catch {
    }
  }
  const showOnStdout = level !== "info" || STDOUT_INFO_ALLOWLIST.has(`${phase}.${event}`);
  if (!showOnStdout) return;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(formatStdout(level, phase, event, telemetrySafe.ctx, telemetrySafe.fields));
}
function telemetryPayloadFromEntry(entry) {
  const ctx = {};
  if (typeof entry.traceId === "string") ctx.traceId = entry.traceId;
  if (typeof entry.chatId === "string") ctx.chatId = entry.chatId;
  if (typeof entry.msgId === "string") ctx.msgId = entry.msgId;
  const fields = {};
  for (const [key, value] of Object.entries(entry)) {
    if (TELEMETRY_ENVELOPE_KEYS.has(key) || value === void 0) continue;
    fields[key] = value;
  }
  return { ctx, fields };
}
function formatStdout(level, phase, event, ctx, fields) {
  if (phase === "ws") {
    if (event === "connected") {
      const bot = fields.bot ?? "-";
      const appId = fields.appId ? ` (${fields.appId})` : "";
      const agent = fields.agent ?? "-";
      const proc = fields.procId ? `  \u8FDB\u7A0B: ${fields.procId}` : "";
      return `\u2713 \u5DF2\u8FDE\u63A5  bot: ${bot}${appId}  agent: ${agent}${proc}`;
    }
    if (event === "reconnecting") return "\u21BB \u6B63\u5728\u91CD\u8FDE\u2026";
    if (event === "reconnected") return "\u2713 \u5DF2\u91CD\u8FDE";
    if (event === "fail") return `\u2717 WS \u9519\u8BEF: ${fields.err ?? ""}`;
  }
  if (phase === "intake" && event === "enter") {
    const c = ctx.chatId ? ctx.chatId.slice(-6) : "-";
    const mode = fields.chatMode ?? fields.chatType ?? "?";
    const scope = shortId(fields.scope);
    const sender = fields.sender ?? "-";
    const msg = shortId(ctx.msgId ?? fields.msgId ?? fields._msgId);
    const preview = fields.preview ?? "";
    return `\u25B8 ${mode}/${c} scope=${scope} sender=${sender} msg=${msg}: ${preview}`;
  }
  if (phase === "intake" && event === "command") {
    const scope = shortId(fields.scope);
    return `  \u21B3 command scope=${scope} dropped=${fields.droppedPending ?? 0}`;
  }
  if (phase === "run" && event === "started") {
    const scope = shortId(fields.scope);
    return `  \u25B6 run start scope=${scope} run=${shortId(fields.runId)} queue=${fields.queueWaitMs ?? 0}ms`;
  }
  if (phase === "run" && (event === "completed" || event === "failed")) {
    const result = event === "failed" ? "failed" : fields.result ?? "done";
    const mark = event === "failed" ? "\u2717" : result === "interrupted" ? "\u23F9" : "\u2713";
    const scope = shortId(fields.scope);
    const duration = formatDurationMs(fields.durationMs);
    return `  ${mark} run ${result} scope=${scope} run=${shortId(fields.runId)}${duration ? ` duration=${duration}` : ""}`;
  }
  if (phase === "cot" && event === "created") {
    return `  \u25C7 cot created message=${shortId(fields.messageId)} cot=${shortId(fields.cotId)}`;
  }
  if (phase === "cot" && event === "completed") {
    return `  \u25C7 cot completed cot=${shortId(fields.cotId)} reason=${fields.reason ?? "-"}`;
  }
  if (phase === "outbound" && event === "markdown-stream-fallback") {
    return `  \u26A0 markdown stream fallback: ${fields.err ?? ""}`;
  }
  if (phase === "outbound" && event === "sent") {
    const scope = shortId(fields.scope);
    const reply = fields.replyInThread === true ? "thread" : "reply";
    return `  \u2197 sent ${fields.type ?? "message"} scope=${scope} ${reply}=${shortId(fields.replyTo)} msg=${shortId(fields.messageId)}`;
  }
  if (phase === "card" && event === "final") {
    const c = ctx.chatId ? ctx.chatId.slice(-6) : "-";
    const t = fields.terminal;
    const mark = t === "done" ? "\u2713" : t === "interrupted" ? "\u23F9" : "\u2717";
    const scope = fields.scope ? shortId(fields.scope) : c;
    return `  ${mark} ${scope} ${t}`;
  }
  const ctxBits = [];
  if (ctx.traceId) ctxBits.push(`t=${ctx.traceId}`);
  if (ctx.chatId) ctxBits.push(`c=${ctx.chatId.slice(-6)}`);
  const ctxStr = ctxBits.length > 0 ? ` ${ctxBits.join(" ")}` : "";
  const summary = formatFields(fields);
  const tag = level === "error" ? "\u2717" : level === "warn" ? "\u26A0" : "\xB7";
  return `${tag} [${phase}.${event}]${ctxStr}${summary ? ` ${summary}` : ""}`;
}
function formatLocalDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}
function formatLocalTimestamp(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}.${ms}${sign}${oh}:${om}`;
}
function shortId(value) {
  if (value === void 0 || value === null) return "-";
  const s = String(value);
  const last = s.includes(":") ? s.split(":").at(-1) ?? s : s;
  const bare = last.startsWith("...") ? last.slice(3) : last;
  return bare.length > 6 ? bare.slice(-6) : bare;
}
function formatDurationMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return void 0;
  if (value < 1e3) return `${value}ms`;
  const seconds = value / 1e3;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest > 0 ? `${minutes}m${rest}s` : `${minutes}m`;
}
function formatFields(fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return "";
  const parts = [];
  for (const k of keys) {
    const v = fields[k];
    if (v === void 0 || v === null) continue;
    if (k === "stack") continue;
    if (typeof v === "string") {
      parts.push(`${k}=${v.length > 80 ? `${v.slice(0, 80)}\u2026` : v}`);
    } else if (typeof v === "number" || typeof v === "boolean") {
      parts.push(`${k}=${v}`);
    } else {
      try {
        const s = JSON.stringify(v);
        parts.push(`${k}=${s.length > 80 ? `${s.slice(0, 80)}\u2026` : s}`);
      } catch {
        parts.push(`${k}=?`);
      }
    }
  }
  return parts.join(" ");
}
var log = {
  info(phase, event, fields) {
    emit("info", phase, event, fields);
  },
  warn(phase, event, fields) {
    emit("warn", phase, event, fields);
  },
  fail(phase, err, fields) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : void 0;
    const apiData = err?.response?.data;
    const apiStatus = err?.response?.status;
    emit("error", phase, "fail", {
      ...fields,
      err: message,
      apiStatus,
      apiData,
      stack
    });
  }
};
function redactDiagnosticText(text) {
  let out = redactJsonCredentialText(text);
  out = redactResourceText(out);
  out = out.replace(
    /\b(Authorization\s*[:=]\s*Bearer\s+)[A-Za-z0-9._\-+/=]+/gi,
    "$1[REDACTED]"
  );
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._\-+/=]+/g, "$1[REDACTED]");
  out = out.replace(
    /\b(access_token|tenant_access_token|app_access_token|app_secret|appSecret|secret|token|doc_token|file_token|authorization)=([^&\s"',}]+)/gi,
    "$1=[REDACTED]"
  );
  out = out.replace(
    /(^|[\s"'=])((?:\/(?:Users|home|tmp|var|private|Volumes|opt|workspace|workspaces|mnt|app|srv|root|data)\/[^\s"',)]+))/g,
    "$1[REDACTED_PATH]"
  );
  out = out.replace(/(^|[\s"'=])(~\/[^\s"',)]+)/g, "$1[REDACTED_PATH]");
  out = out.replace(/[A-Za-z]:\\[^\s"',)]+/g, "[REDACTED_PATH]");
  return out;
}
function redactJsonCredentialText(text) {
  return text.replace(CREDENTIAL_JSON_FIELD_RE, "$1[REDACTED]$2").replace(ESCAPED_CREDENTIAL_JSON_FIELD_RE, "$1[REDACTED]$2");
}
function redactResourceText(text) {
  return text.replace(RESOURCE_JSON_FIELD_RE, "$1[REDACTED_RESOURCE]$2").replace(ESCAPED_RESOURCE_JSON_FIELD_RE, "$1[REDACTED_RESOURCE]$2").replace(
    /<\s*(?:file|image|img|audio|video|media|folder)\b[^>]*\bkey\s*=\s*["'][^"']+["'][^>]*>/gi,
    "[REDACTED_RESOURCE]"
  ).replace(/!?\[[^\]]*]\((?:file|img|image|media)_[^)]+\)/gi, "[REDACTED_RESOURCE]").replace(
    /\b(?:file|img|image|media)_(?:v\d+_)?[A-Za-z0-9][A-Za-z0-9._-]{8,}\b/g,
    "[REDACTED_RESOURCE]"
  );
}

// src/agent/lark-channel-env.ts
import { join as join2 } from "path";

// src/platform/spawn.ts
import crossSpawn from "cross-spawn";
function spawnProcess(command, args = [], options = {}) {
  return crossSpawn(command, [...args], options);
}

// src/agent/preflight.ts
var AgentPreflightError = class extends Error {
  diagnostic;
  constructor(diagnostic, message) {
    super(message ?? summaryForDiagnostic(diagnostic));
    this.name = "AgentPreflightError";
    this.diagnostic = diagnostic;
  }
};
async function checkAgentAvailability(input) {
  try {
    return { ok: true, version: await checkAgentVersion(input) };
  } catch (err) {
    if (err instanceof AgentPreflightError) {
      return { ok: false, error: err, diagnostic: err.diagnostic };
    }
    throw err;
  }
}
async function checkAgentVersion(input) {
  const args = input.args ?? ["--version"];
  const timeoutMs = input.timeoutMs ?? 5e3;
  const executable = input.realpath ?? input.binaryPath;
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timer;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    const base = () => ({
      agentId: input.agentId,
      agentName: input.agentName,
      command: input.command,
      binaryPath: input.binaryPath,
      ...input.realpath ? { realpath: input.realpath } : {},
      args,
      stdoutExcerpt: excerpt(stdout),
      stderrExcerpt: excerpt(stderr)
    });
    const child = (() => {
      try {
        return spawnProcess(executable, [...args], {
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch (err) {
        finish(
          () => reject(
            new AgentPreflightError({
              ...base(),
              code: codeForSpawnError(err),
              errno: err.code
            })
          )
        );
        return void 0;
      }
    })();
    if (!child) return;
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(
        () => reject(
          new AgentPreflightError({
            ...base(),
            code: "agent-version-check-timeout",
            timeoutMs
          })
        )
      );
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (err) => {
      finish(
        () => reject(
          new AgentPreflightError({
            ...base(),
            code: codeForSpawnError(err),
            errno: err.code
          })
        )
      );
    });
    child.once("exit", (exitCode, signal) => {
      finish(() => {
        if (signal) {
          reject(
            new AgentPreflightError({
              ...base(),
              code: "agent-version-check-signaled",
              exitCode,
              signal
            })
          );
          return;
        }
        if (exitCode !== 0) {
          reject(
            new AgentPreflightError({
              ...base(),
              code: "agent-version-check-nonzero-exit",
              exitCode,
              signal
            })
          );
          return;
        }
        const version = (stdout.trim() || stderr.trim()).split("\n")[0]?.trim();
        if (!version) {
          reject(
            new AgentPreflightError({
              ...base(),
              code: "agent-version-check-empty-output",
              exitCode,
              signal
            })
          );
          return;
        }
        resolve(version);
      });
    });
  });
}
function codeForSpawnError(err) {
  if (err.code === "ENOENT") return "agent-binary-not-found";
  if (err.code === "EACCES" || err.code === "EPERM") return "agent-binary-not-executable";
  return "agent-version-check-spawn-failed";
}
function summaryForDiagnostic(diagnostic) {
  return `${diagnostic.agentName} preflight failed: ${diagnostic.code}`;
}
function excerpt(value) {
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 500) : void 0;
}

// src/agent/hermes/acp-client.ts
import { createInterface } from "readline";
import { spawn } from "child_process";
var AcpConnection = class {
  child;
  rl;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  updateHandlers = /* @__PURE__ */ new Set();
  closed = false;
  constructor(binary, args) {
    this.child = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      this.dispatch(msg);
    });
    this.child.stderr.on("data", () => {
    });
    this.child.on("error", (err) => {
      this.rejectAll(err);
    });
    this.child.on("exit", () => {
      this.closed = true;
      this.rejectAll(new Error("hermes acp process exited"));
    });
  }
  get pid() {
    return this.child.pid;
  }
  get exited() {
    return this.closed || this.child.exitCode !== null || this.child.signalCode !== null;
  }
  onUpdate(handler) {
    this.updateHandlers.add(handler);
    return () => this.updateHandlers.delete(handler);
  }
  onStderr(handler) {
    this.child.stderr.on("data", handler);
  }
  dispatch(msg) {
    if (!msg || typeof msg !== "object") return;
    const m = msg;
    if (typeof m.id === "number" && this.pending.has(m.id)) {
      const entry = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) {
        entry.reject(new Error(JSON.stringify(m.error).slice(0, 300)));
      } else {
        entry.resolve(m.result);
      }
      return;
    }
    if (m.method === "session/update") {
      const update = m.params?.update;
      if (update) {
        for (const h of [...this.updateHandlers]) h(update);
      }
    }
  }
  request(method, params) {
    if (this.closed || this.child.exitCode !== null) {
      return Promise.reject(new Error("hermes acp process is not running"));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }
  rejectAll(err) {
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
  }
  async initialize() {
    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: {} }
    });
  }
  async newSession(cwd, opts = {}) {
    const params = {
      cwd,
      mcpServers: [],
      clientCapabilities: { fs: {} }
    };
    if (opts.resumeSessionId) params.resumeSessionId = opts.resumeSessionId;
    const result = await this.request("session/new", params);
    const sessionId = String(result?.sessionId ?? "");
    if (!sessionId) throw new Error("session/new returned no sessionId");
    return { sessionId, models: { availableModels: result?.models?.availableModels } };
  }
  /**
   * Send one prompt and wait for its own response (the turn-complete
   * signal). All `session/update` notifications received while the prompt is
   * in flight are collected and returned alongside the response
   * (`stopReason` / `usage`).
   */
  async prompt(sessionId, text) {
    const params = {
      sessionId,
      prompt: [{ type: "text", text }],
      mcpServers: [],
      clientCapabilities: { fs: {} }
    };
    const resultPromise = this.request("session/prompt", params);
    const updates = [];
    const off = this.onUpdate((u) => updates.push(u));
    try {
      const result = await resultPromise;
      return { updates, result };
    } finally {
      off();
    }
  }
  async stop() {
    if (this.closed || this.child.exitCode !== null) return;
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method: "session/stop", params: {} }) + "\n");
    } catch {
    }
  }
  kill(signal = "SIGTERM") {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try {
        this.child.kill(signal);
      } catch {
      }
    }
  }
  waitForExit(timeoutMs) {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.removeListener("exit", onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.child.once("exit", onExit);
    });
  }
};

// src/agent/bridge-system-prompt.ts
var BRIDGE_SYSTEM_PROMPT = `# feishu-agent-bridge \u8FD0\u884C\u7EA6\u5B9A

\u4F60\u6B63\u5728 feishu-agent-bridge \u91CC\u8DD1\uFF1A\u628A\u98DE\u4E66/Lark \u7528\u6237\u6D88\u606F\u6865\u5230\u672C\u5730 agent CLI\u3002

## bridge_context

\u6BCF\u6761 user message \u9876\u90E8\u4F1A\u5E26\u4E00\u4E2A \`<bridge_context>\` \u5757\uFF1A

\`\`\`
<bridge_context>
{"chatId":"oc_xxx","chatType":"p2p","senderId":"ou_xxx","senderName":"...",
 "senderType":"user|bot","botOpenId":"ou_xxx","mentions":[{"openId":"ou_xxx","name":"...","isBot":true}], ...}
</bridge_context>
\`\`\`

\u91CC\u9762\u662F\u5F53\u524D\u5BF9\u8BDD\u7684 chat_id\u3001chat \u7C7B\u578B\uFF08p2p / group\uFF09\u3001\u53D1\u9001\u8005\u3002\u5173\u952E\u5B57\u6BB5\uFF1A

- \`senderType\`\uFF1A\u53D1\u9001\u8005\u662F\u4EBA\uFF08\`user\`\uFF09\u8FD8\u662F\u53E6\u4E00\u4E2A bot\uFF08\`bot\`\uFF09\uFF1B\u7F3A\u7701\u8868\u793A\u672A\u77E5
- \`botOpenId\`\uFF1A**\u4F60\u81EA\u5DF1**\u7684 open_id
- \`mentions\`\uFF1A\u8FD9\u6761\u6D88\u606F @ \u5230\u7684\u8D26\u53F7\u5217\u8868\uFF08\u542B open_id \u548C isBot\uFF09\uFF0C\u9700\u8981 @ \u67D0\u4EBA/\u67D0 bot \u65F6\u4ECE\u8FD9\u91CC\u53D6 id

\u591A\u6761\u6D88\u606F\u5728\u77ED\u65F6\u95F4\u5185\u5408\u5E76\u9001\u8FBE\u65F6\uFF0C\`user_input\` \u91CC\u6BCF\u6BB5\u4F1A\u5E26 \`[\u540D\u5B57 (user|bot)]:\` \u884C\u9996\u6807\u6CE8\u4EE5\u533A\u5206\u53D1\u9001\u8005\u2014\u2014\u8FD9\u662F bridge \u6CE8\u5165\u7684\u5C55\u793A\u683C\u5F0F\uFF0C**\u4F60\u56DE\u590D\u65F6\u4E0D\u8981\u6A21\u4EFF\u8FD9\u79CD\u6807\u6CE8**\u3002\u8FD9\u4E9B\u90FD\u662F bridge \u6CE8\u5165\u7684\u5143\u6570\u636E\uFF0C**\u4E0D\u8981\u7167\u6284\u3001\u4E0D\u8981\u5728\u4F60\u7684\u56DE\u590D\u91CC\u6E32\u67D3**\u2014\u2014\u5B83\u5BF9\u7528\u6237\u4E0D\u53EF\u89C1\u3002

## \u4E0E\u5176\u4ED6 bot \u534F\u4F5C\uFF08bot-at-bot\uFF09

- \u81EA\u6211\u8BC6\u522B\uFF1A\`bridge_context.botOpenId\` \u662F\u4F60\u81EA\u5DF1\u7684 open_id\uFF1B\u6D88\u606F\u5185\u5BB9\u6216 mentions \u91CC\u51FA\u73B0\u8FD9\u4E2A id \u5C31\u662F\u6307\u4F60\u81EA\u5DF1\u3002
- \u98DE\u4E66\u673A\u5236\uFF1Abot **\u53EA\u6709\u88AB\u771F\u5B9E @\uFF08\u7ED3\u6784\u5316 mention\uFF09\u624D\u80FD\u6536\u5230\u7FA4\u6D88\u606F**\u3002\u7EAF\u6587\u672C\u5199 "@\u540D\u5B57"\u3001\u6216\u4E0D\u5E26 @ \u7684\u666E\u901A\u56DE\u590D\uFF0C\u5176\u4ED6 bot \u4E00\u5F8B\u6536\u4E0D\u5230\u3002\u8FD9\u6761\u9650\u5236\u53EA\u9488\u5BF9 bot\u2014\u2014\u4EBA\u7C7B\u7528\u6237\u80FD\u770B\u5230\u7FA4\u91CC\u6240\u6709\u6D88\u606F\uFF0C\u56DE\u590D\u4EBA\u7C7B\u4E0D\u9700\u8981 @\u3002
- \u9700\u8981\u67D0\u4E2A bot \u63A5\u7740\u5904\u7406\u65F6\uFF0C\u5FC5\u987B\u771F\u5B9E @ \u5B83\uFF08open_id \u4F18\u5148\u4ECE \`bridge_context.mentions\` \u91CC\u53D6\uFF09\u3002\u9664\u6B64\u4E4B\u5916**\u9ED8\u8BA4\u4E0D\u8981 @ \u5176\u4ED6 bot**\u2014\u2014\u4E92\u76F8 @ \u4F1A\u5F62\u6210\u6B7B\u5FAA\u73AF\uFF1B\u7528\u6237\u660E\u786E\u8981\u6C42\u8F6C\u4EA4/\u901A\u77E5\u67D0\u4E2A bot \u65F6\u6309\u8981\u6C42\u6267\u884C\u3002
- \u4E0E\u5176\u4ED6 bot \u5BF9\u8BDD\u65F6\uFF0C\u6CA1\u6709\u65B0\u4FE1\u606F\u8981\u8865\u5145\u5C31\u7B80\u77ED\u6536\u5C3E\uFF0C\u4E0D\u8981\u8FFD\u95EE\u3001\u4E0D\u8981\u5BA2\u5957\u5F80\u8FD4\u3002

## quoted_message

\u5982\u679C\u7528\u6237\u7528"\u5F15\u7528\u56DE\u590D"\u6307\u5411\u67D0\u6761\u6D88\u606F\uFF0Cbridge \u4F1A\u5728 \`<bridge_context>\` \u540E\u6CE8\u5165\u4E00\u4E2A \`<quoted_message>\` \u5757\uFF1A

\`\`\`
<quoted_message id="om_xxx" sender_id="ou_xxx" sender_name="..." created_at="..." type="text|merge_forward|...">
\uFF08\u88AB\u5F15\u7528\u6D88\u606F\u7684\u5185\u5BB9\uFF1Bmerge_forward \u7C7B\u578B\u4F1A\u5C55\u5F00\u6210 <forwarded_messages>...</forwarded_messages>\uFF09
</quoted_message>
\`\`\`

\u8FD9\u662F\u7528\u6237**\u6307\u5411\u7684\u5BF9\u8C61**\u2014\u2014\u7528\u6237\u7684\u5B9E\u9645\u95EE\u9898\u5728\u5B83\u4E4B\u540E\u3002\u56DE\u7B54\u65F6\u56F4\u7ED5\u8FD9\u6BB5\u5185\u5BB9\u5C55\u5F00\uFF1B\u5B83\u4E5F\u662F bridge \u6CE8\u5165\u7684\u5143\u6570\u636E\uFF0C**\u4E0D\u8981\u7167\u6284 XML \u6807\u7B7E**\u5230\u56DE\u590D\u91CC\u3002

## interactive_card

\u7528\u6237\u53D1 / \u5F15\u7528\u4EA4\u4E92\u5361\u7247\u65F6,bridge \u4F1A\u628A\u5361\u7684\u771F\u5B9E JSON \u6CE8\u5165\u5230 \`<interactive_card>\` \u5757:

\`\`\`
<interactive_card>
{ "schema": "2.0", "config": { ... }, "body": { ... } }
</interactive_card>
\`\`\`

\u4E24\u79CD\u6765\u6E90:

- **v2 CardKit (schema 2.0)**:\u98DE\u4E66\u5728 raw event \u91CC\u53CC\u53D1\u2014\u2014\`elements\` \u662F v1 \u517C\u5BB9\u964D\u7EA7("\u8BF7\u5347\u7EA7\u81F3\u6700\u65B0\u7248\u672C\u5BA2\u6237\u7AEF"),\`user_dsl\` \u662F\u771F\u6B63\u7684 schema 2.0 DSL\u3002bridge \u4F18\u5148\u53D6 \`user_dsl\`,\u6240\u4EE5\u4F60\u770B\u5230\u7684\u5C31\u662F**\u771F\u5361\u5185\u5BB9**,\u4E0D\u8981\u88AB elements \u7684\u964D\u7EA7\u6587\u6848\u8BEF\u5BFC
- **\u96F6\u6587\u5B57 v1 \u5361**:\u7EAF\u6309\u94AE / \u56FE\u7247 / \u88C5\u9970\u5361,SDK \u6241\u5E73\u5316\u6293\u4E0D\u5230\u5B57\u65F6,bridge \u628A\u6574\u6BB5 raw JSON \u704C\u8FDB\u6765

\u65E0\u8BBA\u54EA\u79CD,\u5757\u91CC\u90FD\u662F\u5361\u7684\u5B8C\u6574 JSON\u3002\u89E3\u6790\u5B83\u6765\u7406\u89E3\u7ED3\u6784(\u6309\u94AE\u3001\u5B57\u6BB5\u3001\u5E03\u5C40)\u3002**\u4E0D\u8981\u7167\u6284 XML \u6807\u7B7E\u5230\u56DE\u590D**\u2014\u2014\u5BF9\u7528\u6237\u4E0D\u53EF\u89C1\u3002

## \u53D1\u4EA4\u4E92\u5361\u7247\uFF08\u6309\u94AE\u3001\u8868\u5355\uFF09\u7684\u56DE\u8C03\u7EA6\u5B9A

\u4F60\u60F3\u53D1\u4E00\u5F20\u53EF\u4EA4\u4E92\u7684\u5361\u7247\u8BA9\u7528\u6237\u70B9\u9009\u65F6\uFF1A

1. \u7528 \`lark-cli\` \u628A\u5361\u53D1\u5230 \`bridge_context.chat_id\`\uFF1A
   \`lark-cli im send-card --chat-id <chat_id> --card '<json>'\`
2. \u5361\u7247\u7528 CardKit 2.0 schema\uFF08\`schema: "2.0"\`\uFF09\u3002
3. **\u5982\u679C\u4F60\u5E0C\u671B\u7528\u6237\u70B9\u6309\u94AE\u540E\u56DE\u8C03\u5230\u4F60\uFF08\u8BA9\u4F60\u5728\u540C\u4E00\u4F1A\u8BDD\u91CC\u7EE7\u7EED\u5904\u7406\uFF09**\uFF1A
   - \u6309\u94AE\u7684 \`value\` \u5BF9\u8C61**\u5FC5\u987B**\u540C\u65F6\u5305\u542B \`__bridge_cb: true\` \u548C \`bridge_token: "<signed token>"\`\u3002
   - \`bridge_token\` \u5FC5\u987B\u7531 bridge-aware \u7684 lark-cli \u56DE\u8C03\u7B7E\u540D\u80FD\u529B\u751F\u6210\uFF1B\u4E0D\u8981\u731C\u6D4B\u3001\u4F2A\u9020\u3001\u590D\u7528\u6216\u624B\u5199 token\u3002
   - \u5982\u679C\u5F53\u524D lark-cli \u4E0D\u80FD\u751F\u6210 \`bridge_token\`\uFF0C\u4E0D\u8981\u53D1\u9001\u56DE\u8C03\u6309\u94AE\u3002\u6539\u6210\u666E\u901A\u5C55\u793A\u5361\uFF0C\u8BA9\u7528\u6237\u7528\u6587\u5B57\u56DE\u590D\u9009\u62E9\u3002
   - \u540C\u65F6\u53EF\u4EE5\u585E\u4EFB\u610F\u5176\u5B83\u5B57\u6BB5\uFF0C\u4F5C\u4E3A\u4F60\u9700\u8981\u5728\u56DE\u8C03\u65F6\u8BB0\u4F4F\u7684\u72B6\u6001\uFF08\u6BD4\u5982 \`choice\`\u3001\`ticket_id\`\uFF09\u3002
4. \u7528\u6237\u70B9\u51FB\u540E\uFF0Cbridge \u4F1A\u6821\u9A8C \`bridge_token\`\uFF0C\u7136\u540E\u628A payload\uFF08\u53BB\u6389 \`__bridge_cb\` \u548C \`bridge_token\`\uFF09\u4F5C\u4E3A \`[card-click] {...}\` \u6D88\u606F\u53D1\u56DE\u7ED9\u4F60\uFF1B\u4F60\u7684 session \u81EA\u52A8\u7EED\u4E0A\uFF0C\u80FD\u770B\u5230\u81EA\u5DF1\u4E0A\u8F6E\u53D1\u4E86\u4EC0\u4E48\u5361\u3002
5. **\u5982\u679C\u53EA\u662F\u5C55\u793A\u5361\uFF08\u4E0D\u9700\u8981\u56DE\u8C03\uFF09**\uFF0C\u4E0D\u8981\u52A0 \`__bridge_cb\` \u6216 \`bridge_token\`\uFF0C\u5426\u5219\u70B9\u51FB\u4F1A\u88AB\u5F53\u6210\u56DE\u8C03\u5E76\u8981\u6C42\u7B7E\u540D\u3002

\u793A\u4F8B button\uFF1A
\`\`\`json
{
  "tag": "button",
  "text": { "tag": "plain_text", "content": "\u65B9\u6848 A" },
  "behaviors": [{
    "type": "callback",
    "value": {
      "__bridge_cb": true,
      "bridge_token": "SIGNED_TOKEN_FROM_LARK_CLI",
      "choice": "a"
    }
  }]
}
\`\`\`

## lark-cli \u8FD0\u884C\u73AF\u5883

bridge \u4F1A\u7ED9\u4F60\u7684\u5B50\u8FDB\u7A0B\u6CE8\u5165\u5F53\u524D\u8FD0\u884C profile \u7684\u73AF\u5883\u53D8\u91CF:

- \`LARK_CHANNEL=1\`
- \`LARK_CHANNEL_HOME\`: \u5F53\u524D bridge \u7684\u914D\u7F6E\u6839\u76EE\u5F55
- \`LARK_CHANNEL_PROFILE\`: \u5F53\u524D bridge profile
- \`LARK_CHANNEL_CONFIG\`: \u5F53\u524D profile \u7684 lark-cli source projection
- \`LARKSUITE_CLI_CONFIG_DIR\`: \u5F53\u524D profile \u7684 lark-cli \u79C1\u6709\u914D\u7F6E\u76EE\u5F55

\u56E0\u6B64\u666E\u901A \`lark-cli ...\` \u547D\u4EE4\u4F1A\u81EA\u52A8\u8FDB\u5165\u5F53\u524D lark-channel \u5DE5\u4F5C\u533A,\u8BFB\u53D6\u5F53\u524D profile \u7684\u79C1\u6709 lark-cli \u914D\u7F6E\u3002\u4E0D\u8981 unset \`LARK_CHANNEL\` / \`LARK_CHANNEL_HOME\` / \`LARK_CHANNEL_PROFILE\` / \`LARKSUITE_CLI_CONFIG_DIR\`,\u4E5F\u4E0D\u8981\u7528 \`env -u LARK_CHANNEL\` \u7ED5\u56DE\u672C\u673A\u666E\u901A\u914D\u7F6E\u3002

\u5982\u679C \`lark-cli\` \u63D0\u793A \`lark-channel context detected but lark-cli is not bound to it\`,\u4E0D\u8981\u6539\u7528\u666E\u901A profile,\u4E0D\u8981\u76F4\u63A5\u8BFB\u53D6 \`config.json\` \u91CC\u7684\u8D26\u53F7\u6216\u5BC6\u94A5,\u4E5F\u4E0D\u8981\u81EA\u884C\u6267\u884C bind\u3002\u505C\u6B62\u5F53\u524D\u64CD\u4F5C\u5E76\u8BF7\u7528\u6237\u91CD\u542F bridge \u6216\u8FD0\u884C bridge doctor/preflight\u3002

\u914D\u7F6E\u6587\u4EF6\u53EF\u80FD\u662F\u591A profile \u7ED3\u6784,\u4E0D\u8981\u5047\u8BBE\u6839\u5C42\u4E00\u5B9A\u6709\u65E7\u7248\u5355 profile \u7684 \`accounts.app\`;\u786E\u5B9E\u9700\u8981\u8BFB\u53D6\u914D\u7F6E\u65F6\u6309\u5F53\u524D profile \u53D6\u503C,\u4E14\u4E0D\u8981\u8F93\u51FA\u5BC6\u94A5\u3002

## \u98DE\u4E66 OAuth \u6388\u6743\uFF08\`lark-cli auth login\`\uFF09

\u6388\u6743\u6D41\u7A0B\u8981\u8BA9 \`lark-cli\` \u8FDB\u7A0B\u4E00\u76F4\u6D3B\u5230\u7528\u6237\u5728\u6D4F\u89C8\u5668\u91CC\u70B9\u5B8C\u4E3A\u6B62\u3002bridge \u5728\u4F60\u7684 run \u7ED3\u675F\u4E4B\u540E\u4F1A\u56DE\u6536 agent \u5B50\u8FDB\u7A0B\uFF0C**\u4F60 spawn \u7684\u4EFB\u4F55\u540E\u53F0 bash \u4E5F\u4F1A\u8DDF\u7740\u6B7B**\u2014\u2014\u6240\u4EE5\u6388\u6743\u5FC5\u987B\u7528"\u524D\u53F0\u963B\u585E"\u7684\u65B9\u5F0F\u8DD1\uFF1A

1. **\u4EC5\u5728 p2p \u91CC\u53D1\u8D77\u6388\u6743**\u3002\u4ECE \`bridge_context.chat_type\` \u770B\uFF1A
   - \`chat_type: p2p\` \u2014\u2014 \u6B63\u5E38\u6309\u4E0B\u9762\u6D41\u7A0B\u8D70\u3002
   - \`chat_type: group\`\uFF08\u542B topic \u7FA4\uFF09\u2014\u2014 **\u4E0D\u8981**\u8C03 \`lark-cli auth login\`\u3002device flow \u628A \`verification_url\` \u53D1\u5230\u7FA4\u91CC\uFF0C\u8C01\u5148\u70B9\u8C01\u62FF\u8D70 token\u2014\u2014\u4F1A\u7ED1\u5B9A\u5230\u9519\u7684\u8EAB\u4EFD\u3002\u6B63\u786E\u505A\u6CD5\u662F\u56DE\u590D\u7528\u6237\uFF1A"\u6388\u6743\u8981\u5728\u79C1\u804A\u91CC\u505A\uFF0C\u8BF7\u5355\u72EC\u79C1\u4FE1\u6211\u3002"
2. **\u7981\u6B62** \u7528 \`run_in_background: true\` \u8C03 \`lark-cli auth login\`\u2014\u2014\u5B83\u4F1A\u88AB\u4F60 exit \u65F6\u4E00\u8D77\u5E26\u8D70\uFF0C\u7528\u6237\u8FD8\u6CA1\u70B9\u5B8C\u5C31\u4E22\u4E86\u3002
3. **\u63A8\u8350\u4E24\u9636\u6BB5\u6D41**\uFF08lark-cli \u5728 \`--no-wait\` \u7684\u8F93\u51FA\u91CC\u4E5F\u4F1A\u544A\u8BC9\u4F60\u8FD9\u5957\uFF09\uFF1A
   - \u5148\u8DD1 \`lark-cli auth login --no-wait --json [--recommend | --domain ... | --scope ...]\`\uFF0C**\u8FD9\u4E00\u6B65\u79D2\u8FD4\u56DE**\uFF0Cstdout \u91CC\u6709 \`verification_url\` \u548C \`device_code\`\u3002
   - \u628A \`verification_url\` **\u539F\u6837**\u7528\u4EE3\u7801\u5757\u53D1\u7ED9\u7528\u6237\uFF08\u4E0D\u8981 Markdown \u94FE\u63A5\u5316\u3001\u4E0D\u8981 URL \u7F16\u7801\uFF09\u3002
   - \u7D27\u63A5\u7740\u540C\u4E00\u8F6E\u91CC\u8DD1 \`lark-cli auth login --device-code <code>\`\uFF0C**\u8FD9\u4E00\u6B65\u524D\u53F0\u963B\u585E**\u76F4\u5230\u7528\u6237\u70B9\u5B8C\u6216 10 \u5206\u949F\u8D85\u65F6\u2014\u2014\u8FD9\u662F\u4F60\u5E94\u8BE5\u7B49\u7684\u5730\u65B9\uFF0C\u4E0D\u8981\u4E22\u5230\u540E\u53F0\u3002
4. \`lark-cli auth login --device-code <code>\` \u6210\u529F\u540E,\u7EE7\u7EED\u5728\u540C\u4E00\u4E2A\u5F53\u524D profile \u73AF\u5883\u91CC\u6267\u884C:
   - \`lark-cli config strict-mode off\`
   - \`lark-cli config default-as auto\`
   \u8FD9\u4F1A\u8BA9\u5F53\u524D profile \u540C\u65F6\u53EF\u7528\u5E94\u7528\u8EAB\u4EFD\u548C\u5DF2\u6388\u6743\u7528\u6237\u8EAB\u4EFD\u3002\u4E0D\u8981\u91CD\u65B0 bind,\u4E0D\u8981\u7ED5\u56DE\u672C\u673A\u666E\u901A\u914D\u7F6E\u3002
   \u8FD9\u662F\u5185\u90E8\u987A\u5E8F\u6267\u884C\u8EAB\u4EFD\u7B56\u7565\u6536\u655B,\u4E0D\u8981\u628A strict-mode/default-as \u8FD9\u7C7B\u5185\u90E8\u914D\u7F6E\u547D\u4EE4\u5C55\u793A\u7ED9\u7528\u6237,\u4E5F\u4E0D\u8981\u8BA9\u7528\u6237\u5224\u65AD\u8FD9\u4E9B\u547D\u4EE4\u3002\u9762\u5411\u7528\u6237\u53EA\u8BF4\uFF1A"\u5F53\u524D profile \u8FD8\u6CA1\u6709\u53EF\u7528\u7684\u7528\u6237\u8EAB\u4EFD\u6388\u6743,\u8BF7\u6253\u5F00\u4E0B\u9762\u94FE\u63A5\u5B8C\u6210\u6388\u6743;\u6388\u6743\u5B8C\u6210\u540E\u6211\u4F1A\u7EE7\u7EED\u5904\u7406\u3002"
5. \u5982\u679C\u5F53\u524D profile \u5DF2\u7ECF\u6709\u7528\u6237\u6388\u6743,\u4F46 \`--as user\` \u4ECD\u88AB strict-mode/default-as \u62D2\u7EDD,\u4E0D\u8981\u5411\u7528\u6237\u5C55\u793A\u5185\u90E8\u547D\u4EE4;\u5728\u7528\u6237\u660E\u786E\u8981\u6C42\u4F7F\u7528\u7528\u6237\u8EAB\u4EFD\u65F6,\u5185\u90E8\u987A\u5E8F\u6267\u884C\u8EAB\u4EFD\u7B56\u7565\u6536\u655B\u540E\u91CD\u8BD5\u539F\u547D\u4EE4\u3002
6. \u4F60\u524D\u53F0\u963B\u585E\u671F\u95F4\uFF0C\u7528\u6237\u53D1\u7684\u65B0\u6D88\u606F bridge \u4F1A\u81EA\u52A8\u6392\u961F\uFF0C**\u4E0D\u4F1A\u6253\u65AD\u4F60**\uFF1B\u7B49\u4F60 tool_result \u4E00\u56DE\u6765\uFF0C\u4E0B\u4E00\u6279\u6D88\u606F\u518D\u8FDB\u6765\u3002\u6240\u4EE5\u653E\u5FC3\u963B\u585E\u3002
7. \u5982\u679C\u7528\u6237\u4E2D\u9014\u60F3\u53D6\u6D88\uFF0C\u4ED6\u4EEC\u4F1A\u53D1 \`/stop\`\u2014\u2014\u90A3\u65F6\u88AB kill \u662F\u9884\u671F\u884C\u4E3A\uFF0C\u4E0D\u7528\u515C\u5E95\u3002
`;
function buildBridgeSystemPrompt(identity) {
  if (!identity?.openId) return BRIDGE_SYSTEM_PROMPT;
  const nameSuffix = identity.name ? `\uFF0C\u540D\u5B57\u662F\u300C${identity.name}\u300D` : "";
  return `${BRIDGE_SYSTEM_PROMPT}
## \u4F60\u7684\u8EAB\u4EFD

\u4F60\u7684 open_id \u662F \`${identity.openId}\`${nameSuffix}\u3002\u6D88\u606F\u5185\u5BB9\u6216 mentions \u91CC\u51FA\u73B0\u8FD9\u4E2A open_id \u90FD\u662F\u6307\u4F60\u81EA\u5DF1\u3002
`;
}
function prefixBridgeSystemPrompt(prompt, identity) {
  return `${buildBridgeSystemPrompt(identity)}

## user_message

${prompt}`;
}

// src/agent/hermes/adapter.ts
var HermesAdapter = class {
  id = "hermes";
  displayName = "Hermes Agent";
  binary;
  acpArgs;
  larkChannel;
  defaultStopGraceMs;
  botIdentity;
  constructor(opts = {}) {
    this.binary = opts.binary ?? "hermes";
    this.acpArgs = opts.acpArgs ?? [];
    this.larkChannel = opts.larkChannel;
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5e3;
  }
  setBotIdentity(identity) {
    this.botIdentity = identity;
  }
  async isAvailable() {
    return (await this.checkAvailability()).ok;
  }
  async checkAvailability() {
    return checkAgentAvailability({
      agentId: "hermes",
      agentName: "Hermes Agent",
      command: this.binary,
      binaryPath: this.binary
    });
  }
  run(opts) {
    if (!opts.cwd) {
      throw new Error("cwd is required for HermesAdapter.run");
    }
    const args = [...this.acpArgs, "acp"];
    log.info("agent", "spawn", {
      binary: this.binary,
      args,
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model
    });
    const child = new AcpConnection(this.binary, args);
    const stderrChunks = [];
    child.onStderr((chunk) => {
      stderrChunks.push(chunk);
      const text = chunk.toString("utf8").trim();
      if (text) log.warn("agent", "stderr", { line: text.slice(0, 300) });
    });
    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;
    let stopReason;
    return {
      runId: opts.runId,
      events: createEventStream({
        child,
        cwd: opts.cwd,
        prompt: prefixBridgeSystemPrompt(opts.prompt, this.botIdentity),
        resumeSessionId: opts.sessionId,
        stderrChunks,
        getStopReason: () => stopReason
      }),
      async stop() {
        if (child.exited) return;
        stopReason = "interrupted";
        log.info("agent", "stop-sigterm", { pid: child.pid ?? null, graceMs: stopGraceMs });
        await child.stop().catch(() => void 0);
        child.kill("SIGTERM");
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (!child.exited) {
              log.warn("agent", "stop-sigkill", {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: "grace-period-expired"
              });
              child.kill("SIGKILL");
            }
            resolve();
          }, stopGraceMs);
          void child.waitForExit(stopGraceMs).then((exited) => {
            if (exited) {
              clearTimeout(timer);
              resolve();
            }
          });
        });
      },
      waitForExit(timeoutMs) {
        return child.waitForExit(timeoutMs);
      }
    };
  }
};
async function* createEventStream(ctx) {
  const { child } = ctx;
  if (!child.pid) {
    yield {
      type: "error",
      message: `failed to spawn hermes acp (no pid)`,
      terminationReason: "failed"
    };
    return;
  }
  let sessionId;
  let finalText = "";
  let terminalEmitted = false;
  const diag = { thinking: 0, toolUse: 0, toolResult: 0 };
  const emitError = (message) => ({
    type: "error",
    message,
    terminationReason: "failed"
  });
  try {
    await child.initialize();
  } catch (err) {
    yield emitError(`hermes acp initialize failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  try {
    const info = await child.newSession(ctx.cwd, {
      ...ctx.resumeSessionId ? { resumeSessionId: ctx.resumeSessionId } : {}
    });
    sessionId = info.sessionId;
    yield { type: "system", sessionId, cwd: ctx.cwd };
  } catch (err) {
    yield emitError(`hermes session/new failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  let promptResult;
  try {
    const { updates, result } = await child.prompt(sessionId, ctx.prompt);
    promptResult = result;
    for (const update of updates) {
      for (const ev of translateUpdate(update)) {
        if (ev.type === "text") {
          finalText += ev.delta;
          continue;
        }
        if (ev.type === "thinking") diag.thinking++;
        if (ev.type === "tool_use") diag.toolUse++;
        if (ev.type === "tool_result") diag.toolResult++;
        yield ev;
      }
    }
    log.info("agent", "hermes-events", { sessionId, thinking: diag.thinking, toolUse: diag.toolUse, toolResult: diag.toolResult });
  } catch (err) {
    if (ctx.getStopReason()) {
      yield { type: "done", sessionId, terminationReason: "interrupted" };
      terminalEmitted = true;
    } else {
      yield emitError(`hermes prompt failed: ${err instanceof Error ? err.message : String(err)}`);
      terminalEmitted = true;
    }
  }
  if (!terminalEmitted) {
    const stopReason = ctx.getStopReason();
    if (stopReason) {
      yield { type: "done", sessionId, terminationReason: stopReason };
    } else {
      const usage = promptResult?.usage;
      const events = [];
      if (finalText.trim()) {
        events.push({ type: "final_text", content: finalText });
      }
      if (usage) {
        events.push({
          type: "usage",
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd: void 0
        });
      }
      events.push({ type: "done", sessionId, terminationReason: "normal" });
      yield* events;
    }
  }
}
function translateUpdate(update) {
  const kind = update.sessionUpdate;
  const events = [];
  switch (kind) {
    case "agent_thought_chunk": {
      const text = update.content?.text;
      if (text) events.push({ type: "thinking", delta: text });
      break;
    }
    case "agent_message_chunk": {
      const text = update.content?.text;
      if (text) events.push({ type: "text", delta: text });
      break;
    }
    case "tool_call": {
      const id = String(update.toolCallId ?? "");
      const name = String(update.kind ?? update.title ?? "tool");
      const input = update.content;
      if (id) events.push({ type: "tool_use", id, name, input });
      break;
    }
    case "tool_call_update": {
      const id = String(update.toolCallId ?? "");
      if (id) {
        const isError = update.status !== "completed";
        const raw = update.content;
        let output = "";
        if (Array.isArray(raw)) {
          output = raw.map((c) => {
            if (!c || typeof c !== "object") return "";
            const part = c;
            const inner = part.content;
            return String(inner?.text ?? "");
          }).join("\n");
        } else if (raw && typeof raw === "object") {
          const obj = raw;
          const inner = obj.content;
          if (inner && typeof inner === "object") {
            output = String(inner.text ?? "");
          } else {
            output = String(obj.text ?? "");
          }
        }
        events.push({ type: "tool_result", id, output, isError });
      }
      break;
    }
    default:
      break;
  }
  return events;
}
export {
  HermesAdapter
};
