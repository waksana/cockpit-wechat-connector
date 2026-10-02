# Cockpit WeChat module

Native, in-process WeChat iLink transport for one explicitly authorized account,
one private peer, and one Cockpit session. The neutral `wechat/wechat` role has
no instructions, skills, or MCP tools and may coexist with an exclusive
Assistant role. Selecting a role does not create an Assistant or start another
service.

This is a **new module**, not a wrapper around the former CLI. Its new private
database is intentionally incompatible with legacy profiles and receipts.
No old CLI installation, credential, cursor, SQLite/WAL, or service is discovered,
adopted, migrated, or deleted. The obsolete standalone CLI and its queue/recovery
tools have been removed from the repository. Existing native module data is
retained through the [one-time adapter conversion](docs/MODULE.md#upgrading-existing-native-data).

## Requirements

- Linux and Node.js 24 or later.
- Built with the published exact `@waksana/cockpit-module-sdk@0.15.0`.
- Host capabilities: `serviceReadyVersion: 1`, `shutdownVersion: 1`,
  `roleAssignmentVersion: 1`, `roleAvailabilityVersion: 1`,
  `sessionLoadVersion: 1`, `chatReadVersion: 1`, `promptReceiptVersion: 1`,
  and `askResponseVersion: 1`. The targeted host baseline is Rolling 32;
  actual capabilities, not a version label alone, are checked.
- Explicit authorization to consume the selected account. Installation and
  configuration alone are not authorization to run a real account.

## Build and package

The SDK is downloaded from GitHub Packages. Set `NODE_AUTH_TOKEN` to an existing
identity with package read access; never commit the token. CI uses its repository
`GITHUB_TOKEN` with `packages: read` and must already have package access.

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run pack:module
```

The `.tgz` contains `cockpit.module.json`, bundled backend ESM, and license
notices, build inventory, and (for Rolling) an embedded deployment descriptor.
No dependency installation is required by the host. Output is in a new
`module-output/` directory; preserve or remove that output explicitly before
packaging again. Merged PRs publish real Rolling prereleases, never install or
restart production. See [release and deployment boundaries](docs/DELIVERY.md).

## Installation and configuration

Only after separate operator authorization, install the archive using Cockpit's
ordinary trusted local module installer. Configure its next-start `config`:

```json
{
  "enabled": false,
  "exclusiveAccountConfirmed": false,
  "account": "EXPLICIT_BOT_ID",
  "peer": "EXPLICIT_PRIVATE_PEER_ID",
  "fileRoots": ["/absolute/authorized/output-directory"],
  "webUrl": "https://your-cockpit.example"
}
```

`fileRoots: []` explicitly disables outgoing local file access. Outgoing text
still works. Use narrow directories; do not grant a home directory simply to
make credential paths reachable.

Provision only `credentials.json` inside the host-provided private module data
directory (`COCKPIT_HOME/modules/data/wechat`). Its mode must be `0600`, owned
by the host user, regular, and not linked:

```json
{"account":"EXPLICIT_BOT_ID","peer":"EXPLICIT_PRIVATE_PEER_ID","token":"REDACTED"}
```

This module provides no login command and does not read old profiles or environment
tokens. Keep real credentials out of module config, source, chat, and artifacts.
Configure credentials through a separately authorized secure provisioning process.
Missing configuration/credentials produces explicit unavailable reasons, without
blocking host startup.

Only set both `enabled` and `exclusiveAccountConfirmed` to `true` after explicitly
confirming that no legacy connector or other consumer is using the account.
A Linux abstract-socket lease prevents concurrent **new module** instances from
consuming the same account, even in different data roots. It cannot fence an
unmodified legacy process, another machine, or a different network namespace.
The confirmation is not a claim that the module inspected or stopped those
processes. This implementation never stops them.

Configuration takes effect on an operator-authorized host cold start. Service
consumption begins only after `onReady`, not at import/activation or per-session
load. This delivery does not authorize installing or restarting production.

## Conversation behavior

One WeChat conversation corresponds to one original Cockpit session. The module
mirrors new primary assistant message bodies from that shared session, including
replies triggered from Web. The selected peer must be authorized to see the
entire session. It does not forward tool execution details or subagent transcripts.

Ordinary input calls native `prompt` with `mode: "immediate"`; native Copilot
owns busy/steering/execution behavior. Replies call WeChat send/upload directly.
There is no connector-owned durable inbox/outbox, retry worker, or manual
unlock workflow. A failed/unknown message does not block independent later
messages or role selection, and is never automatically retried.

An unloaded existing session still owns its binding. Only a real inbound message
loads that same ID through `session/load`; passive availability/history never
loads, creates, or reloads a session. Only a valid `session/get` response with
`meta: null` retires a missing binding. HTTP errors and malformed responses mean
unknown, not deleted. A generation fence prevents late lookups clearing new
bindings; durable saved-notification IDs prevent replay from rebinding.

### AskUser in WeChat

The connector sends the question and choices as ordinary text. Once that question
has been sent, reply directly with the exact option text or a free-form answer
when the native question allows one. No command prefix or card API is needed.
The answer goes to the exact pending `requestId` through native `respondAsk`,
not as another prompt. Exact choice text uses `wasFreeform: false`; arbitrary
text uses `true` only when allowed.

Messages are associated with the displayed question when received.
Before submission the connector rechecks that request. A question already
answered in Web, replaced, or not yet presented causes a rejection notice; its
reply is never silently used to answer the next question. Duplicate messages do
not answer twice. An unknown response is retained and never retried automatically.

Plain text has no cryptographic or UI-bound question identity: if someone reads
an old question but sends text after a new one is displayed, the sender's
subjective intent cannot be proven. Timestamps, locally retained question
identity, and pre-submission checks reduce but cannot eliminate this ambiguity.
Do not use this text bridge as an approval/security boundary.

Plan and elicitation decisions remain native Web interactions, with a WeChat
link notification; they are not misrepresented as AskUser.

## Files, quotes, delivery limits, and shutdown

See the [module contract](docs/MODULE.md) for direct-call delivery limits,
deduplication/results, immutable media copies, history gaps, and shutdown.
Tencent protocol adaptations retain the [MIT attribution](THIRD_PARTY_NOTICES.md)
and [upstream license](LICENSE.tencent).
