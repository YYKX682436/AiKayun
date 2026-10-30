# ⑦-1B-3C-2A 验收记录

验收对象：商城仓库 `/Users/muchen/Documents/ChatGPT/AiKayun`，起始冻结基线 `ba611606bd1e068ee937d1dee6ec27926c75ee50`。授权中心仓库 `/Users/muchen/Documents/ChatGPT/AiKayun-License` 仅只读，冻结提交 `6f554b51b867a15ad7747c6d002b548e016f65c6`。

## 真实跨仓 HTTPS 验收

`scripts/test-license-center-interop.sh` 在临时目录 clone 并 checkout 授权中心上述精确 SHA，按该中心 lockfile 执行 `npm ci`；启动固定 digest 的 PostgreSQL 18 容器及冻结源码中的真实 Fastify app、challenge/time-anchor handler、数据库迁移与 HTTP Message Signature 验证实现。测试临时创建 Ed25519 身份、测试 root、中心签名 key 与 TLS 证书，只把公用 bundle/JWK/CA 信息提供给商城测试端；临时 checkout、数据库、密钥、证书与容器由 trap 清理。CI 工作流运行同一脚本，避免依赖开发者长期 checkout。

| 验收项 | 结果 |
| --- | --- |
| 真实成功 Challenge | 通过。真实 3A Ed25519 私钥、数据库 binding、公钥和 JKT 与中心完成 HTTPS `/v1/challenges`；客户端仅返回绑定 operation 的 `VerifiedBoundChallenge`。 |
| RFC 9421 / RFC 9530 | 通过。中心源码接受组件顺序 `@method`, `@target-uri`, `content-type`, `content-digest`；`keyid` 为 JKT、`alg=ed25519`、`tag=aikayun-license-v1`，窗口不超过 60 秒。`Content-Digest` 与发送的原始 body bytes SHA-256 一致。 |
| 中心拒绝无效签名请求 | 通过。错误私钥、错误 JKT、签名篡改、请求 body 被改、错误 `Content-Digest`、过期 HTTP 签名均被真实中心拒绝。 |
| 本地 Challenge 绑定拒绝 | 通过。错误 operation 类型、operation ID、intent digest、instance ID、identity JKT、client nonce、签名时间边界及无效 server nonce 均被绑定检查拒绝。 |
| JWS / Trust Bundle 失败 | 通过。Challenge 已过期、未来签发、未知 `kid`、被撤销 key 均不能通过当前可信 resolver 的验签；有效签名 key ID 从已验证 JWS header 导出。 |
| TLS 与响应限制 | 通过。错误 hostname、未信任证书、HTTP redirect、5 秒超时、声明长度超限和 chunked 响应超限均拒绝；不跟随 redirect。 |
| 并发与短暂中断 | 通过。网络中断后用同一 pending operation 重试；并发 Challenge 使用相同 operation 和 intent、不同随机 client nonce，不生成新 operation 或 activation attempt。 |
| 无授权副作用 | 通过。商城 operation 仍为 `pending` 且无 attempt；中心 activation/operation/attempt 表均为 0；商城没有 license projection。 |

## 商城及部署回归

| 检查 | 结果 |
| --- | --- |
| `scripts/test-license-center-interop.sh` | 通过，真实中心互操作专项 7 项均通过。该脚本使用独立 PostgreSQL 18 与精确中心 SHA。 |
| `pnpm verify` | 通过。`pnpm lint` 0 errors（商品页已有 7 条 Vue 排版 warning）；前后端 `typecheck` 通过；money 包 16 项、API 532 项通过。API 内 7 项跨中心用例因完整验证命令未提供隔离中心 checkout 而跳过，并已由上方专项脚本真实执行通过；生产构建通过；主 Playwright 93 项、品牌变体 1 项、SSR 错误 3 项、开发预览 1 项、生产品牌 1 项全部通过。测试 PostgreSQL 是随机端口映射的临时 PostgreSQL 18 `_test` 数据库，未写入当前开发实例。 |
| `node scripts/verify-digital-recovery.mjs` | 通过。脚本专属隔离 Compose 项目中 3A identity 初始化/验证、API 与 PostgreSQL SIGKILL 替换、业务快照、私有文件恢复、3B Trust Store 与加密 Pending key 配对备份恢复、未信任 TLS 拒绝均通过；恢复前后业务历史摘要一致。脚本清理了自身容器、卷、网络、镜像和临时目录。 |
| API 生产镜像内容扫描 | 通过。构建最终 runtime stage 并扫描 `/app` 6,171 个文件；运行用户为 `node`、`NODE_ENV=production`。无 `/app/test`、源码目录、授权中心 fixture、测试证书/key 文件或跨仓测试标记。生产镜像只复制生产依赖、API `dist` 与 package metadata。 |
| 正式发行配置 | 通过边界核对。`generatedTrustedReleaseLicenseConfig` 仍为 `null`；没有生产 root/key 初始化、密钥轮换、部署或中心状态变更。 |

Nuxt 生产构建和 Playwright 启动时，外部 Google Fonts 元数据连接超时，provider 使用回退并继续；构建及浏览器测试通过。构建不依赖该网络请求取得成功。

## 复现命令与 CI

```sh
scripts/test-license-center-interop.sh
pnpm verify
node scripts/verify-digital-recovery.mjs
```

`.github/workflows/ci.yml` 将冻结中心 HTTPS/Challenge 互操作脚本加入 `verify` job。脚本每次在干净环境按 SHA 拉取中心，不会使用工作站中心 checkout。镜像扫描是交付前手动验收步骤，未把测试私钥、测试 root 或测试 TLS CA 作为构建输入。

## 停止点与未覆盖项

3C-2A 仅交付内部 HTTPS Challenge、真实中心 JWS 验签和本地 operation 绑定。Challenge 不是激活回执，不创建经营授权或投影。没有真实 activation、卡密消费、query/continue、自动续签、故障恢复状态机、3D 投影、经营门禁、管理 UI、正式发行 root/key 或生产部署。本记录完成后应停止，等待独立严格验收。
