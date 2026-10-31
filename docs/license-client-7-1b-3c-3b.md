# ⑦-1B-3C-3B 当前有效凭证恢复

商城实现基于冻结基线 `8addb5046faccf0868f9914e072f64ce948b823f`。授权中心保持只读，协议与互操作固定到 `a5cf99439e3bf92b65f19d60c013bca088cf221a`。

## 恢复顺序

内部入口是 `createLicenseOperationRecoveryClient(...).recoverCurrentLease(activationOperationId)`，没有新增商城 HTTP 路由或 UI。

1. 复用 3C-3A 的 `/v1/operations/query`，只有签名、当前可信时间及历史 attempt 绑定均验证通过的 `committed` 事实才可继续。query 签名 `not_found` 时，最多对同一原 activation operation 使用既有 `/v1/operations/continue`。拒绝、取消、最终 `not_found`、历史冲突或状态未知都不会创建 recovery operation。
2. 原提交的 `result_jws` 以 AES-GCM 归档并核对摘要、原 activation attempt、nonce、请求摘要及安装身份。原 lease 仅用于提取被中心提交事实绑定的 generation 和历史 revision；过期、已退休或吊销 signer 的 lease 不作为当前经营凭证。
3. 商城在现有 `local_license_operations` 表创建 `kind=recovery` 的新 operation ID。意图摘要逐字段匹配中心 `renewalIntentDigest(kind='recovery')`，绑定原 activation ID、原 generation、历史 revision、license、database、instance 和 JKT。恢复意图 metadata 使用现有 Pending AES-GCM 加密。
4. 第一次提交使用 `/v1/leases/renew`。若响应未知，使用同一持久 recovery operation ID 调用 `/v1/operations/query`，只有签名 `not_found` 才能在中心 operation 锁下用 `/v1/operations/continue` 续接。重试和并发调用扫描并复用原 recovery 记录。
5. 每次请求沿用现有可信时间、Trust Store、签名身份、RFC 9421/RFC 9530 HTTPS、PG operation/advisory lock、递增 attempt、AES-GCM request/response/result 归档。新 lease 必须用当前信任包验签，并匹配当前安装身份、原 generation、当前请求 nonce/digest 与原 recovery intent；当前 revision 可以高于历史 `known_revision`。

中心返回的 `expired`、`revoked`、`superseded` 或签名拒绝会验签、加密归档并作为未投影证据返回，不会被当作 lease 成功。网络错误、未签名错误、错误签名、过期 lease、身份或历史绑定错误均不产生当前凭证。

## 持久化与边界

- 新迁移 `202610310002_license_operation_recovery_attempts` 只扩展现有 attempt purpose/check 与不可变结果归档触发器，允许 recovery mutation。未新增授权表、迁移状态机或安全基础设施。
- 新 operation 的加密 intent payload 保存原 operation ID、generation 和历史 revision；外层 operation intent 不可变。创建过程以原 activation ID 持有现有 PostgreSQL 锁，未知 COMMIT 后重入会找到已提交 recovery operation。
- v5 配对备份校验现在可重建并检查 recovery intent 和 recovery/query/continue attempts；恢复过程仍只写本地操作证据。
- 返回值没有 `allow` 或 `grants`，始终 `projected: false`。本阶段不写权益投影、不开放经营门禁、不改订单或支付权限，也不修改授权中心。
