interface LarkChannelEnvContext {
    profile?: string;
    rootDir?: string;
    configPath?: string;
    larkCliConfigDir?: string;
    larkCliSourceConfigFile?: string;
}

type LocalAgentId = 'claude' | 'codex' | 'mimo' | 'opencode' | 'hermes';
type AgentPreflightErrorCode = 'agent-binary-not-found' | 'agent-binary-not-executable' | 'agent-binary-resolve-failed' | 'agent-binary-not-readable' | 'agent-version-check-spawn-failed' | 'agent-version-check-timeout' | 'agent-version-check-signaled' | 'agent-version-check-nonzero-exit' | 'agent-version-check-empty-output';
interface AgentPreflightDiagnostic {
    code: AgentPreflightErrorCode;
    agentId: LocalAgentId;
    agentName: string;
    command: string;
    binaryPath?: string;
    realpath?: string;
    args?: readonly string[];
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    timeoutMs?: number;
    errno?: string;
    stdoutExcerpt?: string;
    stderrExcerpt?: string;
    field?: string;
    expected?: string | number;
    actual?: string | number;
}
type AgentAvailability = {
    ok: true;
    version?: string;
} | {
    ok: false;
    error: AgentPreflightError;
    diagnostic: AgentPreflightDiagnostic;
};
declare class AgentPreflightError extends Error {
    readonly diagnostic: AgentPreflightDiagnostic;
    constructor(diagnostic: AgentPreflightDiagnostic, message?: string);
}

type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
type ClaudePermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

type AgentEvent = {
    type: 'system';
    sessionId?: string;
    threadId?: string;
    cwd?: string;
    model?: string;
} | {
    type: 'text';
    delta: string;
} | {
    type: 'final_text';
    content: string;
} | {
    type: 'thinking';
    delta: string;
} | {
    type: 'tool_use';
    id: string;
    name: string;
    input: unknown;
} | {
    type: 'tool_result';
    id: string;
    output: string;
    isError: boolean;
} | {
    type: 'usage';
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    reasoningOutputTokens?: number;
    costUsd?: number;
} | {
    type: 'done';
    sessionId?: string;
    threadId?: string;
    terminationReason: 'normal' | 'interrupted' | 'timeout';
} | {
    type: 'error';
    message: string;
    terminationReason: 'failed' | 'interrupted' | 'timeout';
};
interface AgentRunOptions {
    runId: string;
    prompt: string;
    cwd?: string;
    sessionId?: string;
    threadId?: string;
    model?: string;
    images?: readonly string[];
    sandbox?: CodexSandboxMode;
    permissionMode?: ClaudePermissionMode;
    /**
     * Grace period (ms) between SIGTERM and SIGKILL when stop() is called on
     * the returned run. Lets the agent (and any subprocess it spawned, e.g.
     * lark-cli mid-OAuth) clean up before the kernel reaps the tree.
     * Adapters that don't kill via signals are free to ignore this. Defaults
     * are adapter-specific.
    */
    stopGraceMs?: number;
}
interface AgentRun {
    readonly runId: string;
    readonly events: AsyncIterable<AgentEvent>;
    stop(): Promise<void>;
    /**
     * Wait up to `timeoutMs` for the agent process to exit on its own.
     * Resolves true if it exited within the window, false if the timer
     * fired first (caller usually wants to fall back to stop()).
     *
     * Use this after a terminal stream event (`done` / `error`): the
     * stream-json `result` line arrives before claude has actually closed
     * stdout — there's a brief telemetry/cleanup tail in between. Calling
     * stop() in that window forces a SIGTERM and the run exits with code
     * 143 instead of 0; waiting it out lets it exit cleanly.
     */
    waitForExit(timeoutMs: number): Promise<boolean>;
}
/**
 * The bridge bot's own IM identity, resolved by the channel after the WS
 * handshake (`/open-apis/bot/v3/info`). Injected into adapters so the agent
 * system prompt can state "this open_id is you" with the real value.
 */
interface AgentBotIdentity {
    openId: string;
    name?: string;
}
interface AgentAdapter {
    readonly id: string;
    readonly displayName: string;
    isAvailable(): Promise<boolean>;
    checkAvailability?(): Promise<AgentAvailability>;
    prepareRun?(opts: AgentRunOptions): Promise<void>;
    run(opts: AgentRunOptions): AgentRun;
    /**
     * Late-bound identity injection: the adapter is constructed before the
     * channel connects, so the channel calls this once botIdentity is known.
     * Adapters that don't bake identity into their prompts may omit it.
     */
    setBotIdentity?(identity: AgentBotIdentity): void;
}

interface HermesAdapterOptions {
    binary?: string;
    /** Extra args for `hermes acp`, e.g. `['--profile', 'tomato-studio']`. */
    acpArgs?: string[];
    larkChannel?: LarkChannelEnvContext;
    stopGraceMs?: number;
}
declare class HermesAdapter implements AgentAdapter {
    readonly id = "hermes";
    readonly displayName = "Hermes Agent";
    private readonly binary;
    private readonly acpArgs;
    private readonly larkChannel;
    private readonly defaultStopGraceMs;
    private botIdentity;
    constructor(opts?: HermesAdapterOptions);
    setBotIdentity(identity: AgentBotIdentity): void;
    isAvailable(): Promise<boolean>;
    checkAvailability(): Promise<AgentAvailability>;
    run(opts: AgentRunOptions): AgentRun;
}

declare function prefixBridgeSystemPrompt(prompt: string, identity: AgentBotIdentity | undefined): string;

export { HermesAdapter, prefixBridgeSystemPrompt };
