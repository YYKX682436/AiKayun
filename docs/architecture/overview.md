# AiKayun 架构概览

## 目标与边界

AiKayun 是可独立部署、可通过商业授权销售的数字商品商城。系统采用 TypeScript 模块化单体：一个 Nuxt 前端工程通过同源 BFF 路由调用单一 Fastify API，API 与前端共用 TypeBox 契约。当前目录按可运行的技术边界拆分，不预先创建空业务模块。

当前已实现商城基础、后台基础、管理员安全入口，以及阶段③-D1～D6 的商品管理 API/后台和 D7 顾客商品首页、分类、搜索、详情与公开读取 API。消费者账户、订单、支付和履约仍不在数据库范围内；卡密/账号资源池与第三方库存同步也尚未实现。后续按阶段推进，避免以插件名义引入没有明确边界的万能扩展框架。

旧 MyShop 仓库只允许在后续需要时只读核对业务经验；本工程不复制其代码，不继承其数据库、API、配置或部署依赖，也不接入闲鱼系统。

## 工程边界

- `apps/web`：Nuxt 4 SSR 前台和管理后台；路由按页面拆包，共享 UI 主题。
- `apps/api`：Fastify 5、TypeBox 验证、统一响应与错误格式、请求日志、OpenAPI 和数据库访问。
- `packages/contracts`：前后端共用的 TypeBox schema 和 TypeScript 类型。
- `packages/money`：唯一的基础金额运算边界，使用 `decimal.js`，只接收十进制字符串。
- `deploy`：Caddy 入口；Compose 编排数据库、迁移、API、Web 与代理。

## 数据与迁移

PostgreSQL 18 为唯一业务数据库。Kysely Migrator 以版本化 TypeScript 迁移管理 schema；API 不在进程启动时隐式改表。业务表包括管理员与会话、`products`、`product_variants`、分类、规格、属性关系表和独立商品操作审计表，另有 Kysely 自己的迁移元数据。商品、分类、规格组、规格值、商品属性和 SKU 均有独立 UUID 身份；商品名称与分类名称都不作为身份。商品创建时会生成真实默认 SKU，但默认 SKU 不是永久要求；数据库在事务提交时要求每个商品至少有一个 SKU，允许全部 SKU 暂停或退役。仍有商品时，数据库禁止对 SKU 表执行 `TRUNCATE`。

`product_categories` 使用自关联 `parent_id`，数据库递归触发器验证循环和四级深度。分类树写事务先更新共享的 `product_category_tree_guard` 行；共同元组写冲突使 READ COMMITTED 等待后读取最新树状态，并使持有旧快照的 REPEATABLE READ 事务以序列化冲突失败。触发器也为直接数据库写入更新该行；单独的 advisory lock 不承担快照正确性。`product_category_assignments` 以 `(product_id, category_id)` 去重，部分唯一索引限制每商品一个主分类，延迟约束在事务提交时保证“有关联就必须恰有一个主分类”。关联行按商品保存分类内排序；分类和商品外键均避免删除分类时级联删除商品或关联。

`product_option_groups`、`product_option_values` 和 `product_variant_option_values` 是商品私有规格模型。关系表以复合外键保证 SKU、规格组、规格值属于同一商品，主键保证同一 SKU 每组最多选一个值。服务端限制每商品最多 5 组、每组最多 50 个值、每商品最多 1000 个 SKU；延迟数据库检查要求每个启用 SKU 都有完整且有效的当前组合，但不要求任何 SKU 处于启用状态。`product_variants.retired_at` 区分永久退役与可恢复的临时停用；退役 SKU 的 ID、编码和规格引用不可改写或删除。关联表及其规格父表在有数据时拒绝 `TRUNCATE`，避免绕过行级约束而留下不一致组合。`product_attributes` 是轻量关系表，限制每商品最多 30 项；属性只保存名称、值和顺序，不参与 SKU 组合。

