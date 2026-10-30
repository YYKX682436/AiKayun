# ⑦-1B-3C-3A 原 activation operation 查询与安全续接

本阶段只修改商城仓库，冻结基线为 `8a1d6f29b68d34cdc649b3941d51789dba53eca9`。授权中心仓库 `/Users/muchen/Documents/ChatGPT/AiKayun-License` 保持只读，真实协议以提交 `6f554b51b867a15ad7747c6d002b548e016f65c6` 的源码为准。本阶段不创建独立 recovery operation，不修改中心协议。

## 冻结中心协议核对

中心 `src/app.ts` 的两个路由均要求 HTTP 200 `{ "operation_receipt": "<Compact JWS>" }` 成功封套。请求字段按中心 Fastify schema 精确限制：

- `POST /v1/operations/query`：`operation_id`、`intent_digest`、`attempt_no`、`license_id`、`database_id`、`instance_id`、`identity_jkt`、`public_jwk`、`challenge`。
- `POST /v1/operations/continue` activation：以上公共字段，加原 Pending payload 中的 `activation_code`、`origin` 和 `kind: "activation"`。

中心 `src/services/common.ts` 把 Challenge 绑定 operation 类型/ID、intent digest、安装身份、JKT 和 client nonce。HTTP 请求必须用相同持钥身份签名，RFC 9421 的 nonce 为 Challenge `server_nonce`，RFC 9530 digest 对应实际 body bytes；nonce 只能消费一次。商城对每一次 query/continue 重新请求并验证 Challenge，再构造签名请求。

中心 `queryOperation()` 与 `continueOperation()` 按其真实事务锁序对 operation 和 license 串行化。query 的签名 `not_found` 表示该次线性化查询未找到可见 operation，不能围栏仍可能到达的旧 activation 请求。continue 进入原 activation 处理与同一 operation 锁，最终只允许原 operation 产生一个终态；重放时返回中心持久化的原始 `response_jws`。operation receipt 同时绑定当前 query/continue 的请求元组，以及原始提交 attempt 的编号、nonce hash 和 request digest。

冻结中心对不存在该 actor activation 的 license 会在 `queryOperation()` 的关联身份检查处先返回签名 `not_found`，此时可能尚未读取一个已拒绝的 activation operation。客户端因此检查全部本地历史；本地若有仍有效、完整绑定的中心签名 rejection，会返回这个已验证事实并停止，而不会把 query 的 `not_found` 当成新结论。若历史 rejection 已过验签时限，客户端不推断终态，并保持 fail closed。

冻结中心 `processActivation()` 对不存在、过期或已消费 activation code 可在写入 operation/attempt 之前返回未签名 HTTP 403。这个结果不具备安全终结原 operation 的证据。商城把 continue attempt 记为 `transport_unknown`，返回内部诊断 `requires_protocol_resolution`，保留 Pending 与活动唯一绑定。

## 唯一 operation、共享 attempt 与发送顺序

内部入口位于 `apps/api/src/licensing/license-operation-recovery-client.ts`：

- `queryPendingActivation(operationId)`：只执行一次有界 query。
- `continuePendingActivation(operationId)`：先 query 一次；仅收到完整验证的签名 `not_found` 后，才对同 operation 执行一次 continue。
- `recoverPendingActivation(operationId)`：`continuePendingActivation()` 的显式调用别名，不启动后台任务或循环。

它只接受已有 3C-1 `local_license_operations` activation 及 `local_license_operation_attempts` 历史。原始 `operation_id`、`intent_digest`、license/database/instance/JKT、AES-GCM Pending activation code 和 origin 全程不变。它不会创建第二个 operation、改业务意图、重调 `/v1/activations` 或释放 3C-1 活动唯一索引。

同一 operation 的恢复通过 PostgreSQL session advisory lock 跨越 HTTPS 请求串行化；该锁不放在 SQL 事务中。拿锁后先解密、校验父 operation、原业务 payload、完整且连续的 attempt、AES-GCM envelope、每次原请求 body 和 RFC 9421/RFC 9530 签名。接着从中心获取新的 Challenge、可信时间和 Trust Bundle 验证结果，再由现有 attempt 分配事务一次性提交新 request envelope 与证据。只有事务提交成功，发送状态才推进为 `sent` 并通过固定 HTTPS origin 发请求。提交确认未知时不发送，保留可能已提交的 `prepared` attempt；重启从下一个 attempt 编号和新 Challenge 继续。

query/continue 与原 activation 共用严格连续的 `attempt_no`。每一请求有独立 Challenge、随机 client/server nonce、签名时间、RFC 9421 签名和 RFC 9530 digest。收到 200 后，先将原始 Compact JWS ASCII bytes 按当前 attempt 的 AES-GCM AAD 加密提交，读回并核对持久化 bytes，再验签。普通 HTTP 错误、响应超时、断线、5xx、429、未知 kid 或验签/绑定失败都不能改写为业务终态。

## 双层回执绑定与原始结果

外层 `aikayun-license-operation+jwt` 必须经当前可信时间、当前 Trust Bundle resolver 验证精确 `typ`、issuer、audience、kid、签名、claim allowlist 和五分钟时限。其 `sub/license_id`、actor JKT、operation ID、intent digest、当前 attempt 编号、当前请求 nonce hash 和当前 request digest 必须匹配本次本地持久 attempt。

