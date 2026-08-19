import type {
  AppCredentials,
  AppPreferences,
  MessageReplyMode,
  SecretsConfig,
} from './schema';
import {
  normalizePermissions,
  permissionsToLegacySandbox,
  type AccessMode,
  type CodexSandboxMode,
  type PermissionConfig,
  type PermissionSource,
} from './permissions';
import {
  DEFAULT_COMPACT_BASE_URL,
  DEFAULT_COMPACT_MODEL,
  DEFAULT_COMPACT_TIMEOUT_MS,
} from '../session/compact-llm';

export type AgentKind = 'claude' | 'codex' | 'mimo' | 'opencode' | 'hermes' | 'openclaw';
export type SandboxMode = CodexSandboxMode;
export type { AccessMode, PermissionConfig, PermissionSource };

export interface ProfileAccess {
  allowedUsers: string[];
  allowedChats: string[];
  admins: string[];
  requireMentionInGroup: boolean;
  /**
   * Per-chat override of {@link requireMentionInGroup}, keyed by chat_id.
   * `true` = require an @-mention in that chat, `false` = respond to every
   * message. A chat absent from the map follows the global setting. Takes
   * priority over `requireMentionInGroup` for the chats it lists.
   */
  chatRequireMention?: Record<string, boolean>;
}

export interface SandboxConfig {
  default?: SandboxMode;
  max?: SandboxMode;
  defaultMode: SandboxMode;
  maxMode: SandboxMode;
}

export interface CodexConfig {
  binaryPath: string;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
  codexHome?: string;
  inheritCodexHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
}

export interface MimoConfig {
  binaryPath: string;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
  /** Forward `--thinking` so reasoning events appear in the JSONL stream. */
  thinking?: boolean;
  /**
   * Seconds of silence after the last streaming event before the bridge
   * treats the mimo child as done and SIGTERMs it (mimo keeps running for
   * its background checkpoint-writer after the answer completes). Long
   * replies can legitimately pause mid-generation, so this must be generous.
   * Default 180 (3 min). Set 0 to disable the idle-finish entirely.
   */
  idleSeconds?: number;
}

export interface OpencodeConfig {
  binaryPath: string;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
  /** Forward `--thinking` so reasoning events appear in the JSONL stream. */
  thinking?: boolean;
}

export interface HermesConfig {
  binaryPath: string;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
  /** Extra args for `hermes acp`, e.g. ["--profile", "tomato-studio"]. */
  acpArgs?: string[];
}

export interface OpenClawConfig {
  binaryPath: string;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
  /** The OpenClaw agent id to drive (e.g. "main"). */
  agentId: string;
  /** Thinking level passed to `--thinking` when set. */
  thinking?: string;
}

export interface AttachmentConfig {
  maxCount: number;
  maxBytes: number;
  maxFileBytes: number;
  imageMaxBytes: number;
  cacheTtlMs: number;
  cacheMaxBytes: number;
}

/**
 * `/compact` context-compression settings. The bridge records per-scope
 * conversation history and, on `/compact [N]`, folds the older portion into
 * an LLM summary that is injected at the top of every future prompt.
 */
export interface CompactionConfig {
  /** Master switch. Default true. */
  enabled: boolean;
  /** Rounds to keep when the user runs `/compact` without an argument. */
  keepRounds: number;
  /** OpenAI-compatible endpoint used to produce the summary. */
  llm: {
    baseUrl: string;
    model: string;
    /** Optional explicit key. Defaults to LOCAL_DEEPSEEK_API_KEY from the
     * environment or `~/.hermes/.env` (玄策's local new-api key). */
    apiKey?: string;
    timeoutMs?: number;
  };
}

export const COMPACTION_DEFAULTS: CompactionConfig = {
  enabled: true,
  keepRounds: 20,
  llm: {
    baseUrl: DEFAULT_COMPACT_BASE_URL,
    model: DEFAULT_COMPACT_MODEL,
    timeoutMs: DEFAULT_COMPACT_TIMEOUT_MS,
  },
};

export type CommentConfig = Record<string, never>;

/** Where the agent's answer goes when it responds to meeting content. */
export type MeetingRespondIn = 'meeting' | 'im' | 'both';

