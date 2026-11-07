# ⑦-5B-1：独立隔离恢复与业务一致性验收

## 范围与客户入口

本阶段仅恢复状态为 `verified` 的完整备份集合到全新、内网隔离的 Compose 项目。未实现生产原地覆盖恢复、升级、搬服、授权迁移或异常校时；本机/Docker-in-Docker 结果不代表异地主机灾备。

R1 改动限于恢复宿主 broker、恢复验证测试路径和本验收记录；没有改写 ⑦-5A 备份创建算法或历史履约代码。

客户入口为：

```text
sudo /opt/aikayun/aikayun backup restore-isolated SET_ID
sudo /opt/aikayun/aikayun backup cleanup-isolated RUN_ID
```

`restore-isolated` 只接受备份集合 UUID。签名发行中的 helper 先验证集合、Restic 仓库和双快照角色，再绑定 manifest、文件校验和、数据库 dump、发行镜像、身份及密钥证据。宿主 broker 持有与安装器共享的操作锁，随后创建独立 project 和带 project/run/scope 标签的卷。恢复后的数据库只供只读验证器访问，成功时数据库停止；失败状态不能变为 `verified`。cleanup 仅删除与 ownership 记录、project、run、允许的 service 和资源标签完全一致的本轮资源。

生产恢复没有客户命令，也没有 DNS 切换或自动经营切换入口。

## 隔离边界

- 每次恢复使用新的 Compose project、PostgreSQL 18 数据卷、凭据卷、状态卷、Caddy data/config 卷、部署密钥卷、dump 卷和 manifest 卷。预先存在的目标卷、网络或 project 资源会在使用前导致 `RESTORE_TARGET_RESOURCE_CONFLICT`。
- 恢复 Compose 不启动商城 API、Web、worker 或 Caddy，也不发布端口。Restic 和文件输入容器使用 `network_mode: none`；PostgreSQL 与只读验证器只连 `internal: true` 的专用 bridge。
- 验证器从实际 `1.1.1.1:443` TCP 探测确认外部出站不可达，并检查恢复容器没有端口绑定、镜像/服务身份与预期一致。它以 UID 1000 运行，只读根文件系统、丢弃全部 capabilities，并对 PostgreSQL 使用只读角色和 `default_transaction_read_only=on`。
- 隔离副本不会启动支付、退款、提现、供应商请求、真实回调、授权激活或续签流程。未决操作只读保留原身份、状态、attempt 与幂等标识。

## 客户入口端到端验收

**环境：** 完全可销毁的 Linux Docker-in-Docker 测试环境，Docker Engine 29.9.3，aarch64/overlayfs；客户命令实际从临时 Linux 主机 `/opt/aikayun/aikayun` 执行，连接到独立的内部 Docker Engine。源商城是本轮合成 PostgreSQL 18 Compose fixture：数据库运行，API/Web/Caddy 容器保持停止。没有访问外层现有商城 Docker project 或卷。

**发行：** 使用本轮临时 ECDSA/JWS 签名发行 fixture，通过发行 helper 的文件清单与 SHA-256 校验。Cosign 调用由 test-only `docker` shim 截获并返回成功；真实 Cosign/OIDC、真实 GHCR 拉取及正式商业签名链尚未验证。镜像引用及 digest：

| 工件 | Digest |
| --- | --- |
| API | `ghcr.io/yykx682436/aikayun-api@sha256:cdb82ecceacc64cc708972292f67b22d4e88e6fd0a21274a5d893af3aeee6f3c` |
| Web | `ghcr.io/yykx682436/aikayun-web@sha256:485689da9baa8ceea11959d30e12eed4f353f30cbfadb4be32e9147540cf9682` |
| PostgreSQL 18 | `docker.io/library/postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873` |
| Caddy | `docker.io/library/caddy@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5` |
| Restic test runtime | `ghcr.io/yykx682436/aikayun-backup-restic@sha256:42a2588b740784d3cd20d178cd47c5afa5eef56060bc368a8e5a8d46f557800e` |

