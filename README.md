# iOS Message Notifications

Local OpenClaw gateway plugin for the official iOS app. Version 0.1.1 notifies on response completion and attention requests. Tested on OpenClaw
2026.11.3. Uses the existing `nodes push` / `push.test` path and the official
relay; no new server, APNs keys, runtime dependencies, or model calls.

## Behavior

- Sends one alert when an agent successfully finishes its response, using the
  final visible reply as the preview. Intermediate messages, tool activity, and
  reasoning do not generate notifications. Silent responses (`NO_REPLY` and
  `HEARTBEAT_OK`), failed/aborted runs, and internal subagent/ACP sessions are skipped.
- Completion alerts use `agent_end`; transcript commits and outbound message
  delivery do not trigger alerts. This applies to user and scheduled runs that
  produce a final visible reply. Messages sent outside a completed agent run,
  or tool-only sends followed by a silent final reply, do not trigger alerts.
- Questions from `ask_user` and `request_user_input` notify before the tool waits.
  Native exec and plugin approvals retain OpenClaw's existing push delivery and
  interactive actions; unknown-kind agent approval events receive a generic alert.
- Titles contain the agent ID. Previews contain up to 200 Unicode characters.
  Attachment-only messages use an attachment label when exposed by the host.
- Always sends regardless of foreground presence or time. iOS permission and
  Focus settings determine presentation. Tapping uses the app's existing routing;
  the gateway push RPC cannot select a conversation.
- Deduplicates completion events by run identity. Stores only hashes,
  message IDs, observer identities, timestamps, and acceptance/failure status locally
  (up to 1,000 recent entries, retained for 24 hours); preview text is not persisted.
- Sends asynchronously, with three attempts and 1s/2s backoff. Failed sends are
  logged without message content. Relay acceptance does not confirm presentation.
  In-flight/queued alerts are not replayed after a gateway restart; an ambiguous
  network timeout can cause a duplicate retry. Distinct observers without shared
  identity use a 60-second matching window, so delayed observations can duplicate.

## Install

Use Node 24 or later, as required for the development tests. The gateway loads
TypeScript directly; no compilation or dependency installation is needed.

```sh
git clone https://github.com/hynesc/openclaw-ios-message-notify.git
cd openclaw-ios-message-notify
openclaw plugins install "$PWD" --link --force --accept-capabilities
openclaw config patch --stdin <<'JSON'
{"plugins":{"entries":{"ios-message-notify":{"enabled":true,"hooks":{"allowConversationAccess":true}}}}}
JSON
```

These commands merge installation and configuration into existing gateway state.
Conversation access is required for the final-response reconciliation hook.
Only use `--force` after reviewing the local source.

Optional configuration under `plugins.entries.ios-message-notify.config`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `nodeId` | auto-detect | Paired official iOS node; required when several exist |
| `openclawBinary` | `openclaw` on PATH | Absolute CLI launcher path when gateway PATH differs |
| `genericPreview` | `false` | Keep message text out of push previews |
| `agents` | all | Agent IDs to include |
| `sessions` | all | Exact canonical session keys to include |

Auto-detection requires exactly one paired official iOS node and works while it
is disconnected. Set `nodeId` explicitly to select a particular device.

## Check and test

```sh
npm test
openclaw plugins doctor
openclaw plugins inspect ios-message-notify --runtime --json
openclaw ios-notify status
openclaw ios-notify test
```

`status` reports the target and recent persisted delivery results. `test` sends a
real production alert and prints the relay receipt. The host's `plugins validate`
command supports tool/feature authoring contracts, not this service plugin;
`plugins doctor` and runtime inspection validate its loading and configuration.

Tests cover visibility, attachments, repeated messages, correlation, restarts,
filters, Unicode previews, retries, device selection, and completion/attention adapters.
Regression coverage verifies no intermediate alerts and one completion per run.
Production relay acceptance was verified with the gateway push transport.
Completion and question handling are covered by the service adapter tests.
Real model-driven questions and native interactive approvals still need phone-side
verification. First pair the official app, grant notification permission, and let
it finish registering for push. If delivery fails, check registration, connectivity
to `ios-push-relay.openclaw.ai`, and gateway logs.

## Update or disable

After source edits: `openclaw plugins reload ios-message-notify`. The plugin
declares turn handover, so reload can switch active turns at their next model step.

Rollback: `openclaw plugins disable ios-message-notify`. This stops the service
without affecting native approval pushes or other plugins. The gateway retains
configuration backups and the plugin's hash-only delivery history.

## License

[MIT](LICENSE). This is an unofficial community plugin, not affiliated with OpenClaw.
