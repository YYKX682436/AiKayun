# ⑦-1B-3C-1 商城授权操作持久化与加密 Pending 基础

本阶段在商城 PostgreSQL 建立授权操作唯一业务权威，并为激活意图、逐次请求封套和原始响应建立独立加密存储与崩溃恢复基础。商城冻结基线为 `b18806b73f2e30c5548d59b56cb48d8c68c4a273`；授权中心只读基线为 `6f554b51b867a15ad7747c6d002b548e016f65c6`。本阶段没有真实激活请求，也没有经营授权门禁。

## 唯一操作权威与表结构

前向迁移 `202610300001_local_license_operations` 新建 `local_license_operations` 和 `local_license_operation_attempts`。父表是商城本地唯一操作权威，保存 `operation_id`、kind、不可变 `intent_digest`、license/database/instance/JKT 绑定、schema/key ID、加密业务 payload 和操作状态。当前代码只构建 activation kind；其他 kind 仅有显式 schema 名称，不提供相应的迁移操作流程。

`operation_id` 创建后不能更新或复用：主键固定，父子记录禁止 `DELETE`，两表禁止 `TRUNCATE`，operation ID、kind、绑定、意图摘要、加密 payload 和创建时间受触发器保护。激活操作的活动唯一索引以 `(database_id, instance_id)` 防止另一 operation 抢占同一安装。创建时先用 `pg_advisory_xact_lock(hashtextextended(operation_id, 0))` 串行化相同 operation ID，再锁定 `installation_binding` 行确认 ready 身份；并发唯一冲突 fail closed。

子表按 `(operation_id, attempt_no)` 保存 append-only 证据：attempt 用途、client/request nonce 的 SHA-256 摘要、原始 HTTP body 字节摘要、身份 JKT、签名 key ID、签名时间、加密请求封套以及发送结果状态。触发器锁父行并要求 `attempt_no = MAX(attempt_no) + 1`；应用层在事务内先获取同一 operation advisory lock 和父行 `FOR UPDATE` 后再分配。因而 activation、未来 query 和 continue 共用一个严格递增序列；并发进程不能分配重复编号或跳号。中心当前约束 `(operation_id, attempt_no)` 唯一并拒绝重复编号；商城本地负责更强的连续分配。nonce 摘要也有全表唯一约束。

请求封套保存 HTTP method、path、headers 和原始 body 的 Base64URL 表示，整体由 Pending 密钥加密；独立 `request_body_digest` 对封套还原出的原始 body 字节复核。attempt 分配器先持有 operation 锁并算出下一个编号，再调用同步 `buildRequest(attemptNo)` 构造/签名请求，验证 body 中的 operation、intent、attempt、安装身份、activation payload、签名 JKT 与路径，最后在同一事务提交封套。这个 builder 不执行网络 I/O；只有分配器成功返回后，下一阶段才可以发送已提交的 envelope。幂等恢复遇到已提交 nonce 时返回原加密封套解密后的相同 bytes，不重新签名或重复分配。当前没有任何 HTTP sender，且没有 RFC 9421 请求实现。

## 中心兼容的 activation intent 摘要

商城采用锁定的 `canonicalize@5.1.0` JCS，实现和中心 `activationIntentDigest()` 逐字段一致的对象：

```json
{
  "v": 1,
  "kind": "activation",
  "license_id": "…",
  "activation_code_sha256": "…",
  "instance_id": "…",
  "database_id": "…",
  "identity_jkt": "…",
  "origin": "…"
}
```

`activation_code_sha256` 是规范 32 字节 Base64URL 激活码文本的 SHA-256 Base64URL 摘要；明文激活码不进入摘要，也不在 `intent_digest` 中增加 `operation_id` 等中心协议没有的字段。跨仓固定向量位于 `apps/api/test/fixtures/activation-intent-7-1b-3c-1.json`，注明中心提交和来源函数。向量使用合成测试码，不是实际授权凭据。

## Pending AES-256-GCM 密钥与秘密载荷

Pending 密钥只服务于授权操作 API，固定为独立 32 字节 AES-256-GCM key。默认根目录是 `$XDG_DATA_HOME/aikayun/license-pending`，生产 Compose 使用专属 `license_pending_key` 卷，API 容器不把密钥复制进镜像。受控目录 owner 为 API 用户、权限 `0700`；`license-pending-aes-256-gcm.json` 是普通单硬链接文件，owner 为 API 用户、权限 `0600`。加载时拒绝 symlink、hardlink、owner/mode 错误、文件替换、缺失及损坏。目录与支付密钥环、卡密交付密钥、3A Ed25519 私钥和 3B TrustStore 完全独立。

