# ⑦-5B-2A：生产恢复只读预检

本阶段只提供 `sudo /opt/aikayun/aikayun backup restore-plan SET_ID` 只读预检；不写生产库、不停服务、不操作生产卷、不做恢复、切换或授权迁移。入口复用安装器签名发行验证、共享操作锁、宿主 broker、固定生产 helper、现有双 Restic 快照及完整隔离恢复验证器。预检可短暂使用既有专用 tmpfs staging 进行校验，结束清理该 staging；不创建 Docker 项目或卷。

## 报告语义

命令输出一行白名单 JSON，随后输出中文说明。敏感凭据、客户数据、原始清单、私钥和密钥材料不进入报告。技术验证成功时，`backup=verified`、`compatibility=matched`、`identity=matched`、`target=current-instance`、`technicalChecks=passed` 仅表示备份与当前已验证实例技术匹配；由于容量、业务事实、未决操作和授权状态仍未知，`readiness=blocked` 且 `automaticRestore=blocked`，不授权立即覆盖。

`businessAfterBackup`、`pendingExternalOperations`、`authorization` 和 `disk` 在本阶段均为 `unknown`，`externalReconciliation=required`。备份生成之后可有支付、退款、提现、采购、交付等账外新事实；源库不可读或源服务器损坏时，更不能从旧备份推断其不存在。当前预检没有请求支付服务商、供应商或授权中心；不会通过写请求解决这些未知项。

任何 helper 校验失败、绑定不匹配、目标数据库失联、命令中断或并发争锁都会 fail closed；若可生成报告，则以 `backup=blocked`、其余不能确认项 `unknown`、`readiness=blocked`、`automaticRestore=blocked` 返回。若客户入口自身的签名、锁、Docker endpoint 或固定路径前置门禁失败，命令直接拒绝且不启动 helper。没有 `--force`、测试 flag 或人工确认绕过。

## 后续正式恢复门槛

进入后续受控恢复阶段前，必须单独确认源/目标实例和数据库绑定、具体恢复目标资源所有权、充足磁盘空间、兼容的签名发行与迁移校验、授权中心对目标身份的状态，以及备份之后的新订单和全部外部支付/退款/提现/采购/交付事实。未决操作须按原操作身份人工查单和对账，禁止自动重新提交。授权过期或未知状态不能由本地备份推定为有效。跨服务器恢复是身份迁移，须有授权中心迁移/旧实例失效协议；本阶段不能克隆身份后开放经营。

## 验收结果

本机 macOS 的 `pnpm verify` 在独立临时 PostgreSQL 18 `_test` 容器及冻结授权中心 checkout `185dac80204f60abbaa63ffeb5af7d7054b685d7` 下完整结束：lint 0 errors/7 个既有 Vue 排版 warnings；typecheck、build、API/PostgreSQL 916 passed/26 skipped、release 7/7、Playwright 96/96 和 production-brand 1/1 通过。`backup-helper-command.test.ts` 7/7 通过。真实业务未决状态在报告中一直为 unknown；目标容量与当前授权中心状态也未被本机自动证明，故技术报告 readiness 保持 blocked。输出没有秘密字段。

Linux 专用源路径安全测试没有在 macOS 伪装或放宽。CI run `42382073557` 对代码提交 `3a182f7eaf5a999c368387e6da92f79f060a2761` 总体通过：`backup-source-path-safety.test.ts` 3/3 通过，完整 API/PostgreSQL 916 passed/26 skipped，主浏览器 95 passed 且 reduced-motion 用例一次 flaky 后重试通过；Compose 浏览器 87 passed/9 skipped，持久化与数字交付恢复步骤通过。[GitHub Actions](https://github.com/YYKX682436/AiKayun/actions/runs/42382073557)。明确跳过的包括 `backup-direct-real-set.integration.test.ts` 和 Restic/卷归档集成 fixture，因此此处 CI 不能证明客户恢复计划命令对真实集合的端到端故障矩阵。

当前新增回归对真实 PG18 inspected result 的协议脱敏、双快照 evidence 成功形态、DB unavailable 阻断形态作单元验证；七类恢复风险中，备份后交易/未决外部操作/授权中心实时状态/目标磁盘容量没有自动 oracle，均明确输出 unknown 并阻断。后续需在隔离 Linux 与合成 backup fixture 中逐项演练 schema/身份/key mismatch、跨实例拒绝、并发锁和中断；这些未执行的动态注入不标作通过。

真实生产卷未读写、任何服务未停止、未调用外部写端点、未覆盖数据库或切换流量。MacOS `pnpm verify` 的结果不替代 Linux 专用安全门禁或精确 SHA CI。不得因路径差异削弱安全检查。
