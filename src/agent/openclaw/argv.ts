export interface BuildOpenClawArgsInput {
  agentId: string;
  messageFile: string;
  /** Session id to continue (maps to `--session-id`). */
  sessionId?: string;
  model?: string;
  thinking?: string;
  timeoutSec?: number;
}

/**
 * Build the `openclaw agent` argv for a bridge run.
 *
 * The prompt goes via `--message-file` (long prompts must not ride argv).
 * `--json` emits a single result JSON on stdout; session continuity uses the
 * session id returned by the previous run (`--session-id`).
 */
export function buildOpenClawArgs(input: BuildOpenClawArgsInput): string[] {
  const args = ['agent', '--agent', input.agentId, '--json'];
  args.push('--message-file', input.messageFile);
  if (input.sessionId) args.push('--session-id', input.sessionId);
  if (input.model) args.push('--model', input.model);
  if (input.thinking) args.push('--thinking', input.thinking);
  if (input.timeoutSec) args.push('--timeout', String(input.timeoutSec));
  return args;
}
