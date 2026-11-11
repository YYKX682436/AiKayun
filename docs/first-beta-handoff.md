# 首轮内测使用交接（2026-11-11）

**当前不能邀请内测用户。** 以下入口已确定，但服务器尚未安装商城，也未启动 HTTPS 服务：

| 用途 | 地址 | 当前状态 |
| --- | --- | --- |
| 商城前台 | https://aikayun.aiove.top | 无服务，不能打开 |
| 店主后台 | https://aikayun.aiove.top/admin/login | 无服务，不能登录 |
| 店主首次设置 | https://aikayun.aiove.top/setup | 安装完成后由店主自行设置邮箱与密码 |
| 授权中心 | https://license.aiove.top | 服务器上的生产 API 与数据库已运行；公网 HTTPS 路由尚未接通 |
| 正式发行文件站 | https://releases.aiove.top | GitHub Pages 已启用 HTTPS，发行标记已通过匿名读取和证书校验；尚无正式工件 |

## 已完成的准备

- 原 MyShop 服务器 `ssh myshop-prod` 已连通。它是 Ubuntu x86_64，Docker/Compose 可用，根分区约 21 GiB、`/data` 约 49 GiB 可用；没有运行容器，80/443 端口未占用。连接说明已追加到 `AGENTS.md`，SSH 私钥只在本机。商城安装器目标目录是 `/opt/aikayun`，目前尚未安装。
- 腾讯云 DNSPod 中 `aikayun`、`license` 两条 A 记录指向该服务器的 IPv4 地址 `103.212.187.244`；`releases` 独立 CNAME 指向商城仓库的 GitHub Pages。没有添加 AAAA 记录，根域名与其他解析未改动。DNS 解析并不代表 HTTPS 服务已可访问。
- 独立授权中心源码在 `/Users/muchen/Documents/ChatGPT/AiKayun-License`，服务器部署目录为 `/data/aikayun-license`。已在本机受保护目录 `~/.config/aikayun-production` 创建正式离线根、在线签名和发行签名材料；**离线根私钥没有上传到服务器或 GitHub**。正式 Trust Bundle 已由离线根签名并通过商城现有验证器，有效期至 **2027-02-08 04:33:02 UTC**。这是*信任包*到期时间，不是本次测试许可证到期时间。
- 服务器上的授权中心使用独立 PostgreSQL 18 数据目录、数据库和凭据；数据库只映射 `127.0.0.1:55433`，授权 API 只监听 `127.0.0.1:4318`。8 个迁移已应用，受控生产 CLI 已完成在线签名身份初始化；本机通过正常 TLS 校验请求 `/v1/time-anchor`，并用正式在线公钥验过返回签名、issuer 和随机 nonce。初始数据库备份在服务器 `/data/aikayun-license/backups/initial-2026-11-11.sql.gz`，已通过压缩完整性检查；它仍在同一台服务器，不替代异地备份。外部 `license.aiove.top` 尚不能访问，不能把本机健康检查当作公网可用。
- 已通过受控生产 CLI 建立首轮内测月度许可证 `63681a8f-2c12-48ce-a165-c439e4f6a375`，状态为 **active、尚未激活**，订阅截止 **2026-12-11 05:40:07 UTC**。一次性激活码已签发，有效至 **2026-11-14 05:40:55 UTC**；明文仅保存在服务器的受保护文件中，未写入仓库或本报告。完成商城安装后由 Codex 用于激活，消费后应删除该文件。授权管理**没有网页入口**；当前管理方法是服务器受控 CLI，分别由 `/data/aikayun-license/run-license-admin.sh` 和 `/data/aikayun-license/run-signer-admin.sh` 调用，操作都需预览摘要和同参数二次确认。店主本轮不必操作命令行。
- 商城仓库现为 Public，独立的 AiKayun-License 仍为 Private。正式签名与授权信任所需的 Secret/Variable 已配置；发行文件改由同一手动工作流凭仓库权限写入独立的 `gh-pages` 分支，无需额外上传 Token。四个私有 GHCR 暂存包已建立，并仅授予 `YYKX682436/AiKayun` 的 Actions 写入权限。未创建正式公开包，也未发布发行工件。
- 公开检查覆盖了商城仓库全部 223 个历史提交、2,467 个历史文件内容、212 次可下载的 Actions 日志和 GitHub 列出的 0 个现存工件；另外一次 CI 在任务启动前就被计费系统拒绝，没有作业日志。两种秘密扫描器的命中经核对均为测试夹具、依赖校验值、随机订单 UUID 或代码中的存储键；未发现真实密码、Token 或私钥。普通源码构建默认没有生产授权信任配置，不能替代正式签名发行。

## 镜像扫描与有限风险处理

用现有固定 Trivy 与发行扫描规则，核对了官方当前索引下 AMD64、ARM64 的实际镜像：

