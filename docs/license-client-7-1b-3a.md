# ⑦-1B-3A 商城安装身份与数据库绑定

本文件描述商城端 ⑦-1B-3A 的身份基础。商城代码基线为 `225600b55bbd91bcb7393097b7b5fd44a3465816`；授权中心基线 `6f554b51b867a15ad7747c6d002b548e016f65c6` 在本阶段只读。新增身份能力不构成商城经营授权保护，API、订单、充值、支付、退款、提现、数字交付和采购流程没有增加授权门禁。

## 身份模型

`installation_binding` 是数据库中的单行身份权威，包含：

| 字段 | 含义 |
| --- | --- |
| `database_id` | 随一次数据库身份初始化分配的 UUIDv4；写入实例清单及绑定，不从数据库地址、域名、容器、主机、管理员或启动时间推导。 |
| `instance_id` | 逻辑商城安装 UUIDv4。容器重建、进程重启、升级及域名变化不更改它。 |
| `identity_jkt` | Ed25519 公钥 JWK 的 RFC 7638 SHA-256 thumbprint，使用 JOSE 标准库计算。 |
| `binding_revision` | 正整数单调修订；3A 首次且唯一绑定为 `1`。本迁移禁止普通修改，未来重绑必须由单独的审计迁移和受控流程实现。 |
| `binding_state` | `ready` 或 `rebind_pending`。3A 只创建 `ready`；若将来受控迁移写入 `rebind_pending`，当前验证器返回 `unavailable`。 |

另有 `installation_identity_initializations`，用于崩溃恢复的不可变初始化日志。它只记录 operation UUID、初始化模式和单调阶段，不存身份密钥或身份 UUID。日志阶段为 `preparing → identity_material_saved → identity_staged → committed`，只允许前进；两张表的 UPDATE/DELETE/TRUNCATE 都受到数据库触发器保护，binding 只允许在 staged 日志下首次插入。

迁移 `202610290001_installation_identity` 是前向迁移，没有改写任何已执行迁移。表和触发器只在显式执行数据库迁移时创建；普通 API 启动不会初始化、覆盖或重建实例身份。

## 私钥与文件布局

运行时身份根目录由 `INSTANCE_IDENTITY_ROOT` 指定，必须是绝对路径。未设置时使用 `$XDG_DATA_HOME/aikayun/identity`；Docker Compose 将独立命名卷 `instance_identity` 仅挂载给 API，默认容器路径为 `/var/lib/aikayun/identity`。该目录与代码、Nuxt、公开商品媒体及私有交付文件分离。API 进程使用非 root `node` 用户。

初始化后目录结构如下：

```text
<identity-root>/                         owner API user, mode 0700
└── current/                             owner API user, mode 0700
    ├── identity-intent.json             owner API user, mode 0600
    ├── instance-private-key.pk8.pem     owner API user, mode 0600
    └── identity.json                    owner API user, mode 0600
```

临时阶段目录 `.staging-<operation_uuid>` 只在初始化中断后待恢复时存在，验证器会拒绝把它当作就绪身份。Intent 固定本次 operation、模式及两个 UUID；manifest 保存相同 UUID、RFC 7638 JKT、只含 `kty=OKP`、`crv=Ed25519`、`x` 的公钥 JWK，以及固定私钥文件名。PKCS#8 PEM 私钥由 Node 24 `node:crypto` Ed25519 生成并导入，不加密，安全边界是 API 专属持久卷与 POSIX 所有者/权限。它不进入业务数据库、浏览器、Nuxt 配置、日志或 Docker 镜像。

写入使用同目录临时文件、`0600`、文件 `fsync`、原子 rename 和目录 `fsync`。先持久化 intent，再持久化私钥，再写 manifest 和阶段目录；把完整阶段目录原子安装为 `current` 后，才提交数据库 binding。数据库 session advisory lock 串行化同库的并发初始化；`current` 目录作为共享身份卷的原子 claim。写入中断时只从同一 operation 的意图及已落盘密钥继续；若数据库已记录材料阶段但材料不见，或身份文件已安装而数据库无原始日志，则拒绝重建。

验证会检查 JSON 精确字段、UUID/JKT 格式、路径边界、owner、目录 `0700`、普通文件 `0600`、单硬链接、文件类型、符号链接和 PKCS#8 私钥推导出的实际公钥/JKT。私钥缺失、替换、损坏、备份不配对、DB binding 与文件不匹配均返回 `identity_mismatch`；数据库或目录不可用时返回 `unavailable`。验证失败不生成新密钥，也没有 reset/rekey 命令。

