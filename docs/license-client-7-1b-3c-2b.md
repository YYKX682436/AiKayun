# ⑦-1B-3C-2B 真实持钥激活与签名响应归档

本阶段在商城 API 内实现单次 activation 提交和未投影签名证据归档。商城改动基于冻结提交 `31da224c9a60e66e1a0cfab75b6261cfc868a95e`；授权中心只读并固定到 `6f554b51b867a15ad7747c6d002b548e016f65c6`。没有中心代码、数据库或运行状态改动。

## 冻结协议审计

- `docs/license-protocol-7-1a.md` §4.2、§4.3、§4.4 与 §7.1 定义固定 activation body、短时挑战、中心 operation/nonce/license/code 事务、签名响应，以及提交未知的恢复原则。HTTP 409 只有验过的签名回执才是可信事实；无签名错误、断线及超时不表示中心失败。
- 3A 的 `installation_binding` 和文件 Ed25519 私钥是商城身份唯一来源。每个持钥步骤通过 `withVerifiedInstallationSigningContext()` 核对数据库绑定、私钥、公钥与 JKT。
- 3B 的发行配置、已接受 Trust Bundle、当前 key 生命周期和签名 time-anchor 是时间及验签依据。该流程不使用 `Date.now()` 决定客户端签名时间。
- 3C-1 PostgreSQL `local_license_operations` 是商城唯一 operation 权威；激活码和 origin 从其 AES-GCM Pending payload 解密。父 operation ID 与意图不在此处生成。attempt 是锁内追加的证据，`activation`、未来 `query`/`continue` 共用递增编号。
- 3C-2A 已验收的 `VerifiedBoundChallenge` 保持原行为。RFC 9421/RFC 9530 生成及 HTTPS 传输现在共用 `license-request-http.ts`；Challenge 和 activation 使用同一成熟签名库、标准 HTTPS 校验及传输限制。
- 冻结中心 `src/app.ts` 的 `/v1/activations` schema 精确允许 `operation_id`、`intent_digest`、`attempt_no`、`license_id`、`database_id`、`instance_id`、`identity_jkt`、`public_jwk`、`challenge`、`activation_code` 和 `origin`，并拒绝额外字段。中心 `processActivation()` 在事务内依序锁签名权威、验证挑战、operation、license、实例、一次性激活码与 nonce，再记录 operation/attempt/audit 并签发 lease 或签名拒绝回执。

## 内部能力与调用顺序

`createLicenseActivationClient(...).submitPendingActivation(operationId)` 是 API 源码内部函数。没有 HTTP 路由、管理 UI 或公共 RPC 将它暴露给外部；商城业务与 worker 也未调用它。

1. 验证 3A identity、3B 发行配置及已接受 Trust Bundle，并读取已有 3C-1 pending activation operation、加密 payload。缺失、错配或非 pending 均 fail closed。
2. 在 attempt 检查后取得 3C-2A Challenge。Challenge 客户端先用当前信任包和 3B 时间样本签署请求；收到中心签名 Challenge 后，再取一份新的 3B time-anchor，以该样本验证中心 `kid`、签名、时效及其 operation ID、intent digest、安装身份、JKT 和随机 client nonce 绑定。签名 Challenge 自身不产生 attempt。
3. Challenge 客户端把挑战后的 3B 样本连同已验证 Challenge 交给 activation 客户端。activation 客户端确认样本仍新鲜、Challenge 仍在有效期、已接受 Trust Bundle 未变且 3A 身份仍匹配；签名创建时间只能来自该可信样本。锁内本地签名期间只推进这份样本的单调时钟，不访问网络或数据库外部时间。
4. 在 `allocateLicenseOperationAttempt()` 的 operation advisory 锁和父行 `FOR UPDATE` 事务内分配共用序列中的 attempt。`buildRequest()` 改为可 await，但只在本地组装 bytes、计算 digest 和签名；获取 Challenge、可信时间、HTTP 均在事务外。部分唯一索引与事务检查共同保证同一 operation 至多有一个 `purpose=activation` attempt。
5. 精确 body 序列化为 UTF-8 Buffer 一次。通过中心已采用的 `@misskey-dev/node-http-message-signatures@1.1.2` 与 `structured-headers@1.0.1` 生成 RFC 9421/RFC 9530 头。请求 envelope（固定 method/path、全部请求 headers、原始 body Base64URL）加密落库，保存成功才继续。
6. 提交 `sent` 状态证据后，从已提交 AES-GCM envelope 读回 bytes 和 headers；验证解密、AAD、body digest、请求绑定及签名参数。发送不重建 JSON、不重新签名。发送前最后再次核对签名/Challenge 有效期、当前 bundle 与 3A identity。
7. 只向发行配置固定 HTTPS origin 的 `/v1/activations` 发送 POST。使用标准 TLS certificate/hostname 校验；不跟随重定向；请求超时 5 秒，响应头最多 8 KiB、响应体最多 16 KiB。
8. 只识别 HTTP 200 `{ "license": "<JWS>" }` 与 HTTP 409 `{ "operation_receipt": "<JWS>" }`。有界 JSON 必须是严格单字段 envelope。先提取其 Compact JWS ASCII bytes 并用 Pending key 加密提交，再读回已保存 bytes；随后在事务外取得新的 3B time-anchor，再按最新可信时间与当前信任包验签。
9. 返回的 lease 或拒绝回执是签名验证通过、绑定已持久 attempt 的内部证据。它保持 `projected: false`，没有 `allow`、`grants` 或经营决策属性；不写 3D projection、terminal/cancelled、订单/充值状态或新经营授权。

