# 订单与人工数字交付

阶段④-5在④-4只读结算报价上增加真实订单创建、数量库存预留、待付款订单取消/超时关闭，以及最小人工数字交付闭环。它没有支付渠道，也没有把人工履约扩展成卡密池、文件、链接或外部 API 发货。

## 成交资格与统一报价

购物车报价、商品详情立即购买与结算预览都调用 `apps/api/src/commerce/checkout-quote.ts`。报价读取商品/SKU 状态、规格组合、当前售价、库存模式和可售库存、人工交付就绪状态，以及游客购买策略。

可下单 SKU 必须满足：

1. 商品存在且为 `active`；SKU 启用、未退役，规格组合仍有效。
2. 库存模式为 `quantity` 或 `unlimited`。数量模式须有库存记录且可售数量足够。
3. 商品为数字商品，履约方式为 `manual`，并且商家明确将该 SKU 设置为 `manual_delivery_ready=true`。
4. 登录顾客会话有效；游客正价订单要求商家开启游客结算，零元订单另外要求开启免费领取。

报价仅用于顾客确认。下单请求提交规范化 SKU/数量、幂等键和报价摘要 `quoteToken`，不接受前端提供的售价、商品名、顾客 ID、库存或金额。摘要用于发现预览之后的变化；服务端仍在成交事务内重新计算全部报价。价格、库存、商品状态、规格、履约就绪或购买资格变化时，返回 `409` 与新的报价，要求页面显示并让顾客再次提交。

## 下单事务、锁顺序和库存

`POST /api/v1/checkout/orders` 的事务按以下顺序处理：

1. 锁定并重新验证登录顾客及会话，或锁定当前游客订单会话。游客令牌只从安全 Cookie 读取，数据库只存令牌摘要。
2. 对“身份类型 + 身份 ID + 幂等键”取得 PostgreSQL 事务级 advisory lock；在锁库存前检查已有订单。相同键和相同规范化 SKU/数量返回原订单；相同键、不同内容返回 `ORDER_IDEMPOTENCY_CONFLICT`。
3. 共享锁定店铺策略行，重新验证游客开关和超时时间。
4. 按商品 UUID 顺序取得商品行 `FOR SHARE`，再按商品 UUID、SKU UUID 顺序锁 SKU `FOR UPDATE`。
5. 按商品 UUID、SKU UUID 顺序锁数量库存行 `FOR UPDATE`，最后按 SKU 顺序共享锁定履约配置。
6. 使用与④-4报价相同的核心逻辑在事务内重算；确认报价摘要未变后插入订单和成交快照、插入数量库存预留、封存订单项并返回订单详情。

单笔事务只允许最多 50 个 SKU，每 SKU 数量 1～99。SKU 在写入前排序并合并重复项。遇到 PostgreSQL `40001` 或 `40P01` 最多重试 3 次；重试后仍冲突时返回 `ORDER_CONCURRENT_CONFLICT`。任何插入、快照、库存事件或封存失败都会回滚整笔订单。

订单项快照保存成交商品名、商品类型、SKU 码、规格、成交单价、数量、行金额、库存模式和履约方式；订单保存金额、币种、身份、幂等摘要和原始到期时间。之后的商品改价、下架、SKU 退役或策略调整不会改写已有快照。

数量库存通过现有 `order_inventory_reservations` 和 `order_inventory_events` 写入。订单创建只插入预留记录，由④-1事件触发器实际更新 `reserved` 并递增 SKU 库存修订号；应用代码不直接写 `reserved`。`unlimited` 不创建数量预留；`resource_pool`、`external` 未具备供应能力，拒绝下单。商品与 SKU 锁顺序与③阶段库存调整、SKU 退役及④-1库存事件一致。

顾客取消和超时关闭都会将待付款订单更新为 `closed`，再由④-1状态事件和库存释放触发器保留状态历史并写入释放事件。重复取消直接返回已关闭订单，不重复写释放事件。已确认付款、尚未过期的活动支付尝试、未结资金/退款或处理中履约会阻止普通取消与关闭。支付尝试过期后，④-1触发器能关闭未收款订单；迟到回执仍被记录为异常资金事实，不会恢复已关闭订单。

## 订单超时

`storefront_customer_policy.unpaid_order_timeout_minutes` 默认 15 分钟；后台只允许设置 5、15 或 30 分钟。④-1订单创建触发器把当时策略写入订单的 `unpaid_expires_at`，以后修改店铺设置不会改变既有订单。

API 启动时立即执行一次未付款订单清理，然后每 60 秒执行一轮，每轮最多领取 100 个可关闭订单。PostgreSQL 使用 `FOR UPDATE SKIP LOCKED` 在多个实例间分配任务；服务重启后立即恢复过期任务。查询会排除活动支付、未结资金/退款和处理中履约；④-1关闭与释放触发器仍是最后一道约束。受保护订单不会占满扫描批次而饿死后续可关闭订单。

## 游客会话与顾客访问

