# ⑦-5B-1：独立隔离恢复与业务一致性验收

## 范围

本阶段只验收已发布、状态为 `verified` 的完整 Restic 备份集合恢复到新的隔离 Compose 项目。它不实现生产原地覆盖恢复、升级、搬服、授权迁移或异常校时，也不代表异地主机灾备验收。

客户入口：

```text
sudo /opt/aikayun/aikayun backup restore-isolated SET_ID
sudo /opt/aikayun/aikayun backup cleanup-isolated RUN_ID
```

`restore-isolated` 只接受 UUID 备份集合 ID。它通过已签名发行中的 API、PostgreSQL 18、Restic 和恢复 Compose 文件检查发行身份，重新验证完整集合、双快照角色、manifest、源数据库 dump、身份和密钥配对。它从已验证清单固定 source/manifest 快照 ID 后才创建恢复项目。恢复成功后数据库保持停止；`RUN_ID` 可用于显式清理本次演练资源。

## 隔离边界

- 每次使用新且唯一的 Compose project、PostgreSQL 数据卷、凭据卷、状态卷、Caddy 数据卷、部署密钥卷和 manifest/dump 输入卷；创建前拒绝已存在的目标项目或卷。
- 恢复 Compose 仅含 8 个一次性恢复/校验服务。它不启动商城 API、Web、worker、Caddy 或对外监听端口。
- 文件恢复器和 Restic 容器使用 `network_mode: none`；验证器与 PostgreSQL 只连 `internal: true` 专用 bridge。Docker inspect 还会核实网络属性、端口绑定、镜像身份、服务集合及资源标签。验证器实际尝试连接 `1.1.1.1:443`，必须失败。
- PostgreSQL 恢复后新建无写权限的只读登录角色。验证器运行在 UID 1000、只读根文件系统、丢弃全部 capabilities，并使用 `default_transaction_read_only=on`。
- `validate` 是直接启动发行中的只读校验 CLI，不经过商城服务器或 worker 入口。校验完成后数据库停止，不会与原商城同时经营。
- 失败时保留本次带唯一 run/project/scope 标签的诊断日志、ownership 记录及停止状态资源；cleanup 必须逐一匹配 ownership 记录、project、run、服务白名单、网络和卷标签，任一项不符就拒绝删除。

## 恢复与业务校验

隔离验证器核对：

- PostgreSQL 18 dump 的 SHA-256/字节数、迁移头、迁移校验清单、数据库 binding、安装身份文件和 Pending Key 文件绑定。
- 支付与交付密钥环和备份记录摘要；实际解密历史支付渠道、支付尝试凭据、供应商凭据、固定交付版本/记录和其他已支持的加密交付材料。
- Trust Store 的已初始化发行绑定状态；未配置可信发行 Trust Bundle 的本地 fixture 必须保持为合法的 uninitialized 状态。
- `local_license_operations`、`local_license_operation_attempts`、加密请求/响应/结果 JWS/中心证据、Pending Key 引用及数据库/文件 trusted-time watermark 配对。
- 订单项价格/数量快照和订单金额，钱包余额与不可变账本，提现冻结与未决状态，库存预留和库存事件。
- 公共商品媒体的实际 WebP 文件、私有数字交付文件及历史下载授权引用、采购草稿/采购单附件（若存在）按数据库字节数和 SHA-256。
- 原订单、订单项、尝试、退款分配、提现尝试、交付记录、幂等身份、付款和授权状态通过恢复前后的逐表行数据 SHA-256 摘要一致性检查。

真实 PostgreSQL 18 验收库使用合成但互相关联的数据：待处理文件订单和 `unknown` 支付尝试、成功支付收据及回调证据、处理中退款及保留分配、固定内容加密交付、提现资金冻结及 `unknown` 出款尝试、现金账本、公开媒体变体、可用私有文件和有下载授权的文件型订单。另有带版本化供应商连接、加密历史凭据、映射版本、采购来源、TST 风险预留、`submit` 幂等意图及 `unknown` 执行证据的合成采购订单。采购来源阶段只调用进程内 synthetic transport，不连接供应商。授权 fixture 包含已绑定 Pending Key 的激活/恢复操作、签名 JWS/中心证据及时间水位。恢复后真实解密支付、供应商凭据、采购快照和交付 envelope。