`product_variants.combination_key` 仅为数据库内部身份校验字段，不由 API 接收或返回。无规格 SKU 使用空字符串；有规格时按规格值 UUID 的规范小写文本排序，生成为 `v1:<uuid>.<uuid>`。因此显示名称和排序变化不会改变组合身份。现存 `(product_id, combination_key)` 是 `DEFERRABLE INITIALLY IMMEDIATE` 唯一约束，服务在组合保存事务中显式延迟该约束以支持组合交换；保存使用普通 INSERT/UPDATE/DELETE，不把该约束错误地当作 `ON CONFLICT` 仲裁器。产品修订行的 `FOR UPDATE` 锁与 `expectedRevision` 校验串行化每次商品级编辑；数据库触发器为 SKU/规格/分类/属性关系改动递增商品修订，延迟检查键与实际规格关联一致。

③-D3 为 `product_variants` 增加可选划线价、内部成本价、nullable 库存模式和独立 `inventory_revision`。CNY 售价/划线价使用十进制字符串，最多两位小数；成本价最多五位小数。划线价必须严格高于售价。成本价只在受管理员会话保护的 SKU 价格接口返回，不进入商品详情契约。

数量库存保存在 `product_variant_quantity_inventory`，使用 PostgreSQL INTEGER，包含 `stocked`、`reserved` 和时间戳；数据库约束保证数量非负且 `reserved <= stocked`，可售量由 `stocked - reserved` 计算。`product_variant_inventory_adjustments` 保存不可变调整流水，`operation_id` 全局唯一；数量、流水和 SKU 的 `inventory_revision` 在同一 PostgreSQL 事务中提交。仅库存数量变化不会递增 D2 `products.revision` 或 SKU 普通 `revision`。SKU 库存模式变更则校验商品、SKU 与库存修订并进入商品修订事务。

`inventory_mode = NULL` 表示未配置，不等于不限库存。`quantity` 有可信数量；`resource_pool` 当前明确未就绪，不建立假卡密数据；`external` 当前未就绪，不声称有货；`unlimited` 不追踪数量，库存摘要中的充足状态表示此库存策略不限制数量，不代表交付就绪或可下单。商品库存摘要只供后台使用，不是购买资格判断。

SKU 矩阵预览会标出因正库存、预留或库存调整历史而无法移除/改配的 SKU，并单独说明数量或预留是否阻止永久退役；保存会在商品修订事务内再次检查。数量 SKU 只有 `stocked = 0` 且 `reserved = 0` 才能永久退役；临时停用不受库存数量限制。空数量库存状态可在安全删除 SKU 前一并清理；库存调整历史保留 SKU 外键且 `ON DELETE RESTRICT`，有历史的 SKU 在清零后可永久退役。退役 SKU 保留库存归属，并禁止重新定价或切换模式；只有迁移前已退役且遗留正库存的 SKU 可通过受版本保护、带流水的减少操作清退，不能补货。迁移会保留这些旧记录并报告数量，不会自动清零或删除。规格名称和顺序调整不更改 SKU/库存身份；会改变组合归属的改配在有库存数量或历史时被阻止。

库存数量表和调整流水表各有 PostgreSQL `BEFORE TRUNCATE` 保护；对 SKU 表执行 `TRUNCATE ... CASCADE` 时，级联到这两张库存表也会被拒绝。测试库重置使用 `_test` 数据库上的 `DROP SCHEMA ... CASCADE`，不依赖对业务表执行 `TRUNCATE`。

新增 SKU 必须明确提交价格和启用状态，规格自动生成会先计算笛卡尔积上限；服务不会默认生成零元可售 SKU。`mode: "all"` 的默认值只用于新组合，已存在组合保留价格、启用状态、SKU ID 和编码；预览与保存共用同一事务计划。旧无规格 SKU 不会被映射成新规格：无历史引用时可在同一事务中安全移除；有历史引用时可明确永久退役并保留其原身份和规格关系。临时停用 SKU 可按原身份重新启用，永久退役 SKU 不能重新销售，且保留的历史组合占用其唯一组合键。测试库重置命令在连接后检查数据库名以 `_test` 结尾，随后才允许清空其 schema。

