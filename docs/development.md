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

API 集成测试连接真实 PostgreSQL 并清理测试库 schema：先从 D1 和 D2 迁移基线写入既有商品/SKU，再升级至最新迁移并重复执行迁移。覆盖范围包括管理员认证与 CSRF、D1/D2 商品和规格矩阵约束、分类树和并发移动、SKU 退役及引用保护，以及 D3 CNY 售价/划线价/成本精度、库存模式状态、reserved 边界、并发调整、幂等、流水不可变、分页、模式切换和矩阵删 SKU/改组合保护。D7 增加独立公开投影、生命周期过滤、隐藏分类树、价格/SKU资格、中文搜索、库存状态及 sitemap 的 PostgreSQL 集成覆盖。测试只接受名称以 `_test` 结尾的数据库。Playwright E2E 会重置同一测试库、创建一次性测试管理员，启动 API 和 Nuxt dev server，再在 Chromium 中检查真实首页、分类、搜索、详情、媒体与 SKU 交互以及管理端认证流程。

③-D2 管理 API 的主要写入边界如下：

- `GET/POST/PATCH/DELETE /api/v1/admin/categories` 管理最多四级的分类树。PATCH 使用分类 `expectedRevision`；删除有子类或商品关联的分类会返回冲突，需先移动子类或修改商品分类关系。
- `PUT /api/v1/admin/products/:id/categories` 原子替换一件商品的分类集合。空集合代表解除全部分类；非空集合必须恰有一个主分类。商品 `expectedRevision` 用于并发冲突检测。
- `PUT /api/v1/admin/products/:id/attributes` 原子替换最多 30 项展示属性。保留的属性需携带原 ID；省略的属性会删除。
- `POST /api/v1/admin/products/:id/variant-matrix/preview` 只预览当前版本下的笛卡尔积、保留/新增/修改/移除结果；`PUT /api/v1/admin/products/:id/variant-matrix` 在一个事务中保存规格和 SKU。每个新 SKU 都要有明确售价和启用状态；`mode: "all"` 自动生成全组合前先检查总数，默认值只应用于新增 SKU，已有 SKU 保留价格和启用状态。`mode: "selected"` 只保存提交的组合；临时停用 SKU 可通过相同 ID 再次启用，`retireSkuIds` 则明确永久退役并保留 SKU 身份及规格引用。

所有 D2 写请求都要求管理员会话与 CSRF 校验，并携带商品或分类修订版本。预览不会写数据库；保存时会重新校验修订版本。`combination_key` 是服务端内部字段，不应由客户端生成或持久化；相同的选项值 UUID 集合按规范顺序生成同一键，名称与排序变更不会改变 SKU 组合身份。

## ③-D3 价格与库存管理

- `GET/PATCH /api/v1/admin/products/:id/variants/:variantId/prices` 读取或修改单个 SKU 的 CNY 售价、划线价和成本价。修改携带 `expectedRevision`（商品修订）与 `expectedSkuRevision`；省略可选字段表示不修改，传 `null` 表示清空。售价与划线价为十进制字符串，最多两位小数；划线价必须高于售价。成本价最多五位小数，只在管理员价格响应中出现。
- `GET /api/v1/admin/products/:id/inventory?quantity=1` 返回所有 SKU 的库存摘要。`quantity` 是用于计算 `sufficient` 的目标数量，默认 1。未配置、resource_pool、external 和 unlimited 不伪造数量；`unlimited` 的 `sufficient: true` 只说明库存策略不限制数量，不代表商品可购买或交付已就绪。
- `PUT /api/v1/admin/products/:id/variants/:variantId/inventory-mode` 配置或切换模式，携带商品、SKU 和库存三个修订版本。切至 `quantity` 时在事务中创建 0 库存记录；从数量库存切出前必须先把 `stocked` 和 `reserved` 都处理为 0。`resource_pool` 与 `external` 目前返回 `not_ready`，没有资源池或供应商模拟接口。
- `POST /api/v1/admin/products/:id/variants/:variantId/inventory/adjustments` 支持 `increase`、`decrease` 和目标值 `set`。请求包含 UUID `operationId`、`expectedInventoryRevision` 和调整原因；相同操作重放返回原流水，复用标识但内容不同返回冲突。所有数量在服务端根据当前行锁计算，客户端不能提交权威的前后库存。
- `GET /api/v1/admin/products/:id/variants/:variantId/inventory/adjustments?limit=50` 返回最多 100 条，使用响应中的 `(createdAt, id)` 游标继续读取。流水不可修改或删除。

