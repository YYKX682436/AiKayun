# ⑦-3：一键安装与网页初始化

商城起点：`f21d0de63931daae1c7f29503246c00945c8bb4c`。授权中心只读基线：`185dac80204f60abbaa63ffeb5af7d7054b685d7`。本阶段不修改授权中心代码或 `/v1/activations` 请求协议。

## 客户流程

正式发行域名尚未配置，因此以下命令中的 `<release-origin>` 和 `<version>` 是占位符，不是可访问地址。配置并发布真实发行站后，客户执行同一条命令并提供自己的店铺域名：

```sh
bash -euo pipefail <<'AIKAYUN_INSTALL'
installer="$(mktemp)"
trap 'rm -f "$installer"' EXIT
curl --proto '=https' --tlsv1.2 --fail --silent --show-error \
  --connect-timeout 15 --max-time 120 --max-redirs 0 \
  'https://<release-origin>/releases/<version>/install.sh' --output "$installer"
sudo bash "$installer" install \
  --release-origin 'https://<release-origin>' \
  --version '<version>' \
  --domain 'shop.customer-domain.tld'
AIKAYUN_INSTALL
```

安装器支持 Linux `amd64` 与 `arm64`。客户需要预先准备本机 Unix socket Docker Engine、Docker Compose v2、公开 DNS 和可从公网访问的 TCP 80/443；远程 TCP/SSH Docker context 会被拒绝，因为固定部署目录、宿主端口与 Docker 数据目录必须属于同一台机器。安装器要求 root 权限和目标文件系统至少 8 GiB 可用空间，不安装 Docker、不修改防火墙，也不依赖宿主 Node、pnpm 或 Git。

固定部署目录为 `/opt/aikayun`，Compose project 固定为 `aikayun`，持久卷固定为 `aikayun_postgres_data`、`aikayun_state`、`aikayun_caddy_data` 和 `aikayun_caddy_config`。受控安装器用 `/run/lock/aikayun-install.lock` 排他，并以原子目录切换安装已验证工件；持久阶段为 `verified → secrets_ready → storage_ready → storage_volumes_ready → database_ready → roles_ready → migrated → identity_ready → api_ready → web_ready → caddy_started → https_ready → setup_token_issued`。它在启动任何服务前创建并核对数据库、Caddy 卷的 Compose project/volume 标签；进入 `storage_volumes_ready` 后任何固定卷缺失或标签错配都会停止自动恢复。启动顺序为状态卷初始化、数据库、最小角色、迁移、实例身份与 Pending Key、API、Web、Caddy；Caddy 使用现有生产配置申请 HTTPS。HTTPS/ACME 未就绪时保留已提交状态供 `resume` 使用，不会签发 setup token，也不会通过 HTTP 提交凭证。

首次部署成功后，安装器只在本机 HTTPS 探测通过时调用 API 的受控 CLI，生成 256-bit setup token 并打印在当前服务器终端。客户随后打开 `https://<店铺域名>/setup`、输入该 token、设置管理员邮箱和密码，然后在后台 `/admin/license` 输入运营方提供的组合凭证：

```text
AK1.<licenseId>.<activationCode>
```

本机维护命令：

```sh
sudo /opt/aikayun/aikayun status
sudo /opt/aikayun/aikayun resume
sudo /opt/aikayun/aikayun diagnose
sudo /opt/aikayun/aikayun setup-token
```

`setup-token` 先通过本机 TLS 校验访问实际域名，再在 API 容器内重新签发 token。有效期固定为 30 分钟；重新签发会增加 token generation，使旧 token 和 setup session 失效。token 只在本机终端显示，不进入 URL、前端配置、镜像、Compose 环境、数据库明文或日志。

## 安装供应链与数据边界