金额的基础精度约定：`product_variants.sale_price` 保留 `NUMERIC(18,5)`，数据库约束和 API/服务校验共同限定非负、最多两位小数，首版固定 CNY。更广义的单价运算仍可使用最多 13 位整数、5 位小数的 `packages/money` 精确十进制基础；实付、结算等未来已结算金额最多 16 位整数、2 位小数，对应 `NUMERIC(18,2)`。API 金额始终用十进制字符串，数据库金额由 PostgreSQL 驱动以字符串返回；商品售价输出统一格式化为两位小数，不转换为 JavaScript `number`。结算舍入采用四舍五入（half up），规则由 `packages/money` 明确实现和测试。TypeScript `number` 只用于数量等整数，不用于资金运算。

阶段③-D1 提供草稿商品及默认 SKU 的创建、读取；D2 扩展商品详情，返回分类、规格组选项、SKU 选项关系和展示属性。管理 API 支持分类 CRUD/移动/排序、商品分类关系原子替换、属性原子替换、SKU 矩阵预览与事务保存。D3 增加 SKU 价格读写、库存摘要、模式设置、安全库存调整及分页流水读取。写请求复用管理员会话、同源 Origin 与 CSRF 校验；共享 TypeBox 契约拒绝未知字段。D1-D3 均不提供商品管理 UI、商品生命周期 CRUD、媒体、订单、支付、交付或公开商城商品接口。

③-D4 增加管理员商品列表、基础资料编辑、生命周期、复制、安全永久删除和审计历史。合法流转为 `draft → active → paused → active`；`draft`、`active`、`paused` 可归档，`archived` 只能恢复为 `draft`。状态 API 锁定商品并校验 `expectedRevision`；同状态请求不更新修订或产生重复审计。发布只验证名称、商品性质、SKU 存在和启用 SKU 的规格组合，不要求有货或有启用 SKU；`active` 不代表立即可购买。

基础资料 API 只编辑名称、基础描述和商品性质。名称会去除首尾空白；普通编辑不能编辑归档商品。分类关联、展示属性、SKU 矩阵、SKU 售价和库存模式写入也通过同一商品行锁与修订助手检查归档状态；必须先恢复为草稿再修改经营配置。库存调整与明细读取保留，库存数量仍只使用 `inventory_revision`，不会覆盖或递增商品修订。分类树及分类本身的独立管理不受关联商品状态冻结。商品性质只能在草稿或已下架状态修改，并且在任何 SKU 配置库存模式、存在库存行/库存流水或存在永久退役 SKU 后拒绝变更。相同资料不更新修订或写审计。

商品列表在 PostgreSQL 侧完成名称/UUID/SKU 编码搜索、状态/性质/分类过滤、计数、SKU 数量、最低/最高有效售价和分类摘要。价格范围及售价排序仅纳入未永久退役 SKU，临时停用 SKU 仍计入后台配置价格；无未退役 SKU 时 `priceRange` 为 `null`。价格排序升序和降序都将空价格排在末尾，并以商品 UUID 稳定次级排序；`skuCount` 仍包含退役 SKU。分类过滤使用 `EXISTS`，避免关联重复；每页最多 100 件，创建时间、更新时间也以商品 UUID 作稳定次级排序。一个请求的计数和结果在同一 `REPEATABLE READ` 事务快照读取，不会逐商品加载详情。

