# ⑥-4B-3：采购执行真实 SIGKILL 与全局恢复验收

## 范围、基线与隔离

固定冻结基线：`67c5a2859437b17bb53a00eef66687fecde73786`。本阶段只新增真实进程崩溃测试、隔离恢复夹具和验收记录；未修改正式采购执行、付款、退款、库存或履约实现。采购测试使用独立 PostgreSQL `_test` 数据库、私有临时目录、合成 `TST` 风险额度和独立供应商 HTTP 夹具。没有真实卡易信采购，没有部署，也没有开放自动采购或进入⑥-4C。

生产 `selectCheckoutProcurementSources()` 仍固定返回空集合。测试采购来源只由测试进程的模块加载器替换；生产没有该替身、故障注入开关或可用的真实采购 HTTP 通道。合成业务号只用于本地关联，不作为 `outerNumber` 去重或供应商幂等承诺。

## SIGKILL 方法和进程身份

采购 worker 与订单资料归档 API 均由测试控制器以独立 Node 子进程启动，分别创建自己的 PostgreSQL pool、Kysely 实例及执行上下文。父进程通过 IPC 等待事务检查点或响应门闩，然后直接向子进程发送操作系统 `SIGKILL`。测试断言子进程退出信号正是 `SIGKILL`，不是错误返回、正常关闭或 `SIGTERM`。恢复时重新 fork 新进程、创建新 pool，并读取 PostgreSQL 中已提交的事实；每个采购恢复场景和归档重放均断言新进程 PID 与原 PostgreSQL backend PID 都不同。PID 是每次运行时分配的值，测试逐次比较并断言替换，不把不稳定的 PID 常数固化进文档。

供应商 HTTP 夹具是另一个独立进程。夹具把接收的请求、执行结果和计数写入独立目录中的 JSONL/状态文件，并在每条记录后同步落盘。强杀采购 worker 不会清空或伪造夹具侧的提交、查单及执行计数。恢复结果因此同时由 PostgreSQL 历史和夹具自身持久记录核对。

| 边界 | SIGKILL 时点与提交状态 | 重启后核对结果 |
| --- | --- | --- |
| A. 准备事务提交前 | `prepareProcurementWithRisk` 已写操作、单位、预算预留及准备身份，但 PostgreSQL `COMMIT` 尚未执行。 | PostgreSQL 回滚整笔事务；操作、单位、预留、风险事件和准备身份计数均为 0。已付款订单仍为 `processing`，原支付回执仍为 1。新 worker 用原 request UUID 建立唯一完整身份。 |
| B. 提交意图后、HTTP 发送前 | 租约和唯一 `submit` 意图已提交；子进程在发起 HTTP 前的外部检查点被杀。 | 夹具计数 `submit=0/query=0/execution=0`。新 worker 只追加原身份 `query`；夹具 `not_found` 后操作仍为 `unknown`，风险仍为 `10 TST`。再遇查询错误仍为 `unknown`、预算保留，意图序列为 `submit, query, query`，从未创建采购。 |
| C. 供应商已执行、响应丢失 | 独立夹具已持久记录一次执行并保持 submit 响应门闩；本地 worker 仍在等待响应时被杀。 | 释放夹具门闩后，新 worker 只按原业务身份查单。最终计数为 `submit=1/query=1/execution=1`；原业务号、原操作和风险预留保留，状态恢复为 `success_pending_finalize`，不出现第二次创建。 |
| D. 响应解析后、证据事务提交前 | submit 响应已经到达并解析，worker 在写采购证据前的检查点被杀。 | 杀后数据库没有执行证据，状态仍为 `submit_in_flight`；夹具已有一次提交和一次执行。新 worker 忽略旧内存响应，只用原身份 query 并根据新观察提交 `success` 与 `delivery_confirmed`，submit 数仍为 1。 |
| E. 成功证据已提交、履约未完成 | 成功及逐单位交付证据已提交；该操作有两个单位，尚无履约交付行时杀死 worker。 | 重启后按原操作逐单位 finalize。合成夹具只确认单位 1；订单项数量 2，完成数 1，状态为部分履约；单位 1 `completed`、单位 2 `allocated`，单位 2 finalize 返回 `not_ready`。采购创建未重发。 |
| F. 履约提交后、响应返回前 | finalize 已提交履约尝试、交付和库存消费，worker 在返回 IPC 结果前被杀。 | 杀后已存在且仅存在 1 个履约尝试、1 个交付、1 次 inventory `consume`。全新 worker 和另一个 DB 调用重放 finalize 均返回 `already_completed`；库存 `stocked=9/reserved=1`、订单项 `fulfilled=1/quantity=2` 与单位状态一致。供应商仍为 `submit=1/query=0/execution=1`。 |