**备份集合：** `35a8bd9f-3af4-4f67-a8ab-a66ad272be84`；source snapshot `76778dc982929579dba51d52317d04d98b8a0c8efada4d5a73c92efc66056347`；manifest snapshot `508ebf1f853f544c87f96cbae23c0eac7cd87edd908e3a4ffff506f3067cd2b7`。

成功命令及退出码：

```text
sudo /opt/aikayun/aikayun backup verify 35a8bd9f-3af4-4f67-a8ab-a66ad272be84                       -> 0
sudo /opt/aikayun/aikayun backup restore-isolated 35a8bd9f-3af4-4f67-a8ab-a66ad272be84          -> 0
sudo /opt/aikayun/aikayun backup cleanup-isolated c8f58cd4-ad32-40b5-adb7-6287b3d897a9          -> 0
```

最终安装的临时发行包含 broker SHA-256 `22075e1e669dae79c86f2d2389e1f421adee928c5c7eae6b3027c94fd5e9b806`，manifest SHA-256 `0fa242bbd71fadd545b3b9ce7300693a7421faee8ba02a4af095131ed672ef89`。恢复 run `c8f58cd4-ad32-40b5-adb7-6287b3d897a9` 最终记录为 `status=verified`、`code=RESTORE_ISOLATED_VERIFIED`。恢复的 PostgreSQL 容器最终为 `exited`，内部网络标记 `internal=true`，所有容器端口绑定为空。成功后执行客户 cleanup，并确认仅该 run 的容器、网络、8 个命名卷和 ownership 目录已删除。

发行验证、共享操作锁、broker 快照身份绑定、完整集合校验、恢复 project 创建、数据库 dump 导入、文件/密钥恢复和只读验证均经过实际客户命令。验证结果摘要：

- PostgreSQL 18 schema head 为 `202611040002_file_check_results`；订单 4、订单项 4、支付尝试 5、退款 1、提现 1、交付 2。
- `walletLedgerEntries=2`、`inventoryReservations=4`；钱包、库存、退款分配和提现冻结一致性为 `verified`。
- `unknown` 采购操作 1 条，并保留 procurement request intent、execution evidence、risk reservation/event；supplier operation 为 0。所有未决操作均保留原状态与身份，没有重试外部操作。
- 历史支付 envelope 解密 7 次、交付 envelope 解密 2 次、采购快照解密 1 次；公开媒体 3 个变体与私有文件对象 1 个通过 SHA-256，文件型下载授权、Trust Store 状态、Pending Key、2 条授权操作和 2 次 attempt、trusted-time watermark 均通过。
- 报告 `network=egress-blocked`；实际外网 TCP 探测失败。验证报告是从只读验证容器输出的业务摘要，不以行数、文件名或健康状态代替业务验证。

清理前后，固定备份仓库的文件摘要合计保持 `4f0e24aca555c49e4a47a8c59077ed78b71c9f63d528fbe07140314c24f30555`，仓库大小保持 220257 bytes；合成源数据库容器 ID 与运行状态未变。外层商城 Compose project 未被停止、删除或修改。

## 动态故障注入

