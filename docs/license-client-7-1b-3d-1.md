# ⑦-1B-3D-1 可信授权状态投影

商城冻结基线：`742db156a96a74f305aeca36f2ebf18df66a3c40`。授权中心保持只读，测试使用 SHA `a5cf99439e3bf92b65f19d60c013bca088cf221a`。

## 实现

- 新增单例表 `instance_license_state`，保存安装/许可证绑定、当前有效 lease 的 JWS AES-GCM 密文与摘要、generation/revision/JTI/签发和到期时间，以及最新已接受 revoked/superseded 证据和水位。表不复制 operation 账本；证据来源仍指向 `local_license_operations` / attempts。
- 唯一写入口是内部 `createLicenseStateProjectionClient(...).projectPersistedOperation(operationId)`。入口只从持久化的 activation/recovery response 和结果归档、加密请求封套及 attempts 重建证据；调用方不能传原始 JWS 或 `signatureVerified`。
- 在投影行 `FOR UPDATE` 事务内重新检查安装绑定、来源 attempt、密文摘要、现有拒新水位，再依当前 Trust Store 和可信时间验证新签名 JWS 与请求/实例绑定。trust bundle 的读回确认在事务提交前后执行。
- 同 generation/revision 仅接受 iat 更新且 JTI 不重复的 lease；revision 升级受 revoked 水位约束；superseded 保持不可解除。更低水位、错绑、错误签名和过期 lease 不覆盖 last-good。事务提交结果未知时按完整投影指纹读回确认。
- 投影写入不推进 operation 状态，activation/recovery 仍保持 `response_saved`。v5 配对恢复检查现在校验单例行、AES-GCM 解密、摘要和原始 attempt 来源；安装身份初始化把这张单例表识别为授权元数据。

## 验证

- 冻结中心与 PostgreSQL 18：activation lease、revision 2 recovery lease、revoked/superseded 防旧证据重放、中心 revoke/restore 后 generation 1 的 revision 3 lease、Trust Store signer 轮换、并发、事务回滚、未知 COMMIT 确认、真实 SIGKILL 前后提交与重启均通过。
- v5 恢复配对：已有 pending history 与投影密文可由同一 pending AES key 解密，摘要和 attempt 来源核对通过；损坏投影密文被拒绝。
- 完整 `pnpm verify`：606 API 测试通过；93 个主 E2E、alternate-brand 1 个、SSR-error 3 个、dev-preview 1 个和 production-brand 1 个通过。lint 仍有 7 条既有 Vue 排版 warning，无 error。

## 阶段边界

本阶段只写入并验证可信投影，不提供权限快照或经营准入；订单、充值、续签 worker、正常 renewal 客户端、时间水位/离线计时仍未实现。商城不能据此声称已经获得经营准入保护。3D-1 到此停止，等待独立验收。
