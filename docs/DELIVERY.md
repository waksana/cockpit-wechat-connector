# Connector delivery is separate from enabling chat

This private project's integration ref remains **master**. Thin workflows reuse
fixed-commit build and restricted artifact transfer implementations from
`waksana/cockpit`; push is build-only. `service-delivery.json` packages source and
locked dependency metadata, not profiles, credentials, messages or checkpoints.

Project `wechat` is registered with the shared service-delivery runner. An
authenticated build-only request can produce a verified immutable package while
the connector remains stopped. This is not startup permission, recovery of an
unknown send, or permission to replay old messages.

The future user-unit entry uses the fixed toolkit launcher with
`~/.config/service-delivery/cockpit/launch-wechat.json`. Its independent selection
and lock root is `~/.local/state/service-delivery/wechat`; the existing assistant
profile path is unchanged. A false `activationEnabled` policy refuses candidate
selection. The unit is not started by installation or daemon reload. Unblocking
business recovery, explicitly authorizing a fixed-SHA deployment, enabling its
activation policy and starting a previously stopped service are distinct actions.
Only the recovery owner with actual user authorization should resume chat.

When running from an authorized package, the launcher sets the immutable identity
and the unit sets `SERVICE_DELIVERY_PORT=8792`. The loopback facade exposes
`/version`, same-instance `/health`, aggregate `/status` and `/admin/restart`.
The latter uses the existing drain protocol; it does not infer safety from an
instantaneously empty outbox or abort started send/CDN/prompt operations.
The unit has no forced-stop deadline and does not restart declared unsafe-exit or
blocked-launch outcomes automatically.

Cockpit's system-version view displays an unavailable process and a prepared
build separately. It does not read Git HEAD to invent a running connector version.
No external MCP clients or previously loaded skill instructions are claimed to
have updated merely because a package was built.
