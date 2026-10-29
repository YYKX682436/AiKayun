# ⑦-1B-3B 验收记录

## 验收范围

商城代码基线：`ce01affdc69771537e219ddf8746cb8c24f27001`。授权中心仓库保持只读，起止提交均为 `6f554b51b867a15ad7747c6d002b548e016f65c6`。没有生产 root、生产发行清单、真实客户授权或授权中心部署。

本轮验证 root-signed bundle 与 time-anchor/JWT 兼容、严格证据类型、双文件 TrustStore 恢复、API 专属持久卷及 v4 配对备份。没有增加商城经营门禁、授权数据库、API 激活路由或生产信任回退。

## 回归与执行结果

| 项目 | 命令/证据 | 结果 |
| --- | --- | --- |
| 锁定依赖安装 | `pnpm install --frozen-lockfile`，pnpm 10.29.3 | 通过，lockfile 无变更漂移 |
| Trust Bundle、真实中心互操作、时间引导、JWT 类型和崩溃测试 | `pnpm --filter @aikayun/api exec vitest run test/licensing-trust.test.ts` | 14/14 通过；使用冻结中心提交生成的真实 Ed25519 签名样本、临时密钥和隔离本地 HTTPS |
| TrustStore SIGKILL | 上述用例中的真实子进程 `SIGKILL` | 覆盖 pending checkpoint、state 写入与提交 checkpoint 的 18 个边界；重启后只恢复完整旧头或完整新头 |
| 全仓 lint / 类型检查 | `pnpm verify` | lint 0 errors；有 7 条 `apps/web/pages/products/[id].vue` 既有格式 warning；API 与 Web 类型检查通过 |
| 单元和 PostgreSQL 集成 | `TEST_DATABASE_URL=<本轮临时隔离 _test PostgreSQL> pnpm verify` | money 16/16；API 30 个文件、514/514 测试通过，使用临时本地 PostgreSQL 容器，不连接默认商城数据库 |
| 生产构建 | `pnpm verify` | API 和 Nuxt 生产构建通过。构建期间 Google Fonts 元数据请求超时，provider fallback 后成功；未改字体/页面实现 |
| 浏览器回归 | `pnpm verify` | 93 项生产服务器主套件、品牌变体、SSR 错误态（3/3）、开发预览（1/1）均通过 |
| 生产品牌回归 | `pnpm --filter @aikayun/web test:e2e:production-brand`（包含于 `pnpm verify`） | 1/1 通过 |
| Compose SIGKILL 与 v4 配对恢复 | `node scripts/verify-digital-recovery.mjs` | 通过。独立 Compose API 与 PostgreSQL 分别强杀重建；数据库、3A identity、公开/私有文件及 Trust Store 一致恢复；全部履约方式恢复，账实差异 0，未信任 TLS 握手被拒 |
| 实际 TrustStore 备份/恢复 | 同一隔离 Compose 演练 | 测试 helper 进程内生成临时 root/center Ed25519 key，接受 root-signed v1 bundle；备份后删除卷内 state、checkpoint 和 marker，再恢复并以发行 root 公钥、artifact digest 和 bundle version 重新验签通过。密钥和项目卷随演练清理 |
| Docker runtime 镜像审计 | `apps/api/Dockerfile` 临时镜像构建与 `/app/dist` 检查 | 通过：应用镜像只复制 package metadata、生产依赖和 dist；无应用 `src/`、`test/`、签名互操作 fixture、离线签发接口、license 私钥材料或生产 root；TrustStore 模块在镜像内成功加载。临时 audit tag 已删除 |
| 文件与 shell 语法 | `git diff --check`、`node --check scripts/verify-digital-recovery.mjs`、`node --check apps/api/test/fixtures/trust-store-compose-restore.mjs`、`bash -n scripts/backup-compose-data.sh scripts/restore-test-compose-data.sh` | 通过 |

TrustStore 回归另覆盖：版本最低值和回退、同版本异工件、v1(A)→v2(A+B)→合法退休→`verify_until` 后移除、active key 静默删除、紧急撤销、两类永久墓碑与复活拒绝、错 root/issuer/schema/typ/aud/JWK/kid、重复 JSON 字段、错误签名、state/checkpoint 错代、单文件缺失、损坏和 API 用户目录权限。resolver 在新 bundle 提交后会重新检查当前 checkpoint，旧 resolver 拒绝继续代表当前信任。

时间回归覆盖正确 nonce、nonce 错配与重放、错误 kid、重定向、重复字段、响应超限、无信任 CA、hostname 错配、超过 5 秒超时和样本过期；JS wall clock 前/后偏差五年时仍采用签名 server_time，没有改系统时钟。TLS 证书真实验证保持开启。

## 生产与恢复边界

- `trusted-release-license-config.generated.ts` 目前仍为 `null`。生产能力状态必须是 `trust_uninitialized`；开发样例 root、互操作测试 issuer 和测试 key 不作为生产回退。
- 本轮没有正式中心 bundle 下载接口；导入只接受调用方明确提供的 root-signed 工件。没有首次网络信任或后台下载 worker。
- 严重主机时钟偏差仍可能先使 TLS 证书校验失败，签名时间引导对此场景为 `NOT_VERIFIED`；不能关闭 TLS 校验代替时钟修复。
- 信任卷全丢时不会自动重放工件，状态报告 `bundle_not_initialized`，需要显式重新提供工件并满足发行最低版本。卷丢失本身不能从已丢失的 checkpoint 推断最后接受的高版本；同一高权限操作者同时回滚中心数据库和所有客户持久介质，也不在双文件 checkpoint 可证明的范围内。
- 未验收真实中心 HTTPS 生产网络、正式签名发行工件、真实客户租户、生产镜像发布和生产备份恢复。
- ⑦-1B-3B 完成后在此停止。3C 激活与 attempt 恢复、3D 经营状态投影、3E time-reset/迁移/灾难重绑、3F 最终订单/充值门禁均未开始。

## 提交与 CI

待提交并推送后，在此记录精确 main SHA、`origin/main` 和对应 GitHub Actions CI 结果。只有与最终 SHA 完全一致的 Actions run 通过，才将该项记为完成。
