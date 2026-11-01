# ⑦-1B-3D-2 可信时间与本地授权状态

商城冻结基线：`0b8ce2881e843616aa776d0a8f2c8802a4936621`。授权中心只读基线：`a5cf99439e3bf92b65f19d60c013bca088cf221a`。

本阶段沿用 [3D-1 投影](./license-client-7-1b-3d-1.md)、⑦-1A 协议及现有 Trust Store、签名 time anchor、安装身份和 PostgreSQL；不接入经营门禁。

## 持久时间水位

- 增量迁移 `202611010001_trusted_license_time_watermark` 只在现有 `instance_license_state` 单例行增加 `trusted_time_high_water_ms`，并由 PostgreSQL trigger 拒绝清空或降低该列。没有新增表。
- 复用现有 `license_pending_key` 私有卷，新增 `license-time-watermark.json`。文件绑定 `database_id`、`instance_id` 和 `identity_jkt`，保存毫秒水位；原子临时文件、文件 `fsync`、`rename`、目录 `fsync` 后才更新数据库列并提交事务。
- `installation_binding` 和 `instance_license_state` 按原顺序加行锁。该 DB 行锁同时串行化共享私有卷的多进程文件写入。文件先于 DB；因此 SQL 回滚、未知 COMMIT 或进程强杀最多留下文件领先，恢复时取最大值补高 DB。DB 领先文件无法由规定写入顺序解释，拒绝并进入 `clock_suspect`。
- 可信当前值取 PostgreSQL `clock_timestamp()`、DB/文件既有水位和当前进程内 nonce 绑定签名锚加单调流逝时间的最大值。时间只前进；超过 60 秒的 DB/签名锚冲突、显著回拨、文件损坏/身份不符、授权状态下水位缺失均拒绝新经营判断。30 秒小回拨沿用既有水位。
- R1 起，真正的空白首次未激活状态不会仅用 DB `clock_timestamp()` 建立水位；第一次正式授权投影以已验证的中心签名 time anchor 核对 PostgreSQL 时间后建立水位。现存授权若在迁移后没有配对水位文件，则返回 `clock_suspect`，不从 lease 的 `iat` 静默重建。时间 reset 不在本轮实现。
- 现有 v5 备份把整个 `license_pending_key` 卷作为配对成员打包；`license-pending-restore-check` 在已有授权或水位时校验恢复文件、身份及 DB/文件方向关系。缺失或损坏的活跃授权水位不能通过恢复检查。

## 本地快照

`createLicenseStateProjectionClient(...).getLicenseSnapshot()` 是仅供内部调用的无网络入口。它读取身份绑定、单例投影、AES-GCM 密文、原始 JWS、相关 operation/attempt 来源及 Trust Store；只读取该投影引用的来源历史，不扫描全部 operation。它重新验证来源绑定、lease/status JWS、当前 signer 生命周期和身份，不信任数据库布尔标志。

返回字段为状态、脱敏原因、`allowedUntil`、`nextRenewalAt`、generation/revision 和 `canCreateOrder` / `canCreateTopUp`。截止值是 `min(lease.exp, subscription_end)` 的 UTC 半开区间；没有当前有效 lease 时两项许可都为 false。没有第二份 active/expired 持久字段。

`active` 与 `offline_valid` 都只在签名 lease 的窗口内给出两项内部许可。`offline_valid` 仅在当前进程实际观测到配置中心的 HTTPS 网络失败或 5xx 后使用；快照本身不探网，单纯离线/重启不会被当作失败事实。lease 到期后严格拒绝；订阅已到期返回 `expired`，lease 到期且已有中心网络失败事实返回 `offline_expired`。

已接受的 revoked/superseded 证据优先于 lease。revoked 只有更高 entitlement revision、同 generation 的有效 lease 才能解除；superseded 不接受普通 lease 解除。错误凭证、身份不符和 Trust Store/signer 无法验证均 fail closed。

## R1：首次未激活状态不使用裸 DB 时钟建立水位

在 R1 基线 `6a6966a16072e86c5a99be34a886b767518b3767` 的冻结中心/PostgreSQL 18 复现中，新安装的单例授权行、DB 水位和私有卷水位文件均为空。隔离测试把 `clock_timestamp()` 观测值模拟为当前时间 +24 小时，`getLicenseSnapshot()` 仍返回 `unactivated`，同时原代码将 DB 列与文件写到该未来值。恢复时钟后，空状态快照变为 `clock_suspect/clock_rollback`；中心仍可按原 operation 签发 generation 1 lease，但本地投影因 `license_clock_suspect_clock_rollback` 拒绝，operation 留在 `response_saved`。这确认了空授权读取会把未核实 DB 时间变成永久水位并阻断首次激活。

最小修复：在原锁序下，只有许可证/lease/refusal 均为空、DB 水位为空且水位文件确实缺失时，快照直接返回 `unactivated`，不读取/持久化裸 DB 时钟。会先校验既有 pending key 和文件根目录；若找到有效孤立文件、损坏文件、DB 水位或任何授权/拒新历史，则继续走原有严格水位检查并 fail closed，不把它们当成新安装。

首次正式水位仍由 `projectPersistedOperation()` 建立：该入口先获取并验证现有中心 nonce 绑定签名 time anchor，再与 PostgreSQL 时钟核对；偏差超 60 秒时不写水位。离线快照没有新增网络请求。NTP 修复后，原 activation operation 可继续投影，generation 保持 1，重复投影幂等。

## 剩余限制

- 同一台受信主机以当前 DB 时钟恢复旧配对备份时，当前 DB 时间高于旧水位，快照会向前推进水位；DB 与卷单独恢复的不一致也会拒绝或向前修复。若 root 同时回滚数据库、时间水位文件和系统/DB 时钟，则完全离线无法识别这份一致旧副本。⑦-1A §5.2 已明确记录这一信任边界：[协议源码](./license-protocol-7-1a.md#52-时间规则)。本轮不新增外部单调存储或管理 reset 服务，因此不能宣称抵御这种协同回滚。
- 3D-1 已存在的授权状态在没有新水位文件时会 fail closed；需要后续受审时间恢复流程处理，普通续签和 NTP 修复不能降低水位。
- `getLicenseSnapshot()` 及两项许可结果不是 ⑦-1C 最终数据库事务中的权威门禁。没有新增续签 Worker、公开 API、管理 UI、订单/充值代码或正式部署配置。

## 验证

完整冻结中心/PostgreSQL 18 互操作及恢复回归：96/96 项通过。包含 R1 原时钟错误复现与修复回归、3D-1/R2 来源恢复、双进程快照、隔离 PG 时钟下半开 lease 边界和旧配对水位恢复、提前 subscription_end、网络失败事实、撤销/恢复/吊销 signer、水位文件损坏/缺失/冲突、未知 COMMIT、SIGKILL 和 v5 配对恢复。首次整套运行中一个既有 SIGKILL/未知 COMMIT 用例遇到中心 503；该用例单独重跑 1/1 通过，随后全套重跑 96/96 通过。

最终完整 `pnpm verify` 退出码 0：lint 0 error（保留 7 条商品详情页既有 Vue warning）；合同/API/Web 类型检查及生产构建通过；money 16/16；API/PostgreSQL 35 个文件 544 passed、83 skipped；Playwright 主套件 93/93、alternate-brand 1/1、SSR errors 3/3、dev-preview 1/1、production-brand 1/1。API 套件内未启动授权中心的测试另由上列冻结中心互操作覆盖。
