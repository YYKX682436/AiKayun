# ⑦-1A：生产发行与独立部署架构

状态：设计冻结候选，等待用户验收；不是已实现能力。审计基线为 `main@5cf764d575549bb32b95e513c4c0b424e72d24a0`（2026-10-28）。本阶段只新增文档，未创建客户许可证、生产签名私钥、授权运行时或授权中心，未部署、迁移生产库或访问真实供应商。

配套文档：[真实代码审计](./production-code-audit-7-1a.md)、[授权协议与状态机](./license-protocol-7-1a.md)、[开发接口与验收](./release-license-acceptance-7-1a.md)、[本轮验证](./evidence/phase-7-1a/verification.md)。旧部署文档继续描述现有开发/测试 Compose，不代表本设计已经落地。

## 1. 商业与安全边界

闭源商业软件、客户独立部署，按月/年订阅，每许可证最多一个中心登记的活跃实例。允许改域名、搬服务器，不以 IP、MAC、硬盘或 CPU 作为身份。授权中心是另一个独立私有项目、独立数据库和秘密边界，不把商城顾客、订单、资金或交付内容复制到中心。

订阅到期、撤销、校时异常、凭证无效或授权中心失联，最多禁止**新增订单和新增充值**。已有资金和履约义务、原订单在原付款有效期内的支付、回调、查单、退款、提现、交付、历史下载和必要后台管理继续运行。授权不影响 API/数据库/worker 的启停。每笔交易不访问中心。

继续采用 PostgreSQL + Fastify 模块化单体 + Nuxt SSR/BFF + Caddy；无需 Redis、消息队列、Kubernetes、额外授权代理或新商城常驻服务。中心可复用成熟 PostgreSQL 和 HTTP 服务技术，但独立部署、独立仓库。许可证不能把未开放的业务变成可用业务：生产卡易信仍只读，采购执行内核仍隔离，不能通过许可证 feature、安装参数或升级默认值启用。

## 2. 交付单元和供应链

### 2.1 客户获取渠道

运营方控制独立 HTTPS 下载域名与 OCI 镜像仓库（具体域名在⑦-2绑定，本文不创建真实地址）。客户仅获得安装器、版本清单、生产 Compose/Caddy 配置、预构建镜像、运维工具和商业条款；不需要 GitHub 账号、源码权限、Git、Node、pnpm 或编译器。开发 CI 可使用私有 GitHub，客户运行路径不得引用 GitHub raw、源码压缩包或 `git clone`。

首发支持 Linux `amd64`、`arm64`，必须两平台实际通过后才在 release manifest 宣称支持；缺少验证的平台不发布。镜像不内置业务秘密、激活码或实例身份。API 镜像包含运行 JS、冻结的已编译迁移和运维 CLI；web 镜像包含 Nitro 输出及浏览器必需资源。客户有 root 权限，闭源发行不等于可以阻止读取服务端 JS。发行前应去除不必要源码、测试夹具、开发依赖、公开 sourcemap，并完成所含开源组件许可证/NOTICE 审查，不能声称所有第三方内容都属于闭源商业版权。

采用 SemVer `MAJOR.MINOR.PATCH`，预发布 `-rc.N`；`release_id` 永不复用。同一版本禁止覆盖镜像/清单；修复发行错误必须递增版本。可读 tag 仅便于定位，部署依据 OCI `repo@sha256:<digest>`，固定 API、web、PostgreSQL、Caddy 全部镜像摘要。多架构固定 index digest，并记录各 platform manifest digest。`latest` 不参与安装或升级决策。

### 2.2 发布清单（未来契约，字段非真实发行值）

```ts
interface ReleaseManifestV1 {
  schema: 1
  product: 'aikayun'
  release_id: string
  version: string
  channel: 'stable' | 'candidate'
  built_at: string // UTC RFC3339
  source_commit: string // 40位SHA，仅用于追溯
  platforms: ('linux/amd64' | 'linux/arm64')[]
  images: Record<'api' | 'web' | 'postgres' | 'caddy', {
    reference: string // OCI @sha256 必填
    platform_digests: Record<string, string>
    sbom_sha256: string
  }>
  artifacts: { name: string; size: number; sha256: string }[]
  database: {
    engine_major: 18
    migration_head: string
    migration_checksums_sha256: string
    readable_heads: string[]
    writable_heads: string[]
    upgrade_from_releases: string[]
    rollback_to_releases: string[]
    requires_write_quiescence: true
  }
  min_installer: string
  license_protocol_versions: [1]
  backup_format: string
  security_notes_url: string
}
```