`POST /api/v1/guest/session` 会自动建立或恢复游客会话，不返回令牌。Cookie 为 HttpOnly、SameSite=Lax，并按部署配置启用 Secure；令牌为高熵随机值，数据库仅存摘要。会话到期后，历史订单继续留存，但旧会话不能再读取或取消它们。

顾客订单始终从已验证登录会话取得 `customer_id`。游客订单始终从安全 Cookie 对应的 `guest_order_session_id` 取得。登录顾客不能切换到游客订单 API；游客也不能读取顾客订单或其他游客会话的订单。详情越权统一返回 404，订单 API 设置 `Cache-Control: no-store`。页面请求在顾客身份版本变化后丢弃旧响应，不将旧身份订单写入当前视图。

## 人工数字交付

迁移 `202610190004_orders` 增加 `product_variant_fulfillment.manual_delivery_ready`，默认 `false`；商家必须在商品 SKU 管理页明确开启。只能为仍启用、未退役、库存模式为数量或不限数量的数字商品开启。该阶段未实现的履约方式持续返回未就绪。

管理员在 `/admin/orders/:id` 为订单项逐件录入真实内容。`POST /api/v1/admin/orders/:id/items/:itemId/fulfillments` 需要管理员权限、同源 Origin 和双提交 CSRF。服务和数据库都要求订单为 `processing`：零元订单由④-1订单创建触发器直接置为此状态；正价订单只有④-1确认真实、足额、按时收款后才能进入此状态。本阶段没有任何管理员标记付款成功的接口。

每次履约创建④-1 `order_item_fulfillment_attempts`，记录数量、操作身份、操作幂等键和结果摘要；交付正文存入新增的私有 `order_item_fulfillment_deliveries`，一件商品一条记录，包含操作身份、单件 SHA-256 和时间。只有履约尝试成功后，④-1触发器才更新已交付数量、消耗数量库存，并在全部订单项完成时把订单置为 `completed`。相同操作键与内容重放返回原结果；相同键对应不同内容返回冲突。

交付内容行数必须等于此次交付数量，每件最多 512 个字符。内容只出现在管理员订单详情和所属顾客订单详情，响应禁止缓存；数据库拒绝修改、删除或截断历史交付内容。应用日志不记录请求正文、Cookie 或会话令牌。卡密池、批量文件、可变外链和自动 API 发货不属于本阶段。

## API 与页面

| 方法与路径 | 用途 | 访问保护 |
| --- | --- | --- |
| `POST /api/v1/guest/session` | 自动建立/恢复游客订单会话 | 双提交 CSRF、Origin；限流 |
| `POST /api/v1/checkout/orders` | 从当前报价创建订单；重放返回原订单 | 可选顾客身份、双提交 CSRF、Origin；限流 |
| `GET /api/v1/customer/orders` | 顾客分页订单列表 | 顾客会话 |
| `GET /api/v1/customer/orders/:id` | 顾客订单详情及本人已交付内容 | 顾客会话、订单归属 |
| `POST /api/v1/customer/orders/:id/cancel` | 取消可取消的未付款订单 | 顾客会话、订单归属、Origin、CSRF |
| `GET /api/v1/guest/orders` | 当前游客会话订单列表 | 游客 Cookie；登录身份禁止混用 |
| `GET /api/v1/guest/orders/:id` | 当前游客会话订单详情 | 游客 Cookie、会话归属 |
| `POST /api/v1/guest/orders/:id/cancel` | 取消当前游客的未付款订单 | 游客 Cookie、Origin、CSRF |
| `GET /api/v1/admin/orders`、`GET /api/v1/admin/orders/:id` | 后台分页订单、归属、成交快照、库存事件、履约审计 | 管理员会话 |
| `POST /api/v1/admin/orders/:id/items/:itemId/fulfillments` | 录入真实人工数字交付 | 管理员权限、Origin、CSRF；限流 |
| `GET /api/v1/admin/products/:id/manual-fulfillment` | 查看 SKU 人工交付就绪情况 | 管理员会话 |
| `PUT /api/v1/admin/products/:id/variants/:variantId/manual-fulfillment` | 明确启用或关闭 SKU 人工交付 | 管理员权限、Origin、CSRF |

顾客页面为 `/orders` 与 `/orders/:id`，后台页面为 `/admin/orders` 与 `/admin/orders/:id`。结算预览 `/checkout` 可以创建订单；正价订单只显示等待付款及未开放支付提示，不提供虚假付款按钮。订单列表由服务端分页。

## 数据库变更与阶段边界

新增安全迁移 `202610190004_orders`：新增 SKU 就绪标记、履约管理员身份字段和私有交付内容表；替换订单关闭保护函数，禁止关闭仍有活动支付或异常待处理资金的订单。④-1订单表、库存预留、库存事件、支付回执、履约尝试和订单状态事件均继续复用。回滚迁移会拒绝删除已有交付内容。

真实支付宝/微信支付、支付回调、自动对账、余额组合支付、退款/提现执行、卡密池及外部自动发货不在④-5范围。高级限购与其他库存购买规则留给④-6；基础预留、并发防超卖、取消释放和超时释放已在本阶段完成。
