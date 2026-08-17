export interface BuildOpenClawArgsInput {
  agentId: string;
  messageFile: string;
  sessionKey?: string;
  model?: string;
  thinking?: string;
  timeoutSec?: number;
}

/**
 * Build the `openclaw agent` argv for a bridge run.
 *
 * The prompt goes via `--message-file` (long prompts must not ride argv).
 * `--json` emits a single result JSON on stdout; session continuity uses
 * `--session-key` (e.g. agent:main:<key>) or the returned sessionId.
 */
export function buildOpenClawArgs(input: BuildOpenClawArgsInput): string[] {
  const args = ['agent', '--agent', input.agentId, '--json'];
  args.push('--message-file', input.messageFile);
  if (input.sessionKey) args.push('--session-key', input.sessionKey);
  if (input.model) args.push('--model', input.model);
  if (input.thinking) args.push('--thinking', input.thinking);
  if (input.timeoutSec) args.push('--timeout', String(input.timeoutSec));
  return args;
}
