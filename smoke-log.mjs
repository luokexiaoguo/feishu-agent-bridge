import { HermesAdapter } from './smoke-out/smoke-entry.js';
const adapter = new HermesAdapter({ binary: '/home/luoke/.local/bin/hermes', acpArgs: [], larkChannel: undefined });
const run = adapter.run({ runId: 'smoke-log', prompt: '1+1等于几？直接回答', cwd: '/tmp', sessionId: undefined, model: undefined });
for await (const ev of run.events) {
  if (ev.type === 'final_text') console.log('FINAL:', ev.content.slice(0, 50));
  if (ev.type === 'done') console.log('DONE');
  if (ev.type === 'error') console.log('ERR:', ev.message.slice(0, 100));
}
console.log('SCRIPT-END');