/**
 * Where the end-of-meeting summary is delivered.
 *  - `origin`: the chat the bot was told to join from (`/meeting join` there).
 *  - `owner`: the bot owner's direct message.
 * Either way the other one is used as a fallback, so a summary is never
 * silently dropped just because the preferred target isn't available (a
 * console-initiated join has no origin chat; an unresolved owner has no DM).
 */
export type MeetingSummaryTarget = 'origin' | 'owner';

/**
 * In-meeting agent ("智能体入会", path 2 / TAT): the bot joins a Feishu meeting
 * as a real participant, receives in-meeting activity (transcript, chat,
 * participants, doc shares) and can answer in the meeting or over IM.
 *
 * Off by default — the capability is gated by a Feishu allowlist plus the
 * `vc:meeting.bot.join:write` scope, so it must be opted into per profile.
 */
export interface MeetingConfig {
  enabled: boolean;
  /** Auto-join when the bot is invited (needs `vc.bot.meeting_invited_v1` push). */
  autoJoinOnInvite: boolean;
  transcript: {
    /** Rolling transcript lines kept as agent context. */
    keep: number;
    /** Debounce window (ms) before a sentence counts as final; 0 = emit every update. */
    stabilizeMs: number;
  };
  /** Where answers go. */
  respondIn: MeetingRespondIn;
  /**
   * Extra prefix that makes an in-meeting chat message a question for the agent.
   * `@<bot 当前名字>` is always accepted on top of this, so the natural thing to
   * type works without configuring anything.
   */
  trigger: string;
  /** Base interval for the `bots/events` poller (idle rounds back off). */
  pollIntervalMs: number;
  /** Summarize the meeting to IM when it ends. */
  summaryOnEnd: boolean;
  /** Preferred destination for that summary. See {@link MeetingSummaryTarget}. */
  summaryTarget: MeetingSummaryTarget;
}

export type LarkCliIdentityPreset = 'bot-only' | 'user-default';

/**
 * Deployment mode — a single switch that binds two behaviors together
 * (see the "团队版 Bot 权限调整" spec):
 *   - `personal` (default, the status quo): only owner + allowlisted
 *     users/chats can use the bot; the CLI may carry owner's personal (user)
 *     authorization per {@link LarkCliConfig.identityPreset}.
 *   - `team`: anyone can @-use the bot (no allowlist gating), and the CLI is
 *     forced to `bot-only` so it never carries owner's personal authorization.
 *
 * The two behaviors are intentionally bound to one switch, not two configs.
 * Admin/sensitive commands stay owner/admin-gated in both modes.
 */
export type ProfileMode = 'personal' | 'team';

export type LarkCliUserImportStatus =
  | 'not-needed'
  | 'imported'
  | 'skipped-existing-private-user'
  | 'skipped-no-local-user'
  | 'failed';

export interface LarkCliConfig {
  identityPreset: LarkCliIdentityPreset;
  localUserImport?: {
    status: LarkCliUserImportStatus;
    attemptedAt?: string;
    importedAt?: string;
    reason?: string;
  };
}

export interface ProfileConfig {
  schemaVersion: 2;
  agentKind: AgentKind;
  /** Deployment mode switch. Default 'personal'. See {@link ProfileMode}. */
  mode: ProfileMode;
  accounts: {
    app: AppCredentials;
  };
  secrets?: SecretsConfig;
  preferences: Omit<AppPreferences, 'access' | 'requireMentionInGroup'>;
  access: ProfileAccess;
  workspaces: {
    default?: string;
  };
  sandbox: SandboxConfig;
  permissions: PermissionConfig;
  permissionSource?: PermissionSource;
  codex?: CodexConfig;
  mimo?: MimoConfig;
  opencode?: OpencodeConfig;
  hermes?: HermesConfig;
  openclaw?: OpenClawConfig;
  attachments: AttachmentConfig;
  comments: CommentConfig;
  /** `/compact` context-compression settings. See {@link CompactionConfig}. */
  compaction: CompactionConfig;
  /** In-meeting agent settings. See {@link MeetingConfig}. */
  meeting: MeetingConfig;
  larkCli: LarkCliConfig;
}

/**
 * The lark-cli identity preset that actually takes effect, after applying the
 * deployment-mode override. Team mode forces `bot-only` regardless of the
 * user's stored {@link LarkCliConfig.identityPreset} (which is preserved so it
 * comes back into effect when switching back to personal mode). This is the
 * single source of truth for "team mode forces bot-only" — every place that
 * applies the lark-cli identity policy should read through here.
 */
