# AiKayun 架构概览

## 目标与边界

AiKayun 是可独立部署、可通过商业授权销售的数字商品商城。系统采用 TypeScript 模块化单体：一个 Nuxt 前端工程通过同源 BFF 路由调用单一 Fastify API，API 与前端共用 TypeBox 契约。当前目录按可运行的技术边界拆分，不预先创建空业务模块。

当前已实现商城基础、后台基础、管理员安全入口、阶段③-D1～D6 商品管理 API/后台、D7 商城目录前台，以及阶段④-2顾客注册登录与策略设置、④-3商家后台顾客管理和④-4购物车与结算报价。阶段④-1提供顾客身份、订单、库存预留、资金账本、支付/退款/提现关系及履约记录的数据基础和数据库状态约束；④-3基于这些真实关系提供只读订单关联和带义务检查的身份匿名化。④-4只保存顾客的 SKU 与数量、将游客购物车保存在浏览器，并提供当前商品/库存报价；真实订单创建、库存预留、支付适配器、超时调度、退款操作、发货引擎、密码找回、联系方式验证和 OAuth 尚未实现。卡密/账号资源池与第三方库存同步也尚未实现。

旧 MyShop 仓库只允许在后续需要时只读核对业务经验；本工程不复制其代码，不继承其数据库、API、配置或部署依赖，也不接入闲鱼系统。

## 工程边界

- `apps/web`：Nuxt 4 SSR 前台和管理后台；路由按页面拆包，共享 UI 主题。
- `apps/api`：Fastify 5、TypeBox 验证、统一响应与错误格式、请求日志、OpenAPI 和数据库访问。
- `packages/contracts`：前后端共用的 TypeBox schema 和 TypeScript 类型。
- `packages/money`：唯一的基础金额运算边界，使用 `decimal.js`，只接收十进制字符串。
- `deploy`：Caddy 入口；Compose 编排数据库、迁移、API、Web 与代理。

## 数据与迁移

PostgreSQL 18 为唯一业务数据库。Kysely Migrator 以版本化 TypeScript 迁移管理 schema；API 不在进程启动时隐式改表。业务表包括管理员与会话、商品目录与库存、商品操作审计，以及④-1新增的顾客、订单、支付、退款、钱包、提现和履约记录、④-2顾客会话与④-3顾客管理审计，另有 Kysely 自己的迁移元数据。商品、分类、规格组、规格值、商品属性和 SKU 均有独立 UUID 身份；商品名称与分类名称都不作为身份。商品创建时会生成真实默认 SKU，但默认 SKU 不是永久要求；数据库在事务提交时要求每个商品至少有一个 SKU，允许全部 SKU 暂停或退役。仍有商品时，数据库禁止对 SKU 表执行 `TRUNCATE`。

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

## ④-1 交易数据架构与事务边界

迁移 `202610180001_trade_foundation` 只新增交易基础数据，不回填或改写阶段③商品、SKU、数量库存与库存调整流水。新增 19 张表：`storefront_customer_policy`、`customers`、`guest_order_sessions`、`product_variant_fulfillment`、`orders`、`order_items`、`order_inventory_reservations`、`order_inventory_events`、`wallet_accounts`、`wallet_operations`、`wallet_ledger_entries`、`payment_attempts`、`payment_receipts`、`order_refunds`、`order_refund_allocations`、`withdrawals`、`withdrawal_payout_attempts`、`order_item_fulfillment_attempts`、`order_status_events`；并提供只读投影 `order_financial_status` 与 `customer_order_status`。迁移在既有 `products` 上加订单后商品性质不可变触发器，在 `product_variant_quantity_inventory` 上加 `reserved` 写入保护触发器；没有修改阶段③历史迁移。

### 顾客身份与订单快照

`admin_users` 与 `customers` 完全分离。注册顾客状态为 `active`、`disabled` 或 `deleted`；有效账户必须有用户名和密码哈希，用户名按小写唯一。邮箱和手机号只在对应验证时间非空时受部分唯一索引保护，未验证的联系方式不会长期占用他人可验证的地址/号码。商店策略默认邮箱/手机号均非必填、游客下单与游客免费领取关闭、未付款订单 15 分钟超时；策略只能保留一个数据库行，不能被删除或截断。邮箱/手机号必填开关只校验新建顾客；已有顾客可以继续登录及由管理员禁用、恢复或编辑。修改联系方式会清除该联系方式的验证时间，不能继承旧验证状态。验证时间戳用于以后限制密码找回；注册、验证与找回 API 尚未实现。

