import { HermesAdapter } from './smoke-out/smoke-entry.js';

const adapter = new HermesAdapter({ binary: '/home/luoke/.local/bin/hermes', acpArgs: [], larkChannel: undefined });
const run = adapter.run({
  runId: 'smoke-hermes',
  prompt: '用 bash 工具执行 echo HERMES-OK，然后只回复：完成',
  cwd: '/tmp',
  sessionId: undefined,
  model: undefined,
});
const t0 = Date.now();
let thinking = 0, tools = 0, finalText = '';
for await (const ev of run.events) {
  if (ev.type === 'system') console.log('system sessionId:', ev.sessionId);
  if (ev.type === 'thinking') { thinking++; }
  if (ev.type === 'tool_use') console.log('tool_use:', ev.name, '| input:', JSON.stringify(ev.input).slice(0, 80));
  if (ev.type === 'tool_result') console.log('tool_result:', ev.output.slice(0, 100));
  if (ev.type === 'final_text') { finalText = ev.content; console.log('final_text:', ev.content.slice(0, 100)); }
  if (ev.type === 'done') console.log('done:', ev.terminationReason);
  if (ev.type === 'error') console.log('ERROR:', ev.message.slice(0, 200));
}
console.log('thinking events:', thinking, '| tools:', tools, '| finalTextLen:', finalText.length);
console.log('duration:', ((Date.now() - t0) / 1000).toFixed(1) + 's');
const pass = thinking > 0 && finalText.length > 0;
console.log('SMOKE-' + (pass ? 'PASS' : 'FAIL'));
process.exit(pass ? 0 : 1);
