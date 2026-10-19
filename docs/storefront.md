# D7 商城商品前台、④-2顾客账户与④-3后台顾客管理

本阶段为顾客提供真实商品浏览。页面通过 Nuxt 4 SSR 和同源 BFF 读取 Fastify 的独立公开目录 API；查询投影在 PostgreSQL 中过滤并计算公开数据，再用 `packages/contracts` 的专用 TypeBox 响应契约返回。前台不调用管理员商品详情 API，也不把管理员响应下发后再隐藏敏感字段。

## 页面和公开 API

| 顾客页面 | 用途 | API |
| --- | --- | --- |
| `/` | 当前公开商品首页，稳定分页 | `GET /api/v1/public/products` |
| `/categories/:id` | 当前可见分类及其可见子树商品 | `GET /api/v1/public/categories/:id/products` |
| `/search` | 商品搜索、分类/性质筛选、排序和分页 | `GET /api/v1/public/search` |
| `/products/:id` | 使用永久商品 UUID 查看详情与规格 | `GET /api/v1/public/products/:id` |
| sitemap | 当前可公开商品和分类 | `GET /api/v1/public/sitemap`、`/sitemap.xml`、`/sitemap-:page.xml` |
| 分类导航 | 四级可见分类树 | `GET /api/v1/public/categories` |

所有公开查询响应均为 `Cache-Control: no-store`。商品媒体仍通过 D5 的 `/api/v1/media/:id/{thumbnail,card,detail}.webp` 不可变 URL 长期缓存。Fastify 为公开端点应用独立 schema 和响应契约，包括 `PublicProductCard`、`PublicProductDetail`、`PublicCategory`、`PublicInventorySummary` 和分页结果；额外响应字段不向匿名访问者开放。

## 商品公开规则与字段边界

所有商品列表、搜索、分类和 sitemap 查询均在 SQL 中要求 `products.status = 'active'`；详情按相同条件读取。`draft`、`paused`、`archived`、删除或不存在的商品均不返回公开商品资料。库存状态与商品状态分开计算：缺货 active 商品仍可显示；全部 SKU 暂停或永久退役后商品仍可显示，但会返回 `selectionStatus: none` 和空售价范围。

公开查询不返回 SKU 成本价、SKU 编码、`combination_key`、SKU 管理 ID、revision、管理员身份、审计、库存流水、绝对磁盘路径或未来凭据。详情只投影当前有效规格关系、公开售价与划线价、公开属性、可见分类路径、图片变体 URL 和经共享富文本安全转换器生成的 HTML。媒体地址按 D5 固定 UUID/变体路由构造。

前台有效 SKU 必须同时满足：暂时启用、`retired_at IS NULL`、组合关系完整、规格组和值均可用且组合有效。有效售价范围使用现有十进制金额工具处理，输出固定两位 CNY；一个 SKU 显示准确售价，多 SKU 显示真实起售价/范围。划线价与同一 SKU 的售价同时返回，不能跨规格拼接优惠价格。库存模式及状态独立于价格和商品状态：

| 库存模式 | 公开摘要 | 页面文案含义 |
| --- | --- | --- |
| `quantity` | `in_stock` 或 `out_of_stock`，由真实 `stocked - reserved` 判定 | 有货 / 暂时缺货 |
| `resource_pool` | `not_ready` | 供货能力尚未就绪 |
| `external` | `not_ready` | 供应商未接入，不确认有货 |
| `unlimited` | `unlimited` | 数量策略不限，交付能力尚未开放 |
| `null` | `not_configured` | 库存尚未配置 |

前台不公开精确库存量。所有摘要都不是下单资格或付款承诺；D7 不提供购物车、订单、支付、预留、卡密/文件交付、供应商采购、评价、销量或促销。

## ④-2 顾客账户入口

