// src/ui/qr-register.ts
import { randomBytes as randomBytes3 } from "crypto";
import { registerApp } from "@larksuite/channel";

// src/config/app-paths.ts
import { homedir } from "os";
import { join } from "path";
var DEFAULT_PROFILE = "claude";
function resolveAppPaths(opts = {}) {
  const rootDir = opts.rootDir ?? process.env.LARK_CHANNEL_HOME ?? join(homedir(), ".lark-channel");
  const profile = normalizeProfileName(opts.profile ?? DEFAULT_PROFILE);
  const profileDir = join(rootDir, "profiles", profile);
  const registryDir = join(rootDir, "registry");
  const userLockDir = join(registryDir, "locks");
  return {
    rootDir,
    profile,
    profileDir,
    defaultWorkspaceDir: join(`${rootDir}-workspaces`, profile, "default"),
    configFile: join(rootDir, "config.json"),
    activeProfileFile: join(rootDir, "active-profile"),
    sessionsFile: join(profileDir, "sessions.json"),
    workspacesFile: join(profileDir, "workspaces.json"),
    secretsFile: join(profileDir, "secrets.enc"),
    keystoreSaltFile: join(profileDir, ".keystore.salt"),
    secretsGetterScript: join(rootDir, "secrets-getter"),
    larkCliConfigDir: join(profileDir, "lark-cli"),
    larkCliSourceDir: join(profileDir, "lark-cli-source"),
    larkCliSourceConfigFile: join(profileDir, "lark-cli-source", "config.json"),
    larkCliTargetConfigFile: join(profileDir, "lark-cli", "lark-channel", "config.json"),
    mediaDir: join(profileDir, "media"),
    logsDir: join(profileDir, "logs"),
    uiFile: join(profileDir, "ui.json"),
    hostUiFile: join(rootDir, "ui.json"),
    hostLogsDir: join(rootDir, "logs"),
    hostLockFile: join(userLockDir, "supervisor.lock"),
    registryDir,
    userRegistryFile: join(registryDir, "processes.json"),
    userLockDir,
    profileLockFile: join(userLockDir, "profile", `${profile}.lock`),
    appLockFile: (appId) => join(userLockDir, "app", `${lockSafeName(appId)}.lock`)
  };
}
function normalizeProfileName(profile) {
  const trimmed = profile.trim();
  if (!trimmed) throw new Error("profile name is required");
  if (/[\u0000-\u001f\s/\\:*?"<>|]/.test(trimmed) || trimmed === "." || trimmed === "..") {
    throw new Error(`invalid profile name: ${profile}`);
  }
  return trimmed;
}
function lockSafeName(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

// src/config/profile-store.ts
import { chmod as chmod2, mkdir as mkdir2, readFile, rename, rm as rm2, rmdir, stat, writeFile } from "fs/promises";
import { dirname as dirname2, join as join3 } from "path";
import * as lockfile from "proper-lockfile";

// src/platform/atomic-write.ts
import { randomBytes } from "crypto";
import { chmod, mkdir, open, rm } from "fs/promises";
import { basename, dirname, join as join2 } from "path";
import { promisify } from "util";
import gracefulFs from "graceful-fs";
var gracefulRename = promisify(gracefulFs.rename);
var DEFAULT_RENAME_ATTEMPTS = 5;
var DEFAULT_RETRY_DELAY_MS = 25;
async function writeFileAtomic(path, data, opts = {}) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join2(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`
  );
  try {
    const handle = await open(tmp, "w", opts.mode ?? 384);
    try {
      await handle.writeFile(data);
      try {
        await handle.sync();
      } catch (err) {
        if (!isIgnorableWindowsFsyncError(err)) throw err;
      }
    } finally {
      await handle.close();
    }
    await chmod(tmp, opts.mode ?? 384);
    await renameWithRetry(tmp, path, opts);
    await fsyncDir(dirname(path));
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {
    });
    throw err;
  }
}
async function renameWithRetry(from, to, opts) {
  const maxAttempts = opts.maxRenameAttempts ?? DEFAULT_RENAME_ATTEMPTS;
  const delayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const rename2 = opts.rename ?? ((src, dest, fallback) => fallback(src, dest));
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await rename2(from, to, gracefulRename);
      return;
    } catch (err) {
      lastErr = err;
      if (!isTransientRenameError(err) || attempt === maxAttempts) break;
      await sleep(delayMs * attempt);
    }
  }
  throw lastErr;
}
function isTransientRenameError(err) {
  const code = err?.code;
  return code === "EPERM" || code === "EBUSY";
}
function isIgnorableWindowsFsyncError(err) {
  return process.platform === "win32" && err?.code === "EPERM";
}
async function fsyncDir(path) {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
  }
}
function sleep(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}

// src/config/permissions.ts
var ACCESS_ORDER = {
  "read-only": 0,
  workspace: 1,
  full: 2
};
var CLAUDE_PERMISSION_ACCESS = {
  plan: "read-only",
  default: "workspace",
  acceptEdits: "workspace",
  bypassPermissions: "full"
};
function normalizePermissions(input) {
  const hasSandbox = hasLegacySandbox(input.sandbox);
  const base = hasSandbox ? normalizeLegacySandboxPermissions(input.sandbox) : defaultPermissions();
  if (input.permissions !== void 0) {
    return {
      permissions: normalizeCanonicalPermissions(input.permissions, base),
      source: "permissions"
    };
  }
  return {
    permissions: base,
    source: hasSandbox ? "sandbox" : "default"
  };
}
function assertAccessPair(defaultAccess, maxAccess, source = "permissions") {
  if (ACCESS_ORDER[defaultAccess] > ACCESS_ORDER[maxAccess]) {
    const suffix = source === "sandbox" ? " from sandbox" : "";
    throw new Error(`permission defaultAccess cannot exceed maxAccess${suffix}`);
  }
}
function codexSandboxToAccess(mode) {
  switch (mode) {
    case "read-only":
      return "read-only";
    case "workspace-write":
      return "workspace";
    case "danger-full-access":
      return "full";
    default:
      throw new Error("invalid sandbox mode");
  }
}
function accessToCodexSandbox(access2) {
  switch (access2) {
    case "read-only":
      return "read-only";
    case "workspace":
      return "workspace-write";
    case "full":
      return "danger-full-access";
  }
}
function permissionsToLegacySandbox(permissions) {
  const defaultMode = accessToCodexSandbox(permissions.defaultAccess);
  const maxMode = accessToCodexSandbox(permissions.maxAccess);
  return {
    default: defaultMode,
    max: maxMode,
    defaultMode,
    maxMode
  };
}
function normalizeCanonicalPermissions(input, base) {
  if (!isConfigObject(input)) {
    throw new Error("invalid permission config");
  }
  const explicitMaxAccess = readAccess(input.maxAccess, "maxAccess");
  const explicitDefaultAccess = readAccess(input.defaultAccess, "defaultAccess");
  const maxAccess = explicitMaxAccess ?? base.maxAccess;
  const defaultAccess = explicitDefaultAccess ?? (ACCESS_ORDER[base.defaultAccess] <= ACCESS_ORDER[maxAccess] ? base.defaultAccess : maxAccess);
  assertAccessPair(defaultAccess, maxAccess);
  const claude = normalizeClaudePermissions(input.claude);
  if (claude?.permissionMode) {
    assertClaudePermissionWithinAccess(claude.permissionMode, maxAccess);
  }
  return {
    defaultAccess,
    maxAccess,
    ...claude ? { claude } : {}
  };
}
function defaultPermissions() {
  return {
    defaultAccess: "full",
    maxAccess: "full"
  };
}
function assertClaudePermissionWithinAccess(permissionMode, maxAccess) {
  if (ACCESS_ORDER[CLAUDE_PERMISSION_ACCESS[permissionMode]] > ACCESS_ORDER[maxAccess]) {
    throw new Error("permission claude.permissionMode cannot exceed maxAccess");
  }
}
function normalizeLegacySandboxPermissions(input) {
  if (!isConfigObject(input)) {
    throw new Error("invalid sandbox mode");
  }
  const maxMode = readSandboxMode(input.max ?? input.maxMode, "maxMode") ?? "danger-full-access";
  const defaultMode = readSandboxMode(input.default ?? input.defaultMode, "defaultMode") ?? maxMode;
  const defaultAccess = codexSandboxToAccess(defaultMode);
  const maxAccess = codexSandboxToAccess(maxMode);
  assertAccessPair(defaultAccess, maxAccess, "sandbox");
  return {
    defaultAccess,
    maxAccess
  };
}
function normalizeClaudePermissions(input) {
  if (input === void 0) {
    return void 0;
  }
  if (!isConfigObject(input)) {
    throw new Error("invalid permission claude config");
  }
  if (input.permissionMode === void 0) {
    return void 0;
  }
  if (!isClaudePermissionMode(input.permissionMode)) {
    throw new Error("invalid permission claude.permissionMode");
  }
  return {
    permissionMode: input.permissionMode
  };
}
function hasLegacySandbox(input) {
  if (input === void 0) {
    return false;
  }
  if (!isConfigObject(input)) {
    throw new Error("invalid sandbox mode");
  }
  return input.default !== void 0 || input.max !== void 0 || input.defaultMode !== void 0 || input.maxMode !== void 0;
}
function readAccess(value, field) {
  if (value === void 0) {
    return void 0;
  }
  if (!isAccessMode(value)) {
    throw new Error(`invalid permission ${field}`);
  }
  return value;
}
function readSandboxMode(value, field) {
  if (value === void 0) {
    return void 0;
  }
  if (!isCodexSandboxMode(value)) {
    throw new Error(`invalid sandbox ${field}`);
  }
  return value;
}
function isAccessMode(value) {
  return value === "read-only" || value === "workspace" || value === "full";
}
function isConfigObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isCodexSandboxMode(value) {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}
function isClaudePermissionMode(value) {
  return value === "default" || value === "acceptEdits" || value === "bypassPermissions" || value === "plan";
}

// src/config/profile-schema.ts
function createDefaultProfileConfig(input) {
  return normalizeProfileConfig({
    schemaVersion: 2,
    ...input
  });
}
function normalizeProfileConfig(input) {
  if (!input || typeof input !== "object") {
    throw new Error("profile config must be an object");
  }
  const raw = input;
  if (raw.schemaVersion !== 2) {
    throw new Error("profile schemaVersion must be 2");
  }
  if (raw.agentKind !== "claude" && raw.agentKind !== "codex" && raw.agentKind !== "mimo" && raw.agentKind !== "opencode" && raw.agentKind !== "hermes" && raw.agentKind !== "openclaw") {
    throw new Error("agentKind must be claude, codex, mimo, opencode, hermes, or openclaw");
  }
  const accounts = normalizeAccounts(raw.accounts);
  if (raw.agentKind === "codex" && !raw.codex) {
    throw new Error("codex profile requires codex configuration");
  }
  if (raw.agentKind === "mimo" && !raw.mimo) {
    throw new Error("mimo profile requires mimo configuration");
  }
  if (raw.agentKind === "opencode" && !raw.opencode) {
    throw new Error("opencode profile requires opencode configuration");
  }
  if (raw.agentKind === "hermes" && !raw.hermes) {
    throw new Error("hermes profile requires hermes configuration");
  }
  if (raw.agentKind === "openclaw" && !raw.openclaw) {
    throw new Error("openclaw profile requires openclaw configuration");
  }
  const preferences = normalizePreferences(raw.preferences);
  const access2 = normalizeAccess(
    raw.access ?? raw.preferences?.access,
    raw.preferences?.requireMentionInGroup
  );
  const { permissions, source: permissionSource } = normalizePermissions({
    permissions: raw.permissions,
    sandbox: raw.sandbox
  });
  const sandbox = permissionsToLegacySandbox(permissions);
  const workspaces = normalizeWorkspaces(raw.workspaces);
  const comments = normalizeComments(raw.comments);
  const meeting = normalizeMeeting(raw.meeting);
  const larkCli = normalizeLarkCli(raw.larkCli);
  return {
    schemaVersion: 2,
    agentKind: raw.agentKind,
    mode: raw.mode === "team" ? "team" : "personal",
    accounts,
    ...raw.secrets ? { secrets: raw.secrets } : {},
    preferences,
    access: access2,
    workspaces,
    sandbox,
    permissions,
    permissionSource,
    ...raw.codex ? { codex: normalizeCodex(raw.codex) } : {},
    ...raw.mimo ? { mimo: normalizeMimo(raw.mimo) } : {},
    ...raw.opencode ? { opencode: normalizeOpencode(raw.opencode) } : {},
    ...raw.hermes ? { hermes: normalizeHermes(raw.hermes) } : {},
    ...raw.openclaw ? { openclaw: normalizeOpenClaw(raw.openclaw) } : {},
    attachments: {
      maxCount: numberOr(raw.attachments?.maxCount, 10),
      maxBytes: numberOr(raw.attachments?.maxBytes, 100 * 1024 * 1024),
      maxFileBytes: numberOr(raw.attachments?.maxFileBytes, 25 * 1024 * 1024),
      imageMaxBytes: numberOr(raw.attachments?.imageMaxBytes, 25 * 1024 * 1024),
      cacheTtlMs: numberOr(raw.attachments?.cacheTtlMs, 24 * 60 * 60 * 1e3),
      cacheMaxBytes: numberOr(raw.attachments?.cacheMaxBytes, 512 * 1024 * 1024)
    },
    comments,
    meeting,
    larkCli
  };
}
function normalizeAccounts(input) {
  if (!input || typeof input !== "object") {
    throw new Error("accounts.app is required");
  }
  const accounts = input;
  const app = accounts.app;
  if (!app?.id || !app.secret || app.tenant !== "feishu" && app.tenant !== "lark") {
    throw new Error("accounts.app is incomplete");
  }
  return {
    app: {
      id: app.id,
      secret: app.secret,
      tenant: app.tenant
    }
  };
}
function normalizePreferences(preferences) {
  const {
    access: _access,
    requireMentionInGroup: _mention,
    messageReply,
    ...rest
  } = preferences ?? {};
  if (messageReply !== void 0 && isMessageReply(messageReply)) {
    return {
      ...rest,
      messageReply
    };
  }
  return rest;
}
function isMessageReply(value) {
  return value === "card" || value === "markdown" || value === "text";
}
function normalizeAccess(access2, legacyRequireMentionInGroup) {
  const chatRequireMention = normalizeChatMentionMap(access2?.chatRequireMention);
  return {
    allowedUsers: stringArray(access2?.allowedUsers),
    allowedChats: stringArray(access2?.allowedChats),
    admins: stringArray(access2?.admins),
    requireMentionInGroup: access2?.requireMentionInGroup ?? legacyRequireMentionInGroup ?? true,
    // Omit when empty so configs without per-chat overrides stay clean.
    ...Object.keys(chatRequireMention).length > 0 ? { chatRequireMention } : {}
  };
}
function normalizeChatMentionMap(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out = {};
  for (const [chatId, value] of Object.entries(input)) {
    if (chatId && typeof value === "boolean") out[chatId] = value;
  }
  return out;
}
function normalizeWorkspaces(input) {
  const defaultWorkspace = typeof input?.default === "string" && input.default.trim() ? input.default.trim() : void 0;
  return defaultWorkspace ? { default: defaultWorkspace } : {};
}
function normalizeCodex(input) {
  const codex = {
    binaryPath: input.binaryPath,
    ...typeof input.realpath === "string" ? { realpath: input.realpath } : {},
    ...typeof input.version === "string" ? { version: input.version } : {},
    ...typeof input.sha256 === "string" ? { sha256: input.sha256 } : {},
    ...typeof input.owner === "number" ? { owner: input.owner } : {},
    ...typeof input.mode === "number" ? { mode: input.mode } : {},
    ...typeof input.codexHome === "string" ? { codexHome: input.codexHome } : {},
    inheritCodexHome: input.inheritCodexHome !== false,
    ignoreUserConfig: input.ignoreUserConfig === true,
    ignoreRules: input.ignoreRules !== false
  };
  return codex;
}
function normalizeMimo(input) {
  const mimo = {
    binaryPath: input.binaryPath,
    ...typeof input.realpath === "string" ? { realpath: input.realpath } : {},
    ...typeof input.version === "string" ? { version: input.version } : {},
    ...typeof input.sha256 === "string" ? { sha256: input.sha256 } : {},
    ...typeof input.owner === "number" ? { owner: input.owner } : {},
    ...typeof input.mode === "number" ? { mode: input.mode } : {},
    thinking: input.thinking === true,
    ...typeof input.idleSeconds === "number" && Number.isFinite(input.idleSeconds) ? { idleSeconds: Math.max(0, Math.floor(input.idleSeconds)) } : {}
  };
  return mimo;
}
function normalizeOpencode(input) {
  const opencode = {
    binaryPath: input.binaryPath,
    ...typeof input.realpath === "string" ? { realpath: input.realpath } : {},
    ...typeof input.version === "string" ? { version: input.version } : {},
    ...typeof input.sha256 === "string" ? { sha256: input.sha256 } : {},
    ...typeof input.owner === "number" ? { owner: input.owner } : {},
    ...typeof input.mode === "number" ? { mode: input.mode } : {},
    thinking: input.thinking === true
  };
  return opencode;
}
function normalizeHermes(input) {
  const hermes = {
    binaryPath: input.binaryPath,
    ...typeof input.realpath === "string" ? { realpath: input.realpath } : {},
    ...typeof input.version === "string" ? { version: input.version } : {},
    ...typeof input.sha256 === "string" ? { sha256: input.sha256 } : {},
    ...typeof input.owner === "number" ? { owner: input.owner } : {},
    ...typeof input.mode === "number" ? { mode: input.mode } : {},
    ...Array.isArray(input.acpArgs) ? { acpArgs: input.acpArgs.map(String) } : {}
  };
  return hermes;
}
function normalizeOpenClaw(input) {
  const openclaw = {
    binaryPath: input.binaryPath,
    ...typeof input.realpath === "string" ? { realpath: input.realpath } : {},
    ...typeof input.version === "string" ? { version: input.version } : {},
    ...typeof input.sha256 === "string" ? { sha256: input.sha256 } : {},
    ...typeof input.owner === "number" ? { owner: input.owner } : {},
    ...typeof input.mode === "number" ? { mode: input.mode } : {},
    agentId: input.agentId,
    ...typeof input.thinking === "string" ? { thinking: input.thinking } : {}
  };
  return openclaw;
}
function normalizeComments(_input) {
  return {};
}
var MEETING_DEFAULTS = {
  enabled: false,
  autoJoinOnInvite: false,
  transcript: { keep: 200, stabilizeMs: 0 },
  respondIn: "meeting",
  trigger: "@bot",
  pollIntervalMs: 3e3,
  summaryOnEnd: false,
  summaryTarget: "origin"
};
function normalizeMeeting(input) {
  const raw = input && typeof input === "object" ? input : {};
  const trigger = typeof raw.trigger === "string" && raw.trigger.trim() ? raw.trigger.trim() : MEETING_DEFAULTS.trigger;
  return {
    enabled: raw.enabled === true,
    autoJoinOnInvite: raw.autoJoinOnInvite === true,
    transcript: {
      keep: clampNumber(raw.transcript?.keep, 10, 2e3, MEETING_DEFAULTS.transcript.keep),
      // 0 is meaningful here ("no debounce"), so it can't go through numberOr.
      stabilizeMs: clampNumber(raw.transcript?.stabilizeMs, 0, 3e4, MEETING_DEFAULTS.transcript.stabilizeMs)
    },
    respondIn: raw.respondIn === "im" || raw.respondIn === "both" || raw.respondIn === "meeting" ? raw.respondIn : MEETING_DEFAULTS.respondIn,
    trigger,
    pollIntervalMs: clampNumber(raw.pollIntervalMs, 1e3, 6e4, MEETING_DEFAULTS.pollIntervalMs),
    summaryOnEnd: raw.summaryOnEnd === true,
    summaryTarget: raw.summaryTarget === "owner" || raw.summaryTarget === "origin" ? raw.summaryTarget : MEETING_DEFAULTS.summaryTarget
  };
}
function clampNumber(value, min, max, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
function normalizeLarkCli(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { identityPreset: "bot-only" };
  }
  const raw = input;
  const identityPreset = raw.identityPreset === "user-default" ? "user-default" : "bot-only";
  const localUserImport = normalizeLarkCliUserImport(raw.localUserImport);
  return {
    identityPreset,
    ...localUserImport ? { localUserImport } : {}
  };
}
function normalizeLarkCliUserImport(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return void 0;
  const raw = input;
  if (!isLarkCliUserImportStatus(raw.status)) return void 0;
  return {
    status: raw.status,
    ...typeof raw.attemptedAt === "string" ? { attemptedAt: raw.attemptedAt } : {},
    ...typeof raw.importedAt === "string" ? { importedAt: raw.importedAt } : {},
    ...typeof raw.reason === "string" ? { reason: raw.reason } : {}
  };
}
function isLarkCliUserImportStatus(value) {
  return value === "not-needed" || value === "imported" || value === "skipped-existing-private-user" || value === "skipped-no-local-user" || value === "failed";
}
function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string");
}
function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

// src/config/profile-store.ts
async function loadRootConfig(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return isRootConfig(parsed) ? normalizeRootConfig(parsed) : void 0;
  } catch (err) {
    if (err.code === "ENOENT") return void 0;
    throw err;
  }
}
function normalizeRootConfig(root) {
  const profiles = {};
  for (const [name, profile] of Object.entries(root.profiles)) {
    profiles[name] = normalizeProfileConfig(profile);
  }
  const migrations = normalizeRootMigrations(root.migrations);
  return {
    schemaVersion: 2,
    activeProfile: root.activeProfile,
    preferences: {},
    ...root.secrets ? { secrets: root.secrets } : {},
    ...migrations ? { migrations } : {},
    profiles
  };
}
async function saveRootConfig(root, path) {
  await writeFileAtomic(path, formatRootConfig(root), { mode: 384 });
}
function formatRootConfig(root) {
  return `${JSON.stringify(serializeRootConfig(root), null, 2)}
`;
}
function serializeRootConfig(root) {
  const profiles = {};
  for (const [name, profile] of Object.entries(root.profiles)) {
    profiles[name] = serializeProfileConfig(profile);
  }
  const migrations = normalizeRootMigrations(root.migrations);
  return {
    schemaVersion: 2,
    activeProfile: root.activeProfile,
    preferences: {},
    ...root.secrets ? { secrets: root.secrets } : {},
    ...migrations ? { migrations } : {},
    profiles
  };
}
function serializeProfileConfig(profile) {
  return {
    schemaVersion: profile.schemaVersion,
    agentKind: profile.agentKind,
    mode: profile.mode,
    accounts: profile.accounts,
    ...profile.secrets ? { secrets: profile.secrets } : {},
    preferences: profile.preferences,
    access: profile.access,
    workspaces: profile.workspaces,
    permissions: profile.permissions,
    ...profile.codex ? { codex: profile.codex } : {},
    ...profile.mimo ? { mimo: profile.mimo } : {},
    ...profile.opencode ? { opencode: profile.opencode } : {},
    ...profile.hermes ? { hermes: profile.hermes } : {},
    attachments: profile.attachments,
    comments: {},
    meeting: profile.meeting,
    larkCli: profile.larkCli
  };
}
async function withConfigFileLock(configPath, fn) {
  const lockTarget = `${configPath}.lock`;
  await mkdir2(dirname2(lockTarget), { recursive: true });
  await writeFile(lockTarget, "", { flag: "a", mode: 384 });
  await chmod2(lockTarget, 384).catch(() => {
  });
  const release = await lockfile.lock(lockTarget, {
    realpath: false,
    stale: 3e4,
    update: 1e4,
    retries: {
      retries: 10,
      minTimeout: 10,
      maxTimeout: 100
    }
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}
async function writeActiveProfile(rootDir, profile) {
  const activeProfileFile = join3(rootDir, "active-profile");
  await writeFileAtomic(activeProfileFile, `${profile}
`, { mode: 384 });
}
function createRootConfig(profile, cfg, secrets = cfg.secrets) {
  return {
    schemaVersion: 2,
    activeProfile: profile,
    preferences: {},
    ...secrets ? { secrets } : {},
    migrations: { permissionDefaultsV1: [profile] },
    profiles: {
      [profile]: {
        ...cfg,
        secrets: void 0
      }
    }
  };
}
function isRootConfig(value) {
  if (!value || typeof value !== "object") return false;
  const root = value;
  return root.schemaVersion === 2 && Boolean(root.profiles && typeof root.profiles === "object");
}
function normalizeRootMigrations(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return void 0;
  const permissionDefaultsV1 = uniqueSortedStrings(input.permissionDefaultsV1);
  return permissionDefaultsV1.length > 0 ? { permissionDefaultsV1 } : void 0;
}
function uniqueSortedStrings(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter((value) => typeof value === "string").map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}

// src/utils/feishu-auth.ts
var ENDPOINTS = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com"
};
async function validateAppCredentials(appId, appSecret, tenant) {
  const base = ENDPOINTS[tenant];
  let resp;
  try {
    resp = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret })
    });
  } catch (err) {
    return { ok: false, reason: `\u7F51\u7EDC\u9519\u8BEF\uFF1A${err instanceof Error ? err.message : String(err)}` };
  }
  if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
  let data;
  try {
    data = await resp.json();
  } catch {
    return { ok: false, reason: "\u54CD\u5E94\u4E0D\u662F\u5408\u6CD5 JSON" };
  }
  if (data.code !== 0 || !data.tenant_access_token) {
    return { ok: false, reason: `code=${data.code ?? "?"} msg=${data.msg ?? "<no msg>"}` };
  }
  const info = await fetchBotInfo(base, data.tenant_access_token).catch(() => void 0);
  return { ok: true, botName: info?.bot?.app_name, botOpenId: info?.bot?.open_id };
}
async function fetchBotInfo(base, token) {
  const resp = await fetch(`${base}/open-apis/bot/v3/info`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) return void 0;
  return await resp.json();
}

// src/core/logger.ts
import { AsyncLocalStorage } from "async_hooks";
import { createWriteStream, mkdirSync } from "fs";
import { open as open2, readdir, rm as rm3, stat as stat2 } from "fs/promises";
import { join as join4 } from "path";

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
    stream = createWriteStream(join4(dir, logFileName(today)), { flags: "a" });
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

// src/ui/http.ts
import { timingSafeEqual } from "crypto";
var MAX_BODY_BYTES = 256 * 1024;
var HttpError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
};

// src/cli/agent-detection.ts
import { constants } from "fs";
import { access } from "fs/promises";
import { delimiter, extname, isAbsolute, join as join5 } from "path";
async function resolveExecutablePath(command) {
  if (isAbsolute(command)) {
    await access(command, constants.X_OK);
    return command;
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const candidate of executableCandidates(dir, command)) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
      }
    }
  }
  throw new Error(`executable not found: ${command}`);
}
function executableCandidates(dir, command) {
  const candidates = [join5(dir, command)];
  if (extname(command)) return candidates;
  for (const ext of pathExts()) {
    candidates.push(join5(dir, `${command}${ext}`));
  }
  return candidates;
}
function pathExts() {
  return (process.env.PATHEXT ?? "").split(";").map((ext) => ext.trim()).filter(Boolean);
}

// src/config/keystore.ts
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes as randomBytes2 } from "crypto";
import { readFile as readFile2 } from "fs/promises";
import { hostname, userInfo } from "os";

// src/config/paths.ts
import { homedir as homedir2 } from "os";
import { join as join6 } from "path";
var appPaths = resolveAppPaths();
var paths = {
  ...appPaths,
  appDir: appPaths.rootDir,
  cacheDir: appPaths.rootDir,
  processesFile: appPaths.userRegistryFile
  /**
   * Thin shell wrapper that lark-cli and other exec-provider consumers invoke
   * to resolve secrets from the bridge's encrypted store.
   * Written user-owned and non-symlinked so it passes lark-cli's
   * AssertSecurePath audit on machines where `node` is a Homebrew/Volta
   * symlink or root-owned (`/usr/bin/node`). Wrapper internals do the
   * `node ... secrets get` invocation; lark-cli only audits the wrapper.
   */
};
var legacyPaths = {
  appDir: join6(
    process.env.XDG_CONFIG_HOME ?? join6(homedir2(), ".config"),
    "lark-channel-bridge"
  ),
  cacheDir: join6(
    process.env.XDG_CACHE_HOME ?? join6(homedir2(), ".cache"),
    "lark-channel-bridge"
  )
};

// src/config/keystore.ts
var KEY_LEN = 32;
var IV_LEN = 12;
var PBKDF2_ITER = 1e5;
var FILE_VERSION = 1;
var derivedKeyCache = /* @__PURE__ */ new Map();
async function readStore(storePaths = paths) {
  try {
    const text = await readFile2(storePaths.secretsFile, "utf8");
    const parsed = JSON.parse(text);
    if (parsed?.version !== FILE_VERSION || !parsed.entries) return emptyStore();
    return { version: parsed.version, entries: { ...parsed.entries } };
  } catch (err) {
    if (err.code === "ENOENT") return emptyStore();
    throw err;
  }
}
function emptyStore() {
  return { version: FILE_VERSION, entries: {} };
}
async function writeStore(store, storePaths = paths) {
  await writeFileAtomic(storePaths.secretsFile, `${JSON.stringify(store, null, 2)}
`, {
    mode: 384
  });
}
async function loadOrCreateSalt(storePaths = paths) {
  try {
    const buf = await readFile2(storePaths.keystoreSaltFile);
    if (buf.length === KEY_LEN) return buf;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const salt = randomBytes2(KEY_LEN);
  await writeFileAtomic(storePaths.keystoreSaltFile, salt, { mode: 384 });
  return salt;
}
async function deriveKey(storePaths = paths) {
  const cacheKey = `${storePaths.keystoreSaltFile}`;
  const cached = derivedKeyCache.get(cacheKey);
  if (cached) return cached;
  const salt = await loadOrCreateSalt(storePaths);
  const seed = `${hostname()}|${userInfo().username}`;
  const key = pbkdf2Sync(seed, salt, PBKDF2_ITER, KEY_LEN, "sha256");
  derivedKeyCache.set(cacheKey, key);
  return key;
}
function encrypt(key, plaintext) {
  const iv = randomBytes2(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    data: enc.toString("base64"),
    tag: tag.toString("base64")
  };
}
async function setSecret(id, plaintext, storePaths = paths) {
  const key = await deriveKey(storePaths);
  const env = encrypt(key, plaintext);
  const store = await readStore(storePaths);
  store.entries[id] = env;
  await writeStore(store, storePaths);
}

// src/config/schema.ts
function secretKeyForApp(appId) {
  return `app-${appId}`;
}

// src/config/store.ts
import { readFile as readFile3 } from "fs/promises";
import { dirname as dirname3 } from "path";
async function buildEncryptedAccountConfig(appId, tenant, preferences, appPaths2 = paths) {
  const wrapperPath = await ensureSecretsGetterWrapper(appPaths2);
  return {
    accounts: {
      app: {
        id: appId,
        secret: {
          source: "exec",
          provider: "bridge",
          id: secretKeyForApp(appId)
        },
        tenant
      }
    },
    secrets: {
      providers: {
        bridge: {
          source: "exec",
          command: wrapperPath,
          // The wrapper has args baked in; pass none here.
          args: []
        }
      }
    },
    ...preferences ? { preferences } : {}
  };
}
async function ensureSecretsGetterWrapper(appPaths2 = paths, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const wrapperPath = platform === "win32" ? `${appPaths2.secretsGetterScript}.cmd` : appPaths2.secretsGetterScript;
  const node = opts.nodePath ?? process.execPath;
  const bridgeEntry = opts.bridgeEntry ?? process.argv[1] ?? "";
  const rootDir = appPaths2.rootDir ?? dirname3(appPaths2.secretsGetterScript);
  if (platform === "win32") {
    const dq = (s) => `"${s.replace(/"/g, '""')}"`;
    const content2 = `@echo off\r
rem Auto-generated by feishu-agent-bridge. Do not edit.\r
set "LARK_CHANNEL_HOME=${rootDir.replace(/"/g, '""')}"\r
${dq(node)} ${dq(bridgeEntry)} secrets get %*\r
`;
    await writeFileAtomic(wrapperPath, content2, { mode: 384 });
    return wrapperPath;
  }
  const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  const content = `#!/bin/sh
# Auto-generated by feishu-agent-bridge. Do not edit.
# Forwards exec-provider requests to: node bridge secrets get
LARK_CHANNEL_HOME=${sq(rootDir)} exec ${sq(node)} ${sq(bridgeEntry)} secrets get "$@"
`;
  await writeFileAtomic(wrapperPath, content, { mode: 448 });
  return wrapperPath;
}