export function effectiveLarkCliIdentity(
  profile: Pick<ProfileConfig, 'mode' | 'larkCli'>,
): LarkCliIdentityPreset {
  return profile.mode === 'team' ? 'bot-only' : profile.larkCli.identityPreset;
}

export interface RootConfig {
  schemaVersion: 2;
  activeProfile: string;
  preferences: Record<string, never>;
  secrets?: SecretsConfig;
  migrations?: {
    permissionDefaultsV1?: string[];
  };
  profiles: Record<string, ProfileConfig>;
}

export interface CreateDefaultProfileConfigInput {
  agentKind: AgentKind;
  /** Deployment mode. Default 'personal'. */
  mode?: ProfileMode;
  accounts: {
    app: AppCredentials;
  };
  preferences?: AppPreferences;
  access?: Partial<ProfileAccess>;
  sandbox?: Partial<SandboxConfig>;
  permissions?: Partial<PermissionConfig>;
  codex?: CodexConfig;
  mimo?: MimoConfig;
  opencode?: OpencodeConfig;
  hermes?: HermesConfig;
  openclaw?: OpenClawConfig;
  secrets?: SecretsConfig;
}

export function createDefaultProfileConfig(
  input: CreateDefaultProfileConfigInput,
): ProfileConfig {
  return normalizeProfileConfig({
    schemaVersion: 2,
    ...input,
  });
}

export function normalizeProfileConfig(input: unknown): ProfileConfig {
  if (!input || typeof input !== 'object') {
    throw new Error('profile config must be an object');
  }
  const raw = input as {
    schemaVersion?: unknown;
    agentKind?: unknown;
    mode?: unknown;
    accounts?: unknown;
    secrets?: SecretsConfig;
    preferences?: (AppPreferences & { access?: Partial<ProfileAccess> }) | undefined;
    access?: Partial<ProfileAccess>;
    workspaces?: {
      default?: unknown;
      // Legacy workspace authorization fields are accepted for config
      // compatibility only; normalizeWorkspaces drops them.
      trusted?: unknown;
      trustedRoots?: unknown;
      riskFlags?: unknown;
    };
    sandbox?: Partial<SandboxConfig>;
    permissions?: Partial<PermissionConfig>;
    codex?: CodexConfig & { flags?: unknown };
    mimo?: MimoConfig;
    opencode?: OpencodeConfig;
    hermes?: HermesConfig;
    openclaw?: OpenClawConfig;
    attachments?: Partial<AttachmentConfig>;
    comments?: unknown;
    compaction?: Partial<CompactionConfig>;
    meeting?: unknown;
    larkCli?: unknown;
  };

  if (raw.schemaVersion !== 2) {
    throw new Error('profile schemaVersion must be 2');
  }
  if (raw.agentKind !== 'claude' && raw.agentKind !== 'codex' && raw.agentKind !== 'mimo' && raw.agentKind !== 'opencode' && raw.agentKind !== 'hermes' && raw.agentKind !== 'openclaw') {
    throw new Error('agentKind must be claude, codex, mimo, opencode, hermes, or openclaw');
  }
  const accounts = normalizeAccounts(raw.accounts);
  if (raw.agentKind === 'codex' && !raw.codex) {
    throw new Error('codex profile requires codex configuration');
  }
  if (raw.agentKind === 'mimo' && !raw.mimo) {
    throw new Error('mimo profile requires mimo configuration');
  }
  if (raw.agentKind === 'opencode' && !raw.opencode) {
    throw new Error('opencode profile requires opencode configuration');
  }
  if (raw.agentKind === 'hermes' && !raw.hermes) {
    throw new Error('hermes profile requires hermes configuration');
  }
  if (raw.agentKind === 'openclaw' && !raw.openclaw) {
    throw new Error('openclaw profile requires openclaw configuration');
  }

  const preferences = normalizePreferences(raw.preferences);
  const access = normalizeAccess(
    raw.access ?? raw.preferences?.access,
    raw.preferences?.requireMentionInGroup,
  );
  const { permissions, source: permissionSource } = normalizePermissions({
    permissions: raw.permissions,
    sandbox: raw.sandbox,
  });
  const sandbox = permissionsToLegacySandbox(permissions);
  const workspaces = normalizeWorkspaces(raw.workspaces);
  const comments = normalizeComments(raw.comments);
  const compaction = normalizeCompaction(raw.compaction);
  const meeting = normalizeMeeting(raw.meeting);
  const larkCli = normalizeLarkCli(raw.larkCli);

  return {
    schemaVersion: 2,
    agentKind: raw.agentKind,
    mode: raw.mode === 'team' ? 'team' : 'personal',
    accounts,
    ...(raw.secrets ? { secrets: raw.secrets } : {}),
    preferences,
    access,
    workspaces,
    sandbox,
    permissions,
    permissionSource,
    ...(raw.codex ? { codex: normalizeCodex(raw.codex) } : {}),
    ...(raw.mimo ? { mimo: normalizeMimo(raw.mimo) } : {}),
    ...(raw.opencode ? { opencode: normalizeOpencode(raw.opencode) } : {}),
    ...(raw.hermes ? { hermes: normalizeHermes(raw.hermes) } : {}),
    ...(raw.openclaw ? { openclaw: normalizeOpenClaw(raw.openclaw) } : {}),
    ...(raw.openclaw ? { openclaw: normalizeOpenClaw(raw.openclaw) } : {}),
    attachments: {
      maxCount: numberOr(raw.attachments?.maxCount, 10),
      maxBytes: numberOr(raw.attachments?.maxBytes, 100 * 1024 * 1024),
      maxFileBytes: numberOr(raw.attachments?.maxFileBytes, 25 * 1024 * 1024),
      imageMaxBytes: numberOr(raw.attachments?.imageMaxBytes, 25 * 1024 * 1024),
      cacheTtlMs: numberOr(raw.attachments?.cacheTtlMs, 24 * 60 * 60 * 1000),
      cacheMaxBytes: numberOr(raw.attachments?.cacheMaxBytes, 512 * 1024 * 1024),
    },
    comments,
    compaction,
    meeting,
    larkCli,
  };
}

