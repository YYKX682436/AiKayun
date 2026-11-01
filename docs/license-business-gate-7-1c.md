# ⑦-1C：经营授权门禁

商城基线：`cdde6bb1b052c06e6ab6e33ec733ae078bb90cac`；授权中心只读基线：`a5cf99439e3bf92b65f19d60c013bca088cf221a`。

## 门禁边界

- 唯一事务准入函数为 `assertNewObligationAllowed(trx, 'create_order' | 'create_top_up')`。它复用 3D/3E 的身份检查、JWS 验签、授权投影、Trust Store 和可信时间水位，并在原业务锁之后按 `installation_binding → instance_license_state` 加锁。
- 订单在订单插入前检查；v2 在附件归档前做提示性预检，并在最终订单事务内复查。充值在顾客与钱包锁、同键重放后，attempt、secret 和 provider state 插入前检查。业务事务中不访问授权中心或支付服务商。
- 同键同请求的历史订单或充值先回放，同键不同请求保持原 409。付款、退款、提现、交付、下载、查询和超时修复不增加拒新门禁。
- 授权状态无法确认返回 503 `LICENSE_STATE_UNAVAILABLE`；确认未激活、过期、撤销、被替代或时钟异常返回 403 `LICENSE_NEW_OBLIGATION_BLOCKED`。响应仅含状态、截止时间和可重试标记。
- 前台结算和钱包显示简短中文停购提示；后台管理概览提供管理员认证后的只读诊断。历史付款与充值恢复入口继续可用。

## Trust Store 与数据库串行化

只靠目录文件锁无法保护未知 COMMIT：API 在 COMMIT 阶段被强杀时，PostgreSQL 后端可能仍在提交，文件锁却已经释放。因此，授权状态表新增 Trust Store 摘要和待处理更新字段。

接受新的 root 签名信任包分两步进行。先在 `installation_binding → instance_license_state` 锁序下持久化待处理包及其摘要并提交；门禁看到待处理状态就拒绝新经营。随后再次取得相同数据库锁，获取 PostgreSQL advisory 锁，再写入 Trust Store 文件、更新已接受摘要并清除待处理标记。网络时间锚在进入这些事务前取得，事务内没有 HTTP。若强杀或未知提交发生在文件写入期间，数据库后端持有的行锁会使其他门禁等待；提交完成后，门禁看到新摘要，回滚后看到待处理标记，两种情况都不会按旧状态放行。

已接受摘要覆盖 bundle 版本、签名 artifact 摘要和永久 revoked/retired tombstone。门禁读取到的 Trust Store 必须与同一数据库摘要一致；另一目录的旧副本会 fail closed。待处理状态在重启后保留；只有重试同一个冻结中心签名包才能完成恢复，替换成另一个待处理包会被拒绝。订单事务内的投影查询复用现有 PostgreSQL 事务，避免另开连接形成反向锁序。

Linux 使用内核 `flock`，macOS 测试使用 `fcntl.flock`；PostgreSQL 的状态锁处理数据库 COMMIT 生命周期，目录锁串行文件读写。所有实例应使用相同数据库和同一持久 Trust Store 路径。较新的目录摘要可拒绝旧目录副本；不同数据库共享一个 Trust Store 卷，以及跨宿主机文件锁语义，不在本阶段宣称支持。部署切换时必须停止没有门禁的旧 API 实例，避免旧代码继续创建订单。

现有已授权数据库升级后，若尚无数据库 Trust Store 摘要，普通门禁会拒绝新经营。所有 API 停止、迁移完成并确认当前目录是该安装的规范持久 Trust Store 后，可显式运行一次：

```sh
pnpm --filter @aikayun/api run license-trust-head:init -- --initialize-current-trust-store-as-database-head
```

该命令要求发行工件内有可信发行配置，从当前 root 签名 Trust Store 获取新鲜签名时间锚，并在原数据库锁序下初始化摘要；它不会启用或延长许可证，也不会清除拒新事实。未配置可信发行根时命令失败。

## 测试方案与边界

生产入口只读取发行工件内嵌的不可变信任配置。当前 `trusted-release-license-config.generated.ts` 仍为 `null`，所以当前构建默认拒绝新的订单与充值。测试入口只接受真实签名 fixture、冻结授权中心提供的测试信任根和隔离 `_test` 数据库；没有 `NODE_ENV=test` 放行、环境变量 bypass、布尔授权或生产内嵌测试私钥。

