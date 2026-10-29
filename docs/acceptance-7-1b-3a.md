# ⑦-1B-3A 安装身份验收记录

## 验收目标与范围

确认商城能在隔离 PostgreSQL 上显式建立一套可恢复的 Ed25519 安装身份，并将其绑定到唯一数据库身份；并发、进程中断、文件损坏、备份错配和已有业务数据场景均失败关闭或从同一持久材料恢复。本记录不代表经营授权门禁、授权中心协议、生产部署或生产灾难恢复已经完成。

测试使用容器化 PostgreSQL `_test` 数据库和每例临时身份目录。集成测试直接使用 PostgreSQL、实际迁移 SQL、真实子进程和文件系统；没有用 mock 数据库替代。集成用例结束会删除各自 schema 和临时目录。

## 确定性集成验收

`apps/api/test/installation-identity.integration.test.ts` 覆盖：

1. fresh 初始化生成一次 Ed25519 key，重复初始化和进程重入返回相同 `database_id`、`instance_id`、JKT；身份目录与文件权限符合 POSIX 限制。
2. 两个真实 Node 子进程并发初始化同一 PostgreSQL schema，只产生一套有效 binding 和身份文件。
3. 显式 init/verify CLI 连接隔离 PostgreSQL；不接受生产环境或非隔离数据库。
4. 在初始化日志提交、intent 持久化、私钥持久化、manifest 持久化、目录原子安装、binding 事务提交前、binding 事务提交后等检查点用真实 `SIGKILL` 中断；恢复使用原 UUID/密钥，或对已提交结果幂等验证，不补发第二 key。
5. 商业表中已有数据时 fresh 拒绝；未带确认的 adopt 拒绝；带确认的 adopt 保留数据，并把来源标为 `operator_confirmed_not_verified`。订单、钱包、账本、支付、库存与履约样本逐表前后比对不变。
6. 默认 storefront policy 仅在整行/列与当前迁移默认值精确一致时视为 bootstrap 元数据；修改策略会要求 adopt。
7. binding 已存在而私钥缺失、替换私钥、公钥/JKT不匹配、仅恢复 DB、仅恢复身份文件及混合备份都被拒绝；不会自动重建身份。
8. 错误权限、目录/文件符号链接、非普通文件、额外目录项及仓库路径被拒绝。
9. SQL UPDATE/DELETE/TRUNCATE 不能清除、修改或降级 `installation_binding`，初始化日志也不可被删除或截断。

## 命令与执行证据

以下结果应由当前提交对应的实际运行填入；没有通过的项目不得标记为已验收：

| 项目 | 命令/证据 | 结果 |
| --- | --- | --- |
| 冻结依赖安装 | `pnpm install --frozen-lockfile` | 通过；lockfile up to date，pnpm 10.29.3 |
| 身份 PostgreSQL 集成 | `NODE_ENV=test TEST_DATABASE_URL=<isolated _test PostgreSQL URL> pnpm --filter @aikayun/api exec vitest run test/installation-identity.integration.test.ts` | 18/18 通过（隔离 PG，当前轮） |
| 全仓 lint | `pnpm lint`（包含于 `pnpm verify`） | 通过，0 errors；`apps/web/pages/products/[id].vue` 有 7 条既有格式 warning |
| 全仓类型检查 | `pnpm typecheck`（包含于 `pnpm verify`） | 通过 |
| 全仓测试 | `pnpm test` | 通过；money 16/16，API 29 个文件、498/498 测试，真实 `_test` PostgreSQL |
| 全仓生产构建 | `pnpm build`（包含于 `pnpm verify`） | 通过；Nuxt 构建器访问 Google 字体元数据超时，采用 provider fallback 后构建完成 |
| 浏览器回归及生产品牌回归 | `pnpm verify` | 通过；主套件 93/93、品牌变体 1/1、SSR 错误态 3/3、开发预览 1/1、生产品牌 1/1 |
| Compose 容器/数据库强杀及配对备份恢复 | `node scripts/verify-digital-recovery.mjs` | 通过；隔离 API/PG 均 SIGKILL 重建，身份完全匹配，v3 配对恢复、数字履约对账差异 0，临时项目/卷/镜像已移除 |
| 迁移与私钥隔离 | migration provider、Compose Docker build 与镜像文件检查 | 新迁移由 API / Playwright 测试和隔离 Compose 实际应用；runtime image 扫描 `/app` 得到 `pkcs8Names=0,pemBlocks=0`，私钥只在运行时身份 volume |
| 差异/仓库清洁 | `git diff --check`、`bash -n ...`、`node --check ...` | 通过；本轮生成的构建/Playwright 输出及隔离 PG/Compose/临时镜像已清理，提交推送后 `main` 工作区干净 |

补充的 Compose 恢复验收在独立随机项目和端口中启动容器，恢复 DB、公开媒体、私有文件和身份 volume 为一组，并在 API / DB 容器强杀重建后再次比较身份与业务快照。它不会重启或操作默认商城 Compose 项目。生产数据库、授权中心和外部商家均不在本验收范围。

## 明确未验收

- 实际授权中心 HTTPS、激活码、challenge/PoP、签名 lease、授权续期 Worker、time-reset 和灾难重绑尚未实现。
- API 经营入口尚未连接身份模块作为经营门禁；现有商城业务仍可照常运行，因此不具备已完成的商用授权保护。
- `adopt_existing` 的人工确认只确认操作者要求为当前数据库建立新身份；既有数据来源、历史安装身份及权益所有权仍是 `NOT_VERIFIED`。
- 文件权限适用于 POSIX 部署；其他文件系统、复制到另一主机但完整克隆数据库与 identity volume、恶意高权限主机均不属于本地代码可证明的边界。
- 隔离备份恢复脚本只允许 `_test` 环境，不是生产恢复工具。

## 交付边界

本阶段修改范围限定为商城仓库：新前向迁移、身份模块/显式隔离 CLI、API 专属持久卷、配对备份脚本、真实 PostgreSQL 集成测试以及 3A 文档。授权中心仓库只读。完成 3A 即停止，不接续 3B、3C 或 ⑦-1C。
