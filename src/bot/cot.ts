import * as fs from 'node:fs';
import type { AgentEvent } from '../agent/types';
import type { CotMessagesMode, TenantBrand } from '../config/schema';
import { log } from '../core/logger';
import { toolHeaderText } from '../card/tool-render';
import type { RunState } from '../card/run-state';

const ENDPOINTS: Record<TenantBrand, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

const COT_UPDATE_THROTTLE_MS = 600;
const COT_TOOL_OUTPUT_MAX = 1200;
const COT_TEXT_MAX = 1200;
/** message_cot caps events per write call at 50 (probed: 50 ok, 51 → 400). */
const MAX_EVENTS_PER_WRITE = 50;
// Bounds every CoT HTTP call. Without it a hung message_cot endpoint pins
// start() — which runs before any agent event is drained and before the
// plain-reply fallback — to undici's ~300s default.
const COT_REQUEST_TIMEOUT_MS = 15_000;

export class CotClient {
  private readonly baseUrl: string;
  private readonly appId: string;
  private readonly appSecret: string;
  private token: string | undefined;
  private tokenExpiresAt = 0;

  constructor(opts: { tenant: TenantBrand; appId: string; appSecret: string }) {
    this.baseUrl = ENDPOINTS[opts.tenant];
    this.appId = opts.appId;
    this.appSecret = opts.appSecret;
  }

  async tenantToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.tokenExpiresAt - now > 60_000) return this.token;
    const resp = await fetch(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      signal: AbortSignal.timeout(COT_REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`tenant token HTTP ${resp.status}`);
    const data = await resp.json() as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`tenant token failed: code=${data.code ?? '?'} msg=${data.msg ?? '<no msg>'}`);
    }
    this.token = data.tenant_access_token;
    const expireSeconds = typeof data.expire === 'number' ? data.expire : 7200;
    this.tokenExpiresAt = now + Math.max(60, expireSeconds - 60) * 1000;
    return this.token;
  }

  async request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const token = await this.tenantToken();
    const resp = await fetch(`${this.baseUrl}${path}`, {
      signal: AbortSignal.timeout(COT_REQUEST_TIMEOUT_MS),
      ...init,
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });
    if (!resp.ok) {
      // FIX(fork): surface the API's own error body on non-2xx — a bare
      // "COT HTTP 400" left the root cause invisible in the logs.
      const bodyText = await resp.text().catch(() => '');
      const detail = bodyText.slice(0, 300);
      throw new Error(`COT HTTP ${resp.status}${detail ? `: ${detail}` : ''}`);
    }
    const text = await resp.text();
    if (!text) return {};
    const data = JSON.parse(text) as { code?: number; msg?: string; data?: Record<string, unknown> } & Record<string, unknown>;
    if (data.code !== undefined && data.code !== 0) {
      throw new Error(`COT API failed: code=${data.code} msg=${data.msg ?? '<no msg>'}`);
    }
    return data.data ?? data;
  }

  async create(chatId: string, originMessageId?: string): Promise<Record<string, unknown>> {
    // message_cot only accepts receive_id_type=chat_id. thread_id is NOT a
    // valid receive type for this endpoint (it exists only on the forward
    // APIs) — addressing the create to an omt_* thread id is rejected with
    // code=10002 "Bot/User can NOT be out of the chat" (the backend tries to
    // resolve the omt_* id as a chat the bot belongs to and finds none).
    //
    // Placement inside a topic is instead governed by origin_message_id: the
    // bubble inherits the topic of the message it originates from. Passing an
    // in-topic message id keeps the bubble in the topic; the topic's root
    // (首楼) message has no thread of its own, so a bubble originated from it
    // lands at the group top level. Callers pick origin_message_id
    // accordingly.
    return this.request('/open-apis/im/v1/message_cot?receive_id_type=chat_id', {
      method: 'POST',
      body: JSON.stringify({
        receive_id: chatId,
        ...(originMessageId ? { origin_message_id: originMessageId } : {}),
        // FIX(fork): match dsh-lark's create params — the bubble must not
        // raise an unread badge or bump the chat's feed rank.
        cot_hidden: false,
        enable_badge: false,
        update_feed_rank: false,
      }),
    });
  }

  async update(ref: CotRef, events: readonly CotEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.request('/open-apis/im/v1/message_cot', {
      method: 'PUT',
      body: JSON.stringify({
        cot_id: ref.cotId,
        message_id: ref.messageId,
        events,
      }),
    });
  }

  async complete(ref: CotRef, reason: string): Promise<void> {
    const cotId = encodeURIComponent(ref.cotId);
    const messageId = encodeURIComponent(ref.messageId);
    await this.request(`/open-apis/im/v1/message_cot/complete/${cotId}?message_id=${messageId}&reason=${reason}`, {
      method: 'POST',
      body: '',
    });
  }
}

