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

Before history forwarding, the observation pass retires a displayed association
when an authoritative **loaded** session no longer has that request pending.
Unloaded sessions and failed/malformed reads do not prove withdrawal. Retirement
records an `inactiveAt` boundary, not proof that someone answered the question.
Subsequent unquoted input newer than that boundary can follow the normal prompt
path when no question is pending. Input at/before the boundary, or with no
timestamp, is rejected rather than guessed to be a new request. A captured batch
keeps its original question identity even if observation retires it in flight;
explicit quotes of retired question messages cannot become prompts or answer
another question. No failed input is replayed or reclassified.

Answer failures report distinct reason codes: `ANSWER_NO_LONGER_PENDING`,
`ANSWER_QUESTION_NOT_PRESENTED`, `ANSWER_QUESTION_CHANGED`,
`ANSWER_PREDATES_QUESTION`, `ANSWER_TEXT_ONLY`, `ANSWER_EMPTY`, or
`ANSWER_CHOICE_NOT_ALLOWED`. Native submit races remain `REQUEST_NOT_PENDING`.
These reasons appear in the existing result/status/error surfaces without
including question or answer text. Older retained receipts keep their original
compound `ANSWER_NOT_CURRENT_OR_NOT_ALLOWED` reason; it is not enough on its own
to diagnose a stale answer.

Primary assistant message observations call WeChat send/upload APIs directly.
Multipart sends use a process-local promise chain to retain order; local files
are captured when observed, before waiting for an earlier send. There is no
durable outbox, send worker, retry schedule, recovery barrier, or message
resolution workflow. A failed capture/send does not block the next independent
reply or binding. A missing WeChat context token is a visible failure, not a
message queued for later delivery.

### Peer do-not-disturb and rejected reply contexts

The operator-designated do-not-disturb (DND) response is exactly HTTP 200 on
`sendmessage`, numeric `ret: -2`, absent `errcode`, and a nonempty string
`errmsg`. Its text is never inspected or retained. This narrow signature is a
local behavior policy for the observed response, not a claim that every `-2`
universally means DND. Other shapes/codes, token expiry, polling/upload
rejections, network uncertainty, and file access failures remain ordinary
visible failures. There is no timer, retry, quota guess, login or token refresh.

DND persists outside the binding, scoped by the database's existing
account/peer identity. It survives restart and binding retirement/replacement.
All new output paths (text, files, AskUser, decision links, input-error notices,
and history) are suppressed before file capture when already paused.
Process-local queued output, later chunks, upload-URL requests, CDN uploads,
and final sends also recheck the gate. Already-started effects may complete.
No DND report is sent to the Host or model, and no retry incentive is emitted.
Other errors remain visible, including historical faults in `lastError`.

Only a nonduplicate message from the configured peer for the current binding
can resume output. Its protocol `create_time_ms` must be strictly newer than
both the pause boundary and the latest qualifying inbound timestamp, and not
precede the binding. Missing, equal, or older timestamps cannot establish
freshness and do not resume output. A **same-token** fresh message is sufficient;
another peer, a duplicate ID with a changed timestamp, Web input, internal
events, ticks, and startup are not. Timestamp ambiguity fails closed; no reset
or synthetic message is used to bypass it.

An epoch is captured when output is observed and changes on qualifying inbound
or DND. This fences queued/captured work even if pause and resume happen before
its send turn. Inbound causality is persisted before native submission awaits:
a rejection from a send started before a newer inbound timestamp cannot
re-pause that peer. Historical inbound received during a send cannot defeat
the rejection; a clock-ahead input already seen before the send cannot defeat
it either. Recovery keeps the gate closed through the authoritative native
metadata read (and load if needed), atomically marking existing pending
asks/decisions skipped before opening. Thus pending requests from the paused
period are not backfilled even if no watcher saw them. A failed/interrupted
recovery leaves the gate paused; it is not resumed from a stored work item.
Existing context-token and binding fences still prevent sending
an old output with a newer context or replacement session.

The triggering rejection and suppressed outputs are `skipped` (not delivered
in full), never `accepted`. Their receipts contain no body, media references,
or sent-part bodies; confirmed multipart prefix IDs and allowlisted rejection
diagnostics remain. `WECHAT_DO_NOT_DISTURB`, `WECHAT_OUTBOUND_EPOCH_CHANGED`,
and `WECHAT_SUPPRESSED_HISTORY` distinguish the reasons. Actual network/crash
unknowns remain `unknown`. No old receipt is replayed. On recovery, unseen
historical assistant events at/before the recovery boundary, or lacking a valid
timestamp, are also skipped rather than drained into WeChat.

Prior releases' explicit `replyContextRejection` markers remain readable and
retain their original context guard. Old generic errors/unknown receipts are
not retroactively classified as DND. No schema reset or credential copy is
needed for the additive peer gate.

`GET /status` distinguishes `do_not_disturb`, `unbound`, `no_context`,
`awaiting_new_context` (a retained old context marker), and `ready`. DND includes
only its reason, timestamp, and guidance to wait for genuine peer input, never
a token or response text. `ready` describes the local gate, not API health.

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

API-level rejections retain an optional `apiFailure` on the affected output
receipt and a historical `lastApiFailure` in state and `GET /status`. Host error
reports retain the same safe diagnostic object: fixed API endpoint, HTTP 200,
safe-integer `ret`/`errcode` (or `absent`/`invalid`), `errmsg` classification
(`absent`/`empty`/`present`/`invalid`), and `observedAt` epoch milliseconds.
Raw response bodies, `errmsg` text, extra fields, headers and request payloads
are never retained in diagnostics. `getupdates` rejection has no message receipt;
`getuploadurl` and `sendmessage` failures belong to the attempted output.

These fields diagnose rejection; they do not change success criteria, trigger
reauthentication/retry, or prove that an ambiguous send was not delivered.
The exact DND signature has the explicit suppression behavior above and is
retained on its bodyless receipt rather than reported as a new Host error.
Historical errors remain visible after a later successful operation, so compare
timestamps and subsequent receipts rather than treating the panel as a current
health probe. Old generic `WECHAT_API_REJECTED` records have no recoverable
response detail; missing diagnostics are not zero-valued API success codes.
HTTP, network, parsing and CDN failures retain their existing separate errors.

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