SKU 临时停用不受库存数量影响；永久退役要求 quantity 模式的 `stocked` 与 `reserved` 都为 0。矩阵预览用 `retirementBlocked` / `retirementBlockReason` 明确标出正库存或预留阻止退役，保存与数据库触发器都会再次校验。已有流水不阻止清零后的退役，历史记录保持不变。升级自早期 D3、已经退役但仍有数量库存的 SKU 会原样保留；管理员可以使用带 `expectedInventoryRevision` 与 `operationId` 的减少/降低目标库存请求逐步清退，退役 SKU 不允许补货或切换模式。迁移通过 PostgreSQL NOTICE 报告这类记录数；reserved 大于零时，必须先由负责该预留的后续业务或受控维护流程释放，D3 不提供伪造的预留释放接口。

库存更新锁定商品、SKU 与数量库存行，并在一个事务中更新数量、独立 `inventory_revision` 和流水；库存写入不递增商品修订或普通 SKU 修订。模式切换和价格修改属于商品编辑，使用 D2 商品修订锁并递增商品修订。数据库延迟约束保证仅 quantity 模式拥有数量库存行，外键 `RESTRICT` 保留流水所引用的 SKU。矩阵预览在 `inventoryMutationBlocked` / `inventoryMutationBlockReason` 中说明因库存数量、预留或流水历史导致的改配/删除限制；保存会再次检查。库存数量表和流水表拒绝 `TRUNCATE`，包括由 `product_variants TRUNCATE ... CASCADE` 触发的级联；测试库 schema 重置仍使用受 `_test` 名称保护的 `DROP SCHEMA ... CASCADE`。

`pnpm verify` 会按顺序运行 lint、类型检查、单元/数据库测试、浏览器 E2E 和生产构建。

## ③-D4 商品生命周期与管理操作

所有商品管理写请求都要求管理员会话、同源 Origin、CSRF Cookie 与 `X-CSRF-Token`，并严格拒绝未知字段。商品修改、状态变更、复制和删除均携带 `expectedRevision`；商品锁使用 `products FOR UPDATE`，库存操作继续以独立 `inventory_revision` 并发控制。

- `GET /api/v1/admin/products` 支持 `page`（默认 1）、`pageSize`（默认 20，最大 100）、`search`、`status`、`productType`、`categoryId`、`sortBy` 和 `sortOrder`。搜索覆盖商品名称、UUID 和 SKU 编码；分类筛选使用 `EXISTS`。排序项是创建时间、更新时间或最低有效 SKU 售价，默认更新时间倒序，商品 UUID 始终作为稳定次级排序。价格范围和价格排序排除永久退役 SKU、保留临时停用 SKU；全部 SKU 退役时 `priceRange` 为 `null`，升序和降序均将无价格商品放在末尾。SKU 数仍统计退役 SKU。列表直接返回 SKU 数、价格范围和分类摘要，不逐商品请求详情，也不返回成本价。
- `PATCH /api/v1/admin/products/:id` 编辑 `name`、`description`、`productType` 与 `expectedRevision`。名称会 trim 后验证；相同值不会修改修订或增加审计。归档商品必须先恢复为草稿。性质只允许草稿或已下架商品修改，且任何 SKU 已配置库存模式、存在数量库存行/调整流水或存在永久退役 SKU 时会冲突拒绝。
- `PATCH /api/v1/admin/products/:id/lifecycle` 请求 `status` 和 `expectedRevision`。状态流转为草稿发布、销售中下架、下架后重新上架；草稿/销售中/暂停均可归档，归档只可恢复到草稿。同状态请求返回当前商品，不更新修订、不产生重复审计。发布验证名称、性质、至少一个 SKU 和启用 SKU 规格完整性，不要求库存大于零，也不要求有启用 SKU。
- `POST /api/v1/admin/products/:id/copy` 请求源商品 `expectedRevision`。复制在事务内锁定源商品，重新生成商品、SKU、规格组、规格值和属性 UUID 及 SKU 编码，映射规格组合并复用分类关系。新商品永远为草稿；所有新 SKU 的库存模式为未配置、库存修订为 0，数量、预留和流水均不复制。全部源 SKU 已退役时，会生成一个新的禁用默认 SKU 维持数据库 SKU 下限。
- `DELETE /api/v1/admin/products/:id` 请求 `expectedRevision`。仅当商品没有库存流水、非零库存/预留、永久退役 SKU 或资源来源时才永久删除；拒绝时保留商品并建议归档。删除清理商品自有关系和空数量库存记录，库存历史的 `ON DELETE RESTRICT` 不变，所有步骤与删除审计在同一事务中提交。即使商品已归档也必须通过相同检查。
- `GET /api/v1/admin/products/:id/history` 提供管理员专属审计历史，`limit` 最大 100，并以 `(createdAt, id)` 游标翻页。历史按商品 UUID 保存且无商品外键，删除商品后仍可查；数据库拒绝审计行更新、删除和截断。创建、复制及描述编辑会记录描述前后值；审计不包含 SKU 成本、库存流水、卡密或凭据。

