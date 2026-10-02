# Native WeChat adapter

Configuration is in [README](../README.md). The bundled backend exports
`activate(context)`. Host interaction uses only public SDK `context.host.call`;
there are no native handles, private host imports, CLI runners, or daemons.

## Direct message paths

Incoming authorized peer messages are converted and immediately submitted with
`prompt({ sessionId, mode: "immediate", text, attachments })`. An unloaded session
is first loaded through `session/load` with the **same** ID. The connector does
not inspect native busy state, cancel a turn, clear the native queue, or wait for
the current model turn to finish. Native Copilot owns steering and execution.
A reply associated with an already displayed, still-pending question instead
uses `respondAsk` with its exact request ID. Stale or ambiguous answers are
reported, not silently treated as new prompts or answers to a different question.

Primary assistant message observations call WeChat send/upload APIs directly.
Multipart sends use a process-local promise chain to retain order; local files
are captured when observed, before waiting for an earlier send. There is no
durable outbox, send worker, retry schedule, recovery barrier, or message
resolution workflow. A failed capture/send does not block the next independent
reply or binding. A missing WeChat context token is a visible failure, not a
message queued for later delivery.

Polling remains necessary for the WeChat protocol. The native observation pass
reads persisted chat using its retained anchor and observes pending questions.
It does not drain pending input/output records. Unseen native events can be
observed after reconnect; an event already attempted is not sent again.
Historical file links without an original captured copy fail individually:
the adapter does not reread mutable files to recreate an old attachment.
Missing history anchors are reported rather than silently skipped. They do not
disable independent live events, incoming messages, or role selection.

## Binding and availability

Availability and the saved callback query the existing binding through
`session/get`. Only authoritative `meta: null` frees it; unloaded/idle sessions
still own it, and failed, malformed, or cancelled queries never mean deletion.
Saved notifications are idempotent. A synchronous binding-generation comparison
ensures competing saves cannot both win. The generation is only a binding
identity/fence, not a separate message lifecycle or retired-work ledger.

Availability depends on configuration/account ownership and actual session
existence, **not** old send results or in-flight messages. Old callbacks retain
their original target and recheck binding identity before new effects.
An already-started external effect may still finish for its old target; its
result cannot change the replacement binding or associate a question with it.
No old message is rerouted to the replacement session.

A late poll is recorded against its original binding, never forwarded into a
replacement. After reassignment, input with missing timestamps or timestamps
before the new binding is reported as `PREBINDING_INPUT_NOT_FORWARDED`.
It is not held for manual release or replay.

## Minimal persistent state and delivery limits

The private `native-v1.sqlite` keeps account identity, one binding, saved
notification IDs, WeChat cursor, native observation anchor, the last displayed
question association, and bounded deduplication/results. Message IDs and
successful sent-part references retain exact quoted context and local media.
Result records have only `accepted`, `unknown`, `failed`, or `skipped` outcomes;
there are no runnable queued/intent records. Unknown is recorded before an
attempt for deduplication and stays unknown if the process cannot record its
outcome. It is never automatically retried.

Advancing the WeChat cursor is not a durable delivery promise. A crash between
cursor/dedup persistence and submission can lose that submission. A timeout or
crash during an API call can leave delivery unknown; this is not exactly-once
delivery or proof that nothing was sent. Restart never schedules result records.
No automatic eviction deletes deduplication facts: at 20,000 results, 10,000
notification IDs, or 64 MiB of JSON, writes fail explicitly. Media and existing
credentials remain in the private data root.

`GET /status` reports configuration, binding, revision, `lastError`, and redacted
result keys/directions/statuses/reasons. `lastError` is informational, never a
gate. Errors are also reported to the Host; input failures attempt a WeChat
notice, whose failure is separately visible. The former `POST /resolve` and
`POST /recheck` routes are removed. There is no unlock/drop/retry replacement.

### Upgrading existing native data

SQLite `user_version=1` and the `state(id,json)` table remain unchanged.
The first load of pre-adapter native JSON performs one additive conversion to
`adapter: 2`: preserve the entire old JSON verbatim in `legacy`, retain binding,
cursor and notification identity, and extract only deduplication/result and
quote metadata. Old queued/abandoned/rejected records become non-runnable
`skipped` results; ambiguous intents/unknowns stay `unknown`. Original facts,
including their original stages, remain in `legacy`. Runtime code never reads
that snapshot to dispatch work. No legacy queue implementation is retained.

Credentials, configuration, and private file bytes/paths are untouched.
An already-presented current question is retained only with its confirmed
successful send and presentation time. Unsupported database/JSON schemas still
fail explicitly. This does not discover or migrate former standalone CLI data.
See the [deployment preservation boundary](DELIVERY.md#existing-native-data).

## Media, quotes, and protocol identities

Inbound image/video/file media comes directly from the fixed WeChat CDN and is
decrypted, bounded, checked, and stored privately. Native `prompt` receives file
attachments. No Files module or cross-module upload/reference API is required.
Outgoing explicit Markdown file references are recognized only outside code.
Narrow configured roots, regular-file checks, and denied credential/private
locations constrain access. Copies are hashed and checked before encrypted
upload, and are not executable.

Images support PNG/JPEG up to 4 MiB; file/video limit is 25 MiB. Redirects and
unapproved origins are refused. AES-128-ECB follows Tencent's protocol;
size/hash checks are not a claim of cryptographic authenticity. These limits
are connector policy, not Tencent quota guarantees.

Envelope `message_id`, send receipts, and quote `svr_id` preserve decimal uint64
identities. Item `msg_id` is opaque metadata, including quoted items, never an
envelope identity or a deduplication key. Quotes resolve only exact IDs within
the same binding and authorized account/peer. Ambiguous or absent IDs retain
only supplied quote context; partial selections remain unverified. No topic or
text-similarity matching is used.

## Shutdown

Host stopping gates new effects and cancels polling. Shutdown awaits current
process-local operations so known API outcomes can be recorded before storage
closes. This is lifecycle cleanup, not a durable drain/recovery workflow.
Unfinished effects are not resumed on restart. The module never exits or
restarts the Host.