function normalizeAccounts(input: unknown): ProfileConfig['accounts'] {
  if (!input || typeof input !== 'object') {
    throw new Error('accounts.app is required');
  }
  const accounts = input as { app?: Partial<AppCredentials> };
  const app = accounts.app;
  if (!app?.id || !app.secret || (app.tenant !== 'feishu' && app.tenant !== 'lark')) {
    throw new Error('accounts.app is incomplete');
  }
  return {
    app: {
      id: app.id,
      secret: app.secret,
      tenant: app.tenant,
    },
  };
}

function normalizePreferences(
  preferences: AppPreferences | undefined,
): ProfileConfig['preferences'] {
  const {
    access: _access,
    requireMentionInGroup: _mention,
    messageReply,
    ...rest
  } = preferences ?? {};
  if (messageReply !== undefined && isMessageReply(messageReply)) {
    return {
      ...rest,
      messageReply,
    };
  }
  return rest;
}

function isMessageReply(value: unknown): value is MessageReplyMode {
  return value === 'card' || value === 'markdown' || value === 'text';
}

function normalizeAccess(
  access: Partial<ProfileAccess> | undefined,
  legacyRequireMentionInGroup: boolean | undefined,
): ProfileAccess {
  const chatRequireMention = normalizeChatMentionMap(access?.chatRequireMention);
  return {
    allowedUsers: stringArray(access?.allowedUsers),
    allowedChats: stringArray(access?.allowedChats),
    admins: stringArray(access?.admins),
    requireMentionInGroup: access?.requireMentionInGroup ?? legacyRequireMentionInGroup ?? true,
    // Omit when empty so configs without per-chat overrides stay clean.
    ...(Object.keys(chatRequireMention).length > 0 ? { chatRequireMention } : {}),
  };
}

/** Keep only string→boolean entries; drop anything malformed. */
function normalizeChatMentionMap(input: unknown): Record<string, boolean> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, boolean> = {};
  for (const [chatId, value] of Object.entries(input as Record<string, unknown>)) {
    if (chatId && typeof value === 'boolean') out[chatId] = value;
  }
  return out;
}

