# ⑦-1B-3C-2B 验收记录

验收对象：商城仓库 `/Users/muchen/Documents/ChatGPT/AiKayun`，起始冻结基线 `31da224c9a60e66e1a0cfab75b6261cfc868a95e`。授权中心仓库 `/Users/muchen/Documents/ChatGPT/AiKayun-License` 全程只读，冻结提交 `6f554b51b867a15ad7747c6d002b548e016f65c6`。商城实现未接入订单、充值、支付、退款、提现、数字交付或 worker。

## 冻结中心真实 HTTPS 互操作

运行 `scripts/test-license-center-interop.sh`。脚本在临时目录按冻结 SHA checkout 授权中心并用其 lockfile 安装依赖，启动 PostgreSQL 18 和中心真实 Fastify HTTPS 服务、实际签名验证、激活处理、激活码签发业务逻辑及数据库事务。商城侧使用临时数据库 schema、Ed25519 身份、Trust Bundle 和 TLS CA。脚本结束时清除临时 checkout、数据库容器、密钥与证书。

| 场景 | 结果 |
| --- | --- |
| 完整 activation 成功 | 通过。中心真实 `/v1/activations` 只产生一条 activation，generation 为 1，原激活码消费一次；商城保存并回读原始 lease JWS 与请求摘要。商城 operation/attempt 只记录 `response_saved` 证据，没有写终态、权益 projection 或经营 allow。 |
| 两个商城调用竞争同一 operation | 通过。operation 锁、事务检查和部分唯一索引最终只允许一个初始 activation attempt；中心实际 activation 只有一条，另一调用不会生成新 operation 或重发。 |
| Challenge 与可信时间 | 通过。Challenge 请求和 activation 请求使用同一 RFC 9421/RFC 9530 签名/HTTPS 实现；Challenge 由冻结中心签发并绑定 operation、intent、安装身份和 JKT。Challenge 响应后的新鲜 3B 时间样本用于验证签名及有效期，并传给 activation 构建流程。lease/拒绝回执归档后再取得新样本用于当前 key 生命周期与 JWS 验签。 |
| 请求完整性拒绝 | 通过。冻结中心拒绝 body、Content-Digest、签名、nonce 和 JKT 篡改，以及不可信 TLS；请求固定到发行 origin 的 `/v1/activations`。 |
| 签名拒绝回执 | 通过。真实中心签名的 HTTP 409 receipt 先加密归档再验签；完整绑定 operation、intent、license、actor JKT、attempt、nonce hash、body digest、拒绝状态和 outcome code。HTTP 状态本身不构成本地授权。 |
| 未签名错误与提交未知 | 通过。未签名 403/409、503、超时、发送前断线、中心 COMMIT 后丢弃响应及无效 JWS 均不产生本地伪终态；提交未知保留原 operation 和 attempt，不再次激活、不再次消费激活码。收到的无效 Compact JWS 也先存入加密 response evidence，再因验签失败而拒绝使用。 |
| 真实 SIGKILL 边界 | 通过。七个独立子进程在 attempt 提交前/后、`sent` 提交后、发送前、响应返回后、响应保存前/后被 `SIGKILL`。持久化证据保留；已提交中心激活的断响应场景不重复激活。 |
| 真实中心版本与测试数量 | `13 passed (13)`，全部通过；不是 mock 中心证明。 |

`pnpm verify` 中这组测试因为它不启动隔离授权中心而显示 `13 skipped`；上述独立脚本以真实中心和 PostgreSQL 18 执行了全部 13 项。

## 商城完整验证

最后一轮 `pnpm verify` 在临时 PostgreSQL 18 容器和 `_test` 数据库上通过，命令结束时容器被删除。

| 检查 | 结果 |
| --- | --- |
| 锁定依赖 | `pnpm install --frozen-lockfile` 通过；`package.json` 和 `pnpm-lock.yaml` 未修改。 |
| lint | 0 errors；商品详情页现有 7 条 Vue 排版 warning。 |
| API/Web typecheck | 通过。 |
| 金额单测 | 16/16 通过。 |
| API + PostgreSQL 集成 | 34 个测试文件通过、1 个有意 skip；536 passed、13 skipped（其中 13 项由上面的真实中心脚本执行）。 |
| API、packages、Nuxt 生产构建 | 通过。 |
| Playwright 主套件 | 93/93 通过。 |
| 替代租户品牌 | 1/1 通过。 |
| SSR 错误处理 | 3/3 通过。 |
| 开发预览和生产品牌 | 各 1/1 通过。 |
| Google Fonts 在线元数据 | 构建和 Nuxt 测试服务器连接超时；现有字体 provider 回退成功，全部构建与浏览器测试仍通过。 |

`node scripts/verify-digital-recovery.mjs` 在其自建隔离 Compose 项目中通过：API 与 PostgreSQL 分别被 `SIGKILL` 并替换，业务历史摘要一致；配对备份恢复验证包含安装身份、Trust Store 和加密 Pending key；六种履约方式恢复、真实未信任 TLS 拒绝及对账差异 0 均通过。脚本移除了自己的容器、卷、网络、镜像和临时目录。

API runtime image 以 Dockerfile `runtime` stage 构建并逐文件扫描：6,180 个常规文件、251 个符号链接，运行 UID 1000、`NODE_ENV=production`。未发现 `/app/test`、`/app/src`、fixture、`.env`、PEM/key/p12/pfx 文件、真实私钥 PEM 内容或测试凭据/激活码标记；临时 audit 镜像已删除。镜像包含 436 个构建产生的 JavaScript source map 文件；这些文件中未发现上述敏感值或互操作 fixture 标记。

## 状态边界与复现

本阶段仅交付内部 `submitPendingActivation(operationId)`、加密 attempt request/response evidence 和未投影验证结果。没有公开路由、管理 UI、经营授权门禁、query/continue 自动恢复 worker、3D 投影、续签、迁移流程、正式生产 root/激活码、生产部署或中心改动。提交未知的恢复仍由后续 3C-3 使用同一 operation 与 attempt 证据解决。

```sh
scripts/test-license-center-interop.sh
pnpm verify
node scripts/verify-digital-recovery.mjs
```

完成 3C-2B 后在本阶段停止，等待独立严格验收；不进入 3C-3 或 3D。