// src/cli/profile-bootstrap.ts
import { mkdir as mkdir3, realpath as realpath2 } from "fs/promises";
import { join as join7 } from "path";

// src/platform/spawn.ts
import crossSpawn from "cross-spawn";

// src/agent/preflight.ts
var AgentPreflightError = class extends Error {
  diagnostic;
  constructor(diagnostic, message) {
    super(message ?? summaryForDiagnostic(diagnostic));
    this.name = "AgentPreflightError";
    this.diagnostic = diagnostic;
  }
};
function summaryForDiagnostic(diagnostic) {
  return `${diagnostic.agentName} preflight failed: ${diagnostic.code}`;
}

// src/policy/workspace.ts
import { realpath, stat as stat3 } from "fs/promises";
import { homedir as homedir3, tmpdir } from "os";
import { basename as basename2, dirname as dirname4, resolve } from "path";
async function resolveWorkingDirectory(requestedCwd) {
  const trimmed = requestedCwd.trim();
  if (!trimmed) {
    return reject("empty-requested-cwd", requestedCwd, "\u672A\u6307\u5B9A\u5DE5\u4F5C\u76EE\u5F55\u3002");
  }
  let resolved;
  try {
    resolved = await realpath(trimmed);
  } catch {
    return reject("path-inaccessible", requestedCwd, `\u5DE5\u4F5C\u76EE\u5F55\u4E0D\u5B58\u5728\u6216\u4E0D\u53EF\u8BBF\u95EE\uFF1A${requestedCwd}`);
  }
  const info = await stat3(resolved).catch(() => void 0);
  if (!info?.isDirectory()) {
    return reject("not-directory", requestedCwd, `\u8DEF\u5F84\u4E0D\u662F\u76EE\u5F55\uFF1A${resolved}`);
  }
  const tempRealpath = await realpath(tmpdir()).catch(() => resolve(tmpdir()));
  const homeRealpath = await realpath(homedir3()).catch(() => resolve(homedir3()));
  const broad = classifyHighRiskWorkingDirectory(resolved, requestedCwd, tempRealpath, homeRealpath);
  if (broad) return broad;
  return {
    ok: true,
    requestedCwd,
    cwdRealpath: resolved
  };
}
function reject(reason, requestedCwd, userVisible) {
  return { ok: false, reason, requestedCwd, userVisible };
}
function classifyHighRiskWorkingDirectory(real, requestedCwd, tempRealpath, homeRealpath) {
  if (real === dirname4(real)) {
    return reject("filesystem-root", requestedCwd, "\u4E0D\u80FD\u628A\u6587\u4EF6\u7CFB\u7EDF\u6839\u76EE\u5F55\u8BBE\u4E3A\u5DE5\u4F5C\u76EE\u5F55\u3002");
  }
  const home = homeRealpath;
  if (real === home) {
    return reject("home-root", requestedCwd, "\u4E0D\u80FD\u628A Home \u6839\u76EE\u5F55\u8BBE\u4E3A\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u8BF7\u9009\u62E9\u66F4\u5177\u4F53\u7684\u5B50\u76EE\u5F55\u3002");
  }
  if (real === dirname4(home)) {
    return reject("user-root", requestedCwd, "\u4E0D\u80FD\u628A\u7528\u6237\u76EE\u5F55\u6839\u8BBE\u4E3A\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u8BF7\u9009\u62E9\u66F4\u5177\u4F53\u7684\u5B50\u76EE\u5F55\u3002");
  }
  if (dirname4(real) === home && (/* @__PURE__ */ new Set(["Desktop", "Downloads"])).has(basename2(real))) {
    return reject("broad-user-folder", requestedCwd, "\u8FD9\u4E2A\u76EE\u5F55\u8303\u56F4\u8FC7\u5927\uFF0C\u8BF7\u9009\u62E9\u66F4\u5177\u4F53\u7684\u5B50\u76EE\u5F55\u3002");
  }
  const temp = resolve(tmpdir());
  if (real === temp || real === tempRealpath || real === "/tmp" || real === "/private/tmp") {
    return reject("temp-root", requestedCwd, "\u4E0D\u80FD\u628A\u4E34\u65F6\u76EE\u5F55\u6839\u8BBE\u4E3A\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u8BF7\u9009\u62E9\u66F4\u5177\u4F53\u7684\u5B50\u76EE\u5F55\u3002");
  }
  const systemRoots = /* @__PURE__ */ new Set([
    "/Applications",
    "/bin",
    "/etc",
    "/Library",
    "/private",
    "/sbin",
    "/System",
    "/usr",
    "/var"
  ]);
  if (systemRoots.has(real)) {
    return reject("system-root", requestedCwd, "\u4E0D\u80FD\u628A\u7CFB\u7EDF\u76EE\u5F55\u8BBE\u4E3A\u5DE5\u4F5C\u76EE\u5F55\u3002");
  }
  if (real === "/Volumes" || dirname4(real) === "/Volumes") {
    return reject("volume-root", requestedCwd, "\u4E0D\u80FD\u628A\u78C1\u76D8\u5377\u6839\u76EE\u5F55\u8BBE\u4E3A\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u8BF7\u9009\u62E9\u66F4\u5177\u4F53\u7684\u5B50\u76EE\u5F55\u3002");
  }
  return void 0;
}

