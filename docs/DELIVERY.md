# Native module delivery

`master` is the repository mainline. Implement on an isolated branch/worktree,
reference the owning Issue, obtain independent review, pass the exact PR commit's
`Required checks`, and merge normally. Do not bypass repository rules or use
administrative merge.

Module CI installs the exact published SDK from GitHub Packages using its own
repository `GITHUB_TOKEN`. A successful local install is not CI package permission
evidence. A CI read denial must be reported; do not substitute a local tarball or
silently broaden package grants.

## Rolling publication

Module CI builds TypeScript, bundles runtime dependencies, runs fake-only module
and release tests, and uploads the installable archive. Every merged PR to
`master` also starts the `Rolling` workflow (`pull_request_target: closed`, gated
on `merged`). It checks out only the exact merge SHA, never an unmerged PR head.
The read-only check job rebuilds/tests/packages that SHA before the separate
publisher obtains `contents: write`. Actions are pinned; the token is not
persisted in checkout or passed to module tests.

The workflow's `run_number` is the repository-local sequence: version
`0.0.0-rolling.N`, tag `v0.0.0-rolling.N`. Keep the workflow identity; gaps are
valid, and merges are neither coalesced nor cancelled. The committed package and
module version remain the development baseline (currently `0.2.1`); only the
isolated archive gets the generated version. This does not relabel any previously
installed `0.2.1` package as Rolling.

The publisher rebuilds the exact source to compare bundled bytes with the checked
artifact, then creates the exact-SHA tag and a draft prerelease. Exactly four
assets are uploaded and downloaded for byte equality before publishing:

- `wechat-0.0.0-rolling.N.tgz`
- `wechat-0.0.0-rolling.N.tgz.sha256`
- `cockpit-deployment.json`
- `cockpit-deployment.json.sha256`

The archive contains root-level `cockpit.module.json`, `package.json`,
`module-build.json`, the byte-identical deployment descriptor, bundled backend,
and license/documentation files. The build inventory records source SHA,
version, byte counts, and SHA-256 hashes of all other archive members.
Checksum files use `SHA256  filename` followed by a newline.

Publication is non-draft, prerelease, and not Latest. The release body seals
asset IDs, names, sizes, and hashes. Platform `immutable` is reported as returned
by GitHub, not assumed: application-side refusal to replace a tag or published
asset is not platform immutability. No milestone/promotion workflow is introduced.
There are no write retries, redirected writes, asset overwrite, or automatic
draft repair. A failed/uncertain write or existing draft requires operator
inspection of tag, release ID, assets and workflow before any recovery decision.
A rerun can only acknowledge an already published, byte-identical release, or
publish when no release exists and its existing tag (if any) matches exactly.
Never create a new sequence merely to hide an uncertain publication.

## Deployment contract

`cockpit-deployment.json` uses the existing format **2**, channel `rolling`.
Identity is `repository: waksana/cockpit-wechat-connector`, module ID `wechat`,
and archive `wechat-VERSION.tgz`. The `product` declares Host API range,
capabilities, required intents, database schema/preserved columns, and an empty
migration list. Its database declaration comes from a fresh synthetic native
Store, not production data. Packaging refuses a changed capability/schema
boundary until it is reviewed. Consumers must verify both checksums, tag/source,
embedded descriptor, manifest/version, and build inventory; a CI artifact or
successful workflow alone is not a release.

Host API 1 and all required capabilities/intents are authoritative; SDK `0.15.0`
and Host Rolling 32 are the existing baseline, not a new business SDK upgrade.
See [runtime requirements](../README.md#requirements) and the
[durable data boundary](MODULE.md#durable-boundaries).

### Existing native data

Native data retains `PRAGMA user_version=1`, JSON `schema: 1`, and one `state`
table with `id` and `json` columns. The thin adapter uses the additive JSON marker
`adapter: 2`. On first startup it preserves pre-adapter JSON as an inert `legacy`
snapshot and converts only protocol identity/deduplication/results, never pending
work. See [the conversion contract](MODULE.md#upgrading-existing-native-data).
A missing database initializes fresh; version 0/unknown schema or missing
singleton row is rejected. The declaration preserves both columns and has no
external migration commands. This is unrelated to former standalone CLI databases.

Preserve the entire host-provided `modules/data/wechat` root **at the same
absolute location**, plus host-held module configuration. This includes
`credentials.json`, `native-v1.sqlite`, `incoming/` and `outgoing/`, all associated
private files, owner/mode and bytes. Snapshot references are absolute paths.
Do not reset account/peer identity, binding identity, notification deduplication,
cursor, results or the retained legacy snapshot.

Prove preservation while the old service is drained and stopped, before starting
the replacement. First startup legitimately adds `adapter: 2`, the original `legacy`
snapshot and converted results, and increments the revision. Ordinary protocol
activity can also write state.
A consumer checking exact preserved JSON hashes only **after** startup
cannot distinguish that normal behavior from data loss. Such a consumer must
handle its stopped/pre-start verification boundary explicitly; never omit `json`
from the declaration, suppress conversion, or invent a schema migration merely
to make post-start byte equality pass. No restart retries or message replay are
authorized by this contract.

There is no `workflow_dispatch` deployment, legacy `Delivery artifact transfer`,
production secret use, service restart, or automatic installation. Retired service
delivery definitions are not applied to any existing installation. An external
deployer consumes these public assets under its own separately authorized plan.

Runtime installation, login/credential provisioning, enabling consumption, stopping
an old account consumer, migration, real message tests, and production restart
all require separate explicit authorization. Never infer it from green CI or
successful merge.
