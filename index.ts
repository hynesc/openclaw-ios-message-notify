import { definePluginEntry, buildJsonPluginConfigSchema } from 'openclaw/plugin-sdk/plugin-entry';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Notifier, Transport, visibleText } from './core.mjs';
export default definePluginEntry({
  configSchema: buildJsonPluginConfigSchema({"type": "object", "properties": {"nodeId": {"type": "string"}, "openclawBinary": {"type": "string"}, "genericPreview": {"type": "boolean", "default": false}, "agents": {"type": "array", "items": {"type": "string"}}, "sessions": {"type": "array", "items": {"type": "string"}}}, "additionalProperties": false}),
  id: 'ios-message-notify', name: 'iOS Message Notifications',
  description: 'Native iPhone alerts for visible agent messages and questions.',
  register(api) {
    const config = api.pluginConfig ?? {};
    const transport = new Transport(config);
    let notifier: Notifier | undefined;
    const forward = (e: any) => { void notifier?.accept(e); };
    api.on('message_sent', (e, ctx) => {
      if (!e.success) return;
      const sessionKey = e.sessionKey ?? ctx.sessionKey;
      forward({ source: 'delivery', id: e.messageId, sessionKey,
        agentId: sessionKey?.split(':')[1], runId: e.runId ?? ctx.runId,
        text: visibleText({ role: 'assistant', content: e.content }) });
    });
    api.on('agent_end', (e, ctx) => {
      // Reconcile the final message only, never scan/re-notify historical context.
      const message: any = e.messages.at(-1);
      forward({ source: 'final', id: message?.id, sessionKey: ctx.sessionKey,
        agentId: ctx.agentId, runId: e.runId, text: visibleText(message) });
    });
    api.registerService({
      id: 'ios-message-notify',
      async start(ctx) {
        notifier = new Notifier({ config, file: join(ctx.stateDir, 'ios-message-notify', 'state.json'),
          send: (title, body) => transport.send(title, body), logger: ctx.logger });
        try { await notifier.load(); } catch (error) { notifier = undefined; throw error; }
        unsub = api.runtime.events.onSessionTranscriptUpdate((e: any) => {
          forward({ source: 'transcript', id: e.messageId ?? (e.messageSeq != null ? `seq:${e.messageSeq}` : undefined),
            agentId: e.agentId ?? e.target?.agentId, sessionKey: e.sessionKey ?? e.target?.sessionKey,
            runId: e.runId, text: visibleText(e.message) });
        });
        unsubAgent = api.runtime.events.onAgentEvent((e: any) => {
          const d = e.data ?? {};
          // Only committed assistant occurrences; raw deltas and reasoning never generate pushes.
          if (e.stream === 'assistant' && d.committedMessageSeq != null) {
            forward({ source: 'assistant', id: d.itemId, agentId: e.agentId,
              sessionKey: e.sessionKey, runId: e.runId,
              text: visibleText({ ...d, role: 'assistant', content: d.text }) });
          }
          if (e.stream === 'approval' && d.phase === 'requested' && d.kind === 'unknown') {
            forward({ source: 'approval', kind: 'approval', id: d.approvalId ?? d.itemId,
              agentId: e.agentId, sessionKey: e.sessionKey, runId: e.runId,
              text: d.message ?? d.title ?? 'An agent needs your approval.' });
          }
        });
        ctx.logger.info('ios-message-notify: listening for committed visible messages');
      },
      async stop() { unsub?.(); unsubAgent?.(); unsub = undefined; unsubAgent = undefined; await notifier?.stop(); notifier = undefined; },
    });
    let unsub: (() => void) | undefined;
    let unsubAgent: (() => void) | undefined;
    api.on('before_tool_call', (e, ctx) => {
      if (!['ask_user', 'request_user_input'].includes(e.toolName)) return;
      const p: any = e.params;
      const text = p?.question ?? p?.prompt ?? p?.questions?.map((q: any) => q.question ?? q.title ?? '').join(' ');
      forward({ source: 'question', kind: 'question', sessionKey: ctx.sessionKey,
        agentId: ctx.agentId, runId: ctx.runId, id: (ctx as any).toolCallId, text });
    });
    // Native exec/plugin approval pushes retain their existing interactive actions.
    api.registerCli(({ program }) => {
      const cmd = program.command('ios-notify').description('Inspect or test iOS message notifications');
      cmd.command('status').action(async () => {
        let records: any[] = [];
        try { records = JSON.parse(await readFile(join(api.runtime.state.resolveStateDir(), 'ios-message-notify', 'state.json'), 'utf8')).records ?? []; }
        catch (error: any) { if (error.code !== 'ENOENT') throw error; }
        console.log(JSON.stringify({ nodeId: await transport.node(), genericPreview: !!config.genericPreview,
          recentDeliveries: records.reduce((counts, row) => { counts[row.status] = (counts[row.status] ?? 0) + 1; return counts; }, {}),
          lastAttemptAt: records.at(-1)?.at ?? null,
          state: 'Plugin uses gateway service; inspect with openclaw plugins inspect ios-message-notify --runtime --json' }, null, 2));
      });
      cmd.command('test').action(async () => {
        console.log(JSON.stringify(await transport.send('OpenClaw notifications', 'iOS Message Notifications is ready.'), null, 2));
      });
    }, { commands: ['ios-notify'] });
  },
});