上述 PID/backend PID 由子进程 IPC 的启动消息读取：采购 worker 上报 `process.pid` 与 `SELECT pg_backend_pid()`，归档 API 同样上报二者。每次恢复的断言均要求两项身份变化。SIGKILL 信号由父进程等待真实 `exit` 事件取得并严格比较。子进程可以在测试完成后再次被 SIGKILL 清理，但这不替代表中强杀边界。

## 全局冲突与风险预算恢复

⑥-4B-2 R1 的跨操作单号冲突规则在真实 PostgreSQL 与进程恢复场景中复核：

- A 已接单、B 报告相同连接与供应商单号：在证据事务写入后、提交前强杀。杀后冲突行仍为 0、A 的预算仍保留；新 worker 查询同一原身份后写入双方冲突，B 进入 `manual_review`。A 的接单事实不回退。
- A 已完成、B 再报告同号：同样在冲突证据事务提交前强杀。恢复后冲突双方均有事实，A 保持 `completed`，已有交付不撤销。
- A 已明确拒绝并释放 10 TST，随后 B 报告相同单号：在追加冲突和 reinstate 的事务中、证据插入后提交前强杀。恢复前 A 敞口仍为 0 且冲突行不存在；新 worker 依照供应商事实恢复冲突，A 的风险恢复为 10 TST，原同单位替代操作和 B 各自的预留仍清晰分列。三类预算桶与冲突前值相比只增加这 10 TST，日毛新增保持不变，`reinstate` 仅 1 条。
- 恢复后重复观察已存在的冲突不会增加供应商请求、执行计数或 reinstate。迟到事实不自动覆盖 `completed`/`rejected` 终态。
- 对未解决冲突，测试覆盖退款 API 与数据库约束拒绝、人工交付 API 与数据库约束拒绝、新操作/submit intent 数据库门禁、自动 query 不发送及 finalize 返回 `not_ready`。订单 unresolved 门禁持续生效。
- 跨日恢复的旧操作不清空敞口；释放后可信矛盾事实可以使全局、供应商和 SKU 敞口高于限额，数据库流水不可截断或直接改桶，日毛新增不因释放或 reinstate 重算。

单笔采购恢复测试以每个合成操作 10 TST 风险预留核账；所有成功事实都不自动等于已确认扣费，本阶段不伪造商户扣款。独立风险预算专项同时验证确认 debit 必须关联明确金额/币种证据，并覆盖连接间真实锁竞争及 `pg_blocking_pids`。⑥-4B-2 原有 payment/refund、库存预留、六种履约方式、旧 `http_json_v1` 幂等/查单回归均包含在全量 API/PostgreSQL 与 Chromium 套件中。

## 购买资料和私有图片归档

新增 API 子进程使用独立私有目录和真实 checkout 入口；每个场景使用一个原购买草稿、一个幂等键和原请求体。归档强杀边界及提交状态为：

