// Child process for discord-not-loaded.test.mjs: record every module this process resolves, then run a core bus with
// Discord switched off through a full card round trip, and print the recorded URLs as JSON on the last line.
import { registerHooks } from 'node:module';

const resolved = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const r = nextResolve(specifier, context);
    resolved.push(r.url);
    return r;
  },
});

const { startBus } = await import('../../helpers/bus.mjs');
const mappedButOff = process.argv[2] === 'mapped-but-off';
const fx = await startBus({
  people: { owner1: { key: 'owner-key-0123456789', accounts: { discord: '700000000000000101' } } },
  config: { discord: { enabled: false, ...(mappedButOff ? { projects: { alpha: { channels: { code: '700000000000000201' } } } } : {}) } },
});
const A = { key: fx.keys.alpha, project: 'alpha' };
const d = await fx.call('POST', '/api/ask/dispatch', { ...A, body: { question: 'q?', options: ['a'], askingSeat: 'alphabot' } });
const answered = await fx.call('POST', `/api/ask/${d.body.askId}/answer`, { human: 'owner1', key: 'owner-key-0123456789', project: 'alpha', body: { label: 'a' } });
await fx.call('POST', '/api/message', { ...A, body: { sender: 'alphabot', channel: 'code', content: 'hi' } });
const health = await fx.call('GET', '/api/health');
await fx.close();
console.log(JSON.stringify({ delivery: d.body.delivery, answered: answered.status, channel: health.body.humanChannel, resolved }));