商品复制在一个事务中锁定源商品并检查修订，为商品、非退役 SKU、规格组、规格值和属性分配新 UUID，为每个新 SKU 生成新编码，并按新规格值 UUID 重建组合键。分类关系引用现有分类身份。库存模式与库存修订重置为未配置/0，不复制数量库存、预留、调整流水或永久退役 SKU。若源商品的 SKU 全部永久退役，会创建新的禁用默认 SKU，不继承任何退役身份；此草稿仍满足至少一个 SKU 的数据库约束。

永久删除锁定商品、全部 SKU 和数量库存记录后检查非零库存/预留、库存流水、永久退役 SKU 及已配置资源来源。仅无保留引用且数量为零时才删除商品自有的分类关联、展示属性、规格关系、空数量记录、SKU 和商品。库存流水 SKU 外键继续 `ON DELETE RESTRICT`；未来订单和资源表也必须通过明确的 `RESTRICT` 外键保护，不以级联删除历史记录。整商品删除在同一事务中删除最后一个 SKU 和商品，利用延迟的“每商品至少一个 SKU”约束在提交时检查；单独删除最后一个 SKU 仍然失败。

`product_management_audit_events` 保存创建、基础编辑、发布/下架/重新上架、归档/恢复、复制和删除事件，包含商品 UUID、管理员 UUID、操作类型、时间及安全摘要。描述在创建、复制及实际编辑时保存对应前后值，其他操作只保存长度摘要；审计不复制 SKU 价格、库存、卡密、账号密码或 API 密钥。审计表不设置商品或管理员外键，商品删除不会删除或阻塞审计；更新、删除和截断均被数据库拒绝。审计写入与对应业务事务一起提交。

## ③-D5 商品媒体与富文本

迁移 `202610170003_product_media_and_rich_content` 为商品增加独立的 `rich_content` JSONB Tiptap 文档，并建立 `product_media`、`product_media_variants` 和 `product_media_references`。原 `products.description` 仍是简短基础描述。媒体元数据和图片内容分开保存：PostgreSQL 只存 UUID、WebP 格式、衍生图尺寸/字节数、SHA-256、处理版本和服务端生成的存储标识；图片字节位于 `MEDIA_ROOT`。一张图有 `thumbnail`、`card`、`detail` 三个固定尺寸版本，边长上限分别为 320、960、1920 像素。

管理员上传经同源 Nuxt BFF 到 Fastify multipart 路由；普通 Fastify JSON body limit 保持 64 KiB。multipart 限定一个文件、无字段、单文件 10 MiB、总 Content-Length 最多 10 MiB + 32 KiB。Sharp 校验实际 JPEG/PNG/WebP 解码、24 MP 像素上限、单页内容和 MIME 一致性，再应用 EXIF 方向并转成剥离附加元数据的 WebP。处理最多一个并发任务，失败关闭且不登记部分结果。

上传文件先写入媒体根目录中的 `.staging`，刷新文件数据后通过同文件系统 hard link 原子发布到 UUID 路径，再提交三条变体元数据。数据库提交前公开 API 查不到这些文件；元数据提交失败会尝试清除文件。异常退出留下的 staging 或无元数据对象不会成为可读媒体。`pnpm media:check` 校验已登记文件的尺寸和 SHA-256，并报告缺失、损坏、未登记对象和陈旧临时文件。只有显式传递至少 24 小时的清理宽限期才会删除陈旧且仍无元数据的生成文件；缺失或损坏的已登记对象只报告，不自动删除。

`product_media_references` 是商品图片引用的唯一关系来源：`source = gallery` 表示相册，`source = rich_content` 表示正文引用。图库每商品最多 20 张，`sort_order = 0` 是封面；同一媒体可在多个商品、图库和正文间复用。相册/正文修改都锁定商品并校验 `expectedRevision`，归档商品在恢复为草稿前不可编辑。媒体外键使用 `ON DELETE RESTRICT`，所以删除 API 无法越过任何商品引用；永久删除商品只删除其自身引用行，归档保留引用，复制则复用媒体身份并复制正文关系。