1. `archive_partial_copy`：图片校验/复制期间，私有 staging 已有部分字节，订单和归档对象数据库记录均未提交。恢复同一幂等请求后只生成一个订单及其完整归档引用。
2. `archive_object_registered`：图片已完整落入私有目录且 `prepared` 对象记录已提交，订单事务尚未开始。恢复后订单事务只绑定一次对象。
3. `attachment_binding_uncommitted`：订单、购买资料快照和附件引用正在同一 PostgreSQL 事务绑定，事务未提交。强杀后未出现订单或引用，已准备对象仍由现存数据和原请求恢复。
4. `checkout_committed`：成交事务已提交、原客户端尚未取得响应。杀后订单已恰有 1 条；新 API 进程用相同幂等键收到原订单（HTTP 200），不产生重复订单。

每种情形均断言恢复 API PID 和 PostgreSQL backend PID 与被杀进程不同。恢复后的订单数为 1，购买快照和附件引用各 1 条；通过原用户授权读取图片，比较数据库引用 SHA-256、对象 SHA-256 和文件内容 SHA-256，三者一致。测试还把回收时钟推进 26 小时，确认有效订单仍引用的 `retained` 对象不会被现有回收器删除。只允许 `prepared` 且未被有效附件引用的对象进入既有的延迟回收流程；本轮不直接删除文件或修改数据库对象状态来模拟回收。

既有购买资料专项也覆盖未提交归档对象、未引用对象的安全回收、事务进行中对象的回收围栏及有效引用的保留；本轮新增测试只将归档入口的四个真实 SIGKILL 边界接入同一原订单幂等恢复路径。真实商户购买资料、图片协议及卡易信售后图片语义不在此证明范围。

## 隔离备份和恢复

`node scripts/verify-digital-recovery.mjs` 在独立 Compose 项目、隔离 `_test` PostgreSQL、私有文件卷和独立夹具进程中成功。脚本自行创建并清理项目、卷及临时目录；没有连接或清理用户正在运行的共享 `aikayun-*` 容器及任何生产私有卷。

恢复夹具在数据库中创建 4 笔已付款合成订单和 4 个 TST 采购操作：`completed`、`rejected` 后撞号、`manual_review` 以及 `unknown`。准备请求 4 条，证据 6 条，跨操作冲突 2 条，reinstate 1 条；每个操作最大风险 10 TST。恢复后操作单位分别为上述四种状态各 1 个；全局、供应商及 SKU 风险桶各为 40 TST。无未知操作的重复提交：备份前供应商夹具 `submit=4/query=0/execution=2`，恢复后执行一次未知操作查询，计数为 `submit=4/query=1/execution=2`，原未知 submit 意图仍恰好 1 条，状态和 10 TST 敞口保留。

同一恢复快照核对到 4 个订单支付回执、1 条采购履约交付、1 次库存 consume、1 个 retained 购买图片对象和 1 条未知 submit 意图。已完成订单 owner 授权读取成功；旧 `legacy-test` 合成密钥恢复了解密 supplier 凭据及加密购买资料；购买附件数据库 SHA-256 与私有文件内容相同（`01282306758bcd8da707107f51e09e83082a27a89136abe3905f10c5a580af40`）。历史文件卷校验和为 `637e2b531ef331d6b8c861eec9864524e066c7ab3a4315ecdd5215c56580b422`。

脚本分别对隔离 API 和 PostgreSQL 容器执行 Compose `SIGKILL` 并强制替换容器；两个服务替换后所有受跟踪业务表快照一致，SHA-256 校验和相同。随后用 `scripts/backup-compose-data.sh` 备份数据库和文件卷，在隔离临时容器中制造文件缺失，再以受保护的测试恢复入口恢复。验证包含付款/订单、采购源与操作、请求意图、证据、单号、冲突、风险事件/桶/日额度、逐单位履约、库存事件、加密购买资料、图片附件引用和私有文件内容；恢复后的可授权读取及未知操作 query-only 恢复均成功。数字履约对账差异为 0，六种方法 `api/code_pool/file/fixed_content/link/manual` 均恢复授权读取。该结果只证明本隔离 Compose 夹具及脚本路径，不证明线上生产灾难恢复。

