# ⑦-2 商业发行流程

本目录和 `scripts/release/` 定义 ⑦-2 的发行接口。首个不可覆盖的候选版本是 `0.1.0-rc.1`，release ID 固定由版本派生为 `aikayun-0.1.0-rc.1`。部署配置只接受 API、Web、PostgreSQL、Caddy 的 OCI digest；Compose 不使用 `latest`，也不包含源码构建步骤。

## 发行制品

GHCR 容器包名为：

- `ghcr.io/yykx682436/aikayun-api`
- `ghcr.io/yykx682436/aikayun-web`
- `ghcr.io/yykx682436/aikayun-release-bundle`

客户从 release bundle OCI 镜像取出 `release-manifest.json`、分离式 JWS、Cosign bundle、digest 固定的 Compose、Caddy 配置、DB role bootstrap、迁移 checksum、逐架构 SBOM、第三方 NOTICE、release verifier 和 `extract-release-bundle.sh`。首次引导可从签名 HTTPS release 目录取得并校验该 shell artifact，再由无源码安装器复用其 digest 固定提取接口；脚本底层使用 Docker pull/create/cp，不运行 bundle 代码，且也放在 OCI payload 内供后续直接调用。取包只需要公开 GHCR 匿名拉取权限；两个 Git 源码仓库保持 Private。

版本清单的 schema、字节规范化、ES256 分离式 JWS 签名/验签及篡改测试位于 `apps/api/scripts/release/manifest.mjs`。JWS release key 必须是固定的 P-256 密钥，公钥由受保护的 release 环境固定；每版 manifest 和 bundle OCI 另外由 Cosign GitHub OIDC 身份签名，API/Web OCI index 也签名。Cosign 身份固定为本仓库的 `release.yml` `main` workflow。release key、Cosign workflow 身份与授权中心的在线/离线签名密钥用途分离；签名清单包含授权中心当前在线 signer KID，签名与离线验证都会拒绝 release root 与任一授权 key 重用。独立 `release-verifier.mjs` 可验 JWS，`verify-artifacts.mjs` 会拒绝符号链接并逐个核对签名清单列出的文件大小和 SHA-256。

清单绑定源码 commit、build UTC 时间、SemVer、release ID、两个实际平台的 OCI 子 digest、SBOM SHA-256、所有下载文件 SHA-256、授权 issuer/root/minimum bundle version、迁移文件清单 SHA-256、数据库可读/可写 head 和兼容路径。镜像内只嵌入 release ID、版本和经过生产 issuer/root pin 验证的授权配置；最终清单再绑定镜像 index digest，因此不再有 API 镜像 digest 与 `release_manifest_sha256` 自指问题。

`release-index.json` 使用 HTTPS origin 下 `/releases/<version>/` 路径。独立发布端必须匿名提供静态文件并返回 `.well-known/aikayun-release.json`，其中声明 schema、产品、release 路径、GHCR registry 和 `http-put-if-none-match-v1` 发布协议。发布端的 HTTPS PUT 接口必须对每个文件执行 `If-None-Match: *` 创建，不允许覆盖，并且发布后必须可匿名下载逐字节回读。`release.yml` 先验证 marker 和空版本路径，再上传清单；`release-index.json` 最后写入，作为版本可用的发布标记。当前没有配置发行域名或该 HTTPS endpoint，因此本机/CI 构建只能作为隔离候选验证，不能报告已向客户发布。

API/Web 镜像只推送到 `aikayun-staging-api`、`aikayun-staging-web` 私有 GHCR 包，release workflow 在构建前核实这两个包以及 `aikayun-staging-release-bundle` 已存在并保持 Private。八个平台镜像的 Trivy vuln/secret 扫描、运行时验收、清单签验和 bundle OCI 提取校验均完成后，固定版本标签才由 Skopeo `--all --preserve-digests` 晋级到最终包；脚本核对 staging manifest、copy 返回值和目标 manifest 的 digest 一致。失败时 release 临时目录清理，脱敏扫描 JSON 保存在 runner 临时区并由 workflow 以 7 天期限上传，漏洞不例外、不降级。

## 构建与签名门禁

发行 workflow 是手动触发，要求从 `main` 运行、当前提交的常规 CI 成功、全量验证通过、输入 `PUBLISH-<version>` 确认文本、`main` 分支至少一名 PR reviewer、strict CI status check 和管理员强制执行、GitHub `aikayun-release` environment 至少一名 reviewer 审批且只允许受保护分支、GitHub `v*` tag ruleset 阻止更新与删除、生产授权配置/root pin、独立 release signing key、公钥 pin、授权中心 signer KID 列表、issuer 和已就绪的 HTTPS release origin。脚本会从 GitHub API 读取并核对分支、environment 和 ruleset 设置，读取失败即拒绝登录 GHCR、签名和发布。发布权限仅在该 workflow job 使用 `packages:write` 和 OIDC；普通 CI 保持 `contents:read`。

