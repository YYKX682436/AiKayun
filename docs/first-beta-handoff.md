# 首轮内测使用交接（2026-11-10）

**当前状态：尚未开放内测。** `https://aikayun.aiove.top` 已在腾讯云 DNSPod 配置 `aikayun` A 记录到 `103.212.187.244`，没有 AAAA 记录；但服务器尚无商城服务监听 80/443，HTTPS 请求连接被拒绝。`https://aikayun.aiove.top/admin/login` 也不能登录。现在不要把网址发给内测用户。

## 已确认的环境

- 原 MyShop 服务器已可通过本机 `ssh myshop-prod` 登录。系统为 Ubuntu x86_64，Docker/Compose 可用；根分区约 21 GiB、`/data` 盘约 49 GiB 可用，内存 3.8 GiB。Docker 无容器和卷，80/443 无监听，UFW 已放通 80/443。SSH 命令已追加到项目 `AGENTS.md`，私钥仍只在本机 `~/.ssh/`。
- 商城本机完整代码为 `02f355185fd97934d3541b0481daccb657d64238`，包含 `d7b2bb171f6061a6935fcaf0ca1162945b0b2a8a` 后的五个修复提交；当前本机 `main` 比远端领先 6 个提交。未将远端旧版当作安装版本。
- 独立授权中心源码在 `/Users/muchen/Documents/ChatGPT/AiKayun-License`，私有仓库为 `https://github.com/YYKX682436/AiKayun-License`。目前未发现生产中心服务、生产签名根、有效生产 Trust Bundle 或已创建的本次许可证；因此没有授权状态或到期时间可交付。现有受控生产管理方式是该仓库 `docs/admin-cli.md` 所述本机 CLI，**没有授权管理网页**，且在生产中心配置完成前不能用它发放本次授权。

## 上线阻断与下一步

商城 GitHub 仓库已按店主指示改为 Private。发行流程现按单人手动发行调整：只接受 `YYKX682436` 从 `main` 主动触发或重跑，向 GitHub 核对当前提交 SHA 与工作流路径；仍要求明确版本确认、同一 SHA 的成功 CI、不可复用版本号、真实生产授权配置与 Trust Bundle、独立发行签名、OIDC/Cosign、镜像扫描及安装器验证。当前仓库尚无生产发行变量与材料，Secret 仅有 `LICENSE_CENTER_READ_TOKEN`。2026-11-10 按当前官方索引用固定 Trivy 重新扫描：新 Distroless AMD64、ARM64 为 0 项 HIGH/CRITICAL，ARM64 secret 为 0；PostgreSQL 18 AMD64 仍为 26 项 HIGH/CRITICAL，Caddy AMD64 仍为 2 项。后两者继续阻断正式发行；未将单平台结果冒充多平台通过。不能用默认信任配置为空的普通源码构建冒充已授权的可经营版本。

需要建立并妥善保管正式授权根和发行签名材料，部署独立授权中心与 HTTPS 发行站，完成当前镜像扫描与签名发布，再在原 MyShop 服务器运行仓库已有的受控安装器。服务器目标目录按安装器契约为 `/opt/aikayun`，当前尚未创建。DNS 已完成，无需再修改 `aiove.top` 根域名。

## 手动发行入口（当前材料未就绪，暂勿触发）

店主在 [AiKayun Actions](https://github.com/YYKX682436/AiKayun/actions/workflows/release.yml) 选择 **Commercial release → Run workflow**，选择 `main`，填入经检查未使用的版本号，并在 confirmation 中输入 `PUBLISH-` 加相同版本号。发行失败后原版本可能已被不可变 tag 占用，下一次必须使用新版本。发行凭据将放在私有仓库的 Actions Secrets/Variables；现有工作流仅在 publish 步骤引用生产发行凭据，该步骤开始前再次核验维护者、仓库、工作流与 SHA。`GITHUB_TOKEN` 只在发行 job 取得写 tag、写镜像及 OIDC 权限。商城仍未安装，以上是入口说明，不表示现在能够发行。

## 开通后的使用路径（目前不可操作）

1. 安装器完成 HTTPS 检查后，从服务器终端获取一次性 setup token；打开 `https://aikayun.aiove.top/setup`，输入 token，并自行设置店主邮箱与密码。密码不要写入仓库。
2. 打开 `https://aikayun.aiove.top/admin/login` 登录。到 `/admin/license` 输入由真实授权中心签发的组合激活凭证，确认后台显示有效状态和到期时间，再到 `/admin/products` 建立标为“内测专用”的零元测试商品。
3. 普通内测用户只需用浏览器打开 `https://aikayun.aiove.top`，在 `/register` 注册并领取零元商品，然后到 `/orders` 查询订单与交付。支付商户尚未配置，真实支付、充值与退款均不列为已验证。

**给内测用户的说明：暂缓发送。** 只有 HTTPS、店主登录、真实授权、测试商品和零元订单交付全部实测成功后，才发送上述网址及操作步骤。

授权管理网页列为下一项小功能：许可证列表、创建授权、发码、续期、停用与恢复，复用现有受控业务能力；本轮没有该网页入口。
