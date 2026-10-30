# ⑦-1B-3C-3A 验收记录

验收对象：商城 `/Users/muchen/Documents/ChatGPT/AiKayun`，冻结起点 `8a1d6f29b68d34cdc649b3941d51789dba53eca9`。授权中心 `/Users/muchen/Documents/ChatGPT/AiKayun-License` 保持只读，HEAD 为 `6f554b51b867a15ad7747c6d002b548e016f65c6`。

## 中心真实 HTTPS/PostgreSQL 18 互操作

使用 `scripts/test-license-center-interop.sh`。脚本在临时目录按中心精确 SHA checkout、安装锁定依赖，并启动 PostgreSQL 18 与冻结 Fastify HTTPS 服务。中心 TLS/HTTP 签名、Challenge、operation/attempt 持久化、事务锁、activation 和 query/continue 均走真实实现。商城测试 schema、身份密钥、Pending AES-GCM key、Trust Bundle 和 TLS CA 均为临时数据，脚本退出即清理。

| 场景 | 验收结果 |
| --- | --- |
| 已成功 activation 后 query | 通过。外层 query receipt 当前 attempt 元组与原 activation 提交元组分别匹配；原 lease 按字节归档在提交 attempt，query 回执保存在自己的 attempt，父操作指针更新也未覆盖原响应；generation 仍为 1。 |
| 中心已提交但 activation 响应丢失 | 通过。query 找回原 operation 的 committed receipt 和精确原始 lease；未重发 activation，中心 operation/activation 只有一条，generation 不增加。 |
| query `not_found` 后 continue | 通过。continue 只使用同 operation、同 intent、原 activation code/origin、`kind=activation` 和全新 Challenge/attempt；中心只消费一次激活码并创建 generation 1。 |
| continue 响应丢失后再次恢复 | 通过。首次 continue 已在中心提交但响应丢失；后续显式调用 query 找回 committed 状态，不再发送第二个 continue 或新 activation。 |
| 原 activation 与 query/continue 迟到竞争 | 通过。真实原 activation 请求被测试 gate 暂停；query 观察 not_found，continue 在同 operation 提交，迟到原请求恢复后仍只有一个业务终态与 generation。三个本地 attempt 连续且 query/continue 响应不被较早 attempt 覆盖。 |
| 多进程恢复同一 operation | 通过。两个独立 Node 进程争用 PostgreSQL session advisory lock；只有一个继续执行提交，另一个 query 命中原 committed 结果。 |
| 双层 nonce/digest 和精确 schema | 通过。解密核对 query 精确公共字段和 continue 精确公共字段加 `kind/activation_code/origin`；当前回执 attempt nonce/digest 与原提交 attempt nonce/digest 分开匹配中心真实 attempt。每次 Challenge/client nonce/server nonce 均新建。 |
| 历史签名 rejection | 通过。中心对已撤销 license 的 query 因 actor 未关联 active activation 返回签名 not_found；客户端从完整 attempt 历史重新验签原始 activation rejection，按已验证拒绝事实返回并停止续接。响应历史分别保留。 |
| 错误/未签名结果 | 通过。无签名 403（错误 activation code）、5xx、429、错误 actor、错误 operation、未知 committed attempt、伪造 not_found result、错误 request digest、错误签名和不受信任 kid 均不产生本地伪终态；原 operation/intent/code 占位保留。 |
| 过期原 lease | 通过。测试 fixture 在隔离中心测试数据库中构造并持久化一个中心签名但过期的原 result，再由中心 query receipt 引用。商城只归档 `historical_only` 事实，不产生 `allow`/`grants` 或经营投影；中心 generation 仍为 1。此项验证过期 lease 时效，不模拟旧签名 key 已超过 Trust Bundle 保留期限。 |
| 强杀与提交确认未知 | 通过。独立进程在 query attempt 提交后、query response 保存后、continue response 保存后 SIGKILL；重启从同 operation 和下一个新 attempt 恢复。另注入 PostgreSQL 写入已提交但客户端确认丢失，确认该 attempt 为 `prepared`、未发送 HTTPS，后续安全恢复。 |
| 中心协议缺口 | 通过 fail-closed 验收。随机错误 activation code 在中心返回未签名 403；内部 API 报告 `requires_protocol_resolution`，没有中心终态、没有 generation/code 消费，也不能新建第二个本地 operation。 |
| 测试数量 | 冻结中心脚本：22 passed，0 failed。 |

真实运行日志用于最终验收，不以本表替代运行结果。为测试过期原结果，fixture 只操作临时 PostgreSQL 数据；它不修改授权中心仓库源码、迁移或生产数据。

## 全仓与部署恢复验证