删除顾客是不可逆的匿名化：只有未完成订单、支付/退款/提现、履约、对账等义务均已结清且钱包可用/冻结余额为零时，管理员才能将状态转为 `deleted` 并清除用户名、密码哈希、邮箱、手机号和验证时间。已完成历史交易本身不永久阻止删除；数据库保留顾客 UUID、钱包账户、资金流水及订单、支付、退款、提现和库存关联，不允许恢复身份或物理删除这些记录。匿名化不会自动退款、关闭订单、清空余额或改写成交事实。`guest_order_sessions` 只保存会话 token 的 SHA-256 摘要；订单恰好关联一名注册顾客或一个游客会话，游客会话不能获得独立顾客账户或钱包。

## ④-2 顾客注册登录与商家策略

迁移 `202610190001_customer_sessions` 只新增 `customer_sessions`，不修改④-1及阶段③迁移。会话外键以 `ON DELETE RESTRICT` 保留顾客历史；表内只存随机 Cookie token 的 SHA-256 摘要，并按顾客/到期时间建立撤销和过期查询索引。顾客状态离开 `active` 时由数据库触发器撤销全部会话；API 每次访问仍联查顾客状态、撤销时间和有效期，因此禁用、删除或过期身份不能继续使用旧 Cookie。重新启用曾禁用顾客不会恢复已撤销的旧会话。

顾客账号与管理员账号使用完全独立的请求身份和 Cookie：`aikayun_customer_session`、`aikayun_customer_csrf` 对应顾客路由；`aikayun_admin_session`、`aikayun_admin_csrf` 仅对应管理员路由。两侧共享底层随机不透明令牌、SHA-256 摘要、常量时间双提交 CSRF/Origin 检查、Cookie 属性实现和现有 async scrypt 编码格式，不共享会话表或认证主体。会话 Cookie 为 HttpOnly、SameSite=Lax、Path=/，生产 Secure 由现有 `COOKIE_SECURE` 生产校验保证；CSRF Cookie 为 SameSite=Strict 且可由同源前端读取。默认会话有效期为 12 小时。

顾客用户名为 3～32 位 ASCII 字母、数字、下划线、点或连字符，首字符须为字母或数字，数据库小写唯一索引同时阻止大小写变体和并发重复注册。密码为 12～128 个字符；采用管理员现有随机盐 scrypt 实现，摘要不会出现在响应。注册在一个事务内锁读当前单行商家策略，创建顾客及会话；并发唯一冲突返回通用用户名占用错误。邮箱和手机号仅在注册必填设置开启时要求提供。现有顾客登录不受后来设置变化影响。联系方式可重复使用但保持未验证；本阶段没有验证与找回流程，联系方式变更由④-1数据库触发器清除原验证时间。

主要接口：

- `POST /api/v1/customer/auth/register`、`POST /api/v1/customer/auth/login`、`POST /api/v1/customer/auth/logout`、`GET /api/v1/customer/auth/csrf`、`GET /api/v1/customer/session`。
- `GET/PATCH /api/v1/customer/profile` 只通过已认证顾客 ID 读写资料；`PUT /api/v1/customer/password` 核验当前密码，在同一事务锁定账号、更新 scrypt 摘要、撤销所有旧会话并签发新会话。
- `GET /api/v1/public/storefront/customer-policy` 只读公开注册及游客策略；`GET/PUT /api/v1/admin/storefront/customer-policy` 由管理员会话保护，写入要求同源 Origin 与 CSRF。

注册和登录各限制为每 IP 每分钟 10 次；改密限制为每 IP 15 分钟 5 次，不引入验证码。登录对不存在、禁用和错误密码账户执行相同的通用失败响应。所有状态修改请求执行 Origin 和独立顾客 CSRF 校验；敏感顾客 API 和公开策略均使用 `Cache-Control: no-store`。公开策略中的游客下单和免费领取开关仅保存、读取设置，本阶段没有购物车、订单、领取或付款接口。

商城前台提供 `/register`、`/login` 和 `/account`，通过同源 Nuxt BFF 使用安全 Cookie；默认布局服务端读取会话以保持 SSR、刷新和导航状态一致。商家设置入口位于管理导航 `/admin/storefront/customer-policy`，仅开放四个邮箱/手机号注册要求及游客策略开关；顾客账号管理见④-3。