- 初始下载 URL 只定位发行工件。安装器中的 Cosign 工具镜像 digest、GitHub `release.yml` main workflow identity、Sigstore OIDC issuer 均固定；没有 `--public-key` 或环境变量可以替换生产 JWS 根。
- 安装器核对静态 release marker 和版本 index，验 manifest Cosign、release JWS、逐个 artifact 长度与 SHA-256、API/Web image Cosign、OCI release bundle Cosign 与 digest。它调用 bundle 中已验证的 `extract-release-bundle.sh`，将 HTTPS 与 OCI 提取内容逐字节比较。Compose 的 API、Web、PostgreSQL、Caddy image 全部来自签名 manifest digest。
- 新建部署遇到已有 `/opt/aikayun` 文件、固定卷或网络会停止。`resume` 只接受由本安装器建立的 schema、manifest SHA、域名与发行 origin 记录，并重新验证已保存工件。
- 状态阶段文件不保存秘密。所有密码和 keyring 在启动数据库前以 create-once 方式原子写入 secrets 目录。PostgreSQL bootstrap 密码为 root-owned `0400`；API、migration、支付与交付 keyring 为 UID/GID `1000:1000`、`0400`。状态卷由固定 Postgres 镜像中的一次性初始化脚本处理；只对带安装器标签的新卷创建 UID/GID `1000:1000`、`0700` 的五个固定数据目录并写入 root-owned `0400` 卷标记。SIGKILL 后仅允许从这些已知空目录继续；发现未知路径或任何现存数据时停止。重复安装不生成替代值，缺失或损坏的秘密、卷标记或持久卷会停止恢复。
- `production-install-init` 仅接受 `NODE_ENV=production`。它复用 `initializeInstallationIdentity()` 的数据库 journal、私钥文件和 binding；运行时复核原实例身份。Pending AES-256-GCM key 使用与临时开发 CLI 分开的生产入口，复用同一 key 文件 schema、安全文件写入与 `O_NOFOLLOW` 校验，并把原 key ID 与 32-byte key 的 SHA-256 指纹一次性写入同一 `installation_binding`。数据库事务持有独立 advisory lock；COMMIT 结果不明时读取实际 binding。重复调用只能验证绑定的原文件，文件缺失、权限错或指纹不符都会停止，不生成替代 key。SIGKILL 留下的私有临时文件只按随机临时名和安全 inode 条件继续/清理；不完整临时写入只有在 DB 尚无 key binding 时才可重新生成。
- 数据库迁移与初始化失败后，`resume` 先按真实数据库 migration journal 再运行迁移器；它不从进程退出码推断事务回滚。身份操作复用原数据库 advisory lock 和 identity journal。没有 `down -v`、删除卷、自动改密或重建实例身份路径。
- Web 初始化使用单例 `admin_setup_state` 和 `admin_setup_sessions`。token 在 DB 只存 SHA-256；session 10 分钟、token generation 绑定，所有提交共用 PostgreSQL advisory lock。管理员 insert 与永久完成标记原子提交。页面与兼容 `admin:init` 共用同一个 lock 和状态；setup 完成后删除管理员、停用账号或登录失败均不会重新开放。
- token 验证与管理员创建同时要求生产 HTTPS、精确 Origin、双提交 CSRF 和速率限制。API request body 由 Fastify logger 整体脱敏。COMMIT 回执不确定时按 setup 状态和完成 session hash 查询提交结果，不重复插入或改写密码。

## Trust Store、授权激活与经营门禁

⑦-2 release artifact 新增 `license-trust-bundle.jws`。发行构建必须通过当前发行配置内嵌的离线 Ed25519 root 验证该签名 JWS，并核对 issuer、最低版本与当前有效期；工件 SHA 继而由 release manifest 和 Cosign 签名绑定。正式激活前，API 以现有可信 HTTPS 时间锚再次验证 JWS 和有效期，然后使用既有 Trust Store、文件锁、数据库协调器事务接受 bundle，并在同一首次接受操作中建立 `instance_license_state` 的数据库 trust head。全新安装不运行 `license-trust-head:init`；该命令只供适用的既有 Store/head 绑定流程使用。

授权中心 `185dac80204f60abbaa63ffeb5af7d7054b685d7` 没有公开 Trust Bundle 下载 endpoint，且其仓库保持只读。本阶段不虚构 endpoint。发行站必须带上当前 root 签名 JWS；在该文件缺失或过期时，管理员页面允许导入等价 JWS，系统仍只信任镜像内固定离线根、issuer、最低版本和可信时间，不接受用户替换公钥。无效文件不会改变 Store/head。

组合凭证只用于客户输入，严格拆成 UUID 与现有 32-byte canonical base64url activation code。授权 operation ID 和凭证意图先按现有 AES-GCM Pending Key 加密持久化，再调用既有 Challenge、`/v1/activations`、operation query/continue 和 lease projection。相同凭证重试继续原 operation；另一个凭证遇到同一 license 的未决 operation 时返回明确冲突。原文不进入 URL、日志、错误响应或状态页。

管理员页展示授权状态、有效截止时间、Trust Store 状态及可操作原因。授权中心超时或当前许可证不可验证不会关闭 API、后台、历史交易、付款、退款、提现、交付或下载；新订单与新充值仍由原 `assertNewObligationAllowed()` 门禁 fail closed。