| 命令/检查 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过；锁文件未变更。中心互操作脚本也在临时中心 checkout 中按 frozen lockfile 安装依赖。 |
| `pnpm lint` | 通过，0 errors；7 条 Vue warning 均在 `apps/web/pages/products/[id].vue`：1610 行 2 条、1631 行 1 条、1632 行 2 条、1633 行 2 条。 |
| `pnpm typecheck` | 通过。 |
| `pnpm test`（含真实 PostgreSQL 集成） | `pnpm verify` 中通过：money 16 passed；API 34 个文件通过、1 skipped，537 passed、22 skipped。冻结中心 HTTPS/PostgreSQL 互操作另外独立运行，22 passed、0 failed。 |
| `scripts/test-license-center-interop.sh` | 22 passed；0 failed |
| `pnpm build`（生产构建） | 通过。构建期间 Google Fonts metadata 请求超时并使用本地 fallback；构建成功。 |
| Playwright 主 E2E 和生产 branding E2E | 通过：主 E2E 93 passed；alternate brand 1、SSR errors 3、dev preview 1、production brand 1 passed。 |
| `pnpm verify` | 通过，退出码 0；包含 lint、typecheck、money/API tests、生产构建和上述 E2E。为其启动独立 PostgreSQL 18 测试容器。 |
| `node scripts/verify-digital-recovery.mjs` | 通过，退出码 0。独立 Compose 场景完成 API/PostgreSQL 强杀与重建、TLS 错误拒绝、v5 配对备份还原；数据库、安装身份、Trust Store、Pending key 和业务文件恢复后校验一致，恢复对账差异为 0。 |
| 临时物料清理 | 互操作脚本清理其中心 checkout、证书、密钥和容器；数字恢复脚本清理隔离 Compose 项目、镜像和 volumes；另行移除本轮独立 PostgreSQL 容器及 ignored 构建/E2E 输出。商城依赖目录和现有 Compose 服务保留。 |

## 未终结 Pending 与协议建议

冻结中心在 activation code 无效、过期或已消费时可能返回未签名 403，不能安全区分“业务拒绝终态”与“无 operation 记录/请求未完成”。本地不得删除唯一 operation、改 `not_found` 为 terminal、换 code、释放原 Pending 或重建 operation。建议中心在同一 operation 锁内对确定性错误持久化原始签名终态 receipt、`terminal_reject` attempt 和 `rejected` operation；临时错误继续保持可续接。另建议现有 operation actor 在没有 active activation 时仍能 query 自己已持久化的终态，避免被 `not_found` 掩盖。

本阶段没有独立 recovery operation、自动重试 worker、经营门禁、权益投影、公开 API/UI、生产密钥、部署或授权中心改动。订单、支付、退款、提现、履约、采购与既有 worker 行为保持原样。完成 3C-3A 后立即停止，等待独立严格验收，不进入 3C-3B。

## R1：连接池隔离与结果归档恢复

商城 R1 起点为 `2a770da1e6c6d65c48015235462399e4a87a064e`，授权中心仍固定于本文所列 SHA。旧实现的真实中心回归中，业务池 `max=1` 单次恢复、`max=2` 并发恢复占满、`max=1` 业务连接暂时占满三个场景均在 8 秒内无法完成。修复使用独立受控持锁 session、保留原锁键并设置有界等待；持锁 session 断线时不把已发出的请求判断为未到达中心。

旧恢复预检漏检复现：真实数据库中已持久化 result JWS，将归档密文翻转一字节后旧 verifier 仍退出 0。R1 逐 attempt 调用既有结果读取和解密逻辑，并以迁移回填的单调存在标记识别归档整组缺失。针对性 PostgreSQL 测试 10/10 通过，覆盖旧记录、迁移回填、整组或部分缺失、密文损坏、错误 key、AAD 与摘要。独立 Compose fixture 经生产归档函数保存临时签名的 Compact JWS，在 API/PG 强杀重建和 v5 配对恢复后逐字节比较。

如果归档字段及独立存在标记等所有数据库证据同时被抹除，且无其他可信证据，无法区别合法旧记录；v5 备份文件校验和仍用于发现文件传输损坏。R1 不改变 v5 配对格式或原 operation 状态机。

R1 最终代码本地验收：

| 检查 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过，锁文件未变。 |
| 冻结中心真实 HTTPS/PostgreSQL 互操作 | 26 passed，含原 22 项、池饥饿、多进程、锁等待超时和发送前/响应后锁连接断线。 |
| `pnpm verify` | 通过：lint 0 errors、7 条既有 Vue warning；typecheck 通过；money 16 passed；API 538 passed、26 skipped（中心互操作另行通过）；生产构建通过；主 Playwright 93 passed，alternate brand 1、SSR errors 3、dev preview 1、production brand 1 passed。Google Fonts metadata 请求超时后使用 fallback。 |
| `node scripts/verify-digital-recovery.mjs` | 通过，退出码 0。隔离 API 和 PostgreSQL SIGKILL 重建、v5 配对备份恢复及采购恢复均通过；真实持久化的测试签名 result JWS 在各阶段逐字节一致。 |
| 清理 | 测试脚本清理隔离 Compose 资源及临时中心 checkout；独立测试 PostgreSQL 和生成的构建/E2E 产物在验收后清理。 |
