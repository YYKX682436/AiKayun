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

API 集成测试会连接真实 PostgreSQL、清理测试库 schema，先建立管理员与既有商品迁移基线，写入迁移前商品/SKU 样本，再升级到最新迁移并重复执行迁移。测试覆盖健康检查、管理员登录/退出、会话保护、D1 商品/金额/最低 SKU 约束、分类树四级边界、自引用及 READ COMMITTED/REPEATABLE READ 并发移动、多分类主分类约束和删除冲突、动态规格组合预览/增量保存/交换、暂停后恢复、永久退役身份和引用保护、自动矩阵默认值隔离、TRUNCATE 防护、原子回滚、属性限制、CSRF、严格 TypeBox 校验和 OpenAPI。为了避免误删，测试只接受名字以 `_test` 结尾的数据库。Playwright E2E 会重置同一测试库、创建一次性测试管理员，启动 API 和 Nuxt dev server，再在 Chromium 中检查 SSR 页面及管理端认证流程。

③-D2 管理 API 的主要写入边界如下：

- `GET/POST/PATCH/DELETE /api/v1/admin/categories` 管理最多四级的分类树。PATCH 使用分类 `expectedRevision`；删除有子类或商品关联的分类会返回冲突，需先移动子类或修改商品分类关系。
- `PUT /api/v1/admin/products/:id/categories` 原子替换一件商品的分类集合。空集合代表解除全部分类；非空集合必须恰有一个主分类。商品 `expectedRevision` 用于并发冲突检测。
- `PUT /api/v1/admin/products/:id/attributes` 原子替换最多 30 项展示属性。保留的属性需携带原 ID；省略的属性会删除。
- `POST /api/v1/admin/products/:id/variant-matrix/preview` 只预览当前版本下的笛卡尔积、保留/新增/修改/移除结果；`PUT /api/v1/admin/products/:id/variant-matrix` 在一个事务中保存规格和 SKU。每个新 SKU 都要有明确售价和启用状态；`mode: "all"` 自动生成全组合前先检查总数，默认值只应用于新增 SKU，已有 SKU 保留价格和启用状态。`mode: "selected"` 只保存提交的组合；临时停用 SKU 可通过相同 ID 再次启用，`retireSkuIds` 则明确永久退役并保留 SKU 身份及规格引用。

所有 D2 写请求都要求管理员会话与 CSRF 校验，并携带商品或分类修订版本。预览不会写数据库；保存时会重新校验修订版本。`combination_key` 是服务端内部字段，不应由客户端生成或持久化；相同的选项值 UUID 集合按规范顺序生成同一键，名称与排序变更不会改变 SKU 组合身份。

`pnpm verify` 会按顺序运行 lint、类型检查、单元/数据库测试、浏览器 E2E 和生产构建。

## Compose 全栈

`docker compose up -d --build` 启动 PostgreSQL、迁移、Fastify、Nuxt SSR 和 Caddy。默认 HTTP 入口是 <http://localhost:8080>，HTTPS 入口预留为 8443；宿主机端口只绑定 `127.0.0.1`，开发默认站点只监听 HTTP。`docker compose down` 保留数据卷，`docker compose down -v` 会删除 PostgreSQL 和 Caddy 数据卷。
