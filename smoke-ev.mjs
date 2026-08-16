import { HermesAdapter, prefixBridgeSystemPrompt } from './smoke-out/smoke-entry.js';
const adapter = new HermesAdapter({ binary: '/home/luoke/.local/bin/hermes', acpArgs: [], larkChannel: undefined });
const prompt = prefixBridgeSystemPrompt('请联网搜索一下今天的新闻热点，简要总结。', undefined);
const run = adapter.run({ runId: 'smoke-ev', prompt, cwd: '/tmp', sessionId: undefined, model: undefined });
const stats = { system:0, thinking:0, text:0, tool_use:0, tool_result:0, final_text:0, done:0, error:0 };
const t0 = Date.now();
const toolNames = new Set();
for await (const ev of run.events) {
  stats[ev.type]++;
  if (ev.type === 'tool_use') toolNames.add(ev.name);
  if (ev.type === 'done' || ev.type === 'error') {
    console.log('terminal:', ev.type, ev.terminationReason, '|', ((Date.now()-t0)/1000).toFixed(1)+'s');
  }
}
console.log('stats:', JSON.stringify(stats));
console.log('tools:', [...toolNames].join(', '));
console.log(JSON.stringify(stats));