## 全局验证结果

最终本地 `pnpm verify`（独立 PostgreSQL `aikayun_test`，2026-10-28）成功退出码 0：

| 阶段 | 结果 |
| --- | --- |
| lint | 0 errors；7 条既有 Vue 排版 warning，位置在 `apps/web/pages/products/[id].vue`，本轮未改动 |
| typecheck | API、Web 与 workspace 类型检查通过 |
| 金额单元测试 | 16/16 |
| API / PostgreSQL | 27 个测试文件，469/469；含采购执行和风险预算、订单/支付/退款/库存/履约回归 |
| Chromium 主套件 | 93/93 |
| 辅助浏览器套件 | 替代品牌 1/1、SSR 错误 3/3、开发预览 1/1、生产品牌运行时 1/1；共 6/6 |
| 构建 | Nuxt/Nitro 生产构建通过 |
| skip / flaky / retry | 本次输出无跳过、flaky 或失败重试项 |
| Compose 恢复专项 | 独立 `verify-digital-recovery.mjs` 通过；独立 API/DB 容器 SIGKILL 替换和数据库/私有文件备份恢复均通过 |

构建过程中 Google Fonts/Icons metadata 请求超时，Nuxt 使用可用的本地回退继续构建；没有因该网络告警跳过构建或测试。初轮全量 API 运行发现新增子进程测试沿用旧供应商版本、并挤占后续合成草稿容量；测试已改为读取当前映射版本并仅清理本轮测试草稿。指定 `procurement-executor.integration.test.ts` 随后通过 44/44，全量 PostgreSQL 套件最终通过 469/469。该问题属于新增测试夹具隔离，不是正式执行器缺陷；本轮没有复现到需要改动正式业务代码的生产缺陷。

首次推送 SHA `853fbd8c1a732a01e93f84b30025eb0259064c3f` 的 GitHub Actions 中，Compose 采购/文件恢复证据、历史密钥解密、API/DB 容器 SIGKILL 替换、备份恢复和对账均已成功；最后清理临时宿主目录时报 `EACCES scandir`。根因为独立供应商夹具在非 root API 容器的宿主 bind mount 下创建了 `0700` 子目录，CI runner 无权递归删除。夹具临时目录现在设为可由 runner 清理的 `0777`，里面的合成日志和控制文件仍为 `0600`；不含凭据或顾客资料。修复仅在测试夹具，不影响产品代码、真实数据或正式目录权限；修复后的最终 SHA 将重新执行全部验证和 Actions。

`pnpm verify` 不包含 GitHub Actions 中完整 Compose Web/API 冒烟、重建持久化步骤；这些步骤及本 SHA Actions 状态以本轮最终推送后的实际 workflow 结果记录。独立 Compose 恢复专项则已按上节执行而非跳过。

## 未验证边界与安全结论

- 没有使用真实卡易信商户凭据、真实采购/退款接口或正式 V3 购买载荷。
- 不假设供应商 `outerNumber` 去重，不会因 `not_found`、超时、查询错误或强杀重新提交采购。
- 原 `http_json_v1` 幂等和查单规则及六种现有履约方式未作修改；采购来源选择器仍固定为空。
- 真实商户币种和数量换算、手续费、`safePrice`、扣费、图片传输及售后语义继续为 **NOT_VERIFIED**。
- 本地真实进程强杀和隔离 Compose 备份恢复不等于生产在线恢复；生产数据库/私有卷、生产灾备演练和恢复时限继续为 **NOT_VERIFIED**。

本交付不部署、不开放自动采购、不调用真实商户采购/退款接口，也不进入⑥-4C。完成代码、文档和最终 SHA CI 后停止，等待严格复审及⑥-4B 阶段冻结决定。