## 当前验收与外部条件

release migration head 为 `202611030002_license_pending_key_binding`；它只给已有 `installation_binding` 增加一次性 Pending Key KID/指纹栏位，并允许一次从空到已绑定的受控更新。安装身份、数据库 ID、实例 ID、JWK thumbprint 与初始化 journal 仍使用原有单例结构。

| 验收面 | 结果与边界 |
|---|---|
| Lint / 类型 / 构建 | PASS：`pnpm lint` 0 error（原有商品页 7 warnings）；API、Web typecheck 与 Nuxt production build 通过。发行包装配修正后再跑 lint 与 release 测试通过。 |
| API / PostgreSQL | PASS：全量 `pnpm verify` 的 API 41 文件、695/695 测试通过；包括首次管理员竞争、未知 COMMIT、setup 永久关闭、组合授权激活、冻结中心 HTTPS Challenge 与恢复互操作。测试中心 checkout 为只读 baseline `185dac80204f60abbaa63ffeb5af7d7054b685d7`；凭证、密钥与数据库均为临时测试数据。 |
| Release 与工件 | PASS：最终 `pnpm test:release` 6/6（JWS 错签名、替换公钥、manifest/摘要篡改、symlink 与镜像 digest 清单）；`test-scan-gate.sh` 与 `test-bundle-extraction.sh` 通过。另用临时装配 fixture 确认完整 API/Web 引用落到 Compose、installer 和 Trust Bundle 被装入 bundle。没有使用或生成生产签名密钥。 |
| 浏览器 | PASS：`pnpm verify` Playwright 主套件 95/95，品牌变体 1/1、SSR 错误 3/3、dev preview 1/1、production brand 1/1；含 `/setup` 管理员创建与 `/admin/license` 组合凭证 UI。 |
| Linux 容器架构 | PASS：最终生产 API/Web/PostgreSQL/Caddy Compose 分别在 `linux/amd64` 与 `linux/arm64` 启动；head 为 `202611030002_license_pending_key_binding`，验证 least-privilege DB、fresh identity、Pending Key DB binding、SSR 和无生产授权时拒绝新经营义务；重复 init 与 API 重建后 identity、key ID 与 Pending Key 文件指纹保持不变。使用无生产 Trust Bundle 的隔离镜像，不代表商业授权 PASS。 |
| 原子密钥恢复 | PASS：定向密钥与身份用例 37/37；覆盖 Pending Key 一次绑定、绑定后文件丢失即拒绝、不完整写入/硬链接边界的恢复，以及身份初始化 SIGKILL journal 路径。 |
| 真实公网安装 | BLOCKED（外部条件）：此 checkout/主机没有正式发行 origin、受控发布的 Cosign/JWS 签名材料、生产授权 root/config、当前 Trust Bundle 或客户域名，因此没有运行正式 `install.sh` 下载、ACME、真实卡密或商业激活。隔离 Compose 运行和工件 verifier 不会伪装成公网安装 PASS。 |

无论隔离环境结果如何，缺少正式发行材料时都不标记商业发行 PASS。公开安装与真实客户验收目前受这些外部条件阻断：

- 正式 release HTTPS origin / 域名、静态上传 endpoint 和其 create-only 凭据未配置；不能生成客户可直接复制的正式域名命令。
- 生产 `AIKAYUN_TRUSTED_LICENSE_CONFIG_BASE64`、授权离线根/在线 signer pin、release P-256 key 与公钥 pin 未配置。
- 当前有效的 root 签名 Trust Bundle 未提供给 release workflow 的 `AIKAYUN_TRUSTED_LICENSE_BUNDLE_BASE64` variable。
- GHCR 包管理、受保护 `aikayun-release` reviewers、branch protection 与 `v*` tag ruleset 尚未具备。
- ⑦-2 发行扫描的当前快照仍有未解决的基础镜像 High/Critical findings；正式发行前必须用届时固定 digest 重新扫描并通过 release gate。
- 在以上项未具备前，不生成正式签名密钥，不用测试根冒充生产根，不运行真实客户卡密，也不声称真实公网安装、ACME 或商业激活验收通过。

⑦-3 只交付安装、setup、授权激活及隔离验收，不包括自动升级、完整生产备份、跨主机灾难迁移、告警或客户门户。独立验收完成后停止，不自动进入⑦-4。