`aikayun-release` environment 需要受控的 `AIKAYUN_RELEASE_POLICY_READ_TOKEN` 用于读取 reviewer 与 tag ruleset 设置；GHCR 包权限由隔离的 `AIKAYUN_GHCR_PACKAGE_ADMIN_TOKEN` 管理；自有发行端需要独立的 `AIKAYUN_RELEASE_PUBLISH_TOKEN`。签名密钥通过 `AIKAYUN_RELEASE_SIGNING_KEY_PEM` 与独立 passphrase 注入。发行配置使用 `AIKAYUN_TRUSTED_LICENSE_CONFIG_BASE64`，生产 issuer/root KID、release 公钥 JWK、授权中心 signer KID 清单、发行 origin 与 upload endpoint 分别由同名受保护 Actions variables 固定。所有这些材料必须存入 `aikayun-release` environment，且只授予受控发行 workflow。

相同 SemVer/tag 在 GHCR、manifest ID 和 bundle 中都只接受首次生成。任何阶段失败即消耗该版本，修复必须提高 SemVer 并生成新 release ID。workflow 不覆盖已有容器 tag 或 Git tag，不推送 `latest`。公开可拉取验证在退出 GHCR 登录状态后执行。

实际阻断条件如下：

- 依赖审计中任何 High 或 Critical 漏洞阻断；Trivy 的 CRITICAL/HIGH 漏洞阻断，包括尚无修复版本的项目，直到修复或由独立发行审核更新策略。
- 任一 npm 生产依赖缺 SPDX/license 声明或许可证文本时阻断；OS/runtime SBOM 组件必须有 SPDX license ID，或有随镜像导出的对应版权/许可证文件，否则阻断。
- 任一平台构建、迁移、API readiness、DB least-privilege、SSR、fail-closed 授权检查、层/最终文件检查、SBOM、签名验签或 OCI bundle 提取文件核对失败时阻断。
- 没有受保护的授权生产配置、release signing key、公钥固定值、授权 signer KID 列表、匿名 GHCR 或独立 HTTPS release origin 时阻断，不创建正式商业签名或发布记录。

目前只检测到 `LICENSE_CENTER_READ_TOKEN` 仓库 secret；没有配置正式 release signing key、生产授权配置、release 公钥 pin、production issuer/root KID、授权 signer KID 列表、受保护的 GHCR 包管理权限、受控 `aikayun-release` reviewer 环境与 `v*` tag ruleset、HTTPS release origin、静态上传 endpoint 或上传凭据。首次运行前还必须由受控管理员创建三个 staging GHCR 包并设为 Private。两个源码仓库在本轮初始核对时均为 Private。GitHub API 当前不允许这个 Private 仓库读取或设置 `main` 分支保护和 tag ruleset，并提示需启用支持 Private 仓库保护的 GitHub 计划；`aikayun-release` environment 也不存在。发行门禁保留这些检查，继续保持 fail closed，不把源码仓库改成公开，也不生成测试密钥冒充正式签名。

2026-11-02 的本机扫描快照也阻止候选发行：API 与 Web 的四个平台镜像各自均为 0 个 High/Critical 漏洞。API 镜像为 Trust Store 内核锁携带 `/usr/bin/flock`；它来自固定 Debian `util-linux@2.41.5-0+deb13u1`，Syft 将该 ELF 包列入逐架构 SBOM，随镜像的 Debian copyright 校验副本进入 NOTICE，许可证未解析数仍为 0。固定 PostgreSQL 18 Alpine 镜像在 amd64、arm64 均为 28 个 High/Critical，包含 Alpine `brotli-libs`、`libcurl` 与 `gosu` 所带 Go 1.24.6 标准库问题；升级到官方 Caddy 2.11.7 后，两架构仍各有 10 个 High/Critical，涵盖 Alpine 系统包和 Caddy Go 依赖。官方 PostgreSQL 18 Trixie 变体扫描为 89 个 High/Critical，因此没有替换 Alpine 镜像。八个 API/Web/PostgreSQL/Caddy 平台镜像的 Trivy secret findings 均为 0；每个镜像的 CycloneDX SBOM 与 NOTICE 已生成，第三方许可证文本未解析数为 0。发行扫描无忽略文件和漏洞例外；必须使用更新的上游镜像或经独立审核的修复镜像，并在发布前重新完整扫描。该快照只记录当前依赖状态，不代替未来发行时的重新扫描。

