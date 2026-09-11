# Official WeChat module (opt-in, offline control)

`module.json` is schema/config version 1, module/package version 0.1.0, Linux x64,
Node 24, Cockpit API 1. Its sole role `wechat` provides binding only: no injected
instructions, skills or MCP. The existing lifecycle service remains
`node src/cli.js run`: `/health`, `/version`, `/admin/restart`. It requires one
of the explicit launcher identity/port environments below; the manifest does
not start, log in, recover, drain or send messages.

## Independent module-runner lifecycle

Launch the fixed service entry with the selected config reference, only when
runtime startup is separately authorized:

```text
node src/cli.js run --config /absolute/private/module-config.json
COCKPIT_MODULE_ID=wechat
COCKPIT_MODULE_VERSION=0.1.0
COCKPIT_MODULE_DIGEST=<64 lowercase hexadecimal catalog digest>
COCKPIT_MODULE_INSTANCE=<canonical lowercase UUID for this process>
COCKPIT_MODULE_PORT=<loopback port, integer 1..65535>
```

`SERVICE_DELIVERY_PORT` is also accepted in place of `COCKPIT_MODULE_PORT`.
If both are set they must match. Module version must match the actual installed
`module.json` **and** `package.json`; it is not copied blindly from environment.
The digest is the trusted parent's selected catalog identity, never Git HEAD or
an invented CD artifact identity.

The host **must remove inherited** `SERVICE_DELIVERY_SHA`,
`SERVICE_DELIVERY_ARTIFACT`, `SERVICE_DELIVERY_REQUEST` and
`SERVICE_DELIVERY_INSTANCE` from a module child's environment (not set them to
empty strings). Any simultaneous CD and module identity is rejected with
`LIFECYCLE_IDENTITY_CONFLICT`. Partial/invalid module identity and mismatched
version/ports fail before config or business-state access. Existing private-CD
identity validation and all its response shapes remain unchanged.

Module `/version`:

```json
{"moduleApi":1,"moduleId":"wechat","moduleDigest":"<digest64>","instanceId":"<uuid>","version":"0.1.0"}
```

Module `/health` returns those **same five identity fields** plus
`{"running":true,"ok":true,"phase":"running"}` (actual current state, not a
startup guarantee). `/status` and `/admin/restart` also carry the same module
identity. There is no `sha`, `artifactSha256` or fabricated delivery request.
The facade remains loopback-only; drain semantics are unchanged. Offline
`src/module-control.js` binding commands do not need any lifecycle environment.

## Explicit configuration reference

Existing CLI configurations and their legacy `.bridge-state` and
`.bridge-state/credentials.json` defaults remain unchanged. Optional `stateDir`,
`credentialFile`, `lockDir` must be normalized absolute paths.

Module management additionally requires an explicitly prepared **new** private
config file (0600) with:

```json
{
  "moduleManaged": true,
  "stateDir": "/absolute/private/wechat/bindings",
  "lockDir": "/absolute/private/wechat/control",
  "credentialFile": "/absolute/private/existing-account/credentials.json",
  "cockpit": {
    "apiUrl": "http://127.0.0.1:8771",
    "webUrl": "http://127.0.0.1:8771",
    "sessionId": "",
    "cwd": ""
  },
  "weixin": {
    "allowedAccount": "EXPLICIT_EXISTING_ACCOUNT",
    "allowedPeer": "EXPLICIT_EXISTING_PEER",
    "approvedApiOrigins": ["https://ilinkai.weixin.qq.com"]
  }
}
```

All other existing configuration fields retain their meanings/defaults. The
three paths must not overlap; parent directories must already exist, with
module-created directories 0700. `stateDir` is a new, empty binding-state root,
not an existing profile. `credentialFile` references the existing credential
file directly: no token copies, login or automatic credential discovery.
Raw `cockpit.sessionId/cwd` stay empty; the protected module routing record
provides their effective values. The config file is never rewritten.