富文本 JSON 仅允许服务端明确验证的段落、1～3 级标题、加粗、斜体、安全链接、无序/有序列表、引用、分隔线、换行和商品图片节点。空正文写入时规范化为含一个空段落的 Tiptap `doc`，符合 ProseMirror 文档节点结构。文档限制为 128 KiB、50,000 个文本字符、500 个节点、20 层嵌套和 100 张图。图片节点使用 `{ type: "image", attrs: { mediaId, alt? } }`，拒绝 `src`、任意 URL、`data:`、`blob:` 和客户端路径。链接只接受 HTTP(S)、mailto、tel、站内根相对路径和片段；属性采用精确白名单。共享 `productRichContentToSafeHtml` 只从通过服务端校验的 JSON 生成转义 HTML。D6 管理后台通过 Nuxt UI `UEditor` 与 Tiptap 自定义图片节点适配该 JSON；D7 详情只渲染 API 通过此转换边界生成的轻量 HTML，不向前台 chunk 加载编辑器。

图片公开地址为同源 `/api/v1/media/:id/:variant.webp`，经已有 Nuxt `/api/**` BFF 转发，不增加第二套媒体代理或 Caddy 路由。它只按 UUID 和固定变体读取已登记路径，支持 GET/HEAD、SHA-256 ETag、Last-Modified、条件 304 和一年 immutable 缓存。磁盘文件不在每次请求时解码或转换。

## ③-D6 商品管理后台

D6 开放 `/admin/products`、`/admin/products/new` 和 `/admin/products/:id`，沿用已有管理员登录、`admin-auth` 路由中间件、Nuxt 同源 BFF、`UDashboard` 布局与 AiKayun 蓝色后台主题。页面服务端不读取商品列表或详情，未登录首屏不会输出商品管理数据；写 API 仍逐请求检查管理员会话、Origin、CSRF 和各自的商品、SKU 或库存修订。

列表通过 D4 服务端分页、搜索、分类/状态/性质过滤和日期/价格排序，查询状态写入 URL。创建仍由 D1 创建草稿及默认 SKU，`Idempotency-Key` 通过 `admin_product_creation_requests` 与商品同事务登记，浏览器刷新/重试可返回原商品。SKU 价格列表分页读取，批量修改最多 50 个 SKU、检查商品和 SKU 修订并在单事务内写入；商品列表封面直接由相册首图投影得到。媒体库分页返回引用数量，媒体文件只有完全未引用时才允许永久删除。

SKU 矩阵保存前调用 D2 预览，保留 ID/组合可匹配的 SKU；D1 无规格默认 SKU 加入规格组时必须由管理员显式永久退役，再创建有明确价格/启用状态的新组合。退役身份与历史保留，库存或引用阻止时预览/保存显示原因。库存摘要、模式和 `inventory_revision` 继续用 D3 独立接口；调整以唯一 `operationId` 幂等提交，失败后先按同一 ID 查流水再重试。库存流水支持服务端游标分页及 operationId 筛选。

图片仍按 FormData → Nuxt `proxyRequest` → Fastify multipart → Sharp → PostgreSQL 元数据与媒体目录的链路处理。Chromium 浏览器回归记录 multipart `Content-Length` 并观察上传返回 201，图片 URL 经同源 BFF 访问；全局 JSON body limit 和 Fastify 内部监听边界保持不变。UEditor 的基础格式映射到现有 Tiptap 节点；图片使用自定义 `mediaId` 节点，读写都执行共享契约校验，不将公开 URL 存为媒体身份。

## ③-D7 商城公开商品前台

顾客页面为 `/`、`/categories/:id`、`/search` 和 `/products/:id`，默认 Nuxt 布局读取当前可见分类并提供桌面分类入口、移动端抽屉、搜索入口和主题切换。首页、分类、搜索、商品卡片和详情共用 `components/storefront` 的轻量商品网格/卡片及分类导航；数据通过同源 Nuxt BFF 读取 Fastify 公开接口，页面 SSR 输出真实商品内容。

