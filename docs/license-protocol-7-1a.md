# ⑦-1A：许可证、实例身份与经营准入协议 v1

状态：设计契约，未实现。适用基线及发行边界见[发行架构](./production-release-architecture-7-1a.md)。本文件是技术协议，不替代需另行审核的商业订阅条款。未创建任何实际许可证或生产签名私钥。

## 1. 标准选择和信任边界

许可证采用 **JWS Compact 中的 JWT、Ed25519签名**，由独立授权中心签发、商城 API 本地验证。算法采用 [RFC 9864 §2.2](https://www.rfc-editor.org/rfc/rfc9864.html#section-2.2) 的完全指定 JOSE 标识 `Ed25519`，不是含糊地接受任意 EdDSA 曲线。结构沿用 [JWS RFC 7515](https://www.rfc-editor.org/rfc/rfc7515.html)、[JWT RFC 7519](https://www.rfc-editor.org/rfc/rfc7519.html)，OKP公钥及指纹遵循 [RFC 8037](https://www.rfc-editor.org/rfc/rfc8037.html) / [RFC 7638](https://www.rfc-editor.org/rfc/rfc7638.html)，验证策略遵循 [JWT BCP RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html)。

成熟 TypeScript `jose` 是⑦-1B首选，维护方已列出 Ed25519 标识支持；开发时固定版本、锁文件，并用 Node24 真正验证签发/拒绝向量，不能仅看库名称即宣称兼容。[维护方支持说明](https://github.com/panva/jose/issues/262)、[changelog](https://github.com/panva/jose/blob/main/CHANGELOG.md)。比较：COSE_Sign1同样成熟但当前栈无CBOR需求；PASETO另有封装生态，JWS更便于本栈运维和互操作；自制 `JSON.stringify + crypto.sign` 许可证文件不选用。

实例到中心的持钥证明采用标准 [HTTP Message Signatures RFC 9421](https://www.rfc-editor.org/rfc/rfc9421.html)，请求体使用 [Content-Digest RFC 9530](https://www.rfc-editor.org/rfc/rfc9530.html) SHA-256。这是标准签名封装的应用配置，不发明新的密码算法、JSON规范化、握手或加密协议。HTTP签名库须通过标准测试向量；若成熟实现不能满足Node24/Ed25519，不允许手写低层签名封装凑验收，先报告实现选型阻塞并审查标准替代方案。

### 1.1 三种密钥分工

| 材料 | 所在位置/用途 | 轮换规则 |
| --- | --- | --- |
| 中心授权签名私钥 | 仅中心服务的受控secret/签名后端；离线备份。商城、发行镜像、浏览器均无私钥 | `kid`唯一且不复用；新公钥先分发再签发；旧公钥保留至少最大凭证寿命+发布传播窗口；泄露另走紧急吊销 |
| 商城授权验证公钥集合 | 发行中固定可信issuer对应的只读公钥集，API私有配置 | 新key由现有受信任离线发行根签署的trust bundle或新发行导入；禁止由token自带jwk/jku/x5u下载任意key；中心JWKS仅作已钉住信任内的分发，不能自举新信任 |
| 实例身份 Ed25519 私钥 | 每安装独立生成，API-only秘密文件、加密备份；向中心证明持钥 | 正常更新/迁移保留；正常换key须旧key签名+新key持钥挑战；旧key丢失走灾难迁移/账号人工核验，代次递增 |

发行签名根/在线发行签名与授权签名分别管理，信任用途不可互换。业务支付/交付 AES keyring 也独立，续费/撤销绝不派生、替换或销毁业务解密密钥。

trust bundle包含 `bundle_version`、issuer、各 `kid/alg/kty/crv/x/not_before/retire_after/revoked_at`；bundle_version只增。离线发行根签JWS，商城内嵌根公钥。常规发布需在旧key退休前覆盖所有受支持镜像并验证最长7天缓存。紧急泄露时，已联网安装应用新bundle并拒绝受影响key；完全离线旧安装仍可能信任泄露key，不能承诺远程即时根除。公钥下载失败不等于许可撤销。

`not_before`/`retire_after`限定该key的**签发iat窗口**，不是提前缩短已签lease的exp；另有 `verify_until >= retire_after+604800+传播预算` 限定正常验证保留期。紧急 `revoked_at` 表示接收可信bundle后立即拒绝该key的全部新经营证据（包括旧lease），不等待exp；历史义务继续。清单必须保留旧key到所有正常lease自然失效。不要把普通退休与泄露吊销混成一个状态。

## 2. 身份与不可变引用

```ts
type InstanceId = string // UUIDv4，安装时生成
type LicenseId = string // 中心生成UUID，不是秘密
type ActivationGeneration = string // 正整数十进制字符串，DB bigint
type Revision = string // 正整数十进制字符串，DB bigint，JSON不用浮点number
interface InstallationBinding {
  schema: 1
  database_id: string
  instance_id: InstanceId
  identity_jkt: string // RFC7638 SHA256 JWK thumbprint
  binding_revision: string // DB身份重绑版本，单调增加
}
```

`instance_id`代表逻辑安装；`identity_jkt`代表持钥身份；`license_id`代表商业权益；`activation_generation`是中心为该许可证维护的单调激活栅栏；`entitlement_revision`覆盖续费、撤销、恢复等权益变化。容器ID、Compose project名、域名、IP与机器信息都不是授权主体。相同身份完整复制到另一台离线机器，协议不能分辨；中心只保证一条活跃登记，不能保证物理世界同时只有一个进程。

正常迁移保留上述binding；中心仍递增generation，给旧环境续签围栏。灾难迁移可保留完整备份的instance/key，也可在身份丢失时生成新instance/key，并通过中心管理面显式替换；`database_id`随业务数据保持，不能为了激活新建空账本。

## 3. 订阅与凭证

### 3.1 订阅账期

中心保存 `plan=monthly|yearly`、`billing_anchor_utc`、`anchor_day`、`confirmed_subscription_end`、已确认支付/调整事件。订阅采用UTC绝对时间半开区间，`now < end`有效，`now == end`禁止新增。日历月/年计算，不把“月”默认为30天；月末钳制到目标月末并保留原anchor day，2月29日的年订阅在非闰年钳制为2月28日，并保留原锚点。提前续费从现有confirmed_end延长，已过期续费从确认生效时间开始并重设新账期锚点，绝不让中断期间追溯获得新经营资格；中心账单明确列出每次实际起止UTC，商城不自行计算或延长账期。

只有中心确认支付/人工审计调整后才能提高end，付款发起/商城自报截图无效。续费事件以支付商户事件ID或管理操作UUID唯一，事务锁license后更新revision/end，重复事件不延长两次；中心续费资金规则另属私有项目设计，商城不会承担中心订阅收款。

### 3.2 授权JWT

以下是结构，不是可用token或真实客户信息：

```ts
// protected header，其他header默认拒绝
{ alg: 'Ed25519', kid: '<trusted-key-id>', typ: 'aikayun-license+jwt' }

interface LicenseClaimsV1 {
  v: 1
  iss: string // 精确匹配配置的中心issuer
  aud: 'aikayun-commerce'
  sub: LicenseId
  jti: string // 随机唯一凭证ID
  iat: number // 整数NumericDate，中心可信时间
  nbf: number
  exp: number
  instance_id: InstanceId
  database_id: string
  identity_jkt: string
  activation_generation: ActivationGeneration
  entitlement_revision: Revision
  plan: 'monthly' | 'yearly'
  subscription_end: number
  renew_after: number
  grants: ['create_order', 'create_top_up']
  request_nonce: string
  request_digest: string // 对本次请求实际body bytes的SHA256 base64url
}
```

`exp = min(iat + 604800, subscription_end)`，最长7天，不允许客户端再加“宽限7天”。`nbf=iat`；`renew_after=min(iat+21600, exp)`。若剩余不足6小时，则按截止时间提前续签/显示到期提醒，不能因续签间隔继续经营。`allowed_until=min(exp,subscription_end)`；没有凭证或exp已经到达只禁新经营，不能借网络故障延长。续费后中心签发更高revision和新end，本地验签提交后才恢复；中心已续费而本地离线，只能按先前确认end经营。

验证同时检查：签名、header精确allowlist、算法/key类型/曲线、issuer/aud/typ/v、所有必需字段类型/长度/整数范围、`iat <= renew_after <= exp <= subscription_end`、`exp-iat <=604800`、绑定身份、generation/revision水位、时间。拒绝 `none`、HMAC、算法协商回退、重复JSON key、未知crit、b64=false、嵌入jwk/jku/x5u、压缩/嵌套token；token限制16KiB。禁止对exp使用正向clock tolerance突破已确认截止；iat/nbf允许最多60秒误差仅用于诊断/校时，不授予额外经营时间。严格schema版本未知时拒新并报告需兼容升级。

JWT只包含授权元数据，签名不加密；不包含顾客、订单、机器指纹、支付或供应商secret。grants固定两项，不能携带 `enable_procurement` 一类商业功能绕过。中心签名状态回执与许可证使用不同typ、不同payload校验器，避免跨JWT类型混用。

## 4. 中心数据约束和API

### 4.1 中心最小数据模型（独立项目）

```text
licenses(id PK, account_id, plan, billing_anchor_utc, anchor_day,
  confirmed_subscription_end, status active|revoked,
  current_generation bigint>=0, entitlement_revision bigint>0, revision)
license_activations(id PK, license_id FK, generation bigint, instance_id,
  database_id, identity_jwk_public, identity_jkt, state active|retired,
  activated_at, retired_at, last_seen_at, origin_display,
  UNIQUE(license_id,generation))
  UNIQUE INDEX(license_id) WHERE state='active'
  UNIQUE INDEX(instance_id) WHERE state='active'
activation_codes(id PK, license_id FK, token_hash UNIQUE, expires_at, consumed_at)
request_nonces(nonce_hash PK, operation, instance_jkt, expires_at, consumed_at)
license_operations(operation_id PK, actor, intent_digest, kind,
  license_id, database_id, state committed|rejected|cancelled,
  outcome_code, result_generation, result_revision,
  response_jws, result_digest, created_at, finalized_at,
  CHECK(state IN ('committed','rejected','cancelled')),
  CHECK(finalized_at IS NOT NULL))
license_operation_attempts(attempt_id PK, operation_id, attempt_no,
  intent_digest, body_digest, client_nonce_hash, server_nonce_hash,
  identity_jkt, signature_created_at, received_at,
  outcome accepted|retryable_reject|terminal_reject|committed_replay|
    terminal_replay|cancelled_replay,
  error_code, UNIQUE(operation_id,attempt_no), UNIQUE(server_nonce_hash))
-- 未认证的流量仅进独立限流/安全计数器，不得写入这两张业务操作表。
-- attempt故意不设operation FK；它可先于终态墓碑记录已认证的可重试失败。
entitlement_events(id PK, license_id FK, external_event_id UNIQUE,
  previous_end, new_end, kind, actor, created_at) // 只追加
license_audit_events(id PK, license_id, kind, actor, safe_details, created_at)
```

每次激活/续签/迁移操作先在商城本地生成UUID operation_id及固定 intent_digest，DB持久化pending记录后才请求challenge或发送。intent_digest覆盖不可变业务意图（操作类型、license_id/activation code、instance_id、database_id、identity_jkt、计划目标/预期generation），不覆盖nonce、签名时间、签名、attempt序号及挑战值。激活码只保存在受限本地pending密文中，不出现在中心operation明文/审计/日志。

中心先验证HTTP签名的密码学正确性、签名key与请求主体绑定；通过该身份认证后，才可只读检查operation actor绑定，再验证challenge/nonce新鲜度。在身份/HTTP签名认证之前不得按请求中的operation_id读取、插入或更新操作表。坏签名、未知/撤销身份、已知operation的actor不匹配只写独立限流安全计数（不含可关联的operation_id），本次请求立即拒绝，也不写attempt。签名身份有效且operation actor匹配（或目标operation尚不存在）但nonce过期/重复、限流或临时系统错误时可写独立attempt=`retryable_reject`，不得终结operation。尝试表不设operation外键，因而可记录尚无终态operation的重试；后续关联仅按全局唯一operation_id及不可变intent_digest核对。

每个已认证、新鲜请求用同一锁序：`pg_advisory_xact_lock(hash(operation_id)) → licenses FOR UPDATE → existing license_operations → active activation → request nonce/activation code → attempt/audit`。跨多个license的迁移操作按license_id字典序加行锁。先验actor、license_id/database_id和intent_digest；已有相同摘要的终态只返回相同签名结果，分别记`committed_replay`、`terminal_replay`或`cancelled_replay`，不重复执行。相同operation_id但actor或intent_digest不一致返回409并不得改原行。没有既有操作时，只有通过身份与freshness认证后才可进入业务判定：确定性业务拒绝（如已消费/过期激活码、活跃实例冲突、订阅不满足）与其签名拒绝回执、attempt=`terminal_reject`、operation=`rejected`在一个数据库事务内原子提交，不消费激活码、不建activation、不增generation；成功则在同一事务消费code/nonce、创建activation及原始签名license结果、attempt=`accepted`、operation=`committed`。暂时性DB/中心错误回滚业务事务且不产生终态；nonce消耗如已独立提交则不回滚，但新challenge仍可续接同一operation。取消必须由获授权actor签名，在相同operation advisory锁内原子写`cancelled`墓碑；若已commit/rejected则返回既有终态，不可覆盖。

数据库只允许插入完整终态operation；CHECK约束拒绝其他状态/缺失终态时间，主键和不可变触发器阻止修改actor、摘要、结果或删除。attempt的CHECK限定列举结果；`accepted`只与本事务commit返回，`retryable_reject`从不改变operation，确定性拒绝与终态operation同事务提交。通过`operation_id` advisory锁，迟到原请求与新challenge续接只能串行：先commit者建立唯一终态，后者只回放；先取消者写墓碑，迟到请求不能复活。取消与rejected/committed墓碑均按license生命周期及法务审计保留期保存，不得清理或复用operation_id。不存在不是永久not-found证明；但同operation的原请求在请求进程结束后不能越过中心事务锁提交。generation只在激活/替换成功时增加，续签和恢复签发新lease不增加generation。

商城顺序固定为：①在唯一`local_license_operations`表插入operation意图并提交/fsync；②请求challenge；③在该operation的attempt子表事务持久化challenge、attempt号、原request_nonce的SHA-256、request_digest、jkt/kid、签名时间和将发送的请求封套摘要，并提交/fsync；nonce原值只在需重发的加密request envelope中短期保留；④才发送；⑤中心一个DB事务commit；⑥收到响应先加密原始签名响应、原子落盘/fsync并提交`response_saved`；⑦独立本地事务验签并投影授权；⑧读回确认jti/generation/revision；⑨标`projected`，清理request/response敏感密文但永久保留不含秘密的attempt摘要（含原nonce hash与request_digest）。强杀/超时/响应丢失一律先按原operation查/continue；若第⑦提交未知，先查本地projection的jti/operation_id，再幂等补投影。若中心已commit但本地未保存lease，也保留第③步的原nonce hash/digest/jkt/kid并可从中心回执核对。任何网络调用都不在商城SQL事务内。

商城只有一个pending权威：`local_license_operations(operation_id PK, kind, intent_digest, license_id, database_id, identity_jkt, expected_generation, state pending|response_saved|projected|terminal|cancelled, encrypted_request_secret, encrypted_request_envelope, encrypted_response, response_digest, created_at, finalized_at)`；子表`local_license_operation_attempts(operation_id FK ON DELETE RESTRICT, attempt_no, challenge_jti, request_nonce_hash, request_digest, identity_jkt, key_id, signature_created_at, sent_at, outcome, response_digest, UNIQUE(operation_id,attempt_no))`只保存不可变的逐次请求/响应关联，不拥有父状态或独立pending生命周期。nonce hash与request_digest永久保留至operation墓碑保留期，原nonce/请求内容只存在短期加密envelope；migration/renewal恢复需要原attempt身份时无需保存明文nonce。迁移/重绑所需target/binding字段按`kind`列或同operation的受保护payload保存，不另有`pending_license_operations`。CHECK约束限制父状态转换：`pending→response_saved→projected`、`pending|response_saved→terminal|cancelled`；`projected/terminal/cancelled`不可复活。父子记录禁止级联删除，子attempt不可修改/删除。跨文件迁移journal仅作stage索引，引用operation_id，可由DB父行重建。

激活码、原challenge nonce/请求封套和可能含授权的原响应使用独立本机32-byte密钥`license-pending-encryption-key`（AES-256-GCM）加密，密钥存于持久化0600 secret文件`/etc/aikayun/secrets/license-pending-encryption-key`且只挂给API；开发环境使用隔离独立密钥。该密钥及授权DB/两张本地操作表必须作为同一静止点备份的配对成员纳入加密backup set；解密key另由独立秘密托管，不随备份明文。恢复时先校验密文与key ID/校验和成对可读，再恢复操作表和密钥后才能启动授权恢复器；不能只还原DB然后把pending当未发送。密钥丢失/不匹配时pending保持不可读并fail-closed，停止授权续接及新经营，保留历史义务并走人工灾难迁移，不静默删记录。编码前不写日志、trace、APM、异常或HTTP query。成功投影并读回后清除request/response密文；激活码在中心committed回执确认后立即清除，其余不含secret/token的审计元数据按保留期保留。pending逾期不得自动删掉未知结果操作；已证明未提交且用户明确取消的operation，须中心原子cancel后才可清密文/回收。

双并发激活仍由license行锁和部分唯一索引保护。唯一operation_id的业务结果只能commit一次；重试请求不会二次消耗激活码或产生第二个generation。

未首次激活的license `current_generation=0`，首次成功激活设1，此后只增；所有已签lease的generation必须>0。

### 4.2 中心接口

所有接口仅HTTPS、JSON严格schema、no-store；默认body≤32KiB、响应≤32KiB。中心管理面使用独立管理员认证/MFA和审计，不给商城实例撤销他人license的权限。

| 接口 | 鉴权及请求 | 成功/错误语义 |
| --- | --- | --- |
| `POST /v1/challenges` | operation、instance_id、public_jwk、operation_id、随机client_nonce（≥256 bit）；限流 | 一次性nonce，有效5m，绑定操作与jkt；返回签名challenge及中心时间，不授予权益 |
| `POST /v1/activations` | 短期一次性activation code + 持钥HTTP签名；body含nonce、operation_id、intent_digest、database_id、instance_id、public_jwk、origin | 锁license/operation/code/nonce后激活，登记DB绑定并签LicenseClaims；已有别的active→409 `ACTIVATION_CONFLICT` |
| `POST /v1/leases/renew` | 当前身份签名，license_id/database_id/generation、known_revision、nonce、operation_id、intent_digest | active主体且订阅有效签新lease；过期/撤销/替换返回签名状态回执 |
| `POST /v1/operations/continue` | 原operation_id+原intent_digest、新attempt_no/新challenge nonce/持钥新签名；同一身份和payload | 原子串行检查该operation；committed回原结果，确定可执行则继续同一意图，绝不新建operation |
| `POST /v1/operations/query` | 当前nonce/持钥签名，原operation_id+intent_digest；仅原actor或已授权迁移目标可读 | 返回签名状态快照。not_found只代表线性化查询时未见记录，**不能围栏尚在途的原请求**，也不能据此另建operation |
| `POST /v1/origin` | 同身份签名、新规范origin、nonce、operation_id | 仅更新展示/审计域名；不强绑域名，不改变订阅或代次 |
| `POST /v1/transfers/prepare` | 中心账号确认 + 原实例持钥证明、expected_generation | 发单次transfer ticket，10m有效，绑定目标jkt/instance；不提前释放旧激活 |
| `POST /v1/transfers/commit` | 目标持钥签名、ticket、nonce、operation_id | 一个事务退休旧代次、代次+1激活目标、发新lease；冲突/过期ticket无副作用 |
| 中心管理面 `revoke/restore/disaster-transfer` | 授权中心账号强认证、原因、expected_revision、operation_id | 锁license、提高revision，必要时generation+1，追加审计；不使用activation code代替账号找回 |
| `POST /v1/time-resets` | 身份持钥+中心账号强认证确认，fresh nonce、expected_time_epoch、旧水位摘要 | 签名校时恢复证据，仅开启新时间epoch，不增加订阅/恢复撤销状态 |

HTTP签名覆盖 `@method`、`@target-uri`、`content-type`、`content-digest`，Signature-Input含 `created/expires/nonce/keyid/alg/tag`；`alg=ed25519`为RFC9421的标识（与JOSE header的`Ed25519`大小写不同），`keyid`为jkt，`tag=aikayun-license-v1`。created/expires间隔≤60s，nonce只能消费一次。严格按接收原始字节计算digest，不重排JSON。中心只接受配置的外部target-uri，不信任任意Forwarded头重建签名目标；代理改写行为必须互操作测试。首次public_jwk只准OKP/Ed25519公钥，无`d`字段且长度正确，签名证明该key持有者。

challenge响应为 `typ=aikayun-license-challenge+jwt` 的JWS，含issuer/audience、iat/exp≤5m、server_nonce、client_nonce、operation_id/operation、instance_id/jkt。客户端用可信公钥验签并核对随机client_nonce和≤5秒单调往返时间，由签名iat建立本次请求created/expires；严重wall偏移时也能发起renew/time-reset，不先用错误wall把challenge拒绝。challenge不清撤销、不降低水位、不形成经营许可；过期响应/旧client_nonce不接受。协议所有特殊JWT类型均独立schema/typ验证，不接受许可证充当challenge。

明确的恢复决策：

| 中心观察到的原operation状态 | 处理 |
| --- | --- |
| committed | 返回原业务结果和原响应签名；不再消耗code、不增加generation。商城保存响应并幂等投影 |
| 当前请求仍在执行/等待license锁 | 同operation continue等待有界时间；超时返回状态未知，再query/continue；不并发开启新operation |
| 可证明未提交 | 同operation continue可执行；DB无commit的事务会回滚，原nonce过期也不妨碍新attempt |
| query返回not_found | 仅瞬时观测，不能证明迟到请求不会提交；必须continue同operation，由中心锁串行化 |
| 状态未知/中心不可达 | 本地pending保留，指数退避；不得新建operation或另耗code。已有可信lease到期后只禁新经营 |
| 已终态rejected/cancelled | 原operation不再继续。中心持久化终态须经当前协议的双层回执校验；R3 的 `ACTIVATION_AUTHORIZATION_INVALID` 受限例外按下文本地可信拒绝结案规则处理 |

每个新challenge会产生新server_nonce/client_nonce和递增attempt_no；业务operation_id与intent_digest始终不变。request body的授权业务字段不可改，签名证明、nonce、签名时间、challenge和attempt_no每次更新。对激活码：若原operation未提交/未消费，续接仍使用同一加密pending code；若已提交，operation先命中committed返回结果而不会重新消费code。不能因为普通query一次not_found就另发op。

中心所有变更请求先验HTTP身份签名，再验challenge/nonce；认证后先取operation advisory锁，再按固定顺序取license行锁并查操作/activation/nonce/code。操作结果与终态墓碑在同一事务commit。迟到旧请求与新challenge续接不论哪一个先取同operation锁，都只能产生一条终态；后到者回放终态，若前者回滚则后到者可继续。nonce过期的请求只得retryable拒绝，不持有该nonce提交业务；新attempt必须绑定相同intent_digest与新challenge，业务意图及原attempt证据不能改写。该锁只提供数据库事务内串行，不是阻止客户完整克隆身份的物理防复制措施。

query的not_found不被当作否定执行证明；同operation continue才是恢复活性路径。R3 对新激活中无效、过期、撤销、已消费或跨license的 activation code 可能在持久化 operation/attempt 前返回签名 `ACTIVATION_AUTHORIZATION_INVALID`：直接 activation 可用 HTTP 409，continue 可用 HTTP 200。商城只在重新验签并绑定原 activation/continue attempt 的原始 JWS 后，才可本地结案；该签名必须绑定原 operation、原 intent、actor、attempt、nonce hash 与 request digest，且 `committed_attempt_no`、committed nonce/digest 和 `result_jws` 全为 null。此例外仅适用于该精确 R3 outcome，不把 HTTP 状态或普通 `not_found` 当拒绝证据。

旧的、已过五分钟验签期限的 R3 无持久化拒绝，可在完整本地历史中用当前可信 resolver 重新验签其签名（忽略的仅是过期时间），并严格确认它是同一 R3 outcome、原 attempt 和无 committed tuple。若之后 query 返回签名 `not_found`，且没有任何已归档业务结果或矛盾 committed 历史，客户端可保持同一 operation/intent，取新 Challenge 后 continue，以请求新的当前拒绝回执。历史 `not_found` 本身从不结案；任何历史签名无效、身份/请求绑定不符、已有 committed 结果或冲突拒绝都阻断恢复及结案。可信拒绝结案必须先加密归档原始 JWS，再在 PostgreSQL 事务中锁定并重新验证完整请求/响应历史，原子写入 `terminal` 与加密证据。终态不可逆、不接收后续业务 attempt，且成功结案解除旧 activation 的本地唯一占位。其他中心持久化拒绝仍须验证外层 receipt 与其 committed `result_jws` 的双层提交证据。

operation永久幂等墓碑（operation_id、intent_digest、terminal/result摘要）保留至少license生命周期+法务审计期，敏感密文可按规则清除。中心短期nonce按到期清理不影响operation墓碑。

操作查询/continue结果外层是 `typ=aikayun-license-operation+jwt` 的标准JWS/JWT，含iss/aud/sub/jti/iat/exp（≤5m）、actor_jkt、operation_id、intent_digest、状态、查询attempt_no/nonce_hash/request_digest、terminal结果摘要；committed时另含原`committed_attempt_no`、原`request_nonce_hash`、原`request_digest`及原response JWS。原lease中的request nonce/digest仍绑定原activation attempt，不能强行改绑或重签延长；客户端先验外层新鲜回执并与本地永久attempt摘要逐项对照，再验内层原lease，然后比较当前generation/revision/拒新事实。未提交操作的签名拒绝结果要明确为terminal或retryable；只有中心在operation锁内记录的terminal状态才可让本地清理pending。

标准签名校验、nonce消费、速率限制、activation code消费、账号权限缺一不可。activation code≥256 bit随机，只存hash，默认24小时有效、单次使用；不放URL或日志，不作为常驻商城密码。中心响应若未签名或TLS/超时失败，只记录transport error，**不能作为撤销、恢复或新的截止时间证据**。

### 4.3 已提交激活的长期恢复

中心已提交activation但商城未投影，原lease可能在恢复前已过exp。商城不得使用历史lease开放新经营。它只能作为“曾签发该activation”的历史签名证据：原响应须与本地持久的原operation_id、intent_digest、request_nonce_hash、request_digest、签名key/kid记录逐项一致；中心用操作回执证明该operation确实committed，并以当前实例私钥的新challenge证明当前持钥。

恢复步骤：①从同一备份恢复原父operation、原attempt nonce hash/digest/jkt/kid及身份密钥；②用当前身份新challenge调用只读query原operation；③验证新鲜短期operation回执的主体/operation摘要，并将中心保存的原响应与本地原request_nonce_hash、request_digest、identity_jkt/key_id逐项比对；中心回执确认原operation=`committed`，原lease即使已过exp也只归档，不作经营许可；④通过当前实例私钥PoP和一致的database_id创建一个新的持久renew/recovery operation id，显式引用原activation operation id；⑤中心从权威license/entitlement记录读取当前`entitlement_revision`、订阅截止与状态，并在operation advisory锁和license行锁内核对原activation仍是当前generation、实例key/database_id匹配、权益active且订阅未到期；然后原子提交该新operation与绑定最新revision的lease；这是恢复凭证签发，不创建第二条activation、不消费code、不增加generation；⑥商城按新operation的响应持久化/验签/投影/读回顺序执行。

更高`entitlement_revision`本身不是拒绝理由：中心必须检查该revision对应的权威权益事件和当前license状态。正常续费/权益调整后，只要同一activation generation仍有效、实例身份及database_id匹配、当前状态为active且`now < confirmed_subscription_end`，恢复operation可按最新revision签发新lease。撤销状态拒绝；仅在中心已显式恢复权益、追加更高revision恢复事件且当前状态重新为active时才可恢复签发。activation已被替换/当前generation不同（superseded）、订阅已到期或当前权益仍撤销时，中心对已认证的新恢复operation原子记terminal rejected；不签新lease、不重建activation、不消费激活码、不递增generation。数据库身份或当前持钥证明不匹配属于认证/主体绑定失败：拒绝本请求且不读写受害operation；合法身份下与operation固定database_id不一致则409，不改原墓碑。当前实例无法持钥时走灾难迁移人工审批，不可仅凭旧license token恢复。历史资金/履约不受该准入结论影响。

原延迟HTTP响应与恢复query并发时均以原operation_id取同一中心advisory锁；中心committed墓碑及保存的原nonce_hash/request_digest/identity绑定是响应接收依据。商城延迟响应也必须匹配本地持久attempt记录；未知attempt、摘要或jkt/kid不符一律隔离拒绝。迟到原lease即使验签正确，也必须校验`exp`；过期只允许归档/恢复流程作证，不能更新active projection。新签lease有新的恢复operation_id、nonce/digest和jti，单独验签后才可恢复新经营。中心operation回执（短期、证明已提交操作事实）、历史license凭证（可能过期、仅证明曾签声明）、新license凭证（当前权益、受exp/subscription_end约束）使用不同typ/受众/校验函数，不可相互代替；恢复回执绝不延长历史license的`exp`。

### 4.4 签名状态回执

`typ=aikayun-license-status+jwt`，含 `v/iss/aud/sub/jti/iat/exp`、instance_id、identity_jkt、generation、revision、`status=expired|revoked|superseded`、subscription_end、request_nonce/digest。回执exp≤iat+5m用于接受窗口，但已接受的拒新事实和水位持久化，不在5m后恢复旧license。superseded回执必须绑定请求旧实例和明确 `current_generation`，不能把旧lease里generation当最新水位。恢复只接受同主体、足够新的generation/revision的有效lease；更高revision的撤销不能被更旧或同revision的active lease覆盖。

HTTP状态码仍可403/409，但正文signed receipt才改变商业状态。400/401/409语义冲突、429、5xx分别诊断，不把未经签名403当永久吊销。签名无效返回 `LICENSE_EVIDENCE_INVALID`，保留尚未过期的最后可信lease；本地磁盘上当前凭证本身无效且无可信缓存则进入invalid_credential。这样外部坏响应不能凭空提前停购，也不能延长经营。

## 5. 本地状态、投影和时间

### 5.1 本地数据模型与接口

```ts
type LicenseState = 'unactivated' | 'active' | 'offline_valid' | 'expired'
  | 'offline_expired' | 'revoked' | 'superseded' | 'invalid_credential'
  | 'identity_mismatch' | 'clock_suspect'
interface LicenseSnapshot {
  state: LicenseState
  reason: string
  instanceId: string
  licenseId: string | null
  activationGeneration: string | null
  entitlementRevision: string | null
  credentialId: string | null
  allowedUntil: string | null // UTC RFC3339
  canCreateOrder: boolean
  canCreateTopUp: boolean
  lastVerifiedAt: string | null
  nextRenewalAt: string | null
}
interface AdmissionDecision {
  kind: 'create_order' | 'create_top_up'
  credentialId: string
  generation: string
  revision: string
  decisionAt: Date
  allowedUntil: Date
}
// 接口草案：在⑦-1B实现/⑦-1C接入，当前没有这些模块
verifyAndProjectEvidence(raw: string, binding: InstallationBinding,
  trust: TrustedKeySet, previous: LicenseProjection): VerifiedEvidence
persistLicenseEvidence(trx: Transaction<Database>, evidence: VerifiedEvidence): Promise<void>
getLicenseSnapshot(db: Kysely<Database>): Promise<LicenseSnapshot>
assertNewObligationAllowed(trx: Transaction<Database>,
  kind: 'create_order' | 'create_top_up'): Promise<AdmissionDecision>
```

新增DB表草案：`installation_binding(singleton=true PK, database_id UNIQUE, instance_id UNIQUE, identity_jkt, binding_revision, binding_state ready|rebind_pending)`；`instance_license_state(singleton=true PK, raw_evidence, license_id, database_id, generation, entitlement_revision, evidence_seq, accepted_status, credential_jti, subscription_end, lease_exp, renew_after, trusted_server_time, time_epoch, observed_time_high_water, last_verified_at, last_contact_error, revision)`；`instance_license_events(id PK, kind, safe_reason, credential_jti, operation_id, created_at)`只追加；商城唯一pending权威为`local_license_operations`，主键operation_id，kind区分activation/renewal/recovery/transfer/rebind，固定intent_digest与identity/database绑定；状态为`pending|response_saved|projected|terminal|cancelled`，迁移/重绑字段（expected_binding_revision、source_generation、target_instance_id、target_jkt、signed_receipt）按kind条件必填。CHECK约束验证状态/字段组合，所有时间`timestamptz`，bigint JSON用字符串，CHECK `lease_exp<=subscription_end`等；没有行/不识别schema默认禁新，不允许“未装授权模块所以放行”生产分支。不得另建`pending_license_operations`或文件journal作为第二个状态权威；跨DB/文件迁移journal只允许作可重建的原子文件stage索引，必须引用该表operation_id及其状态。

`persistLicenseEvidence`须在获得当前投影 `FOR UPDATE` 后重新比较全部绑定/代次/revision/已接受拒新事实；锁前验签只证明密码学有效，不证明它比锁后当前状态新。同一generation与entitlement_revision的active lease按iat只接受严格更新者，相同iat保持已接受值（同jti重放幂等）。普通lease仅因`exp`到期、而当前权益仍active时，可接受同revision且iat更新的新续签凭证；更高revision要与中心签名的最新权益状态一致。已接受revoked证据记录其revision水位，任何同revision或更旧revision的active lease（无论iat多新）都不能解除撤销；只有中心显式恢复后签发的更高revision active lease可恢复。superseded须通过绑定新generation的transfer/recovery回执改变，普通lease不能解除。`evidence_seq`仅是本地每次提交+1的审计序号，不能作为中心证据新旧的依据。正常续签不得在不同license_id之间切换；换许可证必须中心显式签迁移/替换授权并清楚绑定旧/新license及实例，不接受任意有效客户token覆盖。

普通renew仅接受与本地完全相同generation；更高generation的普通lease不能自动应用。代次提升仅接受本机预先持久登记的pending transfer/recovery操作及其中心签名提交回执；operations/query也必须经过此条件。初次激活只允许unactivated且与本机pending activation匹配的回执，不能把已有实例改成“初装”清水位。跨license替换不在v1普通renew能力内，未另行定义并验收前明确拒绝。

`raw_evidence`存原签名以便每进程启动重新验证，未验签JSON不能直接变allow=true。代码专用写入口将VerifiedEvidence类型与DB投影约束结合；API业务角色只允许受控更新投影，不能用普通客户请求传投影字段。DB是本机可信应用边界而非对抗root的安全边界。拒新reason和诊断与签名证据分开；过期可由时间直接派生，不必等定时任务写expired。管理员 `/api/v1/admin/license` 返回脱敏snapshot；激活/刷新/迁移指令需原有admin+CSRF，公开 `/api/v1/public/commerce-status` 只回两项canCreate与通用提示，不返回ID、raw token或精确诊断。

### 5.2 时间规则

中心是订阅时间权威；DB `clock_timestamp()`（取得业务/授权锁之后重新取）是事务准入时间源，不能使用事务开始的 `now()` 或页面时间。续签验签后保存签名iat与接收时单调时钟锚点；运行期间有效时间取 `max(DB clock, persisted high_water, signed_server_anchor + monotonic_elapsed)`，不能因本机时间回拨增长剩余授权。

单例投影以 `SELECT FOR UPDATE` 与更新器/新经营事务串行；每次准入更新 `observed_time_high_water`，保持至提交。这是首版明确的正确性取舍：新订单/充值短事务在单例上串行，历史资金/worker不经过该锁。放在现有业务锁之后、最终insert前；更新器只锁授权行，从不锁order/customer/wallet，禁止反向锁形成死锁。⑦-1C必须测锁等待与吞吐，必要优化为shared锁+独立安全时间水位时要重新论证，不能默默减弱时间/状态一致性。

DB clock比high_water低超过60s、单调时钟与wall差异异常，进入clock_suspect拒新并要求NTP修复+在线签名校时；小幅回拨也使用max，不延长exp。不能单凭未认证HTTP Date清水位。启动后单调锚点重建，检测到回拨/恢复旧备份/身份变化时必须联网核对才恢复新经营。持久化DB与本机独立时间水位文件取较高值，写文件用原子rename/fsync；文件写失败使新经营诊断失败，不影响历史处理。文件水位更新可早于事务提交，导致保守拒新可接受，不能降低水位。

误跳未来后不得靠普通renew降低水位。中心为每实例保存单调 `time_epoch`；受审time-reset签发 `typ=aikayun-time-reset+jwt`，绑定license/instance/database/jkt、generation/revision、旧epoch/水位摘要、新epoch、可信server_time、fresh nonce/digest和操作ID。仅该证据可在授权行锁下开启更高epoch，旧epoch水位保留审计，新epoch从签名server_time重新锚定；文件比较先epoch再水位，崩溃可按同reset操作幂等补写，旧文件不能压回新epoch。reset验签采用新nonce+受限单调往返时长（≤5秒）校验新鲜度，不使用已知错误的未来wall判exp；先修复NTP再执行。其不能改订阅end、清除撤销或单独允许经营，随后仍需同代/新revision有效lease。reset端点可通过challenge时间签名发起，不要求客户端先能通过错误wall的普通时间检查。time_epoch回滚/摘要不符拒绝，中心不可达时保持禁新，历史义务照常。此流程不修改原交易时间规则；全机时钟修复还需运维核对受影响付款/任务时序。

root可同时回滚DB、身份文件、水位和系统时间，也能修改程序跳过验证；完全离线无法证明真实时间或即时撤销。协议仅在未被篡改的发行与持久化状态假设下提供有限离线容错。异常断网重启且无法确认新锚点的场景不得承诺可信计时；已有可信水位/正常wall可继续剩余签名窗口，异常则禁新等待核对。不要宣称绝对防复制/绝对防时间回拨。

### 5.3 状态转换表

以下“允许历史”均仍受原认证、订单有效期、真实收款、库存、退款/采购冲突等业务约束。

| 当前/事件 | 结果状态 | 新经营 | 历史义务 |
| --- | --- | --- | --- |
| 无绑定有效lease；首次安装/激活失败 | unactivated | 拒绝 | 允许 |
| 有效签名绑定、当前generation/revision、now<allowed_until，中心最近成功 | active | 允许 | 允许 |
| 续签网络失败/中心5xx，可信lease未到allowed_until | offline_valid | 允许至原allowed_until | 允许 |
| now>=subscription_end | expired（优先于offline_expired） | 拒绝 | 允许 |
| lease_exp到达而subscription_end未到，无法取得新lease | offline_expired | 拒绝 | 允许 |
| 接受更高revision签名revoked回执 | revoked | 立即拒新 | 允许 |
| 接受签名superseded/current_generation更高 | superseded | 拒绝 | 允许；迁移期间运维还须防双执行 |
| 当前凭证损坏/不可信且无有效last-good | invalid_credential | 拒绝 | 允许 |
| 部署文件/私钥公钥/DB绑定不一致 | identity_mismatch | 拒绝 | 允许；缺实际业务key另报故障 |
| 发现时钟异常/水位回退 | clock_suspect | 拒绝 | 允许 |
| expired/offline_expired（仅lease exp到达、当前权益仍active）收到同generation/revision、iat更新的新有效lease | active | 本地提交后允许 | 允许 |
| revoked后收到同rev或更旧revision active lease | revoked | 拒绝 | 允许 |
| 中心显式恢复事件后收到更高revision、同activation generation的active lease | active | 本地提交后允许 | 允许 |
| superseded收到普通lease；无签名transfer/recovery回执 | superseded | 拒绝 | 允许；迁移期间运维还须防双执行 |

一次坏网络响应不得覆盖last-good；未过期last-good继续offline_valid。revoked/superseded/identity_mismatch/clock_suspect优先于普通时间状态；身份和时钟异常不能仅凭换token解除，先恢复绑定/校时再接受新lease。订阅续费由中心增加revision及截止时间；商城恢复时按当前签名权益处理，不能因revision变高本身拒绝。用户续费不能本地改 `subscription_end`，UI缓存也不能恢复权限。

## 6. 到期经营权限矩阵与最终事务

本表适用于所有不能新经营的授权状态；到期后仍可创建退款、提现和历史订单的下游记录，不能按“新增记录”一刀切。

| 实际操作 | 禁新状态下 | 原业务约束/权威位置 |
| --- | --- | --- |
| 新订单（legacy/v2、顾客/游客、零元、所有交付类型） | 禁止 | 最终createOrderTransaction中，先同owner/key/hash重放，再在INSERT前检查 |
| 新充值（新幂等键） | 禁止 | createTopUpAttempt最终事务，已有key返回后、新attempt INSERT前 |
| 同key同hash已提交订单/充值重放 | 允许 | 原结果；不同hash仍409，不改幂等key重新经营 |
| 原订单有效期内首次/后续外部、钱包、组合支付尝试 | 允许 | 原订单pending、原unpaid_expires_at、渠道、收据冲突保护不变 |
| 原支付尝试恢复、原充值重放/查单/对账 | 允许 | 原merchant_order_no/凭据版本，禁止新建充值替代未知结果 |
| 支付回调/收据/账本/退款 | 允许 | 验签、认证查单、on_time/late/excess规则、exactly-once不变 |
| 新提现申请/审核/unknown核实与解冻 | 允许 | 仅可提现cash、冻结/终态、凭据唯一规则不变 |
| 原订单人工/自动履约、供应商create/query/finalize/retry | 允许 | 仅原订单义务，保持原协议幂等/unknown/风险预算规则；不启用卡易信 |
| 历史内容、资料与文件下载（含Range/HEAD） | 允许 | owner、真实付款、冻结版本与文件摘要继续校验 |
| 超时关单/释放预留、文件诊断修复 | 允许 | 不强关资金未知订单；repair独立显式操作 |
| SSR目录/报价/购物车/填写草稿/登录后台/修复配置/补库存 | 允许 | 页面提示不可新下单，原权限和资源限额不变 |
| 新的批量订单/导入开单/手工加余额销售等未来入口 | 默认不得上线 | 必须先分类为新义务并接同事务gate；当前未发现此类生产写入口 |

v2购买附件轻量预检：现有认证与owner/idempotency lock → 先比较key/hash并返回已存在订单（不做授权拒绝）→ 校验报价/草稿 → 在昂贵的readVerified和归档复制前读取本地已验签projection及fresh DB时间作提示性准入检查 → 拒绝时不复制、不写prepared对象。此预检会与截止或撤销竞争，绝不是安全边界。最终订单事务仍在原幂等返回之后、orders INSERT之前重新锁授权projection并作权威检查；若预检后授权失效，沿用附件prepared清理与unknown-commit恢复规则，不删除可能已retained的对象。

调用示意：现有认证/owner锁 → 原幂等hash比较与返回 → 原业务校验/有序锁 → 最终事务 `assertNewObligationAllowed(trx, kind)` → 插入新义务及关联快照/预留 → 同事务commit。所有SQL可重试错误重试时重新检查。网络授权请求绝不能放在交易事务、advisory lock或钱包锁内。

新义务决策与状态更新在单例投影上串行。若交易先锁、采样时间有效，则授权更新等待其commit；更新先commit，则交易见新状态拒绝。**线性化点是最终事务内的fresh授权决策，不是中心真实撤销时间，也不是COMMIT时钟。**自然到期不自动取得DB锁：准入后短事务可能越过截止提交，这是明确允许的已准入事务边界。建议新准入后statement/transaction timeout≤5s、禁止后续外网IO；不能宣称“所有截止后commit均不可能”。⑦-1C必须测试等待跨期和更新竞争，长事务应失败重试并重验，而非拿事务开始时间放行。

稳定错误：HTTP403 `LICENSE_NEW_OBLIGATION_BLOCKED`，details仅含 `reason/allowedUntil/retryable`；reason如 `UNACTIVATED/EXPIRED/OFFLINE_WINDOW_EXHAUSTED/REVOKED/SUPERSEDED/INVALID_EVIDENCE/IDENTITY_MISMATCH/CLOCK_SUSPECT`。只有可能通过续签/校时恢复的本地状态标retryable；不是让客户端自动换key重试。DB/配置不可读返回503 `LICENSE_STATE_UNAVAILABLE`并拒新；历史接口仍用原错误体系，不重定向激活。网页隐藏按钮只是提示，直调API同样受最终gate约束。

## 7. 时序与迁移

### 7.1 首次激活

1. 安装器生成实例身份与秘密，迁移业务库并绑定；HTTPS setup一次性初始化管理员。
2. 管理员提交中心签发的短期activation code；API先加密持久化pending operation/code，再取challenge和签请求。
3. 中心事务锁license、校验订阅、code、nonce、无竞争激活，写activation/generation/operation/audit并签lease；提交后回复。
4. 商城先加密持久化原响应，再核对nonce/body摘要、签名、database_id、身份与水位，事务保存投影；读回确认后清理激活码密文，此时才允许新经营。
5. 中心提交但回复丢失：以新challenge续接原operation_id/intent_digest并恢复原结果。商城投影提交未知：读本地jti/operation_id后幂等补做，不创建第二激活。

### 7.2 周期续签、续费、离线

1. 内嵌任务先持久化稳定operation_id/intent_digest，按6h±10%抖动取challenge并renew；中心核对active代次与database_id，签最长7d且不越confirmed_end的lease。
2. 商城先加密持久化响应，再验签、在单例锁下比较generation/revision/iat/身份和已接受拒新事实，忽略乱序旧响应；投影、读回核对后清理pending。
3. 中心失败：按退避重试，last-good仍在窗口则offline_valid；到exp/end即时在新交易gate拒新，无需定时器先写状态。
4. 中心续费确认提升end/revision；商城接收新lease才恢复。断网不能根据本地续费截图放行，历史义务始终继续。

### 7.3 撤销与恢复

1. 中心管理员撤销事务提高revision、记原因，之后renew回签revoked。
2. 在线商城接受回执后立即本地拒新，已准入短事务按第6节边界结束；历史资金/履约不变。
3. 离线商城最多继续至最后签名exp/end；不保证中心撤销瞬间停止。无需强制webhook服务，轮询为基线。
4. 中心恢复需独立审计事件、提高revision；若涉及身份泄露则代次+1和换key。商城在线验证新lease后恢复，不允许重放旧active覆盖撤销。

### 7.4 改域名

保留实例、DB与key，先验证新DNS/HTTPS和支付商登记/回调路由，更新Caddy、PUBLIC_ORIGIN、Nuxt siteUrl；中心origin接口只更新元数据，不要求换license。迁移窗口保留旧支付notify/return入口重定向/转发方案，服务商签名与POST语义不可盲目301改变，旧回调必须能落同一业务库。旧域名能保留多久、支付商实际是否重试/允许回调改域名须在⑦-3/⑦-5验收；切域名不能让既有收款丢失。

### 7.5 正常迁移

1. 预拉目标发行，验证目标HTTPS与容量，旧环境保持业务数据源；登记迁移计划和目标持钥（通常仍保留原instance/key），此时不领取短期ticket。
2. 运维暂停所有旧写者/出站worker，记录未决操作，做完整一致备份；目标导入原DB/文件/key/binding但保持业务出站隔离。
3. 目标验证数据后，中心账号授权+受控迁移CLI用原身份持钥证明领取fresh ticket，随即目标签名commit；原服务停机不妨碍受控CLI签名。中心锁license原子递增generation，旧代次退休，发目标新lease；同instance/key仍以generation识别旧凭证。
4. 目标存投影、核对旧机器确已停止，再切DNS/回调、恢复原义务和新经营；旧机器不得再连业务库或供应商。
5. ticket过期可重新prepare（新operation、失效旧ticket，不升代、不重做已验证备份），中心不可达时不提交切换；已commit回复丢失先按原operation恢复，不能再prepare重复迁移。generation升级后不“回滚中心”，回切需再做迁移升代次。

中心围栏只能阻止旧代次**再次续签**，相同身份key的旧机器也不得在缺少中心转移授权时自动采纳更高代次lease；renew对代次不匹配返回superseded。完整复制并共同持钥的恶意root仍可能复制新lease，不能声称网络协议阻止root协作。停旧机是资金/履约单执行者要求，不是许可证本身能保证。

### 7.6 旧机损坏后的灾难迁移

中心账号强认证+人工核验许可归属、事故原因和expected_revision，撤旧activation、升generation，向目标身份签lease。完整备份可保留身份，身份丢失可新建key/instance；业务解密key丢失不能靠中心补发重建。联网核对原业务时间水位和pending事实后按原幂等号查单，先对账再重试，不能补建当前来源覆盖冻结快照。

正常transfer与灾备rebind均返回外层 `typ=aikayun-license-transfer+jwt` 的签名提交回执，含issuer/audience、iat/exp≤10m、operation_id、nonce/request_digest、license_id、原database_id、原instance/jkt/generation、目标instance/jkt/generation、expected_binding_revision、entitlement_revision及新lease。中心在首次激活登记database_id，后续要求一致；它不验证业务数据内容，不能把UUID声称成数据库真实性证明。目标必须先用本机运维恢复流程登记pending操作、目标key和旧binding修订，中心账号授权与目标持钥证明均通过后才可应用回执。普通lease不能解除identity_mismatch。

本地恢复接口草案 `applyActivationTransfer(trx, verifiedReceipt, pendingOperation)`：锁binding→授权投影→pending，匹配原database_id/修订/来源代次和目标jkt，保留database_id及全部业务UUID/AES key，升binding_revision并存新lease/回执。DB与文件不声称跨介质原子提交：先stage目标identity/私钥与恢复journal并fsync，DB事务置rebind_pending和新binding；commit后原子切文件指针，再最终事务置ready/消费pending。任一步强杀按operation_id和已存签名回执补写；在ready前始终禁新，历史义务按原业务key继续。DB rollback前的stage可按journal回收，DB commit未知先查revision/操作结果，不能反复升代次。恢复回执过期后未开始应用需重新在线查询已提交操作/新鲜外层回执，不重复迁移；已在本地提交的回执可用于完成文件恢复，不重新授予过期lease权限。

无法确认旧机死亡时提示明确的双执行风险：旧机离线仍可能持有效lease，旧机历史worker也不会因授权撤销停止。须隔离旧网络/卷、切换支付与供应商回调、必要时轮换外部凭据并保留旧凭据可查询能力，人工核对外部事实；这些动作需符合原支付/供应商恢复规则。即使中心只留一条active，物理旧机即时撤销仍不可保证。灾备许可恢复与外部资金单执行者防护是两层问题，不能相互代替。

## 8. ⑦-1B/⑦-1C边界

⑦-1B实现本协议的中心/本地身份、验签、证据投影、状态接口和续签；⑦-1C才将准入接入两个最终交易边界并完成旧义务回归。具体接口、测试矩阵、未来阶段运维门禁见[开发与验收](./release-license-acceptance-7-1a.md)。本阶段立即止于设计，不生成运行时stub、测试绕过或真实激活材料。