One installed connector/configuration reference must use **one stable lockDir**.
The module enforces one active target there, not a global registry of arbitrary
legacy profiles or other independently configured connector installations.
An operator must explicitly ensure no legacy runner consumes the same account
before opting in. This adapter never scans/adopts/stops those other profiles.

## Fixed control transport

The parent invokes trusted installed code:

```sh
printf '%s\n' '{"operation":"status"}' |
  node src/module-control.js --config /absolute/private/module-config.json
```

Exactly one JSON object on stdin, EOF required, at most 16 KiB, 5-second input
deadline. Output is one bounded JSON line (at most 16 KiB), exit 0 for `ok:true`,
exit 2 for `ok:false`. Errors expose stable codes only, never raw exception
messages, tokens, account/peer IDs, message bodies, checkpoints or local paths.
Unknown request fields are rejected. Requests:

```json
{"operation":"status"}
{"operation":"bind","operationId":"unique-bind-0001","sessionId":"native-session-id","cwd":"/exact/native/cwd"}
{"operation":"unbind","operationId":"unique-unbind-0001","sessionId":"native-session-id","cwd":"/exact/native/cwd"}
```

`operationId`: 8–120 ASCII letters/digits/underscore/hyphen (reserved prototype
property names rejected). `sessionId`: 1–200 ASCII letters/digits/underscore/
hyphen. `cwd`: absolute, at most 4096 characters, no NUL/newline. Bind validates
the exact session ID and cwd through `CockpitClient.meta()`'s native
`POST /intent/session/get` **read-only intent**. It does not create/load a
session, prompt, interrupt, send WeChat requests or log in. Optional
`COCKPIT_API_TOKEN` uses the existing client environment mechanism.

Alternatively, set optional `cockpit.tokenFile` to a normalized absolute
**protected file path**, not token contents. This is supported by native bind
reads and the normal runner's Cockpit client. The file must be a regular
non-symlink, single-link file owned by the process UID, with no group/other
permissions (normally 0600), at most 16 KiB. Contents are one nonempty printable
ASCII token with no whitespace; one trailing LF or CRLF is allowed. It is read
in place, never copied into the routing record, manifest or result. An explicit
file reference and `COCKPIT_API_TOKEN` together fail with
`COCKPIT_TOKEN_AUTHORITY_CONFLICT`; the host must remove an inherited token
environment variable when selecting the file authority. Missing/insecure/
malformed files make status `configReady:false` with a stable `configReason`;
status still makes no network requests. File ownership/permissions are checked,
but token validity is only evaluated by the native server.

Status success:

```json
{
  "ok": true,
  "status": {
    "available": true,
    "reason": null,
    "boundSessionId": null,
    "credentialsPresent": true,
    "configReady": true,
    "running": false,
    "runnerUnknown": false,
    "unknownOperation": false,
    "pendingJobs": 0,
    "unknownJobs": 0,
    "revision": 0,
    "managed": true
  }
}
```

`configReason` is additionally returned when credential/account configuration
validation fails. `configReady` is a local identity/configuration check, **not**
remote token validity or target-health verification. Status makes no network
requests. It opens an existing SQLite store read-only, never creates/upgrades
its schema, calls recovery, or changes jobs/checkpoints. Managed status uses
an ephemeral control gate; legacy status creates no local state.

Mutation success:

```json
{"ok":true,"operationId":"unique-bind-0001","revision":1,"boundSessionId":"native-session-id","replayed":false}
```

Unbind returns `boundSessionId:null`. A recorded failure returns:

```json
{"ok":false,"operationId":"unique-bind-0002","error":{"code":"ALREADY_BOUND"},"boundSessionId":"native-session-id","revision":1,"replayed":false}
```

Preflight/transport failures return `{"ok":false,"error":{"code":"..."}}`.
The parent must retain the originally created native session on **every**
binding failure; no recreation or automatic retry.

The same operation ID plus identical fields returns only its saved result with
`replayed:true` (including failures), never re-executes. This receipt may describe
an older revision/target: explicitly request status for current routing.
Reusing an ID with different fields returns `OPERATION_ID_CONFLICT`.
The protected log retains up to 10,000 operation identities, then refuses with
`OPERATION_LOG_FULL`; it does not evict identities and permit replay.

