import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Notifier, visibleText, Transport } from './core.mjs';
const base = { agentId: 'main', sessionKey: 'agent:main:main', runId: 'run1', source: 'transcript', text: 'Hello' };
async function setup(config = {}) {
  const sent = []; const file = join(await mkdtemp(join(tmpdir(), 'ios-notify-')), 'state.json');
  const n = new Notifier({ config, file, send: async (...args) => sent.push(args), sleep: async () => {} });
  await n.load(); return { n, sent, file };
}
test('only visible assistant content is extracted', () => {
  assert.equal(visibleText({ role: 'tool', content: 'secret' }), '');
  assert.equal(visibleText({ role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'Done' }] }), 'Done');
  for (const text of ['NO_REPLY', 'HEARTBEAT_OK']) assert.equal(visibleText({ role: 'assistant', content: text }), '');
  assert.equal(visibleText({ role: 'assistant', content: [{ type: 'image' }] }), '[Attachment]');
});
test('duplicate observers coalesce; equal separate messages and concurrent agents survive', async () => {
  const { n, sent } = await setup();
  await n.accept({ ...base, id: '1' });
  await n.accept({ ...base, source: 'delivery', id: 'external1' });
  await n.accept({ ...base, source: 'final', id: '1' });
  assert.equal(sent.length, 1);
  await n.accept({ ...base, id: '2' });
  await n.accept({ ...base, source: 'delivery', id: 'external2' });
  await n.accept({ ...base, agentId: 'coder', sessionKey: 'agent:coder:main', id: '1' });
  assert.equal(sent.length, 3);
});
test('duplicate identity survives restart without storing previews', async () => {
  const { n, sent, file } = await setup();
  await n.accept({ ...base, id: '1' });
  const other = new Notifier({ file, send: async () => sent.push('duplicate') }); await other.load();
  await other.accept({ ...base, id: '1' }); assert.equal(sent.length, 1);
  assert.ok(!JSON.stringify(other.records).includes('Hello'));
});
test('filters, silent/internal sessions, generic and bounded Unicode previews', async () => {
  const { n, sent } = await setup({ agents: ['main'], genericPreview: true });
  for (const e of [{ agentId: 'other' }, { internal: true }, { incognito: true }, { sessionKey: 'agent:main:subagent:x' }]) await n.accept({ ...base, ...e });
  assert.equal(sent.length, 0); await n.accept(base); assert.ok(!sent[0][1].includes('Hello'));
  const s = await setup(); await s.n.accept({ ...base, text: '😀'.repeat(300) });
  assert.equal(Array.from(s.sent[0][1]).length, 200);
});
test('bounded retries, terminal failure, and stopped services', async () => {
  const { n } = await setup(); let attempts = 0;
  n.send = async () => { attempts++; throw Error('offline'); }; n.logger = { warn() {} };
  await n.accept(base); assert.equal(attempts, 3); assert.equal(n.records[0].status, 'failed');
  await n.stop(); await n.accept({ ...base, id: 'new' }); assert.equal(attempts, 3);
});
test('node discovery never falls back to non-iOS devices', async () => {
  const t = new Transport(); t.command = async () => ({ paired: [{ nodeId: 'linux', platform: 'linux' }] });
  await assert.rejects(t.node(), /No paired/);
  t.command = async () => ({ paired: [{ nodeId: 'phone', clientId: 'openclaw-ios' }] });
  assert.equal(await t.node(), 'phone');
  t.command = async () => ({ paired: [{ nodeId: 'a', clientId: 'openclaw-ios' }, { nodeId: 'b', clientId: 'openclaw-ios' }] });
  await assert.rejects(t.node(), /Multiple/);
});
test('transcript without run metadata deduplicates the final observer', async () => {
  const { n, sent } = await setup();
  await n.accept({ ...base, runId: undefined, id: 'transcript' });
  await n.accept({ ...base, source: 'final', id: 'final' });
  assert.equal(sent.length, 1);
});
test('service alerts only on completion and attention requests, never intermediate activity', async () => {
  const { stripTypeScriptTypes } = await import('node:module');
  const { readFile } = await import('node:fs/promises');
  let code = stripTypeScriptTypes(await readFile(new URL('./index.ts', import.meta.url), 'utf8'));
  code = code.replace(/import .* from 'openclaw\/plugin-sdk\/plugin-entry';/, 'const definePluginEntry = x => x; const buildJsonPluginConfigSchema = x => x;');
  code = code.replace("'./core.mjs'", JSON.stringify(new URL('./core.mjs', import.meta.url).href));
  const { default: plugin } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  const hooks = {}; let service, agent, removed = 0; const sent = [];
  const original = Transport.prototype.send;
  Transport.prototype.send = async (...args) => { sent.push(args); };
  try {
    plugin.register({ pluginConfig: {}, on: (k, h) => hooks[k] = h,
      registerService: s => service = s, registerCli() {},
      runtime: { events: {
        onSessionTranscriptUpdate() { throw Error('Intermediate transcript subscription must not be registered'); },
        onAgentEvent(h) { agent = h; return () => removed++; },
      } } });
    await service.start({ stateDir: await mkdtemp(join(tmpdir(), 'ios-service-')), logger: { info() {}, warn() {} } });
    assert.equal(hooks.message_sent, undefined);
    agent({ ...base, stream: 'assistant', data: { text: 'Progress', committedMessageSeq: 1 } });
    agent({ ...base, stream: 'thinking', data: { text: 'hidden' } });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(sent.length, 0);
    hooks.agent_end({ success: false, runId: 'failed', messages: [{ role: 'assistant', content: 'Partial answer' }] }, base);
    hooks.agent_end({ success: true, runId: 'silent', messages: [{ role: 'assistant', content: 'NO_REPLY' }] }, base);
    const completed = { success: true, runId: 'done', messages: [
      { role: 'assistant', content: 'Progress' }, { role: 'assistant', content: 'Finished' },
    ] };
    hooks.agent_end(completed, base);
    hooks.agent_end(completed, base); // replay must not generate a second completion alert
    hooks.agent_end({ ...completed, runId: 'another-run' }, base); // same answer in another run is distinct
    hooks.before_tool_call({ toolName: 'ask_user', params: { question: 'Which option?' } }, { ...base, toolCallId: 'question' });
    agent({ ...base, stream: 'thinking', data: { text: 'hidden' } });
    agent({ ...base, stream: 'approval', data: { phase: 'requested', kind: 'exec', title: 'Native handles this' } });
    // Wait for the asynchronous service queue to settle before shutdown.
    for (let i = 0; i < 50 && sent.length < 3; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(sent.length, 3); assert.equal(sent[0][1], 'Finished'); assert.match(sent[0][0], /Response finished/); assert.equal(sent[1][1], 'Finished'); assert.equal(sent[2][1], 'Which option?');
    await service.stop(); assert.equal(removed, 1);
  } finally { Transport.prototype.send = original; }
});
