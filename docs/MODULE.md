# Official WeChat module (opt-in, offline control)

`module.json` is schema/config version 1, module/package version 0.1.4, Linux x64,
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
COCKPIT_MODULE_VERSION=0.1.4
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
{"moduleApi":1,"moduleId":"wechat","moduleDigest":"<digest64>","instanceId":"<uuid>","version":"0.1.4","moduleVersion":"0.1.4"}
```

`moduleVersion` aliases the already validated actual `version`; both are retained.
Module `/health` returns those **same six identity fields** plus
`{"running":true,"ok":true,"phase":"running"}` (actual current state, not a
startup guarantee). `/status` and `/admin/restart` also carry the same module
identity. There is no `sha`, `artifactSha256` or fabricated delivery request.
The facade remains loopback-only; drain semantics are unchanged. Offline
`src/module-control.js` binding commands do not need any lifecycle environment.

## Cold input admission

Starting in 0.1.4, already-received supported input explicitly ensures its
original configured session is loaded before checkpoint validation and prompt.
This requires `POST /intent/session/load` with `{sessionId}` and the receipt
`{ok:true,sessionId}`. The host restores only that existing ID and its pinned
roles; an already-loaded handle is not closed, replaced or prompted. This is
not `session/reload` and does not repair a partial-load readiness failure.
Both correlated and shared-session ingress use this path. A restored target's
previous native work is not an authorization to interrupt it.

Startup without queued input, status, binding checks and passive output
observation do not load sessions. Unknown load outcomes are persisted before
any prompt; restart does not retry them. After explicitly establishing that
the previous load has settled (and safely repairing failed native readiness
if needed), an operator may use
`resolve JOB_ID retry-load --confirm --config /absolute/private/module-config.json`.
This only authorizes another original-target readiness attempt for that same
unprompted input. It cannot retry an unknown prompt/send, interrupted handoff,
or expired history, and makes no network call itself.

Saved forward cursors retain their original source and value. A live cursor
pauses passive delivery while unloaded and must be accepted by the native
reader after load **before** ingress can prompt. Expired or malformed cursors
block without replacement, latest-tail bootstrap, source switching or history
rescan. This does not promise that a native live cursor survives cold resume;
an expired cursor still requires an explicit history-review decision.
Legacy checkpoints without a cursor retain their existing bounded migration
rules. Business counts, binding confirmation and mutation gates are unchanged.

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

In 0.1.2 and later, detailed status prioritizes `PERSISTED_BINDING_CHANGED`
over business blockers such as `PENDING_JOBS` and `UNKNOWN_OUTCOMES`. Counts
remain unchanged; a job blocker no longer hides a detected session/cwd
mismatch. In 0.1.2, partial running/WAL snapshots do not inspect the historical
Store binding: their control ID/revision is not a claim of Store consistency.
Mutation fences and recovery behavior are unchanged.

Starting in 0.1.3, `bindingConfirmed` means **the original control association
was checked**, not business database health or permission to replay work. It
requires the current managed configuration authority, one active routing
identity, its unique successful bind receipt at the current revision, ready
configuration/credentials, and known runner/control state. The routing record
is reread before returning. Pending control operations, missing active identity,
duplicate active/archive identity, unknown runner state and configuration drift
cannot produce true. Invalid private control/configuration records fail explicitly.

For `running:true,runnerUnknown:false`, this flag uses only the verified control
active/receipt and current configuration authority. It does **not** open or copy
the running business database, WAL or SHM. `detailsAvailable:false` and null job
counts remain truthful indications that business details were not inspected.
The flag cannot detect or attest to unobserved changes inside a running Store.

When stopped, confirmation additionally requires the existing safe immutable
inspection and an exactly matching Store `binding` in its established format
(account, peer and all Cockpit configuration fields). Missing/changed bindings
are false even when `reason` is `ALREADY_BOUND` or a business blocker. If WAL or
journal prevents safe stopped inspection, confirmation is conservatively false,
with counts still null. No alternate database copy, recovery, checkpoint or
business mutation is performed. Pending/unknown business jobs alone do not
negate a valid control association when inspection is safely available.

A fresh bind may succeed before the runner creates its Store: its exact success
receipt authorizes first initialization. A stopped fresh/missing Store cannot
be treated as confirmed for later cold/apply. Consumers must also compare the
original session/revision and require managed/config/credential readiness.
An explicit false cannot fall back to `RUNNING`/`ALREADY_BOUND`; legacy blocker
reasons without this field must not be guessed safe. The flag grants no
permission to start, send, unbind, rebind or bypass their existing fences.

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
    "bindingConfirmed": false,
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
requests. Managed adapter/CLI status never acquires/creates the mutation gate or
any control state. It derives the target and state directory from the **same
atomic routing record**, checking that record again after diagnostic reads
(at most three read-only attempts). Parallel status calls cannot block each
other or a mutation. Actual bind/unbind/session-unbind and runner startup retain
their exclusive gates and revision checks.

Checkpointed SQLite diagnostics use immutable read-only access, with source-file
identity checks before/after reading: no database, WAL or SHM files are created.
Nonempty WAL/journal files are **not** silently ignored or checkpointed. Their
diagnostics return `reason:"STATE_SNAPSHOT_UNAVAILABLE"`, `available:false`,
`detailsAvailable:false`, and `pendingJobs:null,unknownJobs:null` rather than
inventing zero counts. Once the existing owner has safely checkpointed/closed
the store, ordinary detailed status is readable again; status itself never
performs recovery or changes jobs/checkpoints.

While a runner or real mutation is active, status still returns `ok:true` with
the trusted `boundSessionId` and routing `revision`. Unavailable diagnostic
fields are explicitly marked by `detailsAvailable:false` and null job counts.
The reason is `RUNNING`, `RUNNER_STATE_UNKNOWN`, `MODULE_CONTROL_BUSY`, or the
existing `OPERATION_OUTCOME_UNKNOWN` fence. `running:null,runnerUnknown:true`
means runner activity could not be read consistently during a control change.
A busy result is not permission to bind or retry an unknown mutation.
Corrupt/insecure state and unrelated I/O failures still fail explicitly; they
are not converted into a successful unbound status.

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

## Optional session-unbind capability

The official manifest explicitly opts into this session-deletion hook:

```json
{"sessionLifecycle":{"unbind":{"entry":"src/module-control.js"}}}
```

This is optional module metadata, not a generic hook platform. The parent owns
the explicit delete-modal selection and sequencing: invoke selected declared
unbind capabilities, then delete the native session. Absence of this manifest
field means no hook/no notification. This adapter does not delete native
sessions, initialize them, create first messages, or implement prebinding.

Invoke the same trusted Node entry with `--config /absolute/config.json`, using
the same bounded stdin/stdout and exit-code rules:

```json
{"operation":"session-unbind","operationId":"session-delete-0001","sessionId":"native-session-id"}
```

`cwd` is deliberately absent (and rejected as an unknown field): the module
owns the saved binding's exact cwd, and the native target might already have
been deleted externally. The operation performs **no network requests** and
does not load/create the target or read account/API credentials.

Success is exactly:

```json
{"ok":true,"operationId":"session-delete-0001","sessionId":"native-session-id","unbound":true,"replayed":false}
```

For the exact active session, this uses the existing unbind fences and archives
the old binding reference. A running/stale runner, pending/unknown jobs,
unresolved followup/batch/typing state or uncertain operation can refuse it.
Runner and read-only archive/blocker validation happen under the module gate
**before** reserving this hook's operation identity. Ordinary preflight refusals
therefore leave no receipt: after a separately authorized safe stop/settlement,
the parent may explicitly continue with the same operation ID. There is no
automatic continuation or retry, and no business state is changed by validation.
There is no implicit drain, force-stop, task/send replay or account change.
Historical Store binding, checkpoints, jobs, credentials and config backups
remain untouched.

If the requested session is already unbound or the current target is a
**different** session, success confirms no current association to the requested
session. It saves only the operation receipt, without changing routing revision,
the newer binding or its state. A running/newer target's jobs are not inspected
or interrupted. An unresolved control operation still blocks this confirmation
because the association outcome is uncertain.

Completed failures carry `ok:false`, `operationId`, `sessionId`,
`error:{code:"..."}` and `replayed:false`; preflight failures retain the existing
bounded `{ok:false,error:{code:"..."}}` shape. Recorded successes/failures return
unchanged on identical-ID readback, except `replayed:true`; changing the
operation/session under that ID fails with `OPERATION_ID_CONFLICT`. A pending
receipt returns `OPERATION_OUTCOME_UNKNOWN` and is never retried, resolved or
replaced automatically. Historical successful receipts describe their original
operation, not a fresh unbind of a subsequently rebound target.
Any already-persisted completed failure (including receipts from older code)
also retains strict readback; this change never clears or reinterprets it.

The existing `status`, `bind`, and cwd-bearing `unbind` contracts are unchanged.
Legacy non-module-managed profiles still refuse mutations with
`LEGACY_ADOPTION_REQUIRED`; this hook is not implicit legacy migration.

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
Runner startup, CLI stop/unlock and adapter mutations share
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

## Independent real-runner archive acceptance

Run after committing the selected release:

```sh
TMPDIR=/tmp node --test test/module-runtime-acceptance.test.js
```

Optionally set `WECHAT_ACCEPTANCE_REPORT=/tmp/new-evidence.json` to save the
complete JSON evidence to a new absolute file (0600, no overwrite). The test
archives the exact current `git HEAD` release allowlist, extracts it into its
own temporary fixture, verifies `src/cli.js` against that commit, and launches
the **real archived manifest service entry**, not a replacement HTTP service.
Fixture config, account/API credentials, workspace, binding and database are
all newly generated synthetic data. Teardown removes the fixture and leaves no
service running.

The actual fixture launch is:

```text
node --import FIXTURE/provider.mjs RELEASE/src/cli.js run --config FIXTURE/config.json
HOME=FIXTURE
WECHAT_FIXTURE_ORIGIN=http://127.0.0.1:PROVIDER_PORT
WECHAT_FIXTURE_NETWORK_LOG=FIXTURE/network.jsonl
COCKPIT_MODULE_ID=wechat
COCKPIT_MODULE_VERSION=<actual archived manifest/package version>
COCKPIT_MODULE_DIGEST=<SHA-256 of the exact fixture release tar>
COCKPIT_MODULE_INSTANCE=<fresh lowercase UUID>
COCKPIT_MODULE_PORT=<fresh loopback port>
```

No production environment/auth/proxy/`NODE_OPTIONS` values are inherited.
Minimal real config uses `moduleManaged:true`, `deliveryMode:"correlated"`,
new absolute `stateDir`/`lockDir`, synthetic `credentialFile`, empty raw
`cockpit.sessionId/cwd`, loopback `cockpit.apiUrl/webUrl`, a synthetic protected
`cockpit.tokenFile`, synthetic `weixin.allowedAccount/allowedPeer`, and the
unchanged official `approvedApiOrigins`. The normal offline bind operation
verifies this fixture's session metadata before startup. The generated exact
config and environment are included in the optional report.

**Boundary:** this connector has no paused/disabled healthy no-poll mode.
Unbound/missing-credential/blocked configurations refuse startup; normal
healthy `run` starts inbox polling. Production validation also intentionally
rejects loopback WeChat `baseUrl`, so no production `apiBaseURL` escape hatch was
added. Instead, the external test-only preload (never in the release archive)
maps the real client's official poll URL to the explicit loopback provider.
It allows only native capability/session reads and one held empty-input poll;
login, prompt, send, typing, other mutations and external destinations are
rejected before transport. Every actual fetch destination is audited as the
configured loopback origin. This exercises the unmodified real runner,
configuration/auth checks, storage, HTTP lifecycle and drain loop without a
real WeChat account or server.

The evidence includes matching `/version` and `/health` module identities,
healthy running state, then `node:http` POST `/admin/restart` with exactly
`{"pending":true}`. The held loopback poll closes, the real process logs
`BRIDGE_DRAIN_REQUESTED`/`BRIDGE_DRAINED` and exits naturally with code 0 and no
signal; its HTTP listener and stable run lock disappear. The binding remains,
jobs stay empty, no cursor advances, credential/config bytes stay unchanged,
and there are zero prompt/send/login requests. The fixture archive digest is a
reproducible test authority, **not** an assertion about a separately installed
Cockpit catalog digest or CI artifact. Live account validity and real native
SDK/chat integration remain separate acceptance boundaries.