当前顾客账户页面为 `/register`、`/login` 和 `/account`。商城导航通过同源 BFF 查询 `/api/v1/customer/session`，SSR 首屏及刷新会显示有效用户名；未登录时显示登录和注册入口。注册表单读取 `GET /api/v1/public/storefront/customer-policy`，只有管理员开启时才要求新顾客填写邮箱或手机号。账户页允许修改邮箱/手机号和密码；修改联系方式会清除相应验证时间。个人资料查询/更新从 Cookie 会话绑定的顾客 ID 推导，不接受客户端指定顾客 ID。

顾客注册、登录、退出、个人资料修改和改密接口分别位于 `/api/v1/customer/auth/*`、`/api/v1/customer/profile` 和 `/api/v1/customer/password`。注册/登录失败使用一致的用户名或密码错误响应；写请求有独立顾客 CSRF Cookie、同源 Origin 检查和 IP 限流。前端不会读取或保存会话令牌，浏览器只持有 HttpOnly 会话 Cookie。

管理员在 `/admin/storefront/customer-policy` 管理新注册邮箱/手机号要求、游客下单和游客免费领取设置。设置从 `storefront_customer_policy` 真实读取并写回。顾客管理页面位于 `/admin/customers` 和 `/admin/customers/:id`，支持服务端筛选分页、资料修改、状态维护、临时密码重置、只读历史订单和不可逆匿名化；权限与删除约束见[顾客管理 API](customer-management.md)。游客开关目前只是策略数据，不会开放下单、领取、购物车、支付或履约接口。邮箱/手机号验证、密码找回和 OAuth 尚未实现。

## 分类与检索

公开分类从可见根节点运行递归 CTE，最多四级；隐藏父节点会阻止它及整棵后代树进入前台结果。分类详情、导航、商品详情面包屑和 sitemap 共用此可见集合。父分类默认匹配自身和可见后代的商品关联；查询使用 `EXISTS` 防止多分类关联产生重复商品。分类排序先使用相关关联 `sort_order`，缺少时按创建时间/商品 UUID 稳定排序。

搜索在 PostgreSQL 对商品名称和基础描述作转义的 `ILIKE '%关键词%'` 包含匹配，适合中文关键词；不启用 SKU 内部编码作为公开搜索字段。分类、商品性质、默认/最新/售价升序/售价降序和服务端分页均通过 TypeBox query 参数约束。无效/隐藏分类返回通用 404，不披露分类内部信息。搜索条件存于 URL，输入使用防抖；路由变化会取消前一请求，并以递增 request id 阻止旧响应覆盖最新状态。刷新、浏览器前进/后退都从 URL 恢复筛选条件。

## SKU 选择与详情

SKU 详情不返回 SKU ID、编码或组合键。规格组和值仍用 D2 的稳定 UUID 识别，并给出是否存在有效销售 SKU 的标志。无规格且仅一个有效 SKU 时可以确定性自动选中；多规格不默认替顾客挑选。顾客选择完整组合后，页面只从后端有效变体中匹配，显示同一 SKU 的售价、划线价和库存摘要。不存在的稀疏组合和禁用选项不可完成选择，规格名称或排序变化不改变身份。

页面使用 D5 `thumbnail.webp` 显示缩略图，主图使用 `detail.webp`，卡片使用 `card.webp`。首张详情主图优先加载、其他图片延迟加载；相册切换支持键盘和触控，缺图/加载失败有统一占位。富文本由 Fastify 复用 `productRichContentToSafeHtml` 生成，仅详情正文渲染该 HTML；图片只能基于已登记 `mediaId` 的固定媒体路径，链接仅使用 D5 允许的协议，公开页面不加载编辑器及 Tiptap 编辑依赖。

详情页展示商品性质、基础描述、详情正文、公开展示属性、可见分类路径、规格和供货说明。页面以非操作提示明确标识“购买功能尚未开放”，不提供看似可以交易的主按钮。

## 不可公开详情和服务器错误

