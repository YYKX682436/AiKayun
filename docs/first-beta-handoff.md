# 首轮内测使用交接（2026-11-11）

**当前不能邀请内测用户。** 以下入口已确定，但服务器尚未安装商城，也未启动 HTTPS 服务：

| 用途 | 地址 | 当前状态 |
| --- | --- | --- |
| 商城前台 | https://aikayun.aiove.top | 无服务，不能打开 |
| 店主后台 | https://aikayun.aiove.top/admin/login | 无服务，不能登录 |
| 店主首次设置 | https://aikayun.aiove.top/setup | 安装完成后由店主自行设置邮箱与密码 |
| 授权中心 | https://license.aiove.top | 仅有 DNS，服务尚未部署 |
| 正式发行文件站 | https://releases.aiove.top | 仅有 DNS，服务尚未部署 |

## 已完成的准备

- 原 MyShop 服务器 `ssh myshop-prod` 已连通。它是 Ubuntu x86_64，Docker/Compose 可用，根分区约 21 GiB、`/data` 约 49 GiB 可用；没有运行容器，80/443 端口未占用。连接说明已追加到 `AGENTS.md`，SSH 私钥只在本机。商城安装器目标目录是 `/opt/aikayun`，目前尚未安装。
- 腾讯云 DNSPod 中 `aikayun`、`license`、`releases` 三条 A 记录指向该服务器的 IPv4 地址 `103.212.187.244`，没有添加 AAAA 记录；根域名与其他解析未改动。DNS 解析并不代表 HTTPS 服务已可访问。
- 独立授权中心源码在 `/Users/muchen/Documents/ChatGPT/AiKayun-License`。已在本机受保护目录 `~/.config/aikayun-production` 创建正式离线根、在线签名和发行签名材料；离线根私钥没有上传到服务器或 GitHub。正式 Trust Bundle 已由离线根签名并通过商城现有验证器，有效期至 **2027-02-08 04:33:02 UTC**。这是*信任包*到期时间，不是本次测试许可证到期时间。目前没有许可证、激活码或已激活商城。
- 商城 Private 仓库的三个发行 Secret、七个发行 Variable 已配置；发行上传 Token 尚未配置，因为发行站还不存在。四个私有 GHCR 暂存包已建立，并仅授予 `YYKX682436/AiKayun` 的 Actions 写入权限。未创建正式公开包，也未发布发行工件。
- 商城源码目前以 `d89d23002624ec5d62c80863b85fbc9b872552f7` 为已通过 CI 的基线；本交接中的后续修订需按最终提交 SHA 和该 SHA 的 CI 再核验。普通源码构建默认没有生产授权信任配置，不能替代正式签名发行。

## 当前发行阻断

用现有固定 Trivy 与发行扫描规则，核对了官方当前索引下 AMD64、ARM64 的实际镜像：

| 镜像 | 每个架构的 HIGH/CRITICAL | 结论 |
| --- | ---: | --- |
| `postgres:18-alpine`（已固定的当前官方镜像） | 44（其中 1 项 CRITICAL） | 44 项上游均已有修补版，但当前官方镜像尚未包含；包括 Go 标准库 `CVE-2025-68121`、Kerberos 及 libxslt 组件 |
| `postgres:18`（Debian 当前官方镜像） | 149（其中 2 项 CRITICAL） | 28 项有补丁、121 项无补丁；不适合作为更安全的替代 |
| `caddy:2-alpine`（当前官方镜像） | 2 HIGH | 与已固定版的 AMD64、ARM64 实际子镜像完全相同；`CVE-2026-116587` 影响 go-jose/v3 且该主版本没有补丁，`CVE-2026-78661` 影响 x/net 且上游已有补丁 |

PostgreSQL 仅应在内部网络提供数据库端口；Caddy 对公网提供反向代理，正常代理路径未显示会解析用户提供的 RSA 私钥 JWK 或 HTML，但这不能作为扫描通过的证据。替换成这些官方新索引不会消除阻断。现有发行门禁继续拒绝 HIGH/CRITICAL；没有关闭扫描、加入大范围忽略，也没有伪造正式签名工件。扫描报告和具体 CVE 需在下一次官方镜像更新时重新核对。

授权中心尚无独立生产数据库、TLS 服务与受控生产 CLI 的服务器配置，故不能真实发码。发行站还缺 HTTPS、只允许认证上传的现有发行接口及上传 Token。当前安装器要求 80/443 空闲，而商城自身要占用 80/443；同机部署三个域名还需先落实不会与安装器冲突的入口配置。没有这些条件，不能运行正式安装器或做 `/setup`、激活与订单验收。

## 店主可用的后续操作

1. **现在先不要手动发布，也不要邀请用户。** 等官方 PostgreSQL/Caddy 镜像包含修补版、重扫通过，并完成授权中心、发行站及同机入口后再发行。没有必要购买 GitHub Enterprise。
2. 条件就绪时，在 [AiKayun 的 Commercial release 工作流](https://github.com/YYKX682436/AiKayun/actions/workflows/release.yml) 选择 **Run workflow**，分支选 `main`，填写经确认未使用的版本号（预定首版 `0.1.0-rc.1`），confirmation 填 `PUBLISH-0.1.0-rc.1`。工作流仍检查触发人、固定 SHA、同 SHA 的 CI、版本不可复用、真实授权配置、签名、双架构镜像摘要和扫描、发行站回读与安装器验证。失败后已占用的版本号不能重复使用。
3. 工作流签名并推送四个正式包后，需在 GitHub 的 **Packages → 对应包 → Package settings → Change visibility** 将 `aikayun-api`、`aikayun-web`、`aikayun-backup-restic`、`aikayun-release-bundle` 设为 **Public**；发行工作流会等待并核验其公开状态。暂存包始终保持 Private。
4. 正式工件通过后，安装器部署商城；店主打开 `/setup`，用安装器生成的一次性设置令牌自行填写邮箱与密码，然后在 `/admin/login` 登录。授权管理目前**没有网页入口**，由受控生产 CLI 管理；正式许可证创建后才可在后台 `/admin/license` 激活。
5. 激活后，在 `/admin/products` 建立明确标注“内测专用”的零元商品，使用无价值的测试内容，验证顾客 `/register` 注册、下单、`/orders` 查询及交付。没有支付商户配置，真实支付、充值和退款尚未验证。

离线根私钥位于本机受保护目录，**需由店主另存一份加密离线备份**并与电脑分开保管；不要将私钥、密码或激活码写入仓库、聊天或发给内测用户。授权管理网页列为紧接着的小功能，范围为许可证列表、创建授权、发码、续期、停用和恢复，本轮未开发。