## Fences and retained history

`lockDir/module-binding.json` atomically stores the config digest, exact protected
`configBackup`, routing revision, current binding, archived binding paths, and
pending/completed operation records. Every binding gets a new UUID subdirectory
under `stateDir`. Unbind archives the old routing reference; it does **not**
clear or rewrite the old Store binding, jobs, checkpoints, cursors or images.
A clean rebind uses a fresh directory and the same credential-file reference.

Completed inbox jobs or an existing inbox cursor require
`REBIND_HISTORY_REVIEW_REQUIRED` before any rebind: copying a cursor alone or
discarding terminal deduplication could replay old WeChat input. This version
does not implement that migration decision. Old native history checkpoints stay
in the old directory and are never reused as the new target's checkpoint.
Empty bindings/checkpoint-only history can rebind safely to fresh state.

Important status/mutation fences:

* `ALREADY_BOUND`: one active target, including a configured legacy target.
* `NOT_CONFIGURED`: missing/mismatching local account credentials.
* `MODULE_MANAGED_OPT_IN_REQUIRED` / `LEGACY_ADOPTION_REQUIRED`: legacy
  configuration or pre-existing unmanaged state; automatic adoption is refused.
* `RUNNING`: runner or another CLI operation holds the stable lock. Unbind
  requires a separately authorized safe drain and confirmed exit.
* `RUNNER_STATE_UNKNOWN`: stale/unverifiable runner lock; no auto-unlock.
* `UNKNOWN_OUTCOMES`: prompting/sending/unknown jobs or non-accepted manual
  image attempts. `PENDING_JOBS`, `PENDING_INBOX_BATCH`,
  `NATIVE_FOLLOWUP_UNRESOLVED`, `TYPING_STATE_UNRESOLVED` are separate blockers.
* `MODULE_CONTROL_BUSY`: another operation owns the short gate; no work is
  silently queued or retried.
* `MODULE_CONFIG_STALE` / `MODULE_CONFIG_CHANGED`: stale routing snapshot or
  edited reference. Restore the exact reviewed `configBackup` if an accidental
  config edit is the cause; do not reset the routing record or old Store.
* `MODULE_BINDING_STATE_MISSING`: active/archived state was moved or lost;
  it is not automatically recreated and treated as empty history.
* `OPERATION_OUTCOME_UNKNOWN`: crash/interruption left a pending operation.
  Status and identical-ID readback expose uncertainty; new mutations and
  managed CLI work are fenced. There is deliberately no automatic resolution,
  rollback, retransmission or replacement operation.

`cli run/check/resolve/...` retain `lockDir/run.lock` for their lifetime.
Runner startup, CLI status/stop/unlock and adapter status/mutations share
`lockDir/module-control/run.lock` as a short gate. Routing/config revision is
rechecked after acquiring that gate, before a runner can acquire its lifetime
lock. `cli stop` uses the stable lock's existing safe-drain protocol.
`cli unlock --confirm` can remove dead gate/runner locks using existing PID
verification, **not** pending operation fences. A live/unverified PID is never
unlocked. No manual editing of operation outcomes is provided by this API.

The UI should disable binding whenever `available:false`, including when the
connector is stopped but jobs, unknown outcomes, history review or another
binding remain. Service process availability is separate from binding
availability.

## Validation and release contents

`node --test test/module-control.test.js` covers bounded transport, concurrent
child-process binding, idempotent receipts, native target checks, offline legacy
status, all unresolved categories, archived data/config backup preservation,
config/routing races, and a real managed CLI runner's status/stop/unlock behavior.
Its local fixture returns empty inbox updates and prohibits external network;
no login, message send, prompt, cancellation or production state is used.

The release allowlist contains `src`, `module.json`, `package.json` and
`package-lock.json`; no config, profile, control state, database or credential
file belongs in a release.