// src/cli/profile-bootstrap.ts
async function createBootstrapProfileConfig(input) {
  const workspace = input.workspace ? await resolveBootstrapWorkspace(input.workspace) : input.defaultWorkspace ? await ensureManagedDefaultWorkspace(input.defaultWorkspace) : void 0;
  const codex = input.agentKind === "codex" ? await createBootstrapCodexConfig(input.codexBinaryPath) : void 0;
  const mimo = input.agentKind === "mimo" ? await createBootstrapMimoConfig(input.mimoBinaryPath) : void 0;
  const openclaw = input.agentKind === "openclaw" ? await createBootstrapOpenClawConfig(input.openclawBinaryPath, input.openclawAgentId) : void 0;
  const profile = createDefaultProfileConfig({
    agentKind: input.agentKind,
    accounts: input.accounts,
    preferences: input.preferences,
    secrets: input.secrets,
    ...codex ? { codex } : {},
    ...mimo ? { mimo } : {},
    ...openclaw ? { openclaw } : {}
  });
  if (workspace) {
    profile.workspaces = {
      ...profile.workspaces,
      default: workspace
    };
  }
  if (input.profileDir && profile.codex?.inheritCodexHome === false) {
    await mkdir3(join7(input.profileDir, "codex-home"), { recursive: true });
  }
  return profile;
}
async function resolveBootstrapWorkspace(workspace) {
  const resolved = await resolveWorkingDirectory(workspace);
  if (!resolved.ok) throw new Error(resolved.userVisible);
  return resolved.cwdRealpath;
}
async function ensureManagedDefaultWorkspace(path) {
  await mkdir3(path, { recursive: true, mode: 448 });
  return realpath2(path);
}
async function createBootstrapCodexConfig(binaryPath) {
  const command = binaryPath ?? process.env.LARK_CHANNEL_CODEX_BIN ?? "codex";
  let resolvedBinary;
  try {
    resolvedBinary = await resolveExecutablePath(command);
  } catch (err) {
    const errno = err.code;
    throw new AgentPreflightError({
      code: codexBootstrapBinaryErrorCode(errno),
      agentId: "codex",
      agentName: "Codex CLI",
      command,
      binaryPath: command,
      errno
    });
  }
  return { binaryPath: resolvedBinary };
}
function codexBootstrapBinaryErrorCode(errno) {
  if (errno === "EACCES" || errno === "EPERM") return "agent-binary-not-executable";
  if (errno === "ELOOP" || errno === "ENOTDIR" || errno === "EINVAL") {
    return "agent-binary-resolve-failed";
  }
  return "agent-binary-not-found";
}
async function createBootstrapMimoConfig(binaryPath) {
  const command = binaryPath ?? process.env.LARK_CHANNEL_MIMO_BIN ?? "mimo";
  let resolvedBinary;
  try {
    resolvedBinary = await resolveExecutablePath(command);
  } catch (err) {
    const errno = err.code;
    throw new AgentPreflightError({
      code: mimoBootstrapBinaryErrorCode(errno),
      agentId: "mimo",
      agentName: "MiMo Code",
      command,
      binaryPath: command,
      errno
    });
  }
  return { binaryPath: resolvedBinary };
}
async function createBootstrapOpenClawConfig(binaryPath, agentId) {
  if (!binaryPath || !agentId) return void 0;
  return { binaryPath, agentId };
}
function mimoBootstrapBinaryErrorCode(errno) {
  if (errno === "EACCES" || errno === "EPERM") return "agent-binary-not-executable";
  if (errno === "ELOOP" || errno === "ENOTDIR" || errno === "EINVAL") {
    return "agent-binary-resolve-failed";
  }
  return "agent-binary-not-found";
}

