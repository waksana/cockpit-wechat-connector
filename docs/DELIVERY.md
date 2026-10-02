# Native module delivery

`master` is the repository mainline. Implement on an isolated branch/worktree,
reference the owning Issue, obtain independent review, pass the exact PR commit's
`Required checks`, and merge normally. Do not bypass repository rules or use
administrative merge.

Module CI installs the exact published SDK from GitHub Packages using its own
repository `GITHUB_TOKEN`. A successful local install is not CI package permission
evidence. A CI read denial must be reported; do not substitute a local tarball or
silently broaden package grants.

CI builds TypeScript, bundles runtime dependencies, runs fake-only module tests,
and uploads the installable `.tgz`. There is no `workflow_dispatch` deployment,
legacy `Delivery artifact transfer` workflow, production secret use, release,
tag, version promotion, service restart, or automatic installation. The former
service delivery definitions are retired from CI, not applied to any existing
installation.

Runtime installation, login/credential provisioning, enabling consumption, stopping
an old account consumer, migration, real message tests, and production restart
all require separate explicit authorization. Never infer it from green CI or
successful merge.
