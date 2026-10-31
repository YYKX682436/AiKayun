# ⑦-1B-2D-2 可信拒绝结案与重新激活

**商城基线：** `c3a6bc06212ae916611e29017db8c8d6d5215556`
**冻结授权中心：** `a5cf99439e3bf92b65f19d60c013bca088cf221a`
**日期：** 2026-10-31

本阶段只修改商城仓库。复用 `local_license_operations` 已有的 `terminal`、`encrypted_center_evidence`、`center_evidence_digest` 和 `finalized_at`；不增加数据表或字段，不修改授权中心。终态只表示激活 operation 已被可信拒绝结案，不写入权益、不开放经营权限。

## R3 无持久化拒绝的受限例外

冻结 R3 的 `ACTIVATION_AUTHORIZATION_INVALID` 可在中心持久化 operation/attempt 前返回签名拒绝：直接 activation 使用 HTTP 409，continue 使用 HTTP 200。商城只对这一精确 outcome 接受空 committed tuple，且证据必须重新从已加密保存的原始 JWS 验签，并严格绑定原 operation、intent、actor、当前 activation/continue attempt、nonce hash 和 request digest。HTTP 状态、调用方的 `signatureVerified` 标记、普通错误或 `not_found` 都不构成结案依据。其他无 committed tuple 的 rejected outcome 一律拒绝。

对中心持久化业务拒绝，继续要求外层 operation receipt、committed attempt tuple 和内层 `result_jws` 的双层提交证据校验。成功激活的 operation、已归档 lease、任意 committed 结果或矛盾历史都会阻断拒绝结案。

R3 旧拒绝回执超过五分钟后，客户端仅可为识别历史而用当前受信 resolver 重新验签；忽略的只有有效期，其签名、发行者、格式、R3 outcome、原请求绑定及空 committed tuple 仍须成立。若随后中心返回签名 `not_found`，且全历史无 committed 结果、已归档业务结果或矛盾回执，客户端继续使用原 operation、原 intent 和新 Challenge 请求新的拒绝回执。`not_found` 本身绝不结案。

## 持久化及状态保护

新增迁移 `202610310001_license_operation_trusted_rejection` 只允许 activation 的 `response_saved → terminal` 转换，并保留 response attempt 指针、摘要及时间。attempt 请求与结果归档仍不可变；终态父 operation 与 attempts 都不可再更改。原 response bytes 完成加密归档后，应用在 PostgreSQL 事务中锁定 operation，复核当前安装身份和全部持久化请求/响应历史，重新验签结案 JWS，并原子提交终态、证据密文、摘要与结案时间。

重复相同证据结案幂等。不同证据、错误身份/intent/attempt/nonce/digest、伪造或过期签名、历史 committed 冲突及数据库异常都不能解除 Pending。COMMIT 确认未知时只读取原 operation 并比对已存终态证据；不会另建 operation。终态排除现有 activation 部分唯一索引，故正确码可创建新 operation，同时旧 operation 与全部 attempt 历史永久保留。

## 验收记录

| 验收 | 结果 |
| --- | --- |
| 冻结 R3 HTTPS/PostgreSQL 互操作 | 36/36 通过，0 失败；固定中心 SHA 为 `a5cf99439e3bf92b65f19d60c013bca088cf221a`。覆盖错误、过期、撤销、已消费、跨 license 五类 activation code；直接 409 与 continue 200 拒绝；丢失拒绝响应；旧拒绝过期后 query `not_found` 并以原 operation 新 Challenge 续接；原 activation 与 continue 竞争及迟到拒绝响应；两个独立进程竞争、重复结案、伪造/错绑回执、历史 committed 冲突及未知 COMMIT 确认。 |
| 终态事务故障 | 真实 SIGKILL 覆盖 terminal UPDATE 后、COMMIT 前，以及 COMMIT 后；前者重启后仍可从原拒绝证据恢复，后者读回相同终态证据。注入 COMMIT 确认丢失后只读原 operation 并匹配密文/摘要。 |
| v5 配对备份恢复 | `node scripts/verify-digital-recovery.mjs` 通过。测试配对备份恢复后解密并逐字节核对 terminal center evidence，校验原 operation 仍为 terminal，且可创建新 activation operation。隔离 API 与 PostgreSQL 容器 SIGKILL/重建、业务文件、安装身份、Trust Store 和既有恢复校验通过。恢复夹具签名由一次性测试密钥产生，只验证存储配对连续性；真实中心签名验证由上述 HTTPS 互操作覆盖。 |
| 完整 `pnpm verify` | 通过。lint 0 errors（7 条既有 Vue 格式 warning）；money 16 passed；API 539 passed、35 skipped；生产构建通过；主 Playwright 93 passed，备用品牌 1、SSR 3、开发预览 1、生产品牌 1 passed。 |
| 生产环境 | 未连接或修改；迁移未应用到生产。授权中心源码、数据库和密钥均未修改。 |

## 范围边界与剩余事项

此实现不包含成功权益投影、3C-3B、3D、管理 UI、自动续签或订单门禁。冻结中心 R3 无持久化拒绝例外仅适用于当前已验证的 `ACTIVATION_AUTHORIZATION_INVALID` 回执形状；任何其他新 outcome 或协议差异继续 fail closed，需另行审核后才能支持。