interface CotRef {
  cotId: string;
  messageId: string;
}

interface CotEvent {
  event_type: string;
  content: string;
  // FIX(fork): the message_cot API expects timestamps as STRINGS (dsh-lark
  // sends `String(lastTimestamp)`). Numeric timestamps were accepted by the
  // write API but the Feishu client failed to render subsequent events —
  // the bubble stuck on "理解用户问题".
  timestamp: string;
}

export class CotPublisher {
  private readonly client: Pick<CotClient, 'create' | 'update' | 'complete'>;
  readonly chatId: string;
  readonly originMessageId: string;
  readonly runId: string;
  /** Simple per-run sequence number for messageId namespaces (dsh-lark
   * parity: `reasoning-<turn>` etc. use plain numbers, not UUIDs). */
  readonly runSeq: number;
  readonly scope: string;
  readonly inputPreview: string;
  ref: CotRef | undefined;
  disabled = false;
  degradedReason: string | undefined;
  private buffer: CotEvent[] = [];
  /** Strictly-increasing timestamp source — see {@link nextTimestamp}. */
  private lastTimestamp = 0;
  /** Serialized flush chain: every update runs strictly in order, and
   * `finish()` awaits the tail so nothing can land after `complete()`. */
  private flushTail: Promise<void> = Promise.resolve();
  private completed = false;
  private timer: NodeJS.Timeout | undefined;
  private static seqCounter = 0;

  constructor(opts: {
    client: Pick<CotClient, 'create' | 'update' | 'complete'>;
    chatId: string;
    originMessageId: string;
    runId: string;
    scope: string;
    inputPreview: string;
  }) {
    this.client = opts.client;
    this.chatId = opts.chatId;
    this.runSeq = ++CotPublisher.seqCounter;
    this.originMessageId = opts.originMessageId;
    this.runId = opts.runId;
    this.scope = opts.scope;
    this.inputPreview = opts.inputPreview;
  }

  async start(): Promise<void> {
    // Single chat_id-addressed create. In topics the bubble follows
    // originMessageId's thread (see CotClient.create); the caller passes an
    // in-topic origin so it lands in the topic. On any failure we disable CoT
    // and let the caller fall back to a plain reply — never retry, since a
    // create that failed after committing server-side would leave a duplicate
    // bubble spinning forever.
    let created: Record<string, unknown>;
    try {
      created = await this.client.create(this.chatId, this.originMessageId);
    } catch (err) {
      this.disabled = true;
      log.warn('cot', 'create-failed', { err: err instanceof Error ? err.message : String(err) });
      return;
    }
    const cotId = stringValue(created.cot_id ?? created.cotId);
    const messageId = stringValue(created.message_id ?? created.messageId);
    if (!cotId || !messageId) {
      this.disabled = true;
      log.warn('cot', 'create-failed', {
        err: `CreateCOT missing ids: ${JSON.stringify(created).slice(0, 200)}`,
      });
      return;
    }
    this.ref = { cotId, messageId };
    log.info('cot', 'created', { cotId, messageId });
    // FIX(fork): match dsh-lark's event shape exactly — RUN_STARTED carries
    // only threadId/runId (no `input`), and NO STEP_STARTED is written
    // (dsh-lark: "No STEP event is written: a step is one..."). The STEP_*
    // events were non-standard; the Feishu client rendered the "理解用户问题"
    // step header and then failed to render any subsequent events.
    this.enqueue('RUN_STARTED', {
      threadId: this.scope,
      runId: this.runId,
    });
  }

  enqueue(eventType: string, content: unknown): void {
    if (this.disabled || !this.ref || this.completed) return;
    this.buffer.push({
      event_type: eventType,
      content: JSON.stringify(content),
      // FIX(fork): the message_cot API requires strictly increasing
      // timestamps (the client orders events by this value). Date.now() can
      // collide within one millisecond — token-level streams (hermes
      // agent_thought_chunk bursts) hit that constantly and the update
      // failed with 400 99992402 "field validation failed". dsh-lark's cot
      // renderer carries the same guard (lastTimestamp).
      timestamp: this.nextTimestamp(),
    });
    this.scheduleFlush();
  }

  private nextTimestamp(): string {
    const now = Date.now();
    const ts = now > this.lastTimestamp ? now : this.lastTimestamp + 1;
    this.lastTimestamp = ts;
    return String(ts);
  }

