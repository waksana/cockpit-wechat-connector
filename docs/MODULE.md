# Native module behavior and recovery

Configuration and activation instructions are in [README](../README.md).
The module backend export is `activate(context)` in the bundled `dist/index.js`.
All host interaction uses the public SDK `context.host.call`; the module has
no native handles, host-private imports, HTTP API token, CLI runner, or daemon.

## Binding and availability

Host role mutation locks serialize the complete availability/permit/save/notify
sequence for the module. The module additionally saves its single binding and
notification identity in one synchronous SQLite transaction. Availability
preflight does not reserve the account, load a session, or send a message.
All configuration, occupancy, unresolved-history, and existence-unknown reasons
are returned together. An existing unloaded session is not free capacity.

A successful saved callback means the module durably recorded the association,
not that the native session was loaded or messaging works. Notification replay
is idempotent even after a binding was retired; it never restores old ownership.
Only authoritative `meta: null` retires the old binding. Late/aborted lookups
cannot delete a new generation. Outstanding old-generation work remains an
explicit blocker; no old message is rerouted to a new session.
A poll completed after retirement retains its messages against the old
generation as unresolved. After reassignment, messages with missing timestamps
or timestamps before the new binding require explicit disposition instead of
being treated as fresh commands.

## Durable boundaries

`native-v1.sqlite` is a new schema with `synchronous=FULL`, private permissions,
and bounded records (10,000 per collection, 32 MiB serialized state). Full storage
fails explicitly; no automatic eviction discards deduplication or receipts.
Unknown schema/account changes refuse startup. It is not the old bridge schema.
All files and receipts stay in this module's host-provided data root.

Inbound messages and poll cursor are committed together. IDs are account-scoped.
Before load, prompt, answer, or outbound upload/send, an intent is persisted.
Only a positively validated result records acceptance. Crash-interrupted intents
recover as unknown, not queued. Unknown load/prompt/answer/send results block
automatic consumption and sending. There is no retry-on-timeout or success-shaped
fallback. Confirmed native prompt receipts use `user.message.data.messageId`;
the chat event UUID is used only as a history position, never as that receipt.

Module API `GET /status` (under the host's digest-bound module API base) reports
binding, state revision, redacted stages, and problem codes. It does not reveal
tokens, text, media content, or CDN keys. `POST /resolve` can explicitly abandon
one unknown record (or queued work belonging to a retired binding):

```json
{"revision":42,"key":"record-key-from-status","action":"abandon","note":"Operator investigated the ambiguous outcome and accepts no resend."}
```

This is an explicit loss-accepting disposition, not proof that the remote side
did not act or a rollback. It never resends. Revision mismatch rejects stale
operator action. After diagnosing a transient general fault, `POST /recheck`
with `{"revision":42,"note":"Reason for explicitly resuming passive checks"}` clears
only that fault and permits a new read cycle. It does not clear any unknown
mutation or discard an anchor; a persistent problem blocks again. Missing
history anchors or corrupt storage require diagnosis; do not delete or edit the
database to manufacture success.

## Output and history

Primary `assistant.message` events provide prompt capture of live local file
references. The module claims each output before capture and freezes its own
bytes. A duplicate callback cannot recapture a changed source. Shared-session
text is mirrored regardless of which authorized interface initiated the turn.
No topic matching, text similarity, or subagent output guessing is used.

Passive `session/chat` reads use persisted backward pages, bounded to 40 pages
of 64 events per recovery pass, with an exact retained event anchor. Cursor
source/direction and shape are validated. Initial history establishes a boundary
without replaying pre-binding messages. A missing anchor or invalid page blocks
instead of silently jumping forward. A historical output containing local file
links without a previously captured snapshot becomes unresolved; replay does
not reread a mutable file to impersonate the old attachment.

## Local media boundary (independent of Files)

Inbound image/video/file media is downloaded directly from the fixed WeChat CDN,
decrypted locally, bounded, checked, and retained as a private module-owned file.
Ordinary native `prompt` receives `text` plus `type: "file"` attachments with local
paths. No Files module, old upload endpoint, `files/get`, managed URL attachment,
or cross-module service is required. Optional Files prompt middleware remains
transparent and independently owned by that module.

Outbound explicit Markdown file links/images are interpreted only outside code.
The configured narrow file roots and real local path checks authorize reads;
ordinary files only, no symlinks, devices, directories, broad scans, or remote
URL downloads. Credential names/locations and native/module private roots are
denied. File bytes are independently captured, then hashed and checked before
encrypted CDN upload. No retry or display reads the original source again.
The optional Files module may capture its own copy; no cross-module snapshot
identity is claimed.

Images are PNG/JPEG with a 4 MiB limit; file/video limit is 25 MiB. Small header
checks distinguish supported image/video formats; extensions are not authority.
CDN redirects and unapproved origins are refused. AES-128-ECB follows Tencent's
protocol; optional sizes/hashes detect corruption, not cryptographic authenticity.
Files are not executed. Limits are connector policy, not a claim about Tencent
quotas or permanent API availability.

Quotes resolve only exact retained server IDs within the same account, peer,
and binding generation. Outgoing IDs refer to an exact delivered part, not
necessarily an entire assistant message. Unknown or conflicting IDs retain only
explicitly supplied quote metadata. Partial selections are unverified context;
no text matching recovers missing history.

## Graceful shutdown

`context.stopping` synchronously gates new business effects and cancels long polls.
Already-started sends use `context.signal`, retained until final disposal, so
their acceptance or uncertainty can be durably recorded. `onStop` joins producers
and active capture/send/persistence work. `dispose` releases database and leases
afterward. Failures propagate to the host drain; the module never exits or
restarts the host. A stopped-between-upload-and-send intent remains unknown and
will not be retried automatically.