归档状态也约束 D2/D3 商品配置写入口：分类关联、展示属性、SKU 矩阵保存、SKU 售价和库存模式操作会在同一事务内先锁商品行、校验商品修订，再拒绝 `archived` 商品。必须先恢复到 `draft` 才能继续编辑。规格矩阵预览与商品/库存/审计读取仍可使用；数量库存调整保留独立 `inventory_revision` 机制，允许盘点及有效库存清退。对分类树或单个分类的管理保持独立，不因其关联归档商品而冻结。

新迁移 `202610170002_product_management` 仅添加不可变的商品管理审计表，不回填虚构的历史操作，也不修改之前迁移。API 集成测试会在 `_test` PostgreSQL 数据库上从阶段基线升级到最新迁移并重复迁移，再运行生命周期、编辑、列表、复制、删除、审计和并发路径。

## ③-D5 商品媒体与富文本 API

媒体元数据保存在 PostgreSQL，文件保存在 `MEDIA_ROOT`。本地默认目录是 `$XDG_DATA_HOME/aikayun/media`，未设置 `XDG_DATA_HOME` 时使用用户数据目录 `~/.local/share/aikayun/media`；配置值必须为仓库外的绝对路径。Docker Compose 将 API 的 `MEDIA_ROOT` 挂到独立命名卷 `product_media`，容器 API 进程仍以 `node` 用户运行。

- `POST /api/v1/admin/media` 接受 multipart 单文件字段 `file`，管理员会话、同源 Origin 和 CSRF 校验缺一不可。只接收 JPEG、PNG、WebP；文件最多 10 MiB、图片最多 24 MP、每个请求只有 1 个文件/part 且不接受字段，总请求 Content-Length 上限为 10 MiB + 32 KiB。上传需携带有界 `Content-Length`；伪造 MIME、SVG/HTML、损坏/动画内容都会被拒绝。处理输出为剥离 EXIF 等元数据的 WebP，版本分别适配 320、960、1920 像素的缩略图、商品卡片与详情。
- `GET /api/v1/admin/media/:id` 读取管理员可见的媒体元数据；公开图片使用 `GET/HEAD /api/v1/media/:id/:variant.webp`。`thumbnail`、`card`、`detail` 三个固定路径不接受客户端文件名或磁盘路径。内容是不可变 WebP，响应设置正确 MIME、SHA-256 ETag、Last-Modified、`nosniff` 和一年 immutable 缓存。
- `GET /api/v1/admin/products/:id` 同时返回基础 `description`、富文本 `richContent` 和排序后的 `gallery`。`GET /api/v1/admin/products/:id/media` 只读取图库；`PUT` 同路径完整替换最多 20 张图片，数组顺序即图库顺序，首张即封面。
- `PUT /api/v1/admin/products/:id/rich-content` 使用 `{ expectedRevision, content }` 保存唯一 Tiptap JSON 正文。服务端严格验证节点、mark、属性、链接、节点数/层级/文本/JSON 大小，并确认所有 `mediaId` 已处理完成。正文图片 URL 由服务端稳定生成，不存 HTML 或 Markdown。
- `DELETE /api/v1/admin/media/:id` 仅删除没有图库或正文引用的媒体；引用检查由同一 PostgreSQL 事务锁和 `ON DELETE RESTRICT` 外键保护。取消图库关系不会自动删图。

