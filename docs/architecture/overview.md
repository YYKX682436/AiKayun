# AiKayun 架构概览

## 目标与边界

AiKayun 是可独立部署、可通过商业授权销售的数字商品商城。系统采用 TypeScript 模块化单体：一个 Nuxt 前端工程通过同源 BFF 路由调用单一 Fastify API，API 与前端共用 TypeBox 契约。当前目录按可运行的技术边界拆分，不预先创建空业务模块。

当前已实现商城基础、后台基础、管理员安全入口，以及阶段③-D1/D2/D3/D4 的商品、分类、动态规格、SKU、价格、库存和商品生命周期管理 API。消费者账户、订单、支付和履约仍不在数据库范围内；卡密/账号资源池、第三方库存同步及公开商品接口也尚未实现。后续按媒体、管理页面和公开展示逐步扩展，避免以插件名义引入没有明确边界的万能扩展框架。

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

基础资料 API 只编辑名称、基础描述和商品性质。名称会去除首尾空白；普通编辑不能编辑归档商品。商品性质只能在草稿或已下架状态修改，并且在任何 SKU 配置库存模式、存在库存行/库存流水或存在永久退役 SKU 后拒绝变更。保存前锁商品并比对修订；相同值不更新修订或写审计。库存数量变化只使用 `inventory_revision`，不会覆盖或递增商品修订。

商品列表在 PostgreSQL 侧完成名称/UUID/SKU 编码搜索、状态/性质/分类过滤、计数、SKU 数量、最低/最高售价和分类摘要。分类过滤使用 `EXISTS`，避免关联重复；每页最多 100 件，创建时间、更新时间和最低 SKU 售价均以商品 UUID 作稳定次级排序。一个请求的计数和结果在同一 `REPEATABLE READ` 事务快照读取，不会逐商品加载详情。

商品复制在一个事务中锁定源商品并检查修订，为商品、非退役 SKU、规格组、规格值和属性分配新 UUID，为每个新 SKU 生成新编码，并按新规格值 UUID 重建组合键。分类关系引用现有分类身份。库存模式与库存修订重置为未配置/0，不复制数量库存、预留、调整流水或永久退役 SKU。若源商品的 SKU 全部永久退役，会创建新的禁用默认 SKU，不继承任何退役身份；此草稿仍满足至少一个 SKU 的数据库约束。

永久删除锁定商品、全部 SKU 和数量库存记录后检查非零库存/预留、库存流水、永久退役 SKU 及已配置资源来源。仅无保留引用且数量为零时才删除商品自有的分类关联、展示属性、规格关系、空数量记录、SKU 和商品。库存流水 SKU 外键继续 `ON DELETE RESTRICT`；未来订单和资源表也必须通过明确的 `RESTRICT` 外键保护，不以级联删除历史记录。整商品删除在同一事务中删除最后一个 SKU 和商品，利用延迟的“每商品至少一个 SKU”约束在提交时检查；单独删除最后一个 SKU 仍然失败。

`product_management_audit_events` 保存创建、基础编辑、发布/下架/重新上架、归档/恢复、复制和删除事件，包含商品 UUID、管理员 UUID、操作类型、时间及安全摘要。描述在创建、复制及实际编辑时保存对应前后值，其他操作只保存长度摘要；审计不复制 SKU 价格、库存、卡密、账号密码或 API 密钥。审计表不设置商品或管理员外键，商品删除不会删除或阻塞审计；更新、删除和截断均被数据库拒绝。审计写入与对应业务事务一起提交。

## 管理员认证

管理员由 `pnpm admin:init` 单次初始化，邮箱和密码必须从运行环境注入；命令拒绝短密码，也拒绝第二次初始化。密码以独立随机盐和 scrypt 参数存为编码哈希。认证使用随机不透明 HttpOnly Cookie，数据库只保存会话令牌的 SHA-256 摘要；会话可过期、撤销并即时检查管理员是否仍启用。

变更请求要求同源 `Origin`、CSRF Cookie 与 `X-CSRF-Token` 三者匹配。CSRF 比较使用常量时间比较；登录路由有速率限制。生产环境强制 Secure Cookie，Caddy 是公开入口，API 容器只在 Compose 网络内可达。管理接口逐条执行服务端会话验证，前端路由守卫只提供导航体验，不构成权限边界。

## 事务与未来业务

当前认证写入仅涉及单笔管理员或会话记录。后续订单、支付尝试、库存扣减和履约必须分别定义幂等键、状态转移与并发保护，关键跨表变化放在明确的数据库事务中；外部支付或发货适配器的网络调用不能包在长时间持有的数据库事务里。旧仓库只提供只读的事务设计参考，不能替代新项目自己的数据模型和测试。

## 部署边界

Compose 启动时先等 PostgreSQL 健康，再运行一次性迁移容器，之后启动 API、Nuxt SSR 和 Caddy。PG18 官方镜像卷挂在 `/var/lib/postgresql`，以覆盖 PG18 的版本化数据目录。所有镜像按当前稳定标签和 manifest digest 固定。站点域名、外部 HTTPS、PostgreSQL 密码均通过本地未跟踪的 `.env` 注入；本阶段没有授权中心、安装器或更新器。