商品详情 URL 为 `/products/[id]`，商品名称变更不改变商品 UUID 路径。公开 API 对未知、下架、暂停、归档、永久删除商品一律返回通用 404。前台 SSR 对明确 API 404 使用 HTTP 302 临时跳转到 `/`；客户端导航遵循相同策略。首页、分类、搜索和详情遇到公开 API 服务故障时统一显示安全的可重试错误并返回 HTTP 502；分类不可见或不存在返回 404。服务端错误不会作为 200，也不会被改写成 404。上游 FetchError 响应体在进入 Nuxt SSR payload 前被剥离，避免数据库错误或堆栈序列化给匿名页面。

## SSR、SEO 和站点域名

首页、分类商品、搜索结果与商品详情都从页面服务端数据请求得到真实首屏 HTML，不依赖 `mounted` 后才填入商品数据。请求参数改变时，旧结果不能覆盖新结果。

各页面设置独立标题、描述、canonical 与 OG 数据。首页第一页 canonical 为 `/`，后续分页保留有效 `page`；分类 canonical 保留有效 `page` 和非默认的受支持 `sort`，第一页省略 `page=1`。未知参数不进入 canonical。搜索固定为 `noindex, follow` 并 canonical 到 `/search`。缺失分类和不可用商品详情不进入 sitemap；商品详情明确 404 使用 302 首页策略。详情 JSON-LD 仅包含商品的名称、描述、图片、分类路径和真实展示属性；没有评价、评分、交易资格或可确认可交付的库存时，不生成评论、Offers 或 `InStock`。

Nuxt `runtimeConfig.public.siteUrl` 从 `NUXT_PUBLIC_SITE_URL` 读取。必须设为公开 HTTP(S) origin；无效值回退到 localhost 开发 origin。应用不会把未经验证的 Host 请求头用于 canonical、OG 或 sitemap。`/sitemap.xml` 只列 active 商品和可见分类，超过 sitemap URL 上限时生成分片索引 `/sitemap-:page.xml`。四种商品页面和 sitemap 响应均为 `Cache-Control: no-store`，保证新请求读取最新状态、价格和库存；Caddy 不设置动态 HTML 缓存规则。Nuxt 静态资源及 D5 不可变图片继续使用各自的静态资源缓存策略，图片维持一年 immutable。

## 视觉和边界

首页直接展示共享 `StorefrontProductGrid` 商品网格，桌面 4/5 列、手机窄于 360px 时 1 列、普通手机 2 列；卡片固定图片比例、展示名称/短说明/当前公开价格及必要库存状态，整卡进入详情。共用商品卡片、分页、桌面分类导航与移动端抽屉使用设计系统的 Nuxt UI 语义颜色，沿用浅色/深色/跟随系统和运行时品牌色。列表空状态使用 `UEmpty`，网络失败显示可重试 `UAlert`。

页面只新增顾客目录与浏览交互。购物车、订单、支付、数字交付、卡密资源池、第三方供货、评价和营销功能必须在对应阶段以真实数据模型和事务/API 能力实现，不能由 D7 页面模拟。

## 客户端查询一致性

分类商品请求以分类 UUID、页码和排序组成 Nuxt 异步数据键；响应同时携带启动请求时的完整身份，页面只显示与当前 URL 身份一致的数据。搜索以去空格后的关键词、有效分类、有效商品性质、排序、页码和固定页大小组成请求键，并将结果响应与该身份一起保存。输入防抖期间、URL 条件变化期间及请求失败时，旧身份结果不作为当前结果显示。Nuxt 请求使用取消去重；即使不同键的网络响应乱序完成，身份校验仍阻止过期数据覆盖当前页面。搜索条件始终由 URL 驱动，因此 SSR、刷新、前进/后退和重新进入共用同一数据来源。

Chromium 回归使用真实 `_test` PostgreSQL 和公开 API 校验分类价格排序乱序、错误态清除旧卡片、搜索离页重进、乱序关键词请求、名称/分类/性质/排序/分页与历史恢复。测试以实际商品名称和金额核对返回内容，不以路由变化或加载状态代替结果验证。