## ④-3 商家后台顾客管理

迁移 `202610190002_customer_management` 只新增顾客查询索引和 `customer_management_audit`，不改写或回填冻结迁移。顾客列表由 PostgreSQL 服务端按状态、用户名/邮箱/手机号前缀筛选，按注册时间稳定排序并分页；默认只包含 `active` 与 `disabled`，匿名化身份仅在显式筛选 `status=deleted` 时显示。详情只返回资料和联系方式验证时间，不返回密码摘要、会话摘要或令牌；订单 API 读取④-1的订单状态与财务投影，不提供订单写操作。

所有顾客管理路由都要求现有管理员会话；资料、密码、状态与删除写入还要求校验 Origin 和管理员双提交 CSRF。资料编辑复用④-2用户名规则和④-1联系方式验证清理触发器。密码重置使用相同异步 scrypt 摘要，响应不回显临时密码；密码摘要写入、旧会话撤销和审计在一个事务中完成。禁用撤销所有顾客会话，恢复只允许重新登录，旧会话不能复活。

顾客认证前置检查不能替代敏感写入时的事务内复核。资料修改在同一事务中先锁顾客行，再锁并检查对应会话行，确保会话在认证与资料写入之间被撤销时，请求不会继续修改资料。管理员重置、顾客改密、登录和禁用写入均以顾客行为先；钱包订单付款先以顾客行共享锁开始，再按既有订单与钱包顺序操作。删除事务先锁顾客、按 UUID 顺序锁定其已有订单，再锁钱包行，然后检查未完成订单、未决支付/资金对账、退款、提现、履约和非零钱包余额，最后匿名化、撤销会话并写审计。当前没有订单创建服务，因此不能将订单创建与顾客删除的事务串行化描述为已实现能力。

管理审计记录管理员 UUID、顾客 UUID、操作类型、时间和只包含字段名、状态或撤销会话数的摘要。数据库触发器拒绝普通 `UPDATE`、`DELETE`、`TRUNCATE`；审计与业务写入在同一事务提交。接口、参数、错误码、并发约束和删除检查见[顾客管理 API](customer-management.md)。后台页面为 `/admin/customers` 和 `/admin/customers/:id`，沿用 Nuxt UI、后台语义主题和当前显示模式；手机列表改用卡片，详情按模块展示资料、只读订单与审计。阶段④-3不实现购物车、订单创建、订单管理、退款操作或余额业务。

## ④-4 购物车与结算报价

迁移 `202610190003_customer_cart` 新增顾客购物车项及游客购物车合并幂等记录。登录顾客的购物车按顾客/SKU 唯一保存在 PostgreSQL；游客只在浏览器本地保存 SKU UUID、数量及合并标识。登录时服务端以顾客身份将本地条目做加法合并，合并 ID 与内容摘要阻止重复提交或载荷复用。购物车最多 50 个 SKU，每个 SKU 数量 1～99；商品删除后仍能安全显示失效行。

统一报价服务重新读取当前商品、SKU、规格组合、售价、库存模式、可售量、顾客策略及配置的发货方式。金额只在服务端以十进制字符串通过 `packages/money` 运算；游客策略按 `guest_checkout_enabled` 和独立的 `guest_free_claim_enabled` 检查。`quantity` 核对 `stocked - reserved`；`unlimited` 不代表已有履约能力；`resource_pool` 和 `external` 在对应能力未实现时不可购买。现有 `product_variant_fulfillment` 只记发货方式名称，当前没有真实执行器，因此配置名称本身不会使报价可购买。无法购买的商品仍可显示当前身份、价格和状态原因。

商品详情加入购物车、立即购买、购物车页及结算预览共用报价 API。所有报价与顾客购物车响应禁止共享缓存；报价不创建订单、不预留库存、不扣款且不产生发货记录。页面清楚标明预览状态。报价只代表读取时刻，④-5订单创建必须在自己的数据库事务中再次校验身份、价格、库存和限购；④-6继续负责完整库存预留与并发购买规则。接口和状态原因见[购物车与结算报价](customer-cart-checkout.md)。

