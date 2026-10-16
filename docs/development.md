# 本地开发

## 环境

- Node.js `24.22.0`（项目由 `.node-version` 固定；Nuxt 4.6.1 要求 Node 24.15 以上）。
- pnpm `10.29.3`（由根 `package.json` 的 `packageManager` 固定）。
- Docker Compose v2；PostgreSQL 使用官方 18 镜像。

先安装锁文件中的依赖并准备本机配置：

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
```

在 `.env` 中为 `POSTGRES_PASSWORD` 设置独立随机值。可以用 `openssl rand -hex 24` 生成，然后仅将结果写入未跟踪的 `.env`。`.env` 已加入忽略规则。

## 启动开发

```sh
docker compose up -d db
docker compose exec db createdb -U aikayun aikayun_test
pnpm db:migrate
PUBLIC_ORIGIN=http://localhost:3000 pnpm dev
```

Nuxt 前台和管理后台地址是 <http://localhost:3000>，API 文档是 <http://localhost:3000/api/docs>。Fastify 监听 3001，数据库监听本机 5432。Nuxt 同源 `/api/**` 代理到 Fastify；浏览器不直接连接内部 API。

### 创建初始管理员

先启动数据库、应用并完成迁移。通过安全的环境注入运行一次性命令，不要把密码写进 shell 历史、脚本或仓库：

```sh
ADMIN_INITIAL_EMAIL=owner@example.com ADMIN_INITIAL_PASSWORD='替换为至少14位的唯一密码' pnpm admin:init
```

若 shell 历史会保存命令，先在当前终端安全设置环境变量，再单独执行 `pnpm admin:init` 并在完成后 `unset ADMIN_INITIAL_EMAIL ADMIN_INITIAL_PASSWORD`。初始化命令不会提供默认账号或弱密码，也不允许重复创建。

## 测试与检查

先建立独立测试库，并让 `TEST_DATABASE_URL` 使用 `_test` 数据库名：

```sh
export TEST_DATABASE_URL='postgresql://aikayun:你的测试库密码@127.0.0.1:5432/aikayun_test'
pnpm lint
pnpm typecheck
pnpm test
pnpm e2e
pnpm build
```

API 集成测试会连接真实 PostgreSQL、清理测试库 schema，先建立仅含管理员表的历史基线，再升级到最新迁移并重复执行迁移。测试覆盖健康检查、管理员登录/退出、会话保护、商品与默认 SKU 事务、数据库约束、精确金额、CSRF、严格请求校验和 OpenAPI。为了避免误删，测试只接受名字以 `_test` 结尾的数据库。Playwright E2E 会重置同一测试库、创建一次性测试管理员，启动 API 和 Nuxt dev server，再在 Chromium 中检查 SSR 页面及管理端认证流程。

`pnpm verify` 会按顺序运行 lint、类型检查、单元/数据库测试、浏览器 E2E 和生产构建。

## Compose 全栈

`docker compose up -d --build` 启动 PostgreSQL、迁移、Fastify、Nuxt SSR 和 Caddy。默认 HTTP 入口是 <http://localhost:8080>，HTTPS 入口预留为 8443；宿主机端口只绑定 `127.0.0.1`，开发默认站点只监听 HTTP。`docker compose down` 保留数据卷，`docker compose down -v` 会删除 PostgreSQL 和 Caddy 数据卷。