端到端验收在本机 Docker Desktop 的独立 PostgreSQL 18 Compose 项目中运行。数据库共有 4 个订单、4 个订单项、5 个支付尝试、1 个未决退款、1 个未决提现和 1 个 `unknown` 采购操作；交付记录共 2 条，其中 1 条具有文件下载授权。预先选定的业务、采购、授权表逐行规范化 JSON 后计算 SHA-256，恢复前后每张表的行数与摘要一致。公开媒体 3 个 WebP variant、私有数字文件及采购快照分别按数据库 SHA/加密内容核验。

## 故障闭锁与清理

已实现并由单元、broker 和 Compose 配置测试检查的闭锁包括：

- Restic source tree 路径检查拒绝 symlink、硬链接、特殊权限、特殊文件和路径穿越；不完整的 source/manifest 快照配对不会被视为已验证。
- helper 参数拒绝无效恢复 ID；清单 schema 校验拒绝不完整元数据。
- host broker 限制 Docker 命令、固定已签名 Compose 文件摘要，并校验服务、网络、卷、端口和演练所有权。
- Compose 输入归一化器会拒绝缺失 dump 或 manifest、manifest 树含链接/特殊文件/额外文件，以及无法归一化的所有者和权限。相关检查已由配置测试检查，未逐项在真实 Compose 中注入。
- 任一恢复步骤失败都会停在非 `verified` 状态；cleanup 仅删除带有本次 run/project/scope 标签并与 ownership 记录相符的资源。

真实 Compose 故障注入已验证两项：错误 Restic 密码和不存在的 source snapshot 均在恢复源服务退出时失败，不会进入 DB 导入或成功校验；测试只清理由本次随机 project/run/scope 标签证明归属的资源。

以下情形没有在真实 Compose 恢复流程中做故障注入，不能算作动态验收通过：缺少 manifest 快照、替换已发布 manifest、错误历史密钥或身份、已有/他 project 的目标卷、恢复中 SIGKILL、真实 ENOSPC、数据库成功而文件失败、文件成功而身份/密钥失败，以及目标发行不兼容的 schema dump。针对它们的防护由逐阶段失败闭锁、输入校验、ownership 检查和恢复后绑定/密钥/文件校验实现；正式生产恢复也尚未实现。

## 验收执行结果

2026-11-07 在本机 Docker Desktop 执行 `pnpm verify` 全通过：lint、typecheck、16 个包测试、API 918 项通过（23 项按环境跳过）、release 检查、production build、96 项主浏览器 E2E、alternate-brand、SSR-error、dev-preview 和 production-brand E2E。`test:release` 中的 host broker 与隔离 Compose 配置检查均通过。

同一轮中的 PostgreSQL 18 端到端备份/恢复测试使用新的临时 project 和卷完成：已验证 source/manifest 快照配对、真实 dump 恢复、隔离验证器的真实外网 TCP 探测失败、恢复前后业务表逐行 SHA-256 一致、订单与未决资金操作保持原状态、媒体/私有文件摘要和历史密钥解密通过。演练 project/卷、测试结果目录、任务专用容器镜像和本轮创建的临时文件已清理；现有商城 Compose project 未停止或改动。

## 尚未支持的生产边界

此功能不提供生产数据覆盖/回滚、原地数据库导入、DNS 切换、真实支付/退款/提现、供应商出站、真实回调接收、授权激活或自动续签入口。上述端到端恢复仅在本机 Docker Desktop 项目与合成数据中完成；不能证明异地主机灾备、远端密钥可用性、外部对象存储恢复或生产切换能力。