文件有 schema、purpose 和显式 key ID。AES-GCM 密文包包含算法、key ID、随机 96-bit nonce、tag 和 ciphertext；AAD 绑定协议版本、record 类型、operation ID、attempt 编号（attempt 记录）、字段用途和 key ID。激活码及 origin、原始请求封套（包括签名头）、中心原始签名响应均使用相应 AAD 加密。数据库只保存密文和非秘密摘要。加解密失败、key ID 不匹配、key 丢失或密文/AAD 校验失败时，操作记录保留，读取失败关闭；没有“当作未发送”、清除或换钥重建路径。

普通启动和 key 加载不会创建 key。只有显式 `license-pending-key:init` 命令可创建一次性临时 key，必须给出 `--temporary`、`--environment development|test` 和隔离目录；test 还要求 `_test` 数据库。命令不会覆盖已有 key。该命令不接受 production；生产秘密由未来受控安装器初始化，不由镜像或默认启动创建。

## Attempt 与状态权限

| 当前状态 | 含义 | 本阶段允许的变化 |
| --- | --- | --- |
| `pending` | 操作意图已落库；可追加 prepared、发送证据或传输未知结果的 attempt | 首次保存原始响应后到 `response_saved` |
| `response_saved` | 至少一个加密原始响应与其 attempt、digest 已在同一数据库事务提交；尚未验证为中心权威证据 | 可继续追加共用序列的 query/continue attempt；若再收到响应，父表最新响应指针只能单调前进 |
| `projected` | 为后续 3D 保留的状态 | 本阶段不可写入 |
| `terminal` / `cancelled` | 需要后续中心权威证据的最终状态 | 本阶段不可写入，也不会由本地错误或 HTTP 超时产生 |

父表触发器只允许从 `pending` 到 `response_saved`，之后只允许在 `response_saved` 内用更高 attempt 编号推进最新响应指针；每次指针都必须匹配已保存响应 attempt 的摘要和时间。响应 attempt 与父指针由可延迟约束触发器要求在同一个事务提交。activation attempt 不能在保存响应后重发；恢复只能追加 query/continue。终态复活、终态/投影伪造、意图/attempt 修改和历史删除均由数据库拒绝。单纯 `response_saved` 不代表签名验证、lease、经营权限或本地投影。

## 崩溃恢复边界

PostgreSQL 提交使用其 WAL 持久性，本阶段不再对数据库复制一套文件 journal。数据库事务提交前强杀不会留下半条 operation/attempt；提交后强杀可按相同 operation 与不可变请求输入重读已提交记录。签名响应与 operation 的 `response_saved` 标记原子提交。恢复读取会解密并复核 payload intent digest、请求封套 body digest 和保存响应；若 key 缺失/替换、AAD 错误或密文损坏，pending 数据仍保留，恢复失败关闭。

这不涵盖跨数据库与外部副作用的事务。后续真正发请求时，必须先提交操作和 prepared attempt，再发网络；崩溃后根据持久 attempt 和后续中心权威回执恢复，不能推断超时即失败。当前不发送请求，因此没有声称真实中心恢复验收。

## 配对备份 v5 与限制

`backup-compose-data.sh` 格式明确升级为 `aikayun-compose-backup-v5`，静止窗口配对 PostgreSQL、媒体、私有交付文件、3A identity、3B TrustStore 和 Pending key。清单保存 key ID 和 key 的 SHA-256 指纹用于成员配对，归档另有 SHA256SUMS；指纹不是加密或密钥托管。`restore-test-compose-data.sh` 拒绝 v4、缺少 key、key/清单不匹配、非 `_test` 数据库及非项目专属卷；恢复后、API 服务启动前执行 test-only verifier 解密并核验所有 activation payload、attempt envelope 和已保存响应。

此开发备份包含实例私钥及解密 Pending 数据所需的密钥，**不是可直接用于生产的安全备份**。当前没有商业级备份加密、密钥托管或异地密钥分离。本阶段不能把 v5 SHA-256 校验描述为机密性保护；正式备份加密与密钥托管必须作为发行门禁。恢复验收必须使用全新隔离 Compose 项目和 `_test` 数据库，不接触现有商城实例。

## 下一阶段接口边界

3C-2 可在本地 operation 已创建且 activation attempt 已提交之后接入 challenge/持钥签名与中心请求。可复用 `createOrLoadActivationOperation()`、`allocateLicenseOperationAttempt()`、`markLicenseOperationAttemptSent()`、`markLicenseOperationAttemptTransportResult()`、`saveLicenseOperationResponse()` 及恢复读取函数。调用者必须原样使用加密封套保存的请求 bytes，并将响应原始 bytes 在验证/投影前加密保存。3C-2 应对照中心冻结协议再次核验 nonce、body digest、attempt、终态与回执绑定，不可把本地响应保存当作权威成功。3C-2/3C-3/3D、续签 worker、业务 UI 和经营门禁均不属于本阶段。

现有订单、充值、支付、退款、提现、库存、数字交付和 worker 的代码路径没有接入本地授权操作状态。