function normalizeWorkspaces(input: {
  default?: unknown;
  trusted?: unknown;
  trustedRoots?: unknown;
  riskFlags?: unknown;
} | undefined): ProfileConfig['workspaces'] {
  const defaultWorkspace = typeof input?.default === 'string' && input.default.trim()
    ? input.default.trim()
    : undefined;
  return defaultWorkspace ? { default: defaultWorkspace } : {};
}

function normalizeCodex(input: CodexConfig & { flags?: unknown }): CodexConfig {
  const codex: CodexConfig = {
    binaryPath: input.binaryPath,
    ...(typeof input.realpath === 'string' ? { realpath: input.realpath } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.sha256 === 'string' ? { sha256: input.sha256 } : {}),
    ...(typeof input.owner === 'number' ? { owner: input.owner } : {}),
    ...(typeof input.mode === 'number' ? { mode: input.mode } : {}),
    ...(typeof input.codexHome === 'string' ? { codexHome: input.codexHome } : {}),
    inheritCodexHome: input.inheritCodexHome !== false,
    ignoreUserConfig: input.ignoreUserConfig === true,
    ignoreRules: input.ignoreRules !== false,
  };
  return codex;
}

function normalizeMimo(input: MimoConfig): MimoConfig {
  const mimo: MimoConfig = {
    binaryPath: input.binaryPath,
    ...(typeof input.realpath === 'string' ? { realpath: input.realpath } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.sha256 === 'string' ? { sha256: input.sha256 } : {}),
    ...(typeof input.owner === 'number' ? { owner: input.owner } : {}),
    ...(typeof input.mode === 'number' ? { mode: input.mode } : {}),
    thinking: input.thinking === true,
    ...(typeof input.idleSeconds === 'number' && Number.isFinite(input.idleSeconds)
      ? { idleSeconds: Math.max(0, Math.floor(input.idleSeconds)) }
      : {}),
  };
  return mimo;
}

function normalizeOpencode(input: OpencodeConfig): OpencodeConfig {
  const opencode: OpencodeConfig = {
    binaryPath: input.binaryPath,
    ...(typeof input.realpath === 'string' ? { realpath: input.realpath } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.sha256 === 'string' ? { sha256: input.sha256 } : {}),
    ...(typeof input.owner === 'number' ? { owner: input.owner } : {}),
    ...(typeof input.mode === 'number' ? { mode: input.mode } : {}),
    thinking: input.thinking === true,
  };
  return opencode;
}

function normalizeHermes(input: HermesConfig): HermesConfig {
  const hermes: HermesConfig = {
    binaryPath: input.binaryPath,
    ...(typeof input.realpath === 'string' ? { realpath: input.realpath } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.sha256 === 'string' ? { sha256: input.sha256 } : {}),
    ...(typeof input.owner === 'number' ? { owner: input.owner } : {}),
    ...(typeof input.mode === 'number' ? { mode: input.mode } : {}),
    ...(Array.isArray(input.acpArgs) ? { acpArgs: input.acpArgs.map(String) } : {}),
  };
  return hermes;
}

function normalizeOpenClaw(input: OpenClawConfig): OpenClawConfig {
  const openclaw: OpenClawConfig = {
    binaryPath: input.binaryPath,
    ...(typeof input.realpath === 'string' ? { realpath: input.realpath } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.sha256 === 'string' ? { sha256: input.sha256 } : {}),
    ...(typeof input.owner === 'number' ? { owner: input.owner } : {}),
    ...(typeof input.mode === 'number' ? { mode: input.mode } : {}),
    agentId: input.agentId,
    ...(typeof input.thinking === 'string' ? { thinking: input.thinking } : {}),
  };
  return openclaw;
}

function normalizeComments(_input: unknown): CommentConfig {
  return {};
}