| 镜像 | 每个架构的 HIGH/CRITICAL | 结论 |
| --- | ---: | --- |
| `postgres:18-alpine`（已固定的当前官方镜像） | 44（其中 1 项 CRITICAL） | 44 项上游均已有修补版，但当前官方镜像尚未包含；包括 Go 标准库 `CVE-2025-68121`、Kerberos 及 libxslt 组件 |
| `postgres:18`（Debian 当前官方镜像） | 149（其中 2 项 CRITICAL） | 28 项有补丁、121 项无补丁；不适合作为更安全的替代 |
| `caddy:2-alpine`（当前官方镜像） | 2 HIGH | 与已固定版的 AMD64、ARM64 实际子镜像完全相同；`CVE-2026-116587` 影响 go-jose/v3 且该主版本没有补丁，`CVE-2026-78661` 影响 x/net 且上游已有补丁 |

PostgreSQL 在本次发行 Compose 中没有宿主机端口，只连商城私有网络。26 项 Go 标准库告警位于容器启动时使用的 `gosu`，其进程不处理网络客户请求；其中 CRITICAL `CVE-2025-68121` 要求程序改变 TLS CA 配置并恢复 TLS 会话。16 项 `krb5-libs` 关联 Kerberos，当前数据库使用内部密码连接而非 GSS/Kerberos 认证。2 项 `libxslt` 需要 SQL XML 扩展路径，首轮不启用该扩展。Caddy 的配置只将公网请求反向代理至 Web；它不把客户请求交给受影响的 RSA JWK 解析器或 HTML 解析器。`CVE-2026-116587` 在 go-jose/v3 暂无修补版本；`CVE-2026-78661` 的 x/net 上游已有补丁，但当前官方镜像尚未包含。

发行仍执行原有 Trivy 漏洞和秘密扫描，并保留每项告警。**只对上述当前官方镜像的 AMD64/ARM64 四份完整扫描报告，按精确 SHA-256、镜像子摘要、受影响组件数量及当前 Compose/Caddy 配置接受这次有限风险**；任一新增/变化的 CVE、修复版本、严重程度、镜像或部署入口都会阻断发行。API、Web、备份镜像仍须零 HIGH/CRITICAL 和零秘密告警。风险例外不是修复；官方镜像更新后应重扫并移除旧例外，不应依赖它扩展数据库公网访问或 Caddy 的请求解析功能。

授权中心已在服务器本机正常运行并真实发码，但公网 `license.aiove.top` 尚无 443 路由。发行文件站的 GitHub Pages 已部署，专属 Let's Encrypt 证书通过正常校验，HTTPS 已强制启用；发行仍需实际签名、上传及匿名 HTTPS 回读。当前安装器要求 80/443 空闲，而商城自身要占用 80/443；同机的授权中心仍需落实不会与安装器冲突的入口配置。没有这些条件，不能运行正式安装器或做 `/setup`、激活与订单验收。

此前 Private 仓库提交 `8a74f74b8253afed459f96ab35a44c0842e65940` 的 [CI 运行](https://github.com/YYKX682436/AiKayun/actions/runs/42961482425) 在任务开始前被 GitHub 计费系统拒绝，**没有执行任何测试**。Public 仓库的 `c6794f7ca1fe9bf8efbef2ebfaaff0906a8db3c9` 已由 [GitHub 官方 CI](https://github.com/YYKX682436/AiKayun/actions/runs/42963731527) 完整运行并通过；随后发行站与镜像风险处理的代码修改仍须在新提交上通过同一 CI 才能正式发行。

## 店主可用的后续操作

1. **现在先不要手动发布，也不要邀请用户。** 等发行代码的新提交 CI 通过，并接通授权中心公网入口后再发行。没有必要购买 GitHub Enterprise。
2. 条件就绪时，在 [AiKayun 的 Commercial release 工作流](https://github.com/YYKX682436/AiKayun/actions/workflows/release.yml) 选择 **Run workflow**，分支选 `main`，填写经确认未使用的版本号（预定首版 `0.1.0-rc.1`），confirmation 填 `PUBLISH-0.1.0-rc.1`。工作流仍检查触发人、固定 SHA、同 SHA 的 CI、版本不可复用、真实授权配置、签名、双架构镜像摘要和扫描、发行站回读与安装器验证。失败后已占用的版本号不能重复使用。
3. 工作流签名并推送四个正式包后，需在 GitHub 的 **Packages → 对应包 → Package settings → Change visibility** 将 `aikayun-api`、`aikayun-web`、`aikayun-backup-restic`、`aikayun-release-bundle` 设为 **Public**；发行工作流会等待并核验其公开状态。暂存包始终保持 Private。
4. 正式工件通过后，安装器部署商城；店主打开 `/setup`，用安装器生成的一次性设置令牌自行填写邮箱与密码，然后在 `/admin/login` 登录。首轮真实许可证已建档并发码；公网授权中心连通后才可在后台 `/admin/license` 激活。
5. 激活后，在 `/admin/products` 建立明确标注“内测专用”的零元商品，使用无价值的测试内容，验证顾客 `/register` 注册、下单、`/orders` 查询及交付。没有支付商户配置，真实支付、充值和退款尚未验证。

离线根私钥位于本机受保护目录，**需由店主另存一份加密离线备份**并与电脑分开保管；不要将私钥、密码或激活码写入仓库、聊天或发给内测用户。授权管理网页列为紧接着的小功能，范围为许可证列表、创建授权、发码、续期、停用和恢复，本轮未开发。
