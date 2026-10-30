# ⑦-1B-3C-1 验收记录

验收对象：商城仓库 `/Users/muchen/Documents/ChatGPT/AiKayun`，冻结基线 `b18806b73f2e30c5548d59b56cb48d8c68c4a273`。授权中心仅按只读基线 `6f554b51b867a15ad7747c6d002b548e016f65c6` 审计；未修改中心仓库。

## 已完成验收

| 项目 | 结果 |
| --- | --- |
| activation intent JCS 与中心跨仓向量 | 通过。逐字段算法相同，SHA-256 输入为激活码规范 Base64URL 文本；向量不含真实授权码。 |
| AES-256-GCM key 文件与 AAD | 通过。跨重载解密；篡改、错 operation/字段 AAD、替换 key、key ID 不符、缺失、symlink、hardlink、错误 mode 及损坏均失败关闭。加载器同时核对 POSIX owner；本轮未单独构造错误 owner fixture。 |
| PostgreSQL 操作/attempt 约束 | 通过。重复请求幂等、intent 冲突、同安装身份抢占、并发进程分配连续 attempt、不可变记录、非法 SQL 修改、状态回退/本地终态、重复编号及 DELETE/TRUNCATE 拒绝均有真实 PostgreSQL 覆盖。 |
| DB commit 与进程强杀 | 通过。操作/attempt 提交前 SIGKILL 无记录；提交后 SIGKILL 保留记录，重放读取同一 operation/attempt，不重复分配。 |
| 配对备份预检 | 通过。实际隔离 Compose 使用 v5 配对 DB 与 key 卷，恢复前 verifier 解密 activation payload、request envelope 和加密响应。v4、缺 key、替换 key 的脚本预检测试均在任何 Docker 操作前拒绝。 |
| 真实 Compose 强杀与恢复 | 通过。隔离恢复脚本分别 SIGKILL 并替换 API、PostgreSQL 容器，随后校验操作与 attempt 仍可解密；执行 v5 配对备份/恢复后再次核对。脚本只创建并删除自身带 `-test` 名称的项目、容器、网络和卷。 |
| 商城恢复快照与既有功能 | 通过。隔离验收对订单、库存、支付/收据、退款、提现、交付、supplier/procurement 操作快照及 reconciliation 进行恢复前后比对；验证私有文件下载 SHA-256、所有六种交付方式及采购恢复数据保持一致。 |
| `pnpm verify` | 通过。Node `24.22.0`、锁定依赖；lint 0 errors（既有商品页有 7 条 warning），typecheck、528 API 测试、16 money 测试、生产构建、93 主 E2E、备用品牌 1 项、SSR 3 项、开发预览 1 项、生产品牌 1 项全部通过。 |
| Compose 配置与 shell 语法 | 通过。`docker compose config --quiet` 及新增/修改备份脚本 `bash -n` 通过。 |

`pnpm verify` 的测试 PostgreSQL 使用单独临时容器和 `_test` 数据库；测试结束停止并删除。全程未对已有 `aikayun` DB、容器或授权中心执行写入。`pnpm verify` 的 Nuxt 构建成功；Google Fonts 元数据不可达产生字体 provider warning，不影响构建及浏览器测试。

## 权威与权限边界复核

- 唯一 operation 权威是 PostgreSQL 父表；activation code、完整请求封套及原始签名响应只以独立 Pending key 加密后持久化。
- operation ID、业务意图和 attempt 证据受约束保护；每个 operation 的编号由事务 advisory lock、父行锁和触发器共同连续分配。
- 迁移只允许 `pending → response_saved`；不提供本地 `projected`、`terminal`、`cancelled` 写入。终态不能由本地失败或超时伪造。
- 这轮未接入 HTTP/RFC 9421、challenge、激活码提交、query/continue、worker、经营门禁或 UI；response_saved 只是加密原始 bytes 已持久化，不是中心签名已验证或经营授权成功。
- 本地业务表和 worker 无授权依赖；本阶段没有执行真实授权操作。

## 备份与发行边界

当前格式明确为 `aikayun-compose-backup-v5`，恢复端拒绝 v4。测试证明缺 key、替换 key、格式不配对时预检拒绝；真实隔离恢复证明 DB 与原 key 卷配对后能解密。开发 v5 备份包括 3A identity 私钥与 Pending 解密密钥，没有备份机密性或生产密钥托管。正式发行前仍须设置受控密钥初始化、加密备份、密钥托管/分离和生产恢复演练门禁。

## 结论

3C-1 的 PostgreSQL 权威、加密 Pending key、append-only attempt 与 v5 测试恢复基础验收完成。按阶段边界停止；下一阶段需独立授权后再设计 3C-2 请求接口。本记录不表示授权中心真实互操作、生产恢复或经营授权已验收。