`orders` 的 `(owner, idempotency_key)` 唯一索引阻止同一归属重复提交；重放请求的载荷摘要一致性由订单服务核对。新订单在创建事务内以 `items_sealed=false` 开始，事务可写入全部订单项，随后只能单向将 `items_sealed` 置为 true；延迟约束拒绝未封存订单提交。订单项插入触发器要求订单仍未封存，因此付款后、零元订单提交后及正式提交后的订单都不能追加商品。`order_items` 按订单与 SKU 唯一，保存商品名、性质、SKU 编码、规格组/值名称和身份、库存模式、发货方式、单价、数量及行金额快照；成交字段不可更新。数据库验证快照与创建时锁定的商品/SKU 一致；提交时延迟约束验证订单总额等于非空订单项金额之和。改名、改价和下架不改历史快照；商品性质在存在订单项后不可更改。商品及 SKU 外键为 `ON DELETE RESTRICT`，订单、订单项、库存与资金记录禁止危险级联删除。后台“删除订单历史”应只写入订单上的单向隐藏时间、管理员和原因，不能删除资金或库存凭证。

### 库存预留和状态

④-1复用阶段③ `product_variants` 与 `product_variant_quantity_inventory`。可售数量仍是 `stocked - reserved`。`quantity` 下单时在同一事务写订单项、订单级预留和初始 `reserve` 事件；事件触发器锁 SKU 后锁原数量库存行，校验可售量并递增既有 `inventory_revision`。管理员不能直接更新 `reserved`；预留只能由订单库存事件变动。每个事件有唯一 `operation_id`，每个 quantity 订单项恰好一个初始预留；重复释放在剩余量校验处失败。取消/超时释放未交付量；付款成功保留预留；履约成功才写 `consume`，同步减少 `stocked` 与 `reserved` 并递增 `inventory_revision`。`unlimited` 不创建数量预留；`resource_pool`、`external` 和 `NULL` 不满足下单快照检查，不能据此收款。

多 SKU 下单服务必须按 `product_id`、再按 `product_variant_id` 的 UUID 升序取得全部商品/SKU 锁，再按相同顺序触及数量库存行，并在同一事务内写订单、订单项和预留。现有库存调整也遵循 SKU → 数量库存的锁顺序。订单支付与超时竞争先锁订单，再锁支付尝试并记录回执；关闭订单时按 SKU UUID 顺序释放剩余预留。付款回执在锁等待结束后以 PostgreSQL `clock_timestamp()` 判断订单/支付尝试截止时间，避免 `now()` 的事务开始时刻把超时后的回执误判为准时。若回执先成功，订单从 `pending_payment` 进入 `processing`，超时关闭只能对仍待付款订单生效；若关闭先提交，之后到账被记录为 `late`，订单保持关闭并留待退款/对账。混合钱包付款在外部支付成功以前保持钱包冻结；失败、取消、超时或迟到回执只允许把冻结额解冻一次。若订单已关闭，迟到回执不能重新扣除钱包余额，也不能重新打开订单。已收到但尚未退款的款项会阻止超时关闭；收到全额退款且没有未决退款/不确定发货后，订单才可关闭。数据库触发器、锁与状态检查已覆盖该竞态，但超时扫描任务尚未实现。

订单状态仅允许 `pending_payment → processing → completed`，并可按规则进入 `closed`。未收款订单可取消或超时关闭；零元订单也可取消。任何已收款订单只有在所有实际到账金额已成功全额退款、没有待处理退款、没有处理中/结果未知的发货尝试且没有发货预留时才可关闭，直接改状态绕过退款会被数据库拒绝。部分退款独立记录，不能覆盖原支付成功结果；已付款但发货失败仍是已付款的处理中订单。零元订单在数据库中直接进入 `processing`，没有支付尝试或虚假第三方成功回执。支付尝试独立于订单：每次外部尝试有 UUID 和幂等键，支付回执唯一记录真实来源、通道交易号、金额与分类；仅有回执的状态转换才能确认支付。成功支付不能因后续发货失败恢复为未付款。支付尝试状态包括 `created`、`pending`、`succeeded`、`failed`、`expired`、`cancelled`、`late_succeeded` 和 `reconciliation_required`；回执分类包括准时、迟到、金额不符与超额。迟到、金额不符和超额收款保留原始金额，不能推动订单进入已付款履约状态。