  async finish(reason: string): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // Enqueue a final drain pass and wait for the whole chain: every buffered
    // event must land BEFORE completing the cot — otherwise a trailing batch
    // races the terminal state and the API rejects it with 10001 "COT
    // already in terminal state".
    await this.flush();
    if (this.disabled || !this.ref) return;
    // FIX(fork): dsh-lark does NOT call the complete API — the terminal
    // RUN_FINISHED event closes the bubble on its own ("a terminal
    // RUN_FINISHED closes it without a further call"). Calling complete()
    // forced the bubble into a "finished" collapsed state ("思考已完成，点击
    // 查看") instead of leaving it naturally expandable. We mirror dsh-lark:
    // no complete call, just mark the publisher as terminal so no further
    // updates can land after the drain.
    this.completed = true;
    log.info('cot', 'finished', { cotId: this.ref.cotId, reason });
  }

  private scheduleFlush(): void {
    if (this.timer || this.completed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, COT_UPDATE_THROTTLE_MS);
  }

  /**
   * Enqueue one drain pass on the serialized chain. All updates run in
   * submission order; splits (≤50 events per write) are drained inside a
   * single pass with no throttle delay between them.
   */
  private flush(): Promise<void> {
    this.flushTail = this.flushTail.then(() => this.drain());
    return this.flushTail;
  }

  private async drain(): Promise<void> {
    if (this.disabled || !this.ref || this.completed) return;
    while (this.buffer.length > 0 && !this.disabled && !this.completed) {
      // FIX(fork): the message_cot API caps events per write at 50 — a larger
      // batch fails with 400 99992402 "field validation failed". Token-level
      // streams (hermes agent_thought_chunk) pile up far more than 50 within
      // one 600ms flush window. Split into ≤50-event writes and keep sending
      // until the buffer drains.
      const events = this.buffer.splice(0, MAX_EVENTS_PER_WRITE);
      if (events.length === 0) return;
      try {
        await this.client.update(this.ref, events);
      } catch (err) {
        this.disabled = true;
        this.degradedReason = err instanceof Error ? err.message : String(err);
        log.warn('cot', 'update-failed', { err: this.degradedReason });
        // FIX(fork) debug: the daemon logger truncates messages to ~120
        // chars, hiding which event made the API reject the batch. Dump the
        // full error plus the batch's event types to a side file.
        try {
          fs.appendFileSync(
            process.env.HOME + '/.lark-channel/cot-debug.log',
            `${new Date().toISOString()} ERR=${this.degradedReason}\n` +
              `TYPES=${JSON.stringify(events.map((e) => e.event_type))}\n` +
              `SAMPLE=${JSON.stringify(events.slice(0, 3)).slice(0, 800)}\n\n`,
          );
        } catch {
          /* debug file is best-effort */
        }
        return;
      }
    }
  }
}

export function finalAnswerOnlyState(state: RunState): RunState {
  return {
    ...state,
    blocks: state.finalText
      ? [{ kind: 'text', content: state.finalText, streaming: false }]
      : state.blocks.filter((b) => b.kind === 'text'),
    reasoning: { content: '', active: false },
    footer: null,
  };
}