新建隔离测试授权时，fixture 先接受 root 签名的信任包，再投影签名 lease；该流程和生产 Store 使用同一个数据库摘要协调器。订单与充值集成测试共用 fixture，不逐项重做激活流程。一个显式故障回归在 `COMMIT` 等待 PostgreSQL advisory 锁时 SIGKILL API，并观察 signer 撤销一直等到事务结束；另一个接受真实撤销包后验证旧目录拒绝；第三个在写入信任文件后 SIGKILL 并通过重试同一个 signed bundle 恢复。

Compose 浏览器验收通过独立 PostgreSQL 18 服务和冻结中心只读 checkout 运行。中心隔离管理员策略只接受 loopback PostgreSQL URL，因此 signed fixture 在 API 测试进程中建立仅绑定 `127.0.0.1` 的临时 TCP 转发，转到同一隔离 PostgreSQL 服务；商城 API 仍直连其测试 DB。子进程关闭后转发器也关闭。仅 E2E 签名镜像安装 `openssl` 生成中心 HTTPS 测试证书，未改动授权中心源码或发行配置。

可信时间仍沿用 3D-2 记录的 DB、文件及系统时钟协同回滚边界。本阶段未实现 time-reset、安装身份迁移系统、生产部署或 ⑦-2。

## 验收状态

- 最终 `pnpm verify` 使用真实 PostgreSQL 18 隔离容器与授权中心只读 SHA `a5cf99439e3bf92b65f19d60c013bca088cf221a` 通过。
- `pnpm lint` 无错误；仅保留 `apps/web/pages/products/[id].vue` 的 7 条既有格式警告。API/Web 类型检查、API/Web 生产构建通过；unit 测试 16/16 通过。
- API 集成测试 37 个文件、675/675 项通过，其中冻结授权中心 HTTPS Challenge、签名证据与恢复互操作 135 项全部通过。
- 真实浏览器测试通过：主 Chromium 套件 93/93、brand-alt 1/1、SSR 错误/重试 3/3、dev-preview 1/1、production-brand 1/1。
- 使用冻结中心签名证据的完整 Compose 浏览器套件通过：93 项中 84 项通过，9 项按现有集成服务条件跳过；支付回调测试使用本机隔离宿主 API 端口执行。
- 隔离数字履约恢复脚本 `scripts/verify-digital-recovery.mjs` 在真实 PostgreSQL 18 和冻结中心签名证据下通过。新的合成采购订单经隔离 signed API 准入；随后 API 与 DB 分别 SIGKILL/重启，身份、Pending-key、Trust Store、订单履约、采购预算及附件完成备份恢复；历史密钥、全部 6 种交付方式、未知供应商请求只读恢复均核对成功，最终对账差异为 0。签名档案在重启前后用 SHA-256 比对，fixture 不把 JWS 内容写入日志；恢复脚本退出时会移除 `signed-recovery` profile、容器和卷。
- PostgreSQL 锁竞争回归在真实 PG 18 中通过：测试通过 `pg_stat_activity` / `pg_blocking_pids()` 观察订单准入连接在 `installation_binding` 行锁等待；授权过期边界测试持锁越过签名截止时间后返回 403。另有 SIGKILL、未知 COMMIT、撤销并发、Trust Store 写入中断及重试恢复用例通过。
- 最终整体验收再次执行 `pnpm verify`，退出码 0：lint、类型检查、money 单测 16/16、API 集成 37 个文件 675/675、API/Web 构建、主 Chromium 93/93 和生产品牌 1/1 全部通过。独立 `scripts/test-license-center-interop.sh` 使用冻结中心 SHA `a5cf99439e3bf92b65f19d60c013bca088cf221a` 与真实 PostgreSQL 18，Challenge、签名和 operation/recovery 互操作 135/135 通过。
- 全套通过时，仍只有 7 条上述 lint warning；正式发行根仍为 `null`，所以当前构建会拒绝所有新的订单与充值，直至正式签名发行配置和规范 Trust Store 初始化完成。跨宿主机共享 Trust Store、time-reset、身份迁移、生产部署和 ⑦-2 均不在本阶段范围。