相册与正文保存均使用商品 `expectedRevision`，归档商品必须先恢复草稿。相册或正文修改不改变 SKU、售价、库存或 SKU 身份。空正文规范化为空段落 `doc`，可直接交给未来的 Tiptap 编辑器读取。`gallery_updated` 审计保存排序后的媒体 UUID 和数量；`rich_content_updated` 只保存 JSON 字节数、文本长度、节点数和媒体数，不复制正文。复制和永久删除审计也只保存媒体 UUID 与正文摘要。复制商品保留 JSON 并复制两类关系行；永久删除只释放已删除商品的引用，媒体文件在仍有其他引用时继续受保护。

异常退出后检查媒体：

```sh
pnpm media:check
```

该命令校验所有登记版本的文件大小和 SHA-256，并报告缺失/损坏文件、没有元数据的对象和陈旧 staging。默认只读。显式清理时使用 API 容器内脚本，例如 `docker compose exec api node dist/media/reconcile-cli.js --delete-unreferenced-older-than=24h`；只删除超过指定宽限期且仍未登记的生成对象或 staging，已登记媒体绝不作为孤儿删除。

D5 集成测试使用真实 PostgreSQL 和独立临时媒体目录；测试数据库必须以 `_test` 结尾。覆盖真实 multipart、Sharp 图像处理、媒体磁盘读写/摘要、事务失败清理、引用共享/复制/删除、Tiptap 恶意结构拒绝和并发修订保护。全栈 Compose 联合备份/恢复见 [部署与恢复](deployment.md)。

## ③-D6 商品管理后台

后台页面为 `/admin/products`、`/admin/products/new` 和 `/admin/products/:id`，仅开放商品管理导航。列表使用 D4 服务端分页查询并将搜索、状态、性质、分类和排序保存在 URL；手机改用卡片布局。新建页用 D1 草稿及默认 SKU 接口，并发送 UUID `Idempotency-Key`；迁移 `202610170004_product_creation_idempotency` 在数据库保留键、管理员、规范化载荷摘要和创建商品身份，使相同请求安全返回原商品。

- D6 新增 `GET /api/v1/admin/products/:id/prices?page=...&pageSize=...` 和 `PATCH /api/v1/admin/products/:id/prices/batch`。批量接口每次最多 50 个 SKU，在同一事务校验商品修订、每个 SKU 修订、退役状态、售价/划线价关系和成本精度，再返回当前价格页。资金始终作为十进制字符串处理。
- `GET /api/v1/admin/media?page=...&pageSize=...` 提供可复用图片库及引用数量；商品列表 API 返回相册封面投影。图库移除仅解除当前商品引用，独立 `DELETE /api/v1/admin/media/:id` 仍受共享引用检查和数据库外键保护。
- 库存流水查询 `GET /api/v1/admin/products/:id/variants/:variantId/inventory/adjustments` 可按 `operationId` 找回结果。浏览器请求结果不确定时保存原 operationId，先查流水再以原请求内容安全重试；数量及流水只由服务端决定。
- 上传仍经过浏览器 FormData、Nuxt BFF 的 H3 `proxyRequest`、Fastify multipart、Sharp 和真实媒体目录。Chromium E2E 检查浏览器 multipart `Content-Length`，并在 `aikayun_test` 的 API、数据库和文件目录上完成上传与图片读取；JSON body limit 保持原值。
- 图文详情使用 Nuxt UI `UEditor`（Tiptap），图片节点扩展将编辑器 `src` 绑定转换为 D5 `{ mediaId, alt? }` 契约。保存前共享 TypeBox/富文本校验与服务端白名单仍为最终边界。