## 显式初始化与受控接管

仅开发/隔离测试 CLI 提供初始化和只读验证。CLI 在 `NODE_ENV=production` 下禁用；测试环境数据库名必须以 `_test` 结尾，开发环境数据库名必须以 `_dev` 或 `_test` 结尾。使用已应用商城迁移的隔离 PostgreSQL：

```sh
pnpm --filter @aikayun/api exec tsx src/licensing/installation-identity-cli.ts init --mode fresh
pnpm --filter @aikayun/api exec tsx src/licensing/installation-identity-cli.ts verify
```

全新模式扫描当前 schema 的业务表。只有没有业务行的数据库，以及迁移创建的默认策略行，才可作为 fresh。策略表只有在列集合和值逐项匹配已知迁移默认值时才被视为 bootstrap 元数据；新列或非默认设置会要求受控接管。身份初始化不会清空、重建或改写业务表。

已有商城数据必须显式指定接管模式，并确认已有数据；不会仅因缺少 binding 推断为全新商城：

```sh
pnpm --filter @aikayun/api exec tsx src/licensing/installation-identity-cli.ts init \
  --mode adopt-existing --confirm-existing-data
```

接管仅建立新的本地实例身份并保留原数据，不证明历史商城的来源、归属或授权状态。CLI 结果通过 `businessDataProvenance: operator_confirmed_not_verified` 明确记录此边界；未经人工确认时状态为 `not_verified`，不创建初始化日志或 binding。若数据边界无法证明，应停在 `not_verified`，不得猜测身份、清库或另建数据库。

可以通过 `--identity-dir ABSOLUTE_PATH` 指定隔离目录；路径不能位于仓库、媒体目录或私有交付目录，也不能与这些目录嵌套。初始化重复执行要求数据库和文件已精确匹配，成功返回相同身份；参数模式不同、binding 不匹配、文件缺失或额外文件都拒绝继续。普通 API 启动不会调用 CLI。

## 备份与恢复顺序

数据库与实例目录必须作为同一静止点的配对成员保存。**3A验收时** `scripts/backup-compose-data.sh` 生成 `aikayun-compose-backup-v3`，包含 PostgreSQL custom dump、媒体归档、私有文件归档、`identity.tar.gz` 和 SHA-256 校验。3B明确升级当前备份格式为 v4，新增独立授权 Trust Store 归档；该版本变化及恢复脚本约束见[3B客户端说明](license-client-7-1b-3b.md)。身份归档包含私钥，应按部署环境要求加密、限制访问并存放于独立持久位置；解密材料不得与明文备份放在一起。

恢复必须在隔离环境按顺序执行：停止服务写入 → 校验清单与所有 SHA-256 → 恢复数据库 → 恢复媒体/私有文件/身份卷 → 启动 API → 运行 `identity:verify`。只有数据库与 identity archive 是同一备份集合，`verify` 才应返回 `ready`。只还原数据库、只还原身份目录，或混用不同备份集合都必须报错并停止；不得通过重跑 init 补发密钥。当前 `scripts/restore-test-compose-data.sh` 只接受项目隔离的 `_test` 数据库和 v3 成套备份，用于测试恢复，不是生产恢复入口。

## 本阶段边界与后续阶段

| 阶段 | 本阶段状态 |
| --- | --- |
| 3A：本地安装身份、Ed25519 私钥持久化、数据库 binding、迁移/并发/崩溃恢复、诊断与隔离 CLI | 本文实现。 |
| 3B～3F：授权中心 HTTPS/RFC 9421 请求、root-pinned trust bundle、严格签名与回执验证；持久化 operation/attempt、激活/续签/状态投影与幂等恢复；续签 worker、时间恢复、审计迁移/灾难重绑；最终新订单/充值经营门禁及旧业务义务保护 | 以上均未实现。该范围按授权中心交接列出能力边界，不替后续任务预定每项能力的子阶段归属。3A 不访问中心、不发送激活码、不签经营 lease、不启 worker、不提供绕过审计的重置接口。 |

因此 3A 仅为后续客户端提供稳定、可核对的持钥主体。它没有防止当前商城业务在无授权状态下运行，不能宣称已具备商用授权保护。禁止以 `LICENSE_ENABLED=false` 等配置引入未来授权绕过开关。
