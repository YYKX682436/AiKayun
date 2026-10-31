# ⑦-1B-3C-3B 验收记录

对象：商城 `/Users/muchen/Documents/ChatGPT/AiKayun`。实施起点 `8addb5046faccf0868f9914e072f64ce948b823f`。授权中心 `/Users/muchen/Documents/ChatGPT/AiKayun-License` 只读冻结 SHA `a5cf99439e3bf92b65f19d60c013bca088cf221a`。

## 真实冻结中心 HTTPS / PostgreSQL 18

运行 `bash scripts/test-license-center-interop.sh`：67 passed、0 failed。脚本从本机已核验的只读冻结中心 checkout 创建临时源码副本，使用真实 PostgreSQL 18 和 HTTPS/Fastify 中心服务；只清理脚本自己的临时 checkout、数据库容器和临时目录。

覆盖原 3C-3A query/continue 回归及本阶段恢复路径：

- 原 lease 过期后，从当前中心证明恢复有效 lease；订阅续费后 revision 从 1 升至 2，恢复请求仍绑定历史 revision 1，接受中心签发的 revision 2。
- 原签名者正常退休及紧急吊销后，用当前中心证明与当前 signer 重新签发 lease。
- expired、revoked、superseded 状态签名被验证和归档，结果不包含当前凭证；恢复源身份变更及原始 JWS 篡改均失败关闭，不创建 recovery operation。
- 恢复响应丢失和 HTTP 超时后查询原 recovery operation；签名 `not_found` 后用同一 operation ID continue；两路并发重入只保留同一 recovery operation，activation generation 仍为 1，激活码只消费一次。
- recovery 响应保存后对夹具进程 SIGKILL，再启动新进程查询中心恢复；本地操作 ID 与 center operation 不增加。
- 操作表测试覆盖加密 recovery intent、renewal request attempt 校验、同源并发重入及 PostgreSQL COMMIT acknowledgement 丢失后的 operation 复用。

## 全仓验证

`pnpm verify` 在独立 PostgreSQL 18 `_test` 数据库上退出码 0：

- ESLint：0 errors；7 条既有 Vue warning 位于 `apps/web/pages/products/[id].vue`。
- 类型检查及生产构建：通过。
- API：34 个测试文件通过、1 个跳过；541 passed、54 skipped。Money：16 passed。
- 主 Playwright E2E：93 passed；alternate brand：1 passed；SSR errors：3 passed；dev preview：1 passed；production brand：1 passed。

`node scripts/verify-digital-recovery.mjs` 退出码 0：隔离 Compose 的 API/PostgreSQL SIGKILL 替换、v5 配对备份还原、Trust Store、身份、业务文件、恢复账本及 TLS 拒绝检查通过；summary 中 `licensePendingBackupRestore=true`，reconciliation differences 为 0。脚本清理了自身 Compose 项目、卷、网络、镜像和临时目录。

## 迁移和剩余边界

新增单个增量迁移 `202610310002_license_operation_recovery_attempts`，扩展现有 attempt purpose/check 与归档触发器；没有新增表。`license-pending-restore-check` 可校验恢复 metadata 与 attempt。授权中心仓库无变更。

本阶段仅返回经过验证、未投影的恢复证据；不新增公开路由、业务授权投影、自动续签 worker、UI、经营门禁或生产部署。独立验收后应保持此边界，不据恢复 lease 推导订单/充值权限。