// src/ui/onboard.ts
async function writeNewProfile(input, rootDir) {
  let appPaths2;
  try {
    appPaths2 = resolveAppPaths({ rootDir, profile: input.profile });
  } catch (err) {
    throw new HttpError(400, `profile \u540D\u79F0\u65E0\u6548\uFF1A${err instanceof Error ? err.message : String(err)}`);
  }
  const profile = appPaths2.profile;
  const pre = await loadRootConfig(appPaths2.configFile);
  if (pre?.profiles[profile]) {
    throw new HttpError(409, `profile \u5DF2\u5B58\u5728\uFF1A${profile}\uFF0C\u8BF7\u6362\u4E2A\u540D\u5B57`);
  }
  const encrypted = await encryptAccount(input, appPaths2);
  let profileConfig;
  try {
    profileConfig = await createBootstrapProfileConfig({
      agentKind: input.agentKind,
      accounts: encrypted.accounts,
      preferences: encrypted.preferences,
      secrets: encrypted.secrets,
      ...input.workspace ? { workspace: input.workspace } : {},
      defaultWorkspace: appPaths2.defaultWorkspaceDir,
      profileDir: appPaths2.profileDir,
      // openclaw profiles need a working config at creation time.
      ...input.agentKind === "openclaw" ? {
        openclawBinaryPath: process.env.LARK_CHANNEL_OPENCLAW_BIN ?? "openclaw",
        openclawAgentId: process.env.LARK_CHANNEL_OPENCLAW_AGENT ?? "main"
      } : {}
    });
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
  await withConfigFileLock(appPaths2.configFile, async () => {
    const root = await loadRootConfig(appPaths2.configFile);
    if (!root) {
      await saveRootConfig(createRootConfig(profile, profileConfig, encrypted.secrets), appPaths2.configFile);
      return;
    }
    if (root.profiles[profile]) {
      throw new HttpError(409, `profile \u5DF2\u5B58\u5728\uFF1A${profile}\uFF0C\u8BF7\u6362\u4E2A\u540D\u5B57`);
    }
    root.profiles[profile] = { ...profileConfig, secrets: void 0 };
    if (!root.secrets && encrypted.secrets) root.secrets = encrypted.secrets;
    await saveRootConfig(root, appPaths2.configFile);
  });
  await writeActiveProfile(appPaths2.rootDir, profile);
  return { profile };
}
async function encryptAccount(input, appPaths2) {
  const next = await buildEncryptedAccountConfig(input.appId, input.tenant, void 0, appPaths2);
  await setSecret(secretKeyForApp(input.appId), input.appSecret, appPaths2);
  return next;
}

// src/ui/qr-register.ts
function sanitizeProfileName(name) {
  return name.trim().replace(/[\u0000-\u001f\s/\\:*?"<>|]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 40);
}
function uniqueProfileName(base, existing) {
  const b = base || "bot";
  if (!existing.has(b)) return b;
  let i = 2;
  while (existing.has(`${b}-${i}`)) i++;
  return `${b}-${i}`;
}
var sessions = /* @__PURE__ */ new Map();
var SESSION_TTL_MS = 20 * 60 * 1e3;
function prune(now) {
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}
async function startQrRegistration(rootDir) {
  const id = randomBytes3(9).toString("hex");
  const session = { status: "pending", qrUrl: "", expireIn: 0, createdAt: Date.now() };
  sessions.set(id, session);
  prune(session.createdAt);
  await new Promise((resolve2, reject2) => {
    let readied = false;
    registerApp({
      source: "lark-channel-bridge",
      onQRCodeReady: (info) => {
        session.qrUrl = info.url;
        session.expireIn = info.expireIn;
        readied = true;
        resolve2();
      }
    }).then(async (result) => {
      const tenant = result.user_info?.tenant_brand ?? "feishu";
      session.app = { appId: result.client_id, appSecret: result.client_secret, tenant };
      const info = await validateAppCredentials(result.client_id, result.client_secret, tenant).catch(
        () => void 0
      );
      session.botName = info?.botName;
      const existing = new Set(
        Object.keys((await loadRootConfig(resolveAppPaths({ rootDir }).configFile))?.profiles ?? {})
      );
      session.suggestedProfile = uniqueProfileName(sanitizeProfileName(info?.botName ?? ""), existing);
      session.status = "scanned";
      log.info("ui", "qr-register-scanned", { appId: result.client_id, botName: info?.botName });
    }).catch((err) => {
      session.status = "error";
      session.error = err instanceof Error ? err.message : String(err);
      if (!readied) reject2(new HttpError(502, `\u626B\u7801\u521B\u5EFA\u542F\u52A8\u5931\u8D25\uFF1A${session.error}`));
    });
  });
  return { sessionId: id, qrUrl: session.qrUrl, expireIn: session.expireIn };
}
function qrStatus(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) throw new HttpError(404, "qr session not found or expired");
  return {
    status: s.status,
    profile: s.profile,
    botName: s.botName,
    suggestedProfile: s.suggestedProfile,
    error: s.error
  };
}
async function finishQrRegistration(body, rootDir) {
  const fv = body && typeof body === "object" ? body : {};
  const sessionId = String(fv.sessionId ?? "");
  const s = sessions.get(sessionId);
  if (!s) throw new HttpError(404, "qr session not found or expired");
  if (s.status === "done" && s.profile) return { profile: s.profile };
  if (s.status === "error") throw new HttpError(400, s.error ?? "\u626B\u7801\u521B\u5EFA\u5931\u8D25");
  if (!s.app) throw new HttpError(409, "\u5C1A\u672A\u5B8C\u6210\u626B\u7801");
  const agentKind = fv.agentKind === "codex" || fv.agentKind === "mimo" || fv.agentKind === "opencode" || fv.agentKind === "hermes" || fv.agentKind === "openclaw" ? fv.agentKind : "claude";
  const profile = String(fv.profile ?? "").trim() || s.suggestedProfile || agentKind;
  const created = await writeNewProfile(
    { profile, agentKind, appId: s.app.appId, appSecret: s.app.appSecret, tenant: s.app.tenant },
    rootDir
  );
  s.status = "done";
  s.profile = created.profile;
  s.app = void 0;
  return { profile: created.profile };
}
export {
  finishQrRegistration,
  qrStatus,
  startQrRegistration
};
