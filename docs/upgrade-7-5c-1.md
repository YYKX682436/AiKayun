# ⑦-5C-1 同结构安全升级与程序回退

## 客户命令

```sh
sudo /opt/aikayun/aikayun upgrade --version X.Y.Z
```

升级器只从安装状态中已验证的发行 HTTPS 地址读取目标版本；命令不接受新的发行地址、私钥或信任根。它复用安装器固定的 Cosign 工作流身份、发行 JWS 根、发行工件哈希、签名 OCI 包和共享部署锁。

运行前必须处于完整的 `setup_token_issued` 安装阶段。升级器会验证当前发行、客户命令文件、Compose 配置、秘密、数据库绑定和所有固定业务卷。授权中心发生变更的情况下，只允许使用与当前发行完全相同的信任配置和 Trust Bundle。

## ⑧-2 首页推荐迁移边界

首页推荐只新增 `storefront_featured_products` 表，不改写现有商品、SKU、订单或顾客记录。迁移仅向前应用。由于 ⑦-5C-1 升级器要求当前与候选发行的 schema head 和 checksum 完全相同，仍运行 ⑦-5C-1 命令的实例不能直接升级到包含这项迁移的发行；升级器会在停机前拒绝 schema 不同的候选版本。本阶段不扩展升级器，已有实例的跨 schema 升级须由后续阶段另行提供并验收。

## 首版升级条件

新发行必须在签名清单 `database.upgrade_from_releases` 中列出当前 `release_id`，并在 `database.rollback_to_releases` 中明确声明支持回退到该发行。候选发行和当前发行还必须满足：

- PostgreSQL 主版本均为 18，当前 schema head、完整迁移 checksum 文件逐字节相同。
- 候选 API 镜像中的迁移 registry 与签名 checksum 匹配，生产库已应用的 migration 名称与 registry 完全一致。
- 当前安装身份、数据库绑定和 Pending Key 均通过只读验证。
- 授权协议、trust configuration ID、issuer、离线根、在线 signer 列表、最低 Trust Bundle 版本、Trust Bundle 和离线公钥均相同。
- PostgreSQL、Caddy 镜像和数据库初始化、Caddy、备份 broker、隔离恢复 Compose 工件不变。API/Web 镜像和经签名的发行资料可更新；不会运行 `migrate` 服务。

任何一项不符都会在停机前拒绝升级。升级不执行数据库迁移或 down migration，不重建数据库，不重置身份，不替换业务卷、媒体、私有文件、秘密、Pending Key 或授权历史。

发布工作流接受 `upgrade_from_releases` 和 `rollback_to_releases` 两个可选的逗号分隔输入。仅写入经过 SemVer 校验的发行 ID；没有明确兼容清单的发行不能被客户升级器接受。

## 切换和回退

升级、install、resume、setup-token 与所有客户 backup 命令使用 `/run/lock/aikayun-install.lock`。升级先拉取并验证全部签名工件及镜像，再确认数据库真实状态。它按 Caddy、Web、API 顺序停止旧程序，并确认旧 API 正常退出后才进行下一步。

新 API 在私有网络内以探测模式启动；该模式跳过订单到期、数字交付和授权续期 worker。API/Web 健康检查、数据库 migration registry 和身份检查通过后，升级器写入签名发行目录、更新 API/Web 镜像引用，再以正常模式启动候选程序。确认 API/Web、数据库绑定和 HTTPS 状态后恢复对外服务。PostgreSQL 与全部固定卷始终保持原状。

如果探测阶段失败，候选 worker 未启动且公网入口关闭，升级器会恢复原发行、镜像引用和客户命令，并保留所有持久化数据。如果候选 API 进入正常模式后启动或健康结果不确定，升级器会保留候选现场、关闭或维持关闭的公网入口，并记录阻止自动回退的状态；此时 worker 可能已经处理业务或外部操作，不能盲目恢复旧程序。`status` 和 `diagnose` 会显示中断阶段；backup 与 resume 在存在未完成升级日志时会拒绝操作。

成功后，`install-state.json` 保留当前版本与 manifest SHA-256，并记录 `upgrade.previous_version`、`upgrade.previous_manifest_sha256` 和 `upgrade.rollback_status=blocked_after_acceptance`。旧签名发行目录保存在 `/opt/aikayun/previous-release`；不会删除或裁剪 Docker 镜像。

## 不支持

- 不同 PostgreSQL 主版本、不同 migration head/checksum、schema 迁移或 down migration。
- 没有双向签名兼容声明的发行、变更授权信任配置的发行。
- 数据库/Caddy 镜像更新、实例身份重建、业务数据恢复、跨服务器迁移或 DNS 切换。
- 在候选正常 API 已运行后自动回退；此时必须先人工判断数据库业务状态和外部操作。
- 后台自动检查更新、Kubernetes、升级常驻服务、多版本并行运行或流量调度。

## 已验证内容

本地通过：完整 `scripts/install/test-ai-kayun-installer.sh` AMD64/ARM64 矩阵（含升级成功、不兼容拒绝、迁移不匹配、授权信任不匹配、签名错误、探测启动失败回退、backup 锁竞争、卷/秘密/身份保留）；`pnpm test:release`（发行清单 8/8、host broker、隔离恢复 Compose 配置、镜像元数据）；`pnpm typecheck`；`pnpm lint`（0 error，仓库另有 7 条既存 Vue 样式 warning）；探测模式单测 2/2。

本地使用隔离 PostgreSQL 18 和冻结授权中心 checkout 跑 API 全套测试：929 passed、26 skipped、1 failed。唯一失败在既有 `license-center-challenge.interop.test.ts` 的“查询 superseded evidence”场景，实际得到 `challenge_http_rejected`，测试预期 `activation_result_unknown`。此失败与本阶段升级路径无关，等待精确提交的 GitHub CI 复核。

本阶段要求在推送后核对该提交的完整 GitHub CI；本地结果不代替远程 CI。真实客户服务器、生产签名材料和真实商城流量切换未在本地验证；隔离 installer Docker shim 证明命令流程和数据保留，不代替生产切换验收。

> 引导限制：升级逻辑随本阶段签名发行中的 `install.sh` 一起交付。已安装的旧版 `/opt/aikayun/aikayun` 是此前发行的固定脚本，它不会远程获得本次提交中的新命令；旧版客户在执行上述命令前必须通过可信渠道把本阶段已签名验证的客户命令更新到固定路径。升级器会拒绝从临时路径运行，也不提供未经签名验证的自动自更新。