R1 管理端一致性规则：`mode: "all"` 的 `skuEnabledUpdates` 只携带明确修改的现有 SKU UUID 和启用状态；预览和保存重用相同请求体，新 SKU 默认值只用于新增组合。既有 SKU 的身份、编码、价格和库存关系仍由 D2 组合键映射保持，退役 SKU 更新被拒绝。分类 PATCH 在树保护事务中按 `sort_order, id` 建立同级稳定顺序，插入后重新编号目标同级，移动时也重新编号来源同级；同级排序修订随事务更新。商品列表初始化只由 query watcher 发起一次请求，后续请求使用递增序号，只允许最新序号更新列表、分页、错误和加载状态。商品编辑页只对 `PRODUCT_REVISION_CONFLICT` 打开本地/服务器修订决策；库存和 SKU 的其他 409 保留各自错误原因及本地草稿，库存数量变更只使用独立 `inventory_revision`。商品富文本组件仅由管理商品编辑页异步加载，避免 Tiptap 进入无关路由的客户端入口。

`apps/web/test/e2e/admin-products.spec.ts` 覆盖真实商品创建和刷新、分类关联、规格/SKU 身份与价格、浏览器图片上传、富文本重载、库存不确定响应后同 operationId 查询、完整生命周期、商品复制/删除、库存历史阻止删除与归档保留，以及旧商品修订冲突、SSR 未授权首屏、320px/浅深色主题。页面以同一 `_test` PostgreSQL 数据库运行，测试会重置该测试库，不连接生产数据或媒体目录。

## ③-D7 商城顾客前台

D7 前台路由、公开 Fastify API、字段安全规则、有效售价/库存规则、分类树、搜索、稀疏 SKU 选择、404/302 处理、富文本、SEO、缓存与验证路径详见[商城前台说明](storefront.md)。公开数据只经 `/api/v1/public/*` 读取，不调用管理员 ProductDetail；业务查询在 PostgreSQL 中先过滤 active 商品、可销售 SKU 和可见分类，再映射为公开 TypeBox 契约。Nuxt SSR 与同源 BFF 保持不变。

Chromium D7 E2E 使用真实 `_test` PostgreSQL、Fastify、Nuxt BFF 和独立媒体目录。除页面和 SSR HTML 外，还通过真实后台 API 创建分类、SKU、图片和正文，校验首页/分类/详情、搜索 query 同步、分类排序请求身份、搜索离页重进及乱序响应、真实排序/筛选/分页/历史恢复、失败重试、缺失商品 302、客户端 API 500 不误跳转、sitemap、媒体 immutable 缓存、稀疏 SKU 组合与多个视口尺寸。独立 SSR HTTP 测试使用隔离的模拟 API 注入各公开接口 500，读取实际 HTTP 状态、响应头和 SSR HTML，验证四种页面的 200/404/502/302、错误正文脱敏、canonical 分页、noindex、伪造转发 Host 不影响绝对 URL，以及错误态保留重试操作。搜索交互断言等待控件完成客户端水合后执行；测试不会用 sleep 猜测页面就绪状态。

D7 最初只提供商品浏览。后续阶段已增加购物车、报价、真实订单、库存预留及按 SKU 配置的履约；购买填写、暂停规则和成交资料归档见[⑥-2C-1](./purchase-forms-6-2c-1.md)。当前不声称顾客填写资料会传给上游，也不把尚未配置的付款或履约能力显示为可用。

## Compose 全栈

`docker compose up -d --build` 启动 PostgreSQL、迁移、Fastify、Nuxt SSR 和 Caddy。默认 HTTP 入口是 <http://localhost:8080>，HTTPS 入口预留为 8443；宿主机端口只绑定 `127.0.0.1`，开发默认站点只监听 HTTP。`docker compose down` 保留数据卷，`docker compose down -v` 会删除 PostgreSQL 和 Caddy 数据卷。
