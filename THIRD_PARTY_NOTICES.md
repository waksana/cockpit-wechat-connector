# Protocol provenance

`src/weixin.js` adapts request headers, version encoding, text-message envelopes
and QR login states from **Tencent `@tencent-weixin/openclaw-weixin@2.4.8`**,
published 2026-09-01T02:49:09.161Z. Copyright (C) 2026 Tencent. Its MIT notice
is retained in `LICENSE.tencent`. This attribution must travel with substantial
copies. No OpenClaw runtime, account store, logger, lifecycle or agent code is
imported. All HTTP transport, durable inbox, Cockpit correlation and CLI code
are independent implementations.

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
`channel_version=2.4.8` describes the protocol
baseline; `bot_agent=WeixinCockpitBridge/0.1.0` identifies this independent client,
not an official Tencent product. User-authorized real text roundtrips and
automatic server message-ID receipt classification have been exercised successfully.
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

The original install CLI is **not used**. Do not execute it to run this project.

`src/image.js` additionally adapts the 2.4.8 PNG CDN request fields, AES-128-ECB
padding/encryption and IMAGE envelope from `src/cdn/upload.ts`,
`src/cdn/cdn-upload.ts`, `src/cdn/cdn-url.ts`, `src/cdn/aes-ecb.ts` and
`src/messaging/send.ts` (the same tarball hash above). The default CDN endpoint is
documented in the fixed public protocol and `src/auth/accounts.ts`:
`https://novac2c.cdn.weixin.qq.com/c2c`.
Our source fetch is restricted to already-published configured-backend PNGs,
and our CDN validation, bounded reads, durable no-replay fence and error handling
do not copy the upstream arbitrary-download, response-body logging or retry logic.

`src/media.js` extends the same pinned 2.4.8 protocol with inbound CDN decryption
(`src/media/media-download.ts`, `src/cdn/pic-decrypt.ts`) and VIDEO/FILE envelopes
(`src/api/types.ts`, `src/cdn/upload.ts`, `src/messaging/send.ts`).
Upload media_type IMAGE=1, VIDEO=2, FILE=3 differs from message item types
IMAGE=2, FILE=4, VIDEO=5. VIDEO.video_size and IMAGE.mid_size are ciphertext
bytes; FILE.len is plaintext bytes as a string. Upload uses no_need_thumb=true;
no unverified thumbnail generation, duration or dimension field is invented.
Incoming file.len/MD5 and video.video_size/video_md5 are checked when supplied.
ECB/PKCS7 provides no authentication; optional hashes detect corruption, not
authenticity against an attacker controlling both bytes and metadata.
Only the primary media reference is fetched; image_item.url and thumbnail-only
fallbacks are not original-file sources. Incoming image mid_size does not prove
a particular image variant or recover precompression phone bytes. The upstream
100 MiB post-decrypt storage limit is a client policy, not a demonstrated Tencent
server maximum; this bridge retains its explicit 25 MiB file/video and 4 MiB
image limits.

Unlike the upstream implementation, this bridge streams bounded video/file
content through private scratch files, does not buffer large bodies/base64,
does not follow redirects, permits only the fixed CDN ingress/egress paths,
and never uses extensions alone to identify image/video content. Received
media requires the existing unique authorized binding. Backend resources are
resolved with files/get and safe /uploads URLs; no server/local path is used.
This extension is verified using isolated fake fixtures, not real account sends.
