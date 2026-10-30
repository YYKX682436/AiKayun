# ⑦-1B-3C-2A 商城持钥 HTTPS Challenge 客户端

本阶段在商城端实现面向授权中心的内部持钥 HTTPS Challenge 请求，并用冻结授权中心源码进行真实互操作验收。商城起始基线为 `ba611606bd1e068ee937d1dee6ec27926c75ee50`；授权中心只读基线为 `6f554b51b867a15ad7747c6d002b548e016f65c6`。本阶段不发送激活、不创建公开 API、不改变授权状态或经营行为。

## 审计到的协议边界

- **3A 安装身份：** `installation_binding` 是数据库身份权威，安装目录的 manifest、Ed25519 PKCS#8 私钥、推导出的公钥和 RFC 7638 JKT 必须逐项一致。`withVerifiedInstallationSigningContext()` 在每次签名工作开始前复核数据库及文件身份；只给调用者一个签名函数，不返回私钥。
- **3B 信任与时间：** 请求前必须有发行配置匹配的根签名 Trust Bundle candidate、已接受 bundle 和新鲜签名 time-anchor。时间锚绑定随机 nonce、准确 issuer 与有限有效期；本次 HTTP 签名时间取自 `VerifiedTimeAnchor.serverTime`，仅按单调时钟外推。
- **3C-1 操作权威：** 唯一操作是 PostgreSQL `local_license_operations` 中已提交、类型为 `activation` 且仍为 `pending` 的 operation。激活码仅从现有加密 Pending 读取，用于重算并核对不可变 `intent_digest`；不会放入 Challenge body。不会创建或写入 `local_license_operation_attempts`。
- **中心 2C-4 契约：** 只接入 `POST /v1/challenges`，请求字段为 `operation`、`operation_id`、`intent_digest`、`instance_id`、`public_jwk`、`client_nonce`；中心成功响应为 HTTP 201 JSON `{ "challenge": "<JWS>" }`。不复制中心授权逻辑，验签复用已接受 bundle 的当前 resolver 与现有 `verifyLicenseChallenge()`。

## 内部请求流程

`createLicenseChallengeClient(...).requestActivationChallenge(operationId)` 按以下顺序执行：

1. 通过 3A 验证数据库身份与已持久化 Ed25519 私钥；载入同 ID 的 activation/pending operation 和加密 payload，重构 activation intent 并比较摘要。
2. 用 3B 根认证 candidate 引导中心可信时间，再从 TrustBundleStore 读取当前已接受 bundle。可信时间样本需新鲜，最长有效 30 秒；Challenge 的签名 JWS 也在该可信时刻验签。
3. 以 Node 密码学随机数生成 32 字节 `client_nonce`，规范编码为无填充 Base64URL。
4. 将精确请求对象只序列化一次为 UTF-8 `Buffer`，通过中心已采用的 `@misskey-dev/node-http-message-signatures@1.1.2` 和 `structured-headers@1.0.1` 生成 RFC 9421 与 RFC 9530 头。`Content-Digest` 是对原始 body bytes 的 SHA-256；签名后不改 body、目标 URI 或签名头，网络请求直接发送相同 `Buffer`。
5. 在标准 Node HTTPS 栈中向发行配置规定的唯一 HTTPS origin 与 `/v1/challenges` 发 POST。强制 hostname/证书链校验，无重定向跟随；响应超时 5 秒，响应头上限 8 KiB，响应体上限 16 KiB。
6. 严格解析只有 `challenge` 字段的 JSON envelope。使用 3B 当前已接受 bundle 的 resolver 验证 JWS；既有 verifier 强制 `typ=aikayun-license-challenge+jwt`、发行配置 issuer、`aud=aikayun-commerce`、精确 claims 集合、`nbf=iat` 和受信 `kid`。随后确认 Trust Bundle 在等待及验签期间未变化。
7. 再次绑定 operation 类型、ID、不可变 intent digest、instance ID、identity JKT 及本次 client nonce。Challenge `server_nonce` 必须为规范的 32 字节 Base64URL；`exp-iat` 必须恰为 300 秒，`iat` 不晚于当前可信时间，且当前可信时间严格早于 `exp`。最后再次核对 operation 和 3A 身份未变化。
8. 全部检查成功后返回带模块私有 brand 的 `VerifiedBoundChallenge` 类型。它表示中心 JWS 签名已验证且绑定到本地 pending activation operation，不代表激活成功或具有经营权限。

