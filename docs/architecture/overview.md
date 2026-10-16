# AiKayun 架构概览

## 目标与边界

AiKayun 是可独立部署、可通过商业授权销售的数字商品商城。系统采用 TypeScript 模块化单体：一个 Nuxt 前端工程通过同源 BFF 路由调用单一 Fastify API，API 与前端共用 TypeBox 契约。当前目录按可运行的技术边界拆分，不预先创建空业务模块。

当前已实现商城基础、后台基础、管理员安全入口，以及阶段③-D1 的商品与 SKU 核心数据和最小管理接口。消费者账户、订单、支付、库存和履约业务仍不在数据库范围内。后续按商品规格、库存、生命周期、媒体、管理页面和公开展示逐步扩展，避免以插件名义引入没有明确边界的万能扩展框架。

旧 MyShop 仓库只允许在后续需要时只读核对业务经验；本工程不复制其代码，不继承其数据库、API、配置或部署依赖，也不接入闲鱼系统。

## 工程边界

- `apps/web`：Nuxt 4 SSR 前台和管理后台；路由按页面拆包，共享 UI 主题。
- `apps/api`：Fastify 5、TypeBox 验证、统一响应与错误格式、请求日志、OpenAPI 和数据库访问。
- `packages/contracts`：前后端共用的 TypeBox schema 和 TypeScript 类型。
- `packages/money`：唯一的基础金额运算边界，使用 `decimal.js`，只接收十进制字符串。
- `deploy`：Caddy 入口；Compose 编排数据库、迁移、API、Web 与代理。

## 数据与迁移

PostgreSQL 18 为唯一业务数据库。Kysely Migrator 以版本化 TypeScript 迁移管理 schema；API 不在进程启动时隐式改表。当前业务表为 `admin_users`、`admin_sessions`、`products` 与 `product_variants`，另有 Kysely 自己的迁移元数据。商品和 SKU 使用独立 UUID 身份；商品名称不唯一。商品创建时会生成真实默认 SKU，但默认 SKU 不是永久要求；数据库在事务提交时要求每个商品至少有一个真实 SKU，并阻止在仍有商品时对 SKU 表执行 `TRUNCATE`。`(product_id, combination_key)` 可延迟唯一，以允许事务内安全交换组合键；删除 SKU 或改变其商品归属/组合键前会更新商品修订行，串行化影响 SKU 关系的变更，避免并发删除绕过最低数量约束。SKU 编码全局唯一，商品和 SKU 的更新触发器递增修订版本并更新 `updated_at`。测试库重置命令在连接后检查数据库名以 `_test` 结尾，随后才允许清空其 schema。

金额的基础精度约定：`product_variants.sale_price` 保留 `NUMERIC(18,5)`，数据库约束和 API/服务校验共同限定非负、最多两位小数，首版固定 CNY。更广义的单价运算仍可使用最多 13 位整数、5 位小数的 `packages/money` 精确十进制基础；实付、结算等未来已结算金额最多 16 位整数、2 位小数，对应 `NUMERIC(18,2)`。API 金额始终用十进制字符串，数据库金额由 PostgreSQL 驱动以字符串返回；商品售价输出统一格式化为两位小数，不转换为 JavaScript `number`。结算舍入采用四舍五入（half up），规则由 `packages/money` 明确实现和测试。TypeScript `number` 只用于数量等整数，不用于资金运算。

阶段③-D1 提供 `POST /api/v1/admin/products` 创建草稿商品及默认 SKU，并提供 `GET /api/v1/admin/products/:id` 按稳定商品 ID 读取商品和 SKU。写请求复用管理员会话、同源 Origin 与 CSRF 校验；共享 TypeBox 契约拒绝未知字段。D1 不提供商品状态流转、规格组、库存、图片、管理页面或公开商品接口。`combination_key` 仅由服务端维护；无规格时默认 SKU 使用空字符串。D2 会引入真实规格组、规范组合键和组合校验，多规格商品届时可不保留默认 SKU。

## 管理员认证

管理员由 `pnpm admin:init` 单次初始化，邮箱和密码必须从运行环境注入；命令拒绝短密码，也拒绝第二次初始化。密码以独立随机盐和 scrypt 参数存为编码哈希。认证使用随机不透明 HttpOnly Cookie，数据库只保存会话令牌的 SHA-256 摘要；会话可过期、撤销并即时检查管理员是否仍启用。

变更请求要求同源 `Origin`、CSRF Cookie 与 `X-CSRF-Token` 三者匹配。CSRF 比较使用常量时间比较；登录路由有速率限制。生产环境强制 Secure Cookie，Caddy 是公开入口，API 容器只在 Compose 网络内可达。管理接口逐条执行服务端会话验证，前端路由守卫只提供导航体验，不构成权限边界。

## 事务与未来业务

当前认证写入仅涉及单笔管理员或会话记录。后续订单、支付尝试、库存扣减和履约必须分别定义幂等键、状态转移与并发保护，关键跨表变化放在明确的数据库事务中；外部支付或发货适配器的网络调用不能包在长时间持有的数据库事务里。旧仓库只提供只读的事务设计参考，不能替代新项目自己的数据模型和测试。

## 部署边界

Compose 启动时先等 PostgreSQL 健康，再运行一次性迁移容器，之后启动 API、Nuxt SSR 和 Caddy。PG18 官方镜像卷挂在 `/var/lib/postgresql`，以覆盖 PG18 的版本化数据目录。所有镜像按当前稳定标签和 manifest digest 固定。站点域名、外部 HTTPS、PostgreSQL 密码均通过本地未跟踪的 `.env` 注入；本阶段没有授权中心、安装器或更新器。