若外层回执是终态，还要独立核对 `committed_attempt_no`、`committed_request_nonce_hash`、`committed_request_digest` 对应本地真实存在的 activation/continue attempt，且该 attempt 不可能是尚未发送或本地发送前已失败。承诺提交的结果必须与原 attempt 已归档响应，或旧中心回执中的 `result_jws` 逐字节相同；原结果内容不会由商城重签或改写。signed `not_found` 必须明确没有 committed tuple 和 `result_jws`，否则拒绝。

`result_jws` 另行存入其原提交 attempt 的 `encrypted_result_jws`，使用 Pending AES-GCM 的 `center_result_jws` AAD 和独立 digest；query 回执仍保存在 query 自己的 response 栏。已有原始 activation 响应与新 query 回执永不相互覆盖。父操作 `response_attempt_no` 只指向最近保存的 HTTP 响应，不代表业务终态；恢复逻辑读取并验证完整 attempt 历史。

当前有效 lease 只有再次通过 current lease verifier 才会标记为 `current_lease`。过期 lease 只作为历史事实，返回 `historical_only`；若旧签名 key 已过正常验签保留期限，当前有效的中心 operation receipt 对其原始 `result_jws` 的精确绑定只证明历史提交，不将旧 lease 当作经营凭证。恢复接口的证据类型没有 `allow`、`grants` 或投影字段，并始终 `projected: false`。

rejected/cancelled 只有完整验证并绑定的中心签名终态证据才可对外作为操作事实。直接 activation rejection 回执必须绑定原 activation attempt；历史响应超出正常验签时限时不会仅凭 JWS 外观断言终态。恢复流程不更新父 operation 的 terminal/cancelled/projected 状态、不删除激活码、不增加 generation、不清理 Pending，也不授予经营许可。

## 状态机与失败边界

```text
已有 pending 或 response_saved activation
                │
                ├─ preflight 全部本地历史；获得同 operation 恢复锁
                ├─ fresh query Challenge + query attempt 持久化后发送一次
                │
                ├─ committed/rejected/cancelled 且双层绑定有效 → 仅返回已验证历史事实
                ├─ not_found 且无矛盾的已验证终态历史 → 新 Challenge + continue attempt 一次
                │                                             └─ 返回已验证事实或保留未知
                └─ 超时/断线/5xx/429/未签名错误/验签失败 → 未知；等待后可显式再查
```

continue 只解决 query 线性化之后可能仍在途的原 activation 与原 operation 竞争；它不构成激活码错误的绕过。每次 API 调用最多一个 query，及可选一个 continue；没有无限自动循环、后台 worker 或定时器。所有新请求使用新的 Challenge 与 attempt，绝不重发崩溃前的 activation envelope。

`requires_protocol_resolution` 是已知边界：中心未对无效、过期或已消费激活码提供可验证的终态 403 时，商城无法证明 operation 终结。操作、业务意图和激活码占位保持原样；not_found 不转成 terminal，不删唯一索引，不创建新 operation。后续中心最小协议修订建议：在同 operation 锁内，把确定性 code rejection 作为 `rejected` operation、`terminal_reject` attempt 与原始签名结果原子提交；query 对已经绑定的 actor/operation 在无 active activation 时也应能返回该终态。临时/基础设施错误仍应可由新 Challenge 续接。

## 修改与限制

- 新迁移 `202610300003_license_operation_result_archive` 只允许向原 attempt 一次追加加密中心 result JWS；原 request、HTTP response 和已有 result 均不可变。
- challenge/activation transport、RFC 9421/RFC 9530、可信时间、Trust Bundle、TLS 校验和 3A 私钥仍复用 3C-2A/2B 实现。
- 不提供公开 API 路由、管理 UI、自动续签、3D 权益投影、经营门禁、后台重试、生产密钥或部署。
- 授权中心源代码、数据库结构和协议均没有改动。
- 订单、支付、退款、提现、自动履约、采购与既有 worker 行为不在本阶段改动。

完成 3C-3A 后停止，等待独立严格验收；不进入 3C-3B。

## R1：持锁资源隔离与归档恢复校验

恢复锁使用独立 PostgreSQL session，继承业务池的数据库连接配置，保留原 advisory lock 键。同一进程最多持有四条恢复锁连接；连接建立与锁等待有上限，每次调用结束关闭连接，不归还业务连接池。取得锁后在发送前、收到响应后及返回前确认 session 可用，并核对解锁结果。锁状态不可确认时失败关闭；已发出的 HTTPS 请求可能仍到达中心，其 attempt 保持未知，后续通过同一 operation 查询及中心锁解决竞争。

持锁连接需要直连 PostgreSQL 或使用保持 session 的代理；transaction pooling 不能提供跨请求的 session advisory lock 语义。

v5 配对恢复的 test-only 预检逐条读取 result JWS，复用原有 Pending AES-GCM 解密、AAD、key ID 和摘要校验。迁移 `202610300004_license_result_archive_presence` 回填已有归档的单调存在标记；写入归档与标记在同一事务中完成，约束及触发器禁止不一致和标记回退。旧记录没有归档仍可恢复，标记存在而归档字段缺失则拒绝恢复。v5 文件校验和继续保护数据库备份及配对密钥文件；如果数据库中归档和存在标记等所有独立证据同时被抹除，且没有其他可信证据，无法与合法旧记录区分。
