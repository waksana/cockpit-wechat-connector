# Protocol provenance

## Native module

`native/transport.ts` and `native/media.ts` independently implement the same
Tencent iLink envelopes, numeric message types, lossless server IDs, CDN paths,
and AES-128-ECB media protocol described below. Copyright (C) 2026 Tencent;
the retained MIT license is [LICENSE.tencent](LICENSE.tencent).
No OpenClaw runtime, account store, installer, logger, lifecycle, legacy bridge
CLI, or standalone service is imported into the module.

The native module downloads/decrypts inbound media into its own private local
files and supplies standard native file attachments. It captures outbound local
Markdown references independently. It does **not** use managed-upload endpoints
or `files/get`.

The public interaction-capability review used Tencent revision
[`24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c`](https://github.com/Tencent/openclaw-weixin/tree/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c),
specifically `src/api/types.ts` and `docs/protocol_zh_CN.md`. These sources expose
text/media/tool-status messages, not interactive buttons, card choices, or
selection callbacks. AskUser is therefore bridged through ordinary text and
the public Cockpit `respondAsk` intent, not an invented WeChat card API.

Bundled runtime dependencies retain their source license comments/notices through
the bundle. The module SDK and TypeScript compiler are build-time dependencies.

## Pinned protocol sources

The protocol baseline for request headers, version encoding and text-message
envelopes is **Tencent `@tencent-weixin/openclaw-weixin@2.4.8`**,
published 2026-09-01T02:49:09.161Z. Copyright (C) 2026 Tencent. Its MIT notice
is retained in `LICENSE.tencent`. This attribution must travel with substantial
copies. No OpenClaw runtime, account store, logger, lifecycle or agent code is
imported. The former standalone CLI and its implementation/tests have been
removed; the protocol provenance remains applicable to the native module.

- Registry: https://registry.npmjs.org/@tencent-weixin%2Fopenclaw-weixin/2.4.8
- Tarball: https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.8.tgz
- SHA-256: `cd598cac2a118f7ed73e6b3c82d91385f4af844e49d7c43fbcb716c26ba0e9fc`
- SHA-512 integrity: `sha512-hhO9prUQwzfSpIL6XGWazRsxNs89K+Mis3iQW6a8eum4AIDxOUiTFMg4nlNVD/au0SjAx5CcJjo3KYWZqGpgQA==`
- Relevant package sources: `src/api/api.ts`, `src/api/types.ts`,
  `src/auth/login-qr.ts`, `src/messaging/send.ts`.
- Supplementary public protocol:
  https://github.com/Tencent/openclaw-weixin/blob/7c04adc3e95775efd661ab9fba0626d86d237713/docs/protocol_zh_CN.md

The initial research could not resolve the published package's gitHead.
Follow-up research verified the relevant npm 2.4.8 source files byte-for-byte
against Tencent repository revision
[`70ab695f6a1ca87da4102f857a452e2acb6b37cf`](https://github.com/Tencent/openclaw-weixin/tree/70ab695f6a1ca87da4102f857a452e2acb6b37cf).
The tarball hash above remains the package-content pin. No protocol documentation
was present in that 2.4.8 revision; the separately pinned newer documentation is
corroborating evidence, not a substitute for the actual uploader.
`channel_version=2.4.8` describes the protocol baseline, not an official Tencent
product identity.
MIT is a software license, not a grant of Weixin account access, quotas or SLA.

For ACK research, 2.4.8 `src/api/types.ts:226-229` declares optional `ret` and
`errmsg`; `src/api/api.ts:503-520` rejects only truthy nonzero `ret`. The fixed
public protocol above shows `{ret:0,errmsg:""}`, not an exhaustive missing-ret
success contract. We do not copy its permissive parser or its raw-response logging.
The public source additionally defines the server-assigned send receipt:

- https://github.com/Tencent/openclaw-weixin/blob/7c04adc3e95775efd661ab9fba0626d86d237713/src/api/api.ts#L579-L595
- https://github.com/Tencent/openclaw-weixin/blob/69765a2b2bf240dd12de3350b9cb1f139b7ab097/src/api/types.ts#L239-L244

Its optional `message_id` is a uint64 string. The live service returned an object
containing that field without `ret`; our independent strict validator accepts a
nonzero canonical uint64 receipt only with absent/zero error codes and known
envelope fields. Arbitrary HTTP 200 JSON is not success.

The upstream install CLI is **not used**. Do not execute it to run this project.

The native media implementation uses the 2.4.8 CDN request fields, AES-128-ECB
padding/encryption and IMAGE envelope described in `src/cdn/upload.ts`,
`src/cdn/cdn-upload.ts`, `src/cdn/cdn-url.ts`, `src/cdn/aes-ecb.ts` and
`src/messaging/send.ts` (the same tarball hash above). The default CDN endpoint is
documented in the fixed public protocol and `src/auth/accounts.ts`:
`https://novac2c.cdn.weixin.qq.com/c2c`.
Our CDN validation, bounded reads and error handling do not copy the upstream
arbitrary-download, response-body logging or retry logic.

The same pinned 2.4.8 protocol describes inbound CDN decryption
(`src/media/media-download.ts`, `src/cdn/pic-decrypt.ts`) and VIDEO/FILE envelopes
(`src/api/types.ts`, `src/cdn/upload.ts`, `src/messaging/send.ts`).
Upload media_type IMAGE=1, VIDEO=2, FILE=3 differs from message item types
IMAGE=2, FILE=4, VIDEO=5. VIDEO.video_size and IMAGE.mid_size are ciphertext
bytes; FILE.len is plaintext bytes as a string. Upload uses no_need_thumb=true;
no unverified thumbnail generation, duration or dimension field is invented.
Incoming file.len/MD5 and video.video_size/video_md5 are checked when supplied.
ECB/PKCS7 provides no authentication; optional hashes detect corruption, not
authenticity against an attacker controlling both bytes and metadata.
Incoming image mid_size does not prove
a particular image variant or recover precompression phone bytes. The upstream
100 MiB post-decrypt storage limit is a client policy, not a demonstrated Tencent
server maximum.

The native module's current delivery, attachment and media boundaries are
documented in [docs/MODULE.md](docs/MODULE.md). Protocol attribution does not
imply that the removed CLI's storage or delivery mechanisms remain supported.