| 注入 | 实际结果 |
| --- | --- |
| 恢复数据库导入后、验证前，对客户 broker shell 发送 SIGKILL | 客户命令 `sudo /opt/aikayun/aikayun backup restore-isolated 35a8bd9f-3af4-4f67-a8ab-a66ad272be84` 退出 137；run `ad4d153a-ad37-447e-a07c-2113643d8a93` 的 PostgreSQL 查询到订单 4，ownership 记录仍为 `started`，未出现 `verified`。`sudo /opt/aikayun/aikayun backup cleanup-isolated ad4d153a-ad37-447e-a07c-2113643d8a93` 退出 0，删除本 run 部分资源。 |
| 异归属目标数据库卷冲突 | 创建带 `com.aikayun.test-run=75b1r1`、project 为 `foreign-conflict-fixture` 的同名卷。客户 restore 命令对 run `02f615ad-b57e-4460-8d90-7029495fab9f` 退出 1，记录 `RESTORE_TARGET_RESOURCE_CONFLICT`。客户 cleanup 也退出 1 并保留异归属卷；核实卷标签后，测试清理器才移除该注入卷，再由客户 cleanup 退出 0 删除空 run 目录。 |
| 旧 schema 与目标发行不匹配 | 隔离容器中的 SQL `UPDATE kysely_migration SET name = name || '_r1_incompatible' WHERE name = '202611040002_file_check_results'` 返回 `UPDATE 1`。客户 restore 命令对 run `8f477881-42c4-4bc3-8f85-9696a09cb02e` 退出 1，状态 `failed`；客户 cleanup 退出 0。 |
| 历史支付密钥错误 | `network=none` 的临时 API 镜像 helper 只在本 run 部署密钥卷中替换 `fixture-history` 的密钥材料，ID、数据库和源备份不变。客户 restore 命令对 run `2d1b278b-f2ec-4b92-b22c-70e279a665c2` 退出 1，状态 `failed`；客户 cleanup 退出 0。 |
| 单侧失败：文件已恢复、数据库导入未完成 | 只读探针确认 dump 与 manifest 中的 SHA-256/字节数一致，manifest 与两把密钥文件存在；在 `restore-database` 前只停止本 run 的 DB。Compose 导入报错 `could not translate host name "db"`，客户 restore 命令对 run `dfc1bf7b-184b-4da1-93cf-6ab44fe3bf2f` 退出 1，记录 `RESTORE_DATABASE_FAILED`；客户 cleanup 退出 0，没有成功记录。 |
| 真实磁盘 ENOSPC | **BLOCKED，未执行。** 本轮 Docker-in-Docker overlay 文件系统约有 305 GB 可用空间，恢复卷没有单卷配额；耗尽整个文件系统会危及诊断和清理能力，因此没有声称内核级 ENOSPC 动态通过，也没有用单元测试替代。 |

上述失败路径中，业务命令均来自客户运维入口；数据库/文件篡改由仅挂载本轮隔离卷的测试容器或专用测试进程执行。错误 Restic 密码及不存在 source snapshot 的真实 Compose 回归仍保留在 `backup-direct-real-set.integration.test.ts`；本轮 runner 没有配置该集成测试的 `AIKAYUN_FIXTURE_*` 启动参数，因此 `pnpm verify` 明确将它记为 skip。

## Restic 元数据契约

先前单独运行的真实 Restic 容器元数据集成检查了 uid/gid、mode、ACL、xattr、硬链接、symlink 和 sparse 文件保存/恢复；本轮 `pnpm verify` 中 `backup-restic-container.integration.test.ts` 因缺少该测试专用 Docker fixture 而明确 skip。统一安全契约要求：在创建 verified source snapshot 前，备份发布路径和恢复 helper 都对完整 state/Caddy data/config 树执行 `verifyDirectSourceSnapshot`；symlink、重复 inode/硬链接、特殊文件、非规范路径和特殊权限会在 verified 发布前拒绝。身份、Pending Key、密钥环和 dump 另要求普通单链接文件。因而 Restic 能表达某种文件对象，并不意味着它能被包含于已验证集合。ACL/xattr 与稀疏内容可由 Restic 恢复，当前校验不因这些元数据本身拒绝。

## 完整验证、CI 与剩余边界

本轮 `pnpm verify` 在隔离 Linux runner 运行，并为需要的集成测试提供独立 loopback PostgreSQL 18 `_test` 数据库和冻结的 AiKayun-License commit `185dac80204f60abbaa63ffeb5af7d7054b685d7`。lint 0 errors/7 warnings、typecheck、build、API 910 passed/31 skipped（87 test files passed/12 skipped）和 7 项 release 检查通过。`apps/api/test/backup-direct-real-set.integration.test.ts` 没有设置 `AIKAYUN_FIXTURE_*` 参数，因此 1 项真实 PG18 备份集成测试明确 skip；这项 runner skip 由上文客户入口真实恢复 run 独立补证。

主 Playwright E2E 为 95 passed/1 failed：`private-file-delivery.spec.ts` 期望 `顾客授权说明.txt`，实际浏览器建议文件名为 `download`。该失败在上一轮也已出现，本轮未改动历史交付/下载逻辑。由于 `pnpm verify` 的 E2E 子命令在该失败处停止，`production-brand` 没有在该完整命令中运行；单独执行 `pnpm --filter @aikayun/web test:e2e:production-brand` 为 1/1 passed。故本轮完整 `pnpm verify` 最终退出码为 1，不能记作全绿。