export async function consumeCotEvents(
  events: AsyncIterable<AgentEvent>,
  publisher: CotPublisher,
  opts: { detail: CotMessagesMode },
): Promise<void> {
  let reasoningOpen = false;
  let textMessageOpen = false;
  let textMessageIndex = 0;
  let textMessageId: string | undefined;
  const toolBrief = new Map<string, { name: string; input: unknown }>();
  // dsh-lark parity: plain numeric namespace, not a UUID.
  const reasoningMessageId = `reasoning-${publisher.runSeq}`;

  try {
    for await (const evt of events) {
      if (evt.type === 'system' || evt.type === 'usage') continue;
      if (evt.type === 'thinking') {
        closeTextIfNeeded();
        if (!reasoningOpen) {
          reasoningOpen = true;
          // FIX(fork): dsh-lark's cot renderer does NOT emit REASONING_START /
          // REASONING_END — only REASONING_MESSAGE_START / CONTENT / END.
          // Emitting REASONING_START made the Feishu client treat the block
          // as "to be shown when done" (collapsed "思考已完成" until complete),
          // instead of streaming the reasoning live into the bubble.
          publisher.enqueue('REASONING_MESSAGE_START', {
            messageId: reasoningMessageId,
            role: 'reasoning',
          });
        }
        publisher.enqueue('REASONING_MESSAGE_CONTENT', {
          messageId: reasoningMessageId,
          delta: truncateCot(evt.delta, COT_TEXT_MAX),
        });
        continue;
      }
      if (evt.type === 'tool_use') {
        closeReasoningIfNeeded();
        closeTextIfNeeded();
        const toolCallId = evt.id;
        const detailed = opts.detail === 'detailed';
        const showSummary = opts.detail === 'brief' || detailed;
        const title = showSummary ? cotBriefToolTitle(evt.name, evt.input, 'running') : '正在调用工具';
        toolBrief.set(toolCallId, { name: evt.name, input: evt.input });
        publisher.enqueue('TOOL_CALL_START', {
          toolCallId,
          icon: showSummary ? cotToolIcon(evt.name) : 'default',
          title,
          toolCallName: showSummary ? evt.name : 'tool',
        });
        if (detailed && evt.input !== undefined) {
          publisher.enqueue('TOOL_CALL_ARGS', {
            toolCallId,
            // FIX(fork): the message_cot API caps one event's content at
            // 4096 chars — a large tool input (file read, directory tree,
            // command output) exceeded it and the update failed with HTTP
            // 400, killing the whole thinking bubble mid-reply.
            delta: truncateCot(JSON.stringify(evt.input), COT_TOOL_OUTPUT_MAX),
          });
        }
        publisher.enqueue('TOOL_CALL_END', { toolCallId });
        continue;
      }
      if (evt.type === 'tool_result') {
        const detailed = opts.detail === 'detailed';
        const brief = toolBrief.get(evt.id);
        publisher.enqueue('TOOL_CALL_RESULT', {
          messageId: `result-${evt.id}`,
          toolCallId: evt.id,
          role: 'tool',
          // FIX(fork): structured code-block content like dsh-lark's
          // renderer ({type:'code', code}) — a bare string content did not
          // render as a tool result in the Feishu client.
          content: detailed
            ? { type: 'code', code: truncateCot(evt.output ?? '', COT_TOOL_OUTPUT_MAX) }
            : brief
              ? cotBriefToolTitle(brief.name, brief.input, evt.isError ? 'error' : 'done')
              : '工具调用已完成',
        });
        toolBrief.delete(evt.id);
        continue;
      }
      if (evt.type === 'text') {
        closeReasoningIfNeeded();
        // FIX(fork): no STEP_STARTED around the text block — see the
        // RUN_STARTED note; STEP_* is non-standard and breaks rendering.
        if (!textMessageOpen) {
          textMessageOpen = true;
          textMessageId = `text-${publisher.runSeq}-${++textMessageIndex}`;
          publisher.enqueue('TEXT_MESSAGE_START', { messageId: textMessageId, role: 'assistant' });
        }
        publisher.enqueue('TEXT_MESSAGE_CONTENT', {
          messageId: textMessageId,
          delta: truncateCot(evt.delta, COT_TEXT_MAX),
        });
        continue;
      }
      if (evt.type === 'final_text') continue;
      if (evt.type === 'done' || evt.type === 'error') {
        closeReasoningIfNeeded();
        closeTextIfNeeded();
        if (evt.type === 'error') {
          publisher.enqueue('RUN_ERROR', { message: evt.message, code: evt.terminationReason ?? 'error' });
          await publisher.finish('error');
        } else {
          const status = evt.terminationReason === 'normal' ? 'done' : evt.terminationReason ?? 'done';
          publisher.enqueue('RUN_FINISHED', {
            threadId: publisher.scope,
            runId: publisher.runId,
            status,
          });
          await publisher.finish(status === 'done' ? 'done' : 'error');
        }
        return;
      }
    }
    closeReasoningIfNeeded();
    closeTextIfNeeded();
    await publisher.finish('done');
  } catch (err) {
    log.warn('cot', 'consume-failed', { err: err instanceof Error ? err.message : String(err) });
    await publisher.finish('error');
  }

  function closeReasoningIfNeeded(): void {
    if (!reasoningOpen) return;
    reasoningOpen = false;
    // FIX(fork): no REASONING_END — see the REASONING_MESSAGE_START note.
    publisher.enqueue('REASONING_MESSAGE_END', { messageId: reasoningMessageId });
  }

  function closeTextIfNeeded(): void {
    if (!textMessageOpen || !textMessageId) return;
    publisher.enqueue('TEXT_MESSAGE_END', { messageId: textMessageId });
    textMessageOpen = false;
    textMessageId = undefined;
  }
}

export function cotBriefToolTitle(
  name: string,
  input: unknown,
  status: 'running' | 'done' | 'error' = 'running',
): string {
  return toolHeaderText({ id: 'cot-tool', name, input, status }).replace(/\*\*/g, '');
}

function cotToolIcon(name: string): string {
  const lower = String(name ?? '').toLowerCase();
  if (lower.includes('search') || lower.includes('grep') || lower.includes('rg')) return 'search';
  if (lower.includes('read')) return 'read';
  if (lower.includes('write') || lower.includes('edit')) return 'write';
  if (lower.includes('doc')) return 'doc';
  if (lower.includes('calendar')) return 'calendar';
  if (lower.includes('task')) return 'task';
  if (lower.includes('command') || lower.includes('bash')) return 'bash';
  return 'default';
}

function truncateCot(value: unknown, max: number): string {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