### RFC 9421 请求签名

签名覆盖组件及顺序固定为：

```text
@method
@target-uri
content-type
content-digest
```

`Signature-Input` 含以下参数和值：

| 参数 | 值 |
| --- | --- |
| `created` | 新鲜 3B 可信时间（Unix 秒） |
| `expires` | `created + 60`，有效窗口恰为 60 秒 |
| `nonce` | 本次请求的随机 `client_nonce` |
| `keyid` | 当前 3A identity JKT |
| `alg` | `ed25519` |
| `tag` | `aikayun-license-v1` |

Structured Fields 序列化及底层签名委托给中心相同的成熟实现。该库的参数序列化为 `keyid, alg, created, expires, nonce, tag`；验证器同时约束精确参数集合、参数值和组件顺序。`Content-Digest` 只含 RFC 9530 `sha-256` 字段，其摘要对实际发送的 body bytes 重算并比对。

### HTTPS、时间与错误语义

目标 origin 必须是与发行配置 issuer 相同的标准 HTTPS origin；路径固定为 `/v1/challenges`，没有 URL 重定向、第二 origin 或代理回退。生产请求保持 Node TLS 默认受信 CA、证书有效期和 hostname 校验，`rejectUnauthorized` 与 SNI hostname 均明确设置。自定义 CA/DNS 仅供 `NODE_ENV=test` 隔离互操作测试注入。

`created/expires` 不读取未经验证的主机 wall clock。time-anchor 使用 `performance.now()` 衡量网络往返及样本年龄，用中心签名的 server time 做起点。建立 TLS 连接时，标准证书验证仍依赖系统时钟；若主机偏差导致证书有效期验证失败，time-anchor 无法建立，客户端 fail closed，应先修复主机时钟或证书链。

传输错误、超时、非 201、错误媒体类型、超大响应、JSON/JWS/绑定失败均只返回安全错误代码，不包含请求/响应、激活码、私钥或异常 cause。Challenge 请求本身不持久化客户端 nonce；重试继续使用同一个 operation ID 与不可变 intent，但产生新的 client nonce 和签名。因没有发送 `/v1/activations`，也没有 activation attempt 可以被伪造为已发送或成功。

## 状态及数据边界

- 商城 operation 在 Challenge 前后保持 `pending`；attempt 表仍为空。
- 中心 `license_activations`、`license_operations`、`license_operation_attempts` 不因 Challenge 被写入。
- 商城不存在新的 `license_projection`；经营状态及现有业务授权门禁都不由此客户端产生。
- 加密 Pending、3A 身份持久化及既有业务流程没有改变。日志、异常响应、浏览器与生产镜像不含私钥或授权中心测试资料。
- 正式发行配置 `generatedTrustedReleaseLicenseConfig` 继续为 `null`；没有 root 签发、生产密钥切换或部署。

## 与 3C-2B 的接口边界

3C-2B 可消费 `VerifiedBoundChallenge`，在现有 operation 权威内用异步 RFC 9421 signer 适配真正 activation attempt 的持久化封套。3C-1 同步 `buildRequest(attemptNo)` 本阶段保持不变；本阶段没有调用 `allocateLicenseOperationAttempt()`，也不访问 `/v1/activations`。Query/continue、重试恢复状态机、授权投影、经营门禁、UI 与生产发行均未实现。