function normalizeCompaction(input: Partial<CompactionConfig> | undefined): CompactionConfig {
  const raw = input && typeof input === 'object' ? input : {};
  const keepRounds =
    typeof raw.keepRounds === 'number' && Number.isFinite(raw.keepRounds)
      ? Math.max(0, Math.floor(raw.keepRounds))
      : COMPACTION_DEFAULTS.keepRounds;
  const llm = raw.llm && typeof raw.llm === 'object' ? raw.llm : ({} as CompactionConfig['llm']);
  return {
    enabled: raw.enabled !== false,
    keepRounds,
    llm: {
      baseUrl:
        typeof llm.baseUrl === 'string' && llm.baseUrl.trim()
          ? llm.baseUrl.trim()
          : COMPACTION_DEFAULTS.llm.baseUrl,
      model:
        typeof llm.model === 'string' && llm.model.trim()
          ? llm.model.trim()
          : COMPACTION_DEFAULTS.llm.model,
      ...(typeof llm.apiKey === 'string' && llm.apiKey.trim()
        ? { apiKey: llm.apiKey.trim() }
        : {}),
      ...(typeof llm.timeoutMs === 'number' && Number.isFinite(llm.timeoutMs) && llm.timeoutMs > 0
        ? { timeoutMs: llm.timeoutMs }
        : {}),
    },
  };
}

/** Defaults keep the in-meeting agent off until a profile opts in. */
export const MEETING_DEFAULTS: MeetingConfig = {
  enabled: false,
  autoJoinOnInvite: false,
  transcript: { keep: 200, stabilizeMs: 0 },
  respondIn: 'meeting',
  trigger: '@bot',
  pollIntervalMs: 3000,
  summaryOnEnd: false,
  summaryTarget: 'origin',
};

function normalizeMeeting(input: unknown): MeetingConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as {
    enabled?: unknown;
    autoJoinOnInvite?: unknown;
    transcript?: { keep?: unknown; stabilizeMs?: unknown };
    respondIn?: unknown;
    trigger?: unknown;
    pollIntervalMs?: unknown;
    summaryOnEnd?: unknown;
    summaryTarget?: unknown;
  };
  const trigger = typeof raw.trigger === 'string' && raw.trigger.trim() ? raw.trigger.trim() : MEETING_DEFAULTS.trigger;
  return {
    enabled: raw.enabled === true,
    autoJoinOnInvite: raw.autoJoinOnInvite === true,
    transcript: {
      keep: clampNumber(raw.transcript?.keep, 10, 2000, MEETING_DEFAULTS.transcript.keep),
      // 0 is meaningful here ("no debounce"), so it can't go through numberOr.
      stabilizeMs: clampNumber(raw.transcript?.stabilizeMs, 0, 30_000, MEETING_DEFAULTS.transcript.stabilizeMs),
    },
    respondIn:
      raw.respondIn === 'im' || raw.respondIn === 'both' || raw.respondIn === 'meeting'
        ? raw.respondIn
        : MEETING_DEFAULTS.respondIn,
    trigger,
    pollIntervalMs: clampNumber(raw.pollIntervalMs, 1000, 60_000, MEETING_DEFAULTS.pollIntervalMs),
    summaryOnEnd: raw.summaryOnEnd === true,
    summaryTarget:
      raw.summaryTarget === 'owner' || raw.summaryTarget === 'origin'
        ? raw.summaryTarget
        : MEETING_DEFAULTS.summaryTarget,
  };
}

/** Like {@link numberOr} but keeps 0 and bounds the result. */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function normalizeLarkCli(input: unknown): LarkCliConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { identityPreset: 'bot-only' };
  }
  const raw = input as {
    identityPreset?: unknown;
    localUserImport?: unknown;
  };
  const identityPreset: LarkCliIdentityPreset =
    raw.identityPreset === 'user-default' ? 'user-default' : 'bot-only';
  const localUserImport = normalizeLarkCliUserImport(raw.localUserImport);
  return {
    identityPreset,
    ...(localUserImport ? { localUserImport } : {}),
  };
}

function normalizeLarkCliUserImport(input: unknown): LarkCliConfig['localUserImport'] | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as {
    status?: unknown;
    attemptedAt?: unknown;
    importedAt?: unknown;
    reason?: unknown;
  };
  if (!isLarkCliUserImportStatus(raw.status)) return undefined;
  return {
    status: raw.status,
    ...(typeof raw.attemptedAt === 'string' ? { attemptedAt: raw.attemptedAt } : {}),
    ...(typeof raw.importedAt === 'string' ? { importedAt: raw.importedAt } : {}),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
  };
}

function isLarkCliUserImportStatus(value: unknown): value is LarkCliUserImportStatus {
  return (
    value === 'not-needed' ||
    value === 'imported' ||
    value === 'skipped-existing-private-user' ||
    value === 'skipped-no-local-user' ||
    value === 'failed'
  );
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