Fastify 的 `/api/v1/public/*` 接口与管理员接口分离，使用独立 TypeBox 契约和 PostgreSQL 查询投影。列表、详情与搜索只选 `status='active'`；详情不可用为 404，列表以 UUID 稳定分页。可见分类使用根节点向下的递归 CTE，隐藏节点会剪掉整个子树；分类商品用关联 `EXISTS`，父分类合并可见后代且不重复。中文搜索在 PostgreSQL 对名称和基础描述执行转义的 `ILIKE` 包含匹配。公开查询排除成本、SKU 编码、组合键、退役 SKU、修订、审计与库存流水；富文本仅由共享安全转换器生成。

前台售价按 `enabled=true AND retired_at IS NULL` 且规格关系有效的 SKU 计算，SQL 聚合与明细价格都不使用 JavaScript `number`。划线价随同一 SKU 返回；全部销售 SKU 停用时商品仍可展示但无可选价格。数量库存仅公开 `stocked - reserved > 0` 的状态；resource pool/external 是 `not_ready`，unlimited 表示数量策略不限，null 为未配置。这些状态不是购买资格，也不公开精确库存、管理摘要或交付承诺。

商品 UUID 为稳定详情 URL 身份。不可公开的有效 UUID 由公开 API 返回 404；SSR 详情收到明确 404 时以 302 临时返回首页，首页、分类、搜索、详情遇到上游服务故障时均返回安全的 502 页面，不当作不存在商品。商品页面 HTML 和公开商品 API 为 `no-store`；Caddy 不设置动态 HTML 缓存，D5 图片 URL 仍保持长期 immutable。页面 canonical、OG、结构化 Product 和 XML sitemap 使用 `NUXT_PUBLIC_SITE_URL` 配置的 HTTP(S) origin，不拼接未经验证的 Host；首页和分类 canonical 保留有效分页，分类保留非默认受支持排序，搜索为 noindex 并 canonical 到 `/search`。sitemap 只列当前 active 商品与可见分类。购买、购物车、订单、支付、卡密交付、评价和供应商采购均不属于 D7。

## 管理员认证

管理员由 `pnpm admin:init` 单次初始化，邮箱和密码必须从运行环境注入；命令拒绝短密码，也拒绝第二次初始化。密码以独立随机盐和 scrypt 参数存为编码哈希。认证使用随机不透明 HttpOnly Cookie，数据库只保存会话令牌的 SHA-256 摘要；会话可过期、撤销并即时检查管理员是否仍启用。

变更请求要求同源 `Origin`、CSRF Cookie 与 `X-CSRF-Token` 三者匹配。CSRF 比较使用常量时间比较；登录路由有速率限制。生产环境强制 Secure Cookie，Caddy 是公开入口，API 容器只在 Compose 网络内可达。管理接口逐条执行服务端会话验证，前端路由守卫只提供导航体验，不构成权限边界。

## 事务与未来业务

当前认证写入仅涉及单笔管理员或会话记录。后续订单、支付尝试、库存扣减和履约必须分别定义幂等键、状态转移与并发保护，关键跨表变化放在明确的数据库事务中；外部支付或发货适配器的网络调用不能包在长时间持有的数据库事务里。旧仓库只提供只读的事务设计参考，不能替代新项目自己的数据模型和测试。

## 部署边界

Compose 启动时先等 PostgreSQL 健康，再运行一次性迁移容器，之后启动 API、Nuxt SSR 和 Caddy。PG18 官方镜像卷挂在 `/var/lib/postgresql`，以覆盖 PG18 的版本化数据目录。所有镜像按当前稳定标签和 manifest digest 固定。站点域名、外部 HTTPS、PostgreSQL 密码均通过本地未跟踪的 `.env` 注入；本阶段没有授权中心、安装器或更新器。
