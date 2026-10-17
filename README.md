# AiKayun

AiKayun 是面向独立部署和商业授权的数字商品商城工程。当前已具备商城基础设施、管理员入口，以及商品、媒体、富文本、分类、动态规格、SKU、价格和数量库存的核心数据与管理 API；商品管理页面和前台商品详情仍未实现。

## 工程结构

- `apps/web`：Nuxt 4 SSR 商城前台与管理后台。
- `apps/api`：Fastify 5 API、Kysely 数据访问、数据库迁移和管理员认证。
- `packages/contracts`：TypeBox 请求、响应与共享类型。
- `packages/money`：基于 `decimal.js` 的精确金额运算基础。
- `deploy`：Caddy 反向代理。
- `docs`：架构、开发和部署说明。

## 快速开始

要求 Node.js 24.22.0、pnpm 10.29.3 和 Docker Compose。

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
```

在 `.env` 中设置唯一的 `POSTGRES_PASSWORD`，再启动数据库并准备测试数据库：

```sh
docker compose up -d db
docker compose exec db createdb -U aikayun aikayun_test
pnpm db:migrate
PUBLIC_ORIGIN=http://localhost:3000 pnpm dev
```

商城地址为 <http://localhost:3000>，API 文档为 <http://localhost:3000/api/docs>。管理员登录入口是 `/admin/login`；管理员只允许使用一次性初始化命令创建。完整说明见 [本地开发](docs/development.md) 和 [部署](docs/deployment.md)。

## 检查命令

`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm e2e` 和 `pnpm build`。数据库集成测试和浏览器测试需要 `TEST_DATABASE_URL` 指向独立的 `_test` PostgreSQL 数据库。
