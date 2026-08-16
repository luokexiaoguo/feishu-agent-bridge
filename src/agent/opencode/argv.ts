export interface BuildOpencodeArgsInput {
  cwd: string;
  sessionId?: string;
  model?: string;
  thinking?: boolean;
  skipPermissions?: boolean;
}

/**
 * Build the `opencode run` argv for bridge execution.
 *
 * The prompt is appended as the positional argument by the caller (adapter),
 * so special characters never reach a shell. `--format json` emits the JSONL
 * event stream on stdout; `--thinking` makes reasoning events appear; the
 * session id resumes a previous conversation.
 */
export function buildOpencodeArgs(input: BuildOpencodeArgsInput): string[] {
  const args = ['run', '--format', 'json'];
  if (input.skipPermissions) args.push('--dangerously-skip-permissions');
  if (input.thinking) args.push('--thinking');
  if (input.model) args.push('--model', input.model);
  if (input.sessionId) args.push('--session', input.sessionId);
  args.push('--dir', input.cwd);
  return args;
}