### Attempt envelope 与摘要

Activation body 的确切字段如下，次序固定为实现的序列化顺序；origin 保持原 payload 的规范 HTTPS origin 或 `null`：

```json
{
  "operation_id": "<existing operation>",
  "intent_digest": "<existing immutable intent>",
  "attempt_no": 1,
  "license_id": "<operation license>",
  "database_id": "<3A database ID>",
  "instance_id": "<3A instance ID>",
  "identity_jkt": "<3A Ed25519 JKT>",
  "public_jwk": { "kty": "OKP", "crv": "Ed25519", "x": "<public key>" },
  "challenge": "<original verified Challenge JWS>",
  "activation_code": "<original Pending code>",
  "origin": null
}
```

Attempt evidence stores `client_nonce_hash = SHA256(client_nonce)`, `request_nonce_hash = SHA256(server_nonce)`, and `request_body_digest = SHA256(actual raw body bytes)` in canonical Base64URL. RFC 9421 `Signature-Input` nonce is the Challenge `server_nonce`, and its `keyid` is the 3A identity JKT. The encrypted request envelope also stores signature headers and exact request body. Existing 3C-1 append-only and AAD rules remain authoritative.

The 202610300002 forward migration adds a partial unique index for the single initial activation attempt and tightens its state transitions. A preflight read avoids unnecessary Challenge work when an attempt exists; correctness comes from the in-transaction advisory/row locks, unique index, and migration trigger, never from that read alone. Query/continue attempt allocation remains available on the shared increasing sequence for later phases.

### Response verification and result boundaries

For a 200 lease, a fresh signed time sample acquired after the response drives the current accepted bundle resolver, which must validate the retained, non-revoked `kid`, Ed25519 signature, exact issuer, audience `aikayun-commerce`, `typ=aikayun-license+jwt` and full claims allowlist. The verifier checks `license_id`, `database_id`, `instance_id`, `identity_jkt`, canonical positive generation/revision, plan, subscription end, lease `exp`, `renew_after`, exact ordered grants, and `request_nonce == Challenge.server_nonce`; `request_digest` must equal the persisted raw-body digest. Trust Bundle and installation identity are rechecked after verification.

For a 409 receipt, HTTP status alone is ignored. The same post-response trusted time and current bundle resolver validate `typ=aikayun-license-operation+jwt`, signature, key, issuer/audience and full claims. The client then checks `sub/license_id`, `operation_id`, `intent_digest`, `actor_jkt`, `attempt_no`, `request_nonce_hash`, `request_digest`, `state=rejected` and bounded `outcome_code`. A valid signed rejection is retained as unprojected evidence; it does not grant use or clear the activation payload.

The encrypted response table stores only the extracted compact JWS bytes. Same-attempt byte-identical replay is idempotent; different bytes cannot overwrite it. Out-of-order response saving continues to follow 3C-1 per-attempt archival and monotonic parent-pointer rules. `response_saved` proves only local encrypted persistence, not that the response is valid or current.

## Failure and recovery semantics

Once a request may have left the process, disconnect, timeout, response loss, malformed/unsigned HTTP error, 5xx and uncertain local commit acknowledgement preserve the original operation and attempt as pending/unknown evidence. No HTTP status alone becomes a signed center decision. The client does not automatically retry activation, allocate another initial activation attempt, generate an operation ID, or consume the code again. A stale Challenge or signature stops the send. A pre-send stop after `sent` evidence may record local `transport_error`; it does not write a local terminal state.

The isolated center fixture covers the real center commit followed by dropped response: the center activation remains exactly once while the shop retains its original operation and unknown attempt. Resolving that fact requires a later signed query/continue recovery flow. 3C-3 must use the same operation ID, verify fresh Challenge and operation receipt against retained attempt evidence, and never infer non-commit from `not_found` alone.

## 阶段停止边界

本阶段不做 query/continue 自动恢复、后台重试 worker、3D 权益投影、经营授权门禁、管理 UI、公开激活路由、time-reset、正常/灾难迁移、正式生产 root/激活码或生产部署。订单、充值、支付、退款、提现、数字交付及 worker 路径保持原样。完成 3C-2B 后停止，等待独立严格验收。