清单保存精确字节并用标准 JWS detached payload 签名（禁止自制拼接哈希签名）；另附安装器签名及镜像签名/证明、SBOM、依赖扫描、来源 commit、验证记录。发行签名和授权签名使用不同 key/用途、不同信任集合。安装器内嵌发行信任根，校验清单后才接受其中的下载地址和摘要；HTTPS 不能替代工件验签。可用成熟 OCI 工具生成/验证镜像证明，具体工具固定版本在⑦-2验证，不能把未完成的供应链签名写成现有 CI 能力。

镜像仓库凭据短权限、可轮换，只用于拉镜像。凭据失效或订阅到期不得删除本机镜像、数据或停止运行的商城；恢复历史义务所需已发行版本应有受控离线镜像包/灾备获取渠道。发行下载权限与运行授权是两个独立检查。

## 3. 安装与 HTTPS 初始化

目标体验是一条固定版本的命令启动安装，然后在 HTTPS 页面完成初始化。正式文档将提供形如 `curl -fsSL https://<发行域名>/install/vX.Y.Z.sh | sh` 的单命令入口；它是未来示意，域名和安装器尚不存在。下载首跳依赖系统 CA/HTTPS，安装器随后必须验证内嵌信任根签署的清单和全部工件，不依赖脚本自己报告的 SHA。高审计要求客户可先下载并核验同一签名脚本再执行。安装器幂等、可恢复，不能覆盖已有身份、密钥或数据目录。

安装器只检查 Docker/Compose 兼容版本、平台、磁盘、端口和 DNS，创建固定项目名与目录、随机秘密和身份，拉取 digest 镜像，启动 db → migrate → API/web → Caddy。所有检查先于破坏性步骤；遇到现有部署或非空目标目录转为明确的 inspect/resume，禁止默认重装。执行计划、工件校验和失败阶段记录可读，日志不含秘密。

首次安装：域名解析和 ACME 成功后才开放网页 setup。HTTP 只允许跳转 HTTPS/ACME，不提交初始化密码。安装器把随机 ≥256 bit 的一次性 setup token 放在本机 `0600` 文件/终端，禁止 URL query、访问日志和镜像环境；页面输入 token 后换取短会话，复用 Origin/CSRF、限流。token 有短期有效期（默认30分钟），到期仅本机 CLI 重发。初始化事务用 advisory lock + 单例状态，从 `uninitialized → initialized` 一次性创建管理员和 deployment binding；任何并发第二个请求返回 `SETUP_ALREADY_COMPLETED`。提交未知时先查 singleton，不能再次创建或重置密码。现有 `admin:init` 的一次性锁语义须保留；本阶段没有网页 setup API。

初始化管理员与授权激活分离：中心不可达时仍能登录后台、诊断和恢复数据，首次无凭证禁止新经营。激活码只经 HTTPS、后台管理员+CSRF提交到 API，再由 API 直连中心，禁止送入 Nuxt public runtimeConfig。域名不通/ACME失败时保持 setup 未完成，给本机诊断；不降级公网 HTTP 初始化。

## 4. 配置、秘密与持久身份

建议目录是部署契约，未来工具须实现并校验，不在本轮创建：

```text
/opt/aikayun/releases/<release_id>/   # 只读 compose/Caddy/manifest/signature
/opt/aikayun/current -> releases/... # 原子切换指针
/etc/aikayun/deployment.json         # 非秘密，固定project name、origin、release
/etc/aikayun/secrets/                # 0700，秘密0600，不进入git
  database-password
  payment-key-ring.json
  delivery-key-ring.json
  instance-private.jwk
/var/lib/aikayun/identity.json       # instance_id、public jwk thumbprint、格式版本
/var/lib/aikayun/                    # 持久数据挂载根；禁止隐式改project名换卷
```

PostgreSQL、媒体、私有文件使用固定命名卷/显式绑定路径，固定 project name 是部署配置的一部分。身份 UUIDv4 与 Ed25519 身份密钥首次安装产生，存活跨容器重建、版本更新、改域名和正常迁移；不来自业务库里“任意第一个用户”，也不随每次启动随机重建。DB 新增部署绑定行记录 `database_id`（首次建库 UUID）、`instance_id`、身份公钥thumbprint。部署文件、DB binding、签名许可证claims.database_id与中心activation登记、身份私钥推导公钥必须匹配；renew也带database_id供中心核对。错配禁新经营，保留历史义务；完整root克隆仍不可绝对阻止。业务DB中不存身份私钥；缓存许可证不是身份来源。

缺失身份/秘密时禁止自动生成替代密钥覆盖历史数据。身份不匹配进入 `identity_mismatch`，只禁新经营，恢复/历史工作继续按现有安全约束运行；允许管理员诊断和用完整备份恢复。若历史凭据解密密钥确实丢失，相关付款查单/交付会无法完成，这是数据恢复故障，不能归因于授权，也不能忽略错误强行处理。