`order_item_fulfillment_attempts` 将幂等发货操作绑定到单个订单项；`processing/unknown` 保留待发货数量，明确失败可释放，成功必须带结果摘要并消费数量库存。不同订单项可有不同 `fulfillment_method_snapshot`。每个订单项独立记录 `pending/processing/partially_fulfilled/failed/unknown/completed` 和已完成/处理中数量；父订单只有全部订单项全量完成后才成为 `completed`。顾客展示投影依序映射为待付款、待发货、进行中、已完成、已退款或已关闭。部分退款、迟到支付、对账异常和履约失败仍保留各自业务状态，不覆盖订单或真实收款结果。

### 余额、退款与提现

`wallet_accounts` 分开保存现金/赠送的可用和冻结金额，全部为 `NUMERIC(18,2)`，四个余额都不得为负。账户由顾客行自动创建、不可删除；余额不能直接更新，只能由插入不可变 `wallet_ledger_entries` 触发变更。每个 `wallet_operations.id` 唯一，资金流水引用操作及支付回执、退款分配或提现；操作必须在事务提交时拥有匹配流水。`packages/money` 的 Decimal.js 函数以十进制字符串运算，消费顺序固定为赠送余额后现金余额；数据库账户行锁串行化并发消费。全额钱包付款在同一事务直接扣可用余额并写成功回执；组合支付则创建外部 `payment_attempt`，把实际可用的赠送余额优先、现金余额其次写成冻结流水，剩余款项交外部支付。外部准时付款回执锁定同一付款尝试后，才创建唯一的 settlement 操作，从冻结桶扣款并写资金凭证；外部失败、取消、超时及迟到回执创建唯一 release 操作解冻。付款尝试与钱包账户锁顺序固定为订单 → 付款尝试 → 钱包账户。超时/回调竞争和重复结算、解冻由唯一解析操作、状态触发器与账本约束共同拦截。

退款请求与每个资金来源的 `order_refund_allocations` 分离。分配先冻结可退金额；每个分配只能从 `reserved` 一次转为 `succeeded` 或 `released`，同一资金来源累计预留和成功金额不超过实际回执。原路退款要求与来源通道一致；余额退款仍回到来源桶，赠送余额只能回到赠送余额，禁止转成现金。退款状态单独表达申请、审核、处理中、部分成功、成功、失败或取消；“申请中”不等于退款已到账。

`withdrawals` 保存人工审核/打款的提交金额、手续费、到账金额和私有收款信息快照，首次状态只能是 `pending_review`。冻结与解冻/扣减都写资金操作与账本流水。每次外部人工打款都有 `withdrawal_payout_attempts`；未知结果保留 `transfer_uncertain` 并由唯一活动尝试索引阻止重复启动。提现尝试只有在管理员记录结果审核身份和外部核实材料 SHA-256 摘要后，才能转为明确成功或失败。只有明确失败才能回到待打款并新建尝试，明确成功才完成提现并扣除冻结现金。人工转账不与数据库共享事务，阶段④-2 后的管理界面必须在结果未知时保持阻断，不自动重试或假定成功。收款资料不是公开商品媒体，也未建立公开访问路径。

### 阶段边界与部署恢复

此阶段落地的是迁移、类型、钱包记账基础函数、数据库约束、状态投影和 PostgreSQL 集成测试；不提供顾客注册/下单 API、购物车、支付渠道/回调/主动查单、充值流程、退款审核执行、提现界面/人工打款、超时调度或卡密/文件/API 发货。实际支付补偿、对账和结果未知的人工处理闭环由后续阶段实现；上线前不得据此宣称交易接口已开放。

部署前恢复方案沿用 [部署与恢复](../deployment.md)：先用 `scripts/backup-compose-data.sh` 同时保存 PostgreSQL custom dump 与商品媒体，再用隔离 Compose 项目、`_test` 数据库和项目专属媒体卷执行 `scripts/restore-test-compose-data.sh` 验证校验与恢复。若生产迁移失败，停止写入并从已验证的迁移前数据库/媒体备份恢复，再部署兼容版本；本次只在本机隔离 PostgreSQL 测试库验证前向升级，没有连接或迁移生产环境，也没有声称已完成生产备份恢复演练。

## 部署边界

Compose 启动时先等 PostgreSQL 健康，再运行一次性迁移容器，之后启动 API、Nuxt SSR 和 Caddy。PG18 官方镜像卷挂在 `/var/lib/postgresql`，以覆盖 PG18 的版本化数据目录。所有镜像按当前稳定标签和 manifest digest 固定。站点域名、外部 HTTPS、PostgreSQL 密码均通过本地未跟踪的 `.env` 注入；本阶段没有授权中心、安装器或更新器。