**GitHub CI：** [Actions run 42340198373](https://github.com/YYKX682436/AiKayun/actions/runs/42340198373) 对提交 `014366b656033a815a808a019fceb671d7063851` 最终为 success。CI 的 `Unit and PostgreSQL integration tests` 步骤中，`backup-direct-real-set.integration.test.ts` 明确 1 skipped，因为没有启用该测试专用 `AIKAYUN_FIXTURE_*` Docker fixture；同一 run 后续的 `Digital delivery SIGKILL, backup restore and untrusted TLS acceptance` 步骤通过。该 CI fixture 不是异地主机灾备；本轮客户入口 PG18 实际恢复证据见上文。

**正式商业发行尚未验证：** 临时测试发行清单记录的源码提交为 `2550c1c5a64039b2255292626e05fbffb57df137`，宿主 broker 使用本轮工作树内容 SHA-256 `22075e1e669dae79c86f2d2389e1f421adee928c5c7eae6b3027c94fd5e9b806` 并由临时 ECDSA/JWS 密钥签名；Cosign 调用由 test-only shim 返回成功。真实 OIDC 身份、Cosign 签名、GHCR 镜像发布/拉取和正式生产发行根配置不在验收范围。没有执行正式生产恢复、原地覆盖恢复、升级、搬服或异地主机灾备。

## ⑦-5B-1-R2：私有文件下载文件名回归收尾

本轮范围仅为下载文件名 E2E 断言和证据；没有修改私有文件下载 API、授权、私有存储、文件完整性或历史履约实现。测试现同时检查锚点属性、同源下载端点响应及浏览器实际下载事件，不跳过 `suggestedFilename()` 断言。

### 实测响应与差异定位

业务 E2E 的下载按钮 DOM 为 `download="顾客授权说明.txt"`，`href` 为同源路径 `/api/v1/customer/orders/{orderId}/items/{itemId}/deliveries/{deliveryId}/file`。隔离 Postgres 18 fixture 中，首次和重复请求均返回 HTTP 200、`Content-Type: text/plain; charset=utf-8`、95 字节以及相同 SHA-256 `affc7560d89e54efa877f70ca6b33f59f61d1bd572e209460d94ac945110a1c5`。实际 `Content-Disposition` 为：

```text
attachment; filename="______.txt"; filename*=UTF-8''%E9%A1%BE%E5%AE%A2%E6%8E%88%E6%9D%83%E8%AF%B4%E6%98%8E.txt
```

该页面的 Playwright `response` / Chromium DevTools 事件不会暴露 attachment 响应，所以测试通过页面上的同源 `fetch` 检查相同 URL 的状态、头部和字节，再继续点击锚点，逐次断言实际 `download.suggestedFilename()`、下载字节和 SHA-256。响应与浏览器环境摘要会随测试输出，失败时也进入断言信息。

| 环境 | 浏览器与服务启动方式 | 首次/重复 `suggestedFilename()` | 结果 |
| --- | --- | --- | --- |
| 本机 macOS arm64 | Node 24.22.0、Playwright 1.64.1、Chromium 156.0.8078.4（Playwright Chromium revision 1248）；`PLAYWRIGHT_USE_PRODUCTION_SERVER=true`，测试配置启动独立 Nuxt production server 与 API；HTTP proxy 环境变量未设置 | `顾客授权说明.txt` / `顾客授权说明.txt` | 业务 E2E 通过，响应、字节及摘要正确 |
| 隔离 Linux arm64 容器 | Debian 12 bookworm、Node 24.22.0、Playwright 1.64.1、Chromium 156.0.8078.4；同一 production server 启动方式，测试 Postgres 位于本轮专用 Docker 网络，容器无外网路由 | `download` / 首次已失败，重复断言未运行 | API 响应仍为 200，DOM 属性、UTF-8 `Content-Disposition`、95 字节和 SHA-256 均正确；下载事件只报告 `download` |
| 隔离 Linux x64 容器 | Debian 12 bookworm、Node 24.22.0、Playwright 1.64.1、Chromium 156.0.8078.4；同一 production server 启动方式，测试 Postgres 位于本轮专用 Docker 网络；浏览器以容器默认 root 运行 | `download` / 首次已失败，重复断言未运行 | 实际商城 E2E 同样得到 200、正确响应头/字节/摘要，但下载事件报告 `download` |
| Linux arm64 与 x64 最小静态 HTTP fixture | 不加载 AiKayun；只提供相同 `download` 属性和 `Content-Disposition`，使用 Chromium 156.0.8078.4；x64 fixture 以 UID 1000 运行 | 两边均为 `download` | 均可独立复现，排除了 AiKayun 服务器响应、业务文件和浏览器架构差异 |
| GitHub Actions | workflow 使用 `ubuntu-24.04` x64、锁定 Playwright 1.64.1 和 `.node-version`；主浏览器任务运行 `PLAYWRIGHT_USE_PRODUCTION_SERVER=true pnpm e2e`，workflow 未设置 HTTP proxy | 旧基线 run `42344017199` 成功（SHA `628a3a2182917e7558ad7219088c2add78baf3ff`）；它早于本轮变更 | 当前提交推送后的精确 SHA/CI 结果在交付记录中核对；旧基线通过不代替本轮 CI |

macOS 主机与 Linux 容器用的是同一 Playwright/Chromium 版本；Linux arm64 与 x64 容器均失败，macOS 主机通过。独立静态 fixture 也只在 Linux 容器复现。故已将根因收窄到本地容器化 Linux Playwright 下载观测环境与主机运行环境的差异，当前证据不支持架构差异或产品响应错误。没有改小预期文件名，也未改产品下载行为；日常本机 E2E 改在原生 macOS 主机执行，Linux CI 在 GitHub host runner 执行。Linux 容器场景保留严格失败证据，不据此宣称通过。

### 定向与完整验证

- 更新后的私有文件 Playwright 回归：本机 macOS arm64 1/1 通过；首个与重复下载都得到 `顾客授权说明.txt`，并通过响应头、字节和 SHA-256 断言。
- API 私有文件回归：`test/private-file-delivery.integration.test.ts` 10/10 通过，覆盖下载授权、中文 RFC 5987 编码、ASCII `delivery-notes.txt` 文件名、文件字节与 SHA-256。
- 本机完整浏览器命令 `pnpm e2e`：主套件 96/96、备用品牌 1/1、SSR 错误 4/4、开发预览 1/1 通过；`test:e2e:production-brand` 1/1 通过。
- `pnpm test:release`：7/7 Node release tests、host broker、隔离 Compose、image metadata 检查通过。
- `pnpm build` 和 lint/typecheck 通过；lint 为 0 错误、7 条既有 `apps/web/pages/products/[id].vue` 排版警告。
- 本机完整 `pnpm verify` 已执行，但在 API 测试阶段退出 1：Vitest 为 99 个文件中 85 通过、11 跳过、3 个文件失败（903 tests passed、26 skipped、12 failed）。失败集中于既有备份归档/Restic 路径安全 fixture 在 macOS 文件系统上的路径属性校验（`DEPLOYMENT_ARCHIVE_PATH_INVALID`、`RESTIC_CONTAINER_SOURCE_INVALID`、`RESTIC_READER_PATH_INVALID`），与下载代码无关；因顺序执行在 API 阶段停止，构建、浏览器套件和 production-brand 已按 `pnpm verify` 后续步骤单独执行并通过。Linux x64 CI 将用于核对这些平台相关测试。

### 范围收尾

未修改 PostgreSQL 恢复链、备份创建逻辑或正式生产恢复边界。真实 ENOSPC 故障注入移至⑦-6，必须使用有容量限制的隔离文件系统；禁止通过耗尽宿主机磁盘实现。当前浏览器差异只在隔离 Linux arm64 Playwright 运行时复现，不构成真实客户桌面浏览器或异地主机灾备验收。