开发/测试/生产分别使用目录、Compose project、DB、文件卷、实例身份、中心 issuer/trust store、镜像仓库凭据和支付/供应商配置；测试 `_test` 校验继续保留。生产镜像不得带测试服务/测试私钥、`NODE_ENV=test` 或授权绕过 flag。测试中心凭证即使签名正确，也被生产 issuer/audience/trust集合拒绝。现有 loopback supplier/payment fixture 保护不得放宽。

生产用 Compose secrets 文件显式授予 API/迁移等必要服务；DB用官方密码文件支持，应用在⑦-2增加 `*_FILE` 加载，secret与同名env同时设置时报 `CONFIG_CONFLICT`，不隐式选一个。Nuxt/web只接非秘密配置；加密密钥只给 API及有需要的运维命令，迁移不默认获取供应商/授权秘密。Compose secrets 在普通 Compose 下是文件挂载，不是宿主root不可读的密钥保险箱。[Docker 官方说明](https://docs.docker.com/compose/how-tos/use-secrets/)

生产加载严格 schema 和模式：HTTPS origin、Secure cookie、可信代理范围、无测试override、只读信任集、绝对且隔离的文件根；当前仓库自动找 `.env` 的逻辑不是生产配置隔离方案。部署origin同时更新 `PUBLIC_ORIGIN`、Nuxt site URL、Caddy、支付回调登记；不能从不可信 Host 自动学习域名。域名变化不更换身份/密钥。业务密钥环与中心签名公钥轮换独立；保留历史 `key_id` 的解密能力，未完成全量引用扫描及备份保留期前不能删旧key。

## 5. 数据库版本与升级失败边界

现有迁移仅前向，保持所有历史迁移字节不变。发行时生成迁移名+内容SHA的有序清单；当前 Kysely 的已执行名不能证明内容未被篡改，新增校验应对旧版本建立审计基线，不重跑历史迁移。发行 API 在 readiness 前核对 `migration_head` 在清单 `readable_heads/writable_heads`，仅有 `SELECT 1` 不足以证明 schema 兼容。

首发采用计划停写升级，避免混合版本写入。流程：校验兼容矩阵/空间 → 预拉全部镜像 → 暂停入口和所有写入进程（含CLI/清理工具）→ 等待短事务结束及有界worker退出 → 一致备份并验证 → 单一迁移任务 → schema/key/file检查 → 启动新API/worker → web/代理恢复 → 历史资金/交付冒烟。备份期间和短维护期回调可暂不可达，必须依赖服务商重试+商城后续查单，运维不能伪造成功回执。

迁移器使用既有 Kysely DB 锁；安装器另持部署操作锁，避免两个升级器同时切版本。只接受清单明确列出的 upgrade path；禁止跳过未支持的schema head。每次升级保留源清单、目标清单、迁移结果、备份id和脱敏日志。

| 失败点 | 必须行为 |
| --- | --- |
| 拉取/校验失败，尚未停写 | 不动当前服务/数据，保留可重试计划 |
| 备份失败 | 不迁移；确认服务状态后恢复原版本，报告失败 |
| 迁移失败 | 不启动不兼容新API，查实际migration元数据及事务提交状态；不得假定全部回滚或直接重跑 |
| schema已前进，新API失败 | 只允许清单明确兼容该head的旧版本；否则保持维护并修复前进 |
| 要恢复备份 | 先隔离现状，核对备份后是否已有外部付款/采购/提现事实；不能用旧库直接覆盖当前账本后开放经营 |
| 版本回滚不支持 | 明确拒绝自动down迁移，给恢复/前向修复路径 |

不得把 PG 主版本升级混进普通应用升级。PG18 → 未来版本另行制定 `pg_upgrade`/逻辑迁移、扩展兼容、恢复演练；禁止仅改镜像tag启动旧数据目录。升级停机不是授权失效；授权过期不得触发维护模式。

## 6. 一致备份与恢复

默认采用短暂停写的 `pg_dump --format=custom` + 媒体/私有文件归档 + 配置/秘密备份，减少新依赖。不能对运行中PGDATA做普通tar备份；物理备份/PITR需成熟PG工具与WAL方案单独验收。[PostgreSQL 18 文件系统备份约束](https://www.postgresql.org/docs/18/backup-file.html)

必须组成同一 `backup_set_id`：

| 组成 | 保留要求 |
| --- | --- |
| PostgreSQL | 全业务表、账本、幂等键、provider收据/unknown证据、迁移元数据、DB binding、授权缓存和时间水位 |
| 公开媒体 | 全目录、元数据SHA对应对象、必要暂存状态 |
| 私有文件 | 完整根，含交付文件、购买草稿附件、订单归档附件、提现QR等隔离命名空间，禁止只备数字交付子目录 |
| 业务秘密 | payment/delivery两套密钥环的全部仍引用历史key、DB凭据、备份加密解密所需标识 |
| 身份与部署 | instance私钥、identity.json、deployment.json、project/卷映射、origin、release manifest与签名、trust bundle版本 |
| 辅助恢复 | Caddy配置；ACME数据可受控备份或重签（考虑限流），不是订单身份 |

备份秘密用独立的成熟加密备份工具/密钥托管封装；备份解密密钥不与备份明文一起存放。清单列所有文件长度、SHA256、schema head、release id、key IDs（不含key bytes）、身份thumbprint、写入停止/开始时间和工具版本。目录原子提交，验证所有校验和后才标记 `complete`；当前v2脚本只是基础，不能冒充这种完整生产备份。

停止所有 API副本/内嵌worker以及人工CLI，禁止只有一个容器停了就宣称全局静止。旧 http_json_v1 或采购出站已发生而回执未落库时，保留 `unknown` 和原幂等身份，恢复后先查单；备份无法撤销外部已经发生的事实。需要记录停写前后未决操作清单和恢复后对账任务。普通恢复不能重新派发新商户订单号去“补单”。

恢复到独立隔离环境：禁止真实收款/采购出站、禁止真实回调域名切流、禁止自动激活/续签克隆身份；导入相容版本、核对全部key引用和文件SHA、执行只读reconcile及账实检查，完整演练通过后销毁隔离副本。这个“运维隔离环境”不提供生产授权绕过：不能新经营，不获取并行有效许可证。生产恢复必须经目标身份/卷确认及受控恢复流程，现有 `_test` restore脚本绝不能改名当生产工具。

同机恢复/正常服务器迁移恢复原 `database_id`、instance_id和身份密钥；灾难迁移必须按授权协议升 activation generation 并明确旧机失效风险。恢复旧备份不代表可以把中心 entitlement revision/generation 回滚。联网后先向中心核对；恢复模式在未核对前禁新经营，但不阻断历史义务。恢复后通过媒体读取SHA、历史解密、付款查单、未决交付、退款/提现账实检查才算成功，不以“进程都绿了”代替恢复验收。

## 7. 健康、诊断与任务恢复

`live`仅进程可响应；`ready`检查DB、schema兼容、必要文件根可读/可写及配置基础有效。授权到期/失联不能使ready变红、触发重启风暴。诊断分开报告 `commerce_admission` 与 `obligation_processing`：前者许可新经营与否，后者存储、密钥引用、worker、provider未决队列是否可处理。关键业务密钥缺失应明确诊断；不能借“ready绿”假装历史资金可恢复。

公开健康仅粗粒度状态；管理员诊断才返回 release/schema、实例ID脱敏、授权reason/deadline、最近续签、worker最后tick/成功时间、待处理/unknown数量与最老年龄、文件/密钥检查摘要。禁止暴露许可证全文、激活码、私钥、加密blob、顾客资料、provider原始响应。当前日志已有body/cookie等脱敏，但 URL query 可能有支付回调签名/交易信息，⑦-4需审查 API与代理全部日志链并验证，不在本轮顺手改日志。

已有两个worker入口继续用现有PostgreSQL锁、lease、fence和幂等恢复；新授权续签任务作为 API 内有界定时任务，DB advisory选主避免多进程重复续签，无需额外服务。它只更新授权/时间状态，不触碰订单锁/资金表。网络超时3秒、总5秒、有界响应；默认6小时续签±10%抖动，失败指数退避1m→5m→30m→最长1h，接近期限至少每5m尝试，不能高频自旋。持久化最近成功/失败码并在有意义变化时告警。

授权到期、中心故障、续签任务崩溃都不得停止unpaid-expiry和digital-delivery；原支付unknown通过已有refresh/管理员reconcile恢复，当前没有独立支付/退款/提现自动worker，不能写成已有自动全量恢复。生产卡易信采购dispatcher仍不存在，⑦阶段也不新增；若后续独立采购阶段开放，许可状态只管新订单，不管其已承诺订单的查询/恢复。

保留现有账本只追加、库存保留/消费、退款与履约订单锁串行、采购风险预算/冲突证据、私有授权下载等规则。退出等待要有上限并记录未决状态；Docker重启不应依赖内存队列。⑦-4补任务心跳、积压和锁等待监控；⑦-5/⑦-6验证强杀/灾备。现有CI中的SIGKILL和恢复是既有测试覆盖的证据，不是本轮重新运行或生产验证。