## 独立验证

OCI image digest 由 Docker/OCI 客户端验证；Cosign 验签使用 Sigstore trust root 与固定的 `release.yml` main workflow 身份。客户先用 Cosign 验证清单和 OCI 签名，再用 JWS key 验证 manifest；这一步先认证 release JWS root，避免把同一 HTTPS bundle 内未经认证的公钥当作信任锚。随后可在没有宿主 Node/npm 或 GitHub 登录的 Linux 上通过 Docker 运行独立工件 verifier：

```sh
docker run --rm \
  -v "$PWD:/release:ro" \
  ghcr.io/sigstore/cosign/cosign:v2.5.3@sha256:f1946d0f30fc8e3777b02f2201e02efdba9fe38f4918162f937052fac98e083f \
  verify-blob --bundle /release/release-manifest.cosign.bundle \
  --certificate-identity 'https://github.com/YYKX682436/AiKayun/.github/workflows/release.yml@refs/heads/main' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  /release/release-manifest.json

docker run --rm \
  -v "$PWD:/release:ro" \
  --entrypoint /nodejs/bin/node \
  node:24.22.0-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c \
  /release/release-verifier.mjs \
  /release/release-manifest.json \
  /release/release-manifest.jws \
  /release/release-signing-root.jwk.json

docker run --rm \
  -v "$PWD:/release:ro" \
  --entrypoint /nodejs/bin/node \
  node:24.22.0-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c \
  /release/verify-artifacts.mjs /release/release-manifest.json /release
```

实际发行必须先核对 manifest 签名及根 key JKT，再依照 manifest 下载工件并核验长度/SHA-256，最后用 manifest 中 digest 拉取镜像。HTTPS 只用于获取，不代替 Cosign/JWS 验证。

## 数据库与授权升级

新数据库发行 Compose 使用独立 `aikayun_app` 与 `aikayun_migrator` 角色；API 只持有应用 DML 凭据，迁移只持有 DDL 凭据，bootstrap superuser 不进入 API 或 Web 容器。role bootstrap 只有在隔离的新库中首次创建角色，不会把旧数据库账号或对象所有者静默改写。已有安装迁移角色必须停写、备份并由数据库所有者单独评审。

API 和迁移进程固定以镜像 UID/GID `1000:1000` 运行。普通 Compose 的文件型 secrets 会保留宿主机文件 owner 和 mode：API 数据库密码、迁移数据库密码、支付密钥环和交付密钥环必须由 UID/GID 1000 读取，建议 owner=`1000:1000`、mode=`0400`；数据库 bootstrap 密码只供 PostgreSQL 初始化和本机角色 bootstrap 使用，可保持 root-owned `0400`。进程内仍会用 `O_NOFOLLOW`、普通单链接文件和严格 mode 校验阻止链接替换、宽权限及 `*_FILE`/明文冲突。

Distroless API 保持无 shell。Trust Store 的进程间内核锁使用镜像中单独复制的固定版 `flock` 运维二进制；备份脚本从已停止 API 容器取得项目卷，通过 digest 固定的 PostgreSQL 镜像、UID/GID 1000 且禁网的临时工具容器归档。恢复验收脚本只允许显式隔离 `_test` 数据库，并用同一受限工具容器解包，不把 shell 或 tar 安装回 API。

首次安装先验证签名发行清单和授权配置，然后通过本机 `license-trust-head:init` 获取并验证固定 issuer/offline-root 签名的 Trust Bundle，只有确认其版本达到发行最低值并与数据库 singleton trust head 一致后才能初始化信任状态。缺少生产配置、bundle 或离线根时新订单/充值继续 fail closed。

普通升级应保留同一 `trust_configuration_id`、issuer、offline root 和已有 Trust Store/DB trust head/时间水位；release ID 随 SemVer 变化，不因此重置 installation identity。若 issuer/root/configuration ID/minimum trust policy 变化，先完整备份 DB、identity、Trust Store、pending key 和 release artifacts，保持旧 bundle 状态可验证，由受控人工审核迁移信任；发行 Compose 不会接受 bundle、替换身份、重置水位或执行 down migration。

当前迁移 checksum 在生产 API 启动前由镜像中的已编译迁移清单验证；release manifest 只声明实际发布 head 和明确兼容范围。未列入可读/可写矩阵的 head 不升级、不回滚。API 服务永不承担 schema owner 或 superuser 权限。
