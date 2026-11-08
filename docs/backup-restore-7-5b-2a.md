# ⑦-5B-2A：生产恢复只读技术预检

## 真实功能

客户入口为 `sudo /opt/aikayun/aikayun backup restore-plan SET_ID`。它复用已签名发行校验、共享部署操作锁、宿主 broker、固定生产 helper、完整备份集合及双 Restic 快照验证器，对当前数据库绑定、发行/schema 兼容性和备份技术完整性进行只读检查。

可正常生成的报告始终为 `readiness=blocked`、`automaticRestore=blocked`、`target=unknown`。`businessAfterBackup`、`pendingExternalOperations`、`authorization` 和 `disk` 保持 `unknown`，`externalReconciliation=required`。退出码 0 只表示报告生成成功，不表示允许恢复。报告只使用固定字段和阻断原因枚举，不输出原始错误、凭据、客户数据、私钥或密钥材料。

检查复用只读数据库连接和专用临时 staging；不停止商城服务、不写业务数据库、不操作生产数据卷、不切换 DNS，也不向支付、供应商或授权中心发送业务写请求。锁丢失、执行中断、清理不确定及无法安全分类的异常不会被转换成正常报告，命令以非零状态失败。宿主 broker 只接受严格白名单报告；协议不符时拒绝成功响应。

## 已通过测试

- `backup-helper-command.test.ts`：**21/21**。覆盖安全报告字段、敏感错误脱敏、已知阻断原因、`UnsafeMaintenanceRecoveryError`、锁/发行验证边界丢失、中断和不可分类异常。
- `scripts/release/test-backup-host-broker.sh`：通过。覆盖 restore-plan 报告白名单和错误协议拒绝。
- Shell 语法检查及 `git diff --check`：通过。
- Linux AMD64 安装器入口协议场景退出码 **0**。测试实际经过临时 JWS 签名发行安装的客户 launcher、共享锁和真实宿主 broker；Docker helper 使用受控报告 fixture。verified、数据库不可用、schema/身份/密钥/快照错误报告、命令中断及锁竞争的输出符合阻断协议。
- 该 Linux 入口测试是**协议模拟**：报告由 helper fixture 提供，没有真实 PG18 备份集合作为客户命令输入，不能证明真实数据故障注入或源业务数据前后摘要一致。
- 此前完整 `pnpm verify` 已通过；本次提交后的 Linux 完整验证以精确提交 SHA 对应的 GitHub CI 为准。

## 未支持事项

本功能不执行生产数据恢复、覆盖、实例切换、DNS 切换、服务器迁移或授权迁移，也不开放恢复副本经营。备份之后可能发生的新业务事实、未决外部操作、目标机器是否为原机、当前授权中心状态和恢复空间条件不能由本预检证明，因此必须保持未知并阻断。

真实 PostgreSQL 18 与双 Restic 快照的完整客户恢复演练、七类灾难注入及源数据前后不变性验证**尚未通过**。在任何后续生产恢复方案获准前，这些真实灾难测试必须作为独立验收门槛完成；本阶段的协议模拟或 CI 通过不能替代它们。
