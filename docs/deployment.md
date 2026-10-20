# 部署

当前 Compose 是本地和测试环境的完整运行边界。它不连接、不修改 MyShop 生产环境，也不含正式客户安装器、自动更新器或商业授权中心。

## 准备

1. 在目标 Linux 主机安装 Docker Engine 与 Compose 插件。
2. 从受控渠道获取代码和锁文件。
3. 复制 `.env.example` 为 `.env`，为 PostgreSQL 设置唯一高强度密码。
4. 在 `.env` 中设置 `NUXT_PUBLIC_SITE_URL` 为商城公开的规范 HTTP(S) origin，并按需设置 `NUXT_PUBLIC_STORE_NAME`、`NUXT_PUBLIC_STORE_LOGO_URL` 和 `NUXT_PUBLIC_STORE_BRAND_COLOR`。该 origin 用于 canonical、OG 图片/地址和 sitemap，不从请求 Host 头推断。它们通过 Nuxt public runtimeConfig 在容器启动时读取。修改后仅需重新创建 web 容器，例如 `docker compose up -d --no-deps --force-recreate web`，无需重新构建镜像。
5. 配置 DNS，将独立商城域名指向主机；放通 TCP 80 和 443。
6. 将 `HTTP_BIND_ADDRESS=0.0.0.0` 明确设为公开入口，`SITE_ADDRESS` 设为域名，`PUBLIC_ORIGIN` 和 `NUXT_PUBLIC_SITE_URL` 都设为同一 `https://域名` origin，`COOKIE_SECURE=true`，并将 `HTTP_PORT=80`、`HTTPS_PORT=443`。Caddy 负责 TLS 终止；生产管理员会话必须使用 Secure Cookie。

默认品牌配置为 `AiKayun 数字商城`、无 Logo、`#2563EB`。例如，独立部署为紫色品牌可使用：

```dotenv
NUXT_PUBLIC_STORE_NAME="青屿数字商店"
NUXT_PUBLIC_STORE_LOGO_URL="/store-logo.svg"
NUXT_PUBLIC_STORE_BRAND_COLOR="#7C3AED"
```

Logo URL 仅接受站内根路径或 HTTPS 地址；主色仅接受 `#RGB` 或 `#RRGGBB`。非法值回退到默认配置。品牌配置在商城前台生效，后台继续使用 AiKayun 主题。

所有真实密钥仅从 `.env` 或部署平台密钥注入，不能提交到仓库。不要将数据库端口暴露到公网；Compose 默认只绑定到 `127.0.0.1`。正式部署必须显式设置公开绑定地址、HTTPS 域名与 Secure Cookie。

启用在线支付前，在 API 容器环境配置 `PAYMENT_CREDENTIAL_KEY_RING`。每个独立部署实例各自生成 AES-256-GCM 密钥，不要让 web 容器接收该值。完整格式、通道管理和密钥轮换步骤见[在线支付协议与运行手册](./online-payments.md)。

## 启动与管理员初始化

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 migrate api web caddy
```

`migrate` 服务必须成功完成后，API 才会启动；API readiness 检查同时验证 PostgreSQL 连接。随后通过 API 容器运行一次性管理员初始化：

```sh
docker compose exec -e ADMIN_INITIAL_EMAIL=owner@example.com -e ADMIN_INITIAL_PASSWORD='注入的唯一强密码' api node dist/admin-init.js
```

在生产主机上优先用容器平台的 secret 注入功能，避免把密码写入终端历史。确认登录后清除临时环境变量。

## 数据、升级和回滚

PostgreSQL 18 使用命名卷 `postgres_data` 并挂载至 `/var/lib/postgresql`，覆盖 PG18 的实际版本化 PGDATA 路径。商品图片使用独立命名卷 `product_media`，默认挂载在 `/var/lib/aikayun/media`，目录通过 `MEDIA_ROOT` 配置；一次性 `media-init` 容器为所配置的卷挂载点设置 `node:node` 所有权后退出，运行中的 Fastify API 始终使用非 root `node` 用户。`docker compose up -d --build` 或容器重建不会移除两个数据卷；不要用 `docker compose down -v` 保留数据。

PostgreSQL 元数据和媒体文件必须作为同一备份时间点的一对数据保存。仓库提供 `scripts/backup-compose-data.sh BACKUP_ROOT`：它先停止 API 以静止媒体/商品写入，再生成 PostgreSQL custom dump、打包 `MEDIA_ROOT`、写入 SHA-256 校验文件，最后重新启动 API。备份目录含数据库、图片及管理员数据，应存放在访问受控的持久位置；备份脚本本身不删除旧备份。

`scripts/restore-test-compose-data.sh BACKUP_DIRECTORY` 仅用于隔离恢复验证。它先校验备份文件 SHA-256，只允许 Compose 目标数据库名以 `_test` 结尾，并要求显式设置 `ALLOW_TEST_DATABASE_RESTORE=YES`、显式测试/恢复项目名及项目专属 `product_media` 卷；失败时会让目标服务保持停止供检查。不要将该测试恢复脚本用于生产恢复。建议在单独 Compose 项目、独立命名卷和独立端口进行验证，例如：

```sh
export COMPOSE_PROJECT_NAME=aikayun-restore-test
export POSTGRES_DB=aikayun_restore_test
export PG_PORT=15433 HTTP_PORT=28080 HTTPS_PORT=28443
docker compose up -d --build
ALLOW_TEST_DATABASE_RESTORE=YES scripts/restore-test-compose-data.sh /secure/backups/20261017T120000Z
docker compose exec -T api node dist/media/reconcile-cli.js --check
```

恢复后再通过隔离站点的公开媒体 URL 请求图片，并将返回体 SHA-256 与媒体 API 元数据比较。只确认文件名存在不足以验收恢复。恢复完成后可停止隔离项目并删除它自己的测试卷；不要操作默认 Compose 项目或正式卷。

升级时拉取目标提交，检查迁移说明，然后 `docker compose up -d --build`。数据库迁移按版本前进并由部署前的一次性服务执行。当前未承诺自动 schema 回滚或在线零停机升级；如应用回滚依赖不可逆迁移，应恢复经过验证的备份并部署兼容版本。

`docker compose down` 保留数据。只有明确要销毁本地/测试环境数据时才使用 `docker compose down -v`。不要在生产环境使用该命令。
