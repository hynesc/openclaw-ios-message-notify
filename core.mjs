import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export function visibleText(message) {
  if (!message || message.role !== 'assistant' || message.isReasoning || message.hidden || message.visibility === 'internal') return '';
  const content = message.content ?? message.text;
  const blocks = Array.isArray(content) ? content : [];
  const text = typeof content === 'string' ? content : blocks.filter(b => b.type === 'text' && !b.isReasoning).map(b => b.text ?? '').join('\n');
  if (/^\s*(NO_REPLY|HEARTBEAT_OK)\s*$/.test(text)) return '';
  return clean(text) || (blocks.some(b => ['image', 'image_url', 'audio', 'file', 'video'].includes(b.type)) ? '[Attachment]' : '');
}
export function clean(text) {
  return String(text ?? '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').replace(/\[\[(?:reply_to[^\]]*|audio_as_voice)\]\]/g, '').replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
}
export class Transport {
  constructor(config = {}) { this.config = config; }
  async command(args) {
    const { stdout } = await exec(this.config.openclawBinary || 'openclaw', args, { timeout: 30000, maxBuffer: 1024 * 1024 });
    // --json commands produce a single JSON value; never log stdout (may contain device metadata).
    return JSON.parse(stdout);
  }
  async node() {
    if (this.config.nodeId) return this.config.nodeId;
    const data = await this.command(['nodes', 'list', '--json']);
    const candidates = (data.paired ?? data.nodes ?? []).filter(n => n.clientId === 'openclaw-ios' && n.deviceFamily !== 'AppleWatch');
    if (candidates.length !== 1) throw new Error(candidates.length ? 'Multiple iOS devices: configure nodeId' : 'No paired official iOS device');
    return candidates[0].nodeId;
  }
  async send(title, body) {
    const nodeId = await this.node();
    const result = await this.command(['nodes', 'push', '--node', nodeId, '--title', title, '--body', body, '--json']);
    if (result.ok === false || result.result?.ok === false) throw new Error('Push relay rejected alert');
    return result;
  }
}
export class Notifier {
  constructor({ config = {}, file, send, logger = console, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
    Object.assign(this, { config, file, send, logger, now, sleep });
    this.records = []; this.chain = Promise.resolve(); this.active = true;
  }
  async load() {
    try { this.records = JSON.parse(await readFile(this.file, 'utf8')).records ?? []; }
    catch (e) { if (e.code !== 'ENOENT') throw new Error('Cannot read notification state'); }
  }
  async save() {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(this.file + '.tmp', JSON.stringify({ records: this.records }), { mode: 0o600 });
    await rename(this.file + '.tmp', this.file);
  }
  accept(event) {
    this.chain = this.chain.then(() => this.deliver(event)).catch(() => this.logger.warn('ios-message-notify: notification failed; agent response unaffected'));
    return this.chain;
  }
  async deliver(e) {
    if (!this.active || !e.text || !e.sessionKey || /:(subagent|acp):/.test(e.sessionKey) || e.internal || e.incognito) return;
    if (this.config.agents?.length && !this.config.agents.includes(e.agentId)) return;
    if (this.config.sessions?.length && !this.config.sessions.includes(e.sessionKey)) return;
    const now = this.now();
    this.records = this.records.filter(r => now - r.at < 86400000).slice(-999);
    const signature = createHash('sha256').update(JSON.stringify([e.agentId, e.sessionKey, e.kind ?? 'message', clean(e.text)])).digest('hex');
    const id = e.id ? `${e.agentId}:${e.sessionKey}:${e.id}` : undefined;
    // Match different observers one-to-one, preserving repeated equal messages from the same source.
    const duplicate = this.records.find(r => (id && r.ids.includes(id)) || (r.signature === signature && (!r.runId || !e.runId || r.runId === e.runId) && now - r.at < 60000 && !r.sources.includes(e.source)));
    if (duplicate) {
      duplicate.sources.push(e.source); if (id) duplicate.ids.push(id);
      await this.save(); return;
    }
    const record = { signature, runId: e.runId, ids: id ? [id] : [], sources: [e.source], at: now, status: 'pending' };
    this.records.push(record);
    await this.save();
    const title = `${e.agentId || 'Agent'} · ${e.kind === 'question' ? 'Needs your answer' : e.kind === 'approval' ? 'Approval needed' : 'New message'}`;
    const body = this.config.genericPreview ? 'Open OpenClaw to view the update.' : Array.from(clean(e.text)).slice(0, 200).join('');
    for (let attempt = 0; attempt < 3 && this.active; attempt++) {
      try { await this.send(title, body); record.status = 'accepted'; await this.save(); return; }
      catch {
        if (attempt === 2) { record.status = 'failed'; await this.save(); throw new Error('Push delivery failed'); }
        await this.sleep(1000 * 2 ** attempt);
      }
    }
  }
  async stop() { this.active = false; await this.chain; }
}
