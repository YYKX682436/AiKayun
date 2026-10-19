# ④-3 顾客管理 API

顾客管理由 `apps/api/src/customers/admin.ts` 实现，契约定义在 `packages/contracts`。所有端点都需要管理员会话。写端点还需要与 `PUBLIC_ORIGIN` 一致的 `Origin`，以及管理员 CSRF Cookie 和相同的 `X-CSRF-Token`。顾客 Cookie 不能访问这些端点；路径中的顾客 UUID 只用于定位目标，不能替代管理员鉴权。

所有管理员 API 响应使用 `Cache-Control: no-store`。响应不含密码哈希、会话 token 或 token 摘要。顾客状态变更、资料修改、密码重置和匿名化均从目标 UUID 重新读写数据库，不能信任浏览器提供的身份资料或状态。

## 列表与只读详情

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/v1/admin/customers` | 服务端搜索、筛选、稳定排序和分页 |
| `GET /api/v1/admin/customers/:id` | 基本资料、状态和联系方式验证时间 |
| `GET /api/v1/admin/customers/:id/orders` | 只读历史订单分页 |
| `GET /api/v1/admin/customers/:id/audit` | 只读管理审计分页 |

列表参数：

- `search` 最多 120 字符，对用户名、邮箱进行小写前缀匹配，对手机号先去除空格、括号和连字符后做前缀匹配；SQL 中转义 `%`、`_` 和反斜线。不会加载全量数据到浏览器再筛选。
- `status` 可为 `all`、`active`、`disabled` 或 `deleted`。省略时只查 `active` 和 `disabled`；已匿名化身份必须显式选择 `deleted`。
- `sortOrder` 为注册时间 `asc` 或 `desc`，默认 `desc`；顾客 UUID 作为稳定次级排序。
- `page` 最小为 1，最大为 100000；`pageSize` 默认 20，范围为 1～100。订单和审计接口使用相同分页范围。

列表每行包含用户名、邮箱、手机号、账户状态、注册及更新时间。详情额外返回邮箱和手机号的 `emailVerifiedAt` / `phoneVerifiedAt`。联系方式值为 `null` 表示未填写；验证时间为 `null` 表示未验证。

订单摘要基于④-1的 `orders`、`customer_order_status` 和 `order_financial_status`，只读显示订单状态、顾客可见状态、支付状态、退款状态、金额、币种和时间。当前未开放订单创建，所以真实顾客可能没有订单；空列表不是演示数据。

## 写操作

| 方法与路径 | Body | 行为 |
| --- | --- | --- |
| `PATCH /api/v1/admin/customers/:id/profile` | 至少一个 `username`、`email`、`phone` | 更新实际变化的字段；联系方式变化会清除对应验证时间 |
| `PATCH /api/v1/admin/customers/:id/status` | `{ "status": "active" \| "disabled" }` | 禁用或恢复账户；同状态重复请求幂等 |
| `PUT /api/v1/admin/customers/:id/password-reset` | `{ "temporaryPassword": "..." }` | 设置新 scrypt 密码摘要、撤销全部旧会话 |
| `DELETE /api/v1/admin/customers/:id` | 无 | 满足删除条件时不可逆匿名化；重复删除成功且不重复写审计 |

用户名沿用④-2契约：3～32 个 ASCII 字符，以字母或数字开头，其余可用字母、数字、`_`、`.`、`-`；PostgreSQL 的小写唯一索引负责最终并发唯一性。冲突返回 `409 USERNAME_TAKEN`。邮箱会 trim 并小写归一化，手机号会移除空格、括号和连字符；管理员修改不会将新联系方式自动标记为已验证。

密码长度为 12～128 字符，使用④-2异步 scrypt。密码摘要计算后在锁定目标顾客的事务中写入，并在同一事务撤销该顾客全部旧会话、写审计。接口只返回 `passwordReset` 和撤销会话数，不返回临时密码。顾客需要用管理员设置的临时密码重新登录；本阶段没有邮件/短信传送和自助找回。

禁用时在数据库事务中撤销所有有效顾客会话，顾客认证接口仍会检查顾客状态。恢复仅把状态改为 `active`，不会恢复原会话。管理员可编辑禁用账户资料；已删除身份不可修改、恢复或重置密码。

## 安全匿名化条件

删除会锁定顾客行、钱包行和该顾客已有订单，再于同一事务内检查义务。任一情况成立时返回 `409` 并保留账户及全部交易数据：

- 订单仍为 `pending_payment` 或 `processing`；
- 支付尝试仍在 `created`、`pending` 或 `reconciliation_required`，包括钱包充值；存在迟到/超额/金额不匹配收款、退款分配预留或未结清资金对账；
- 退款处于请求、批准、处理中或部分成功，或退款分配仍预留；
- 提现或人工打款仍待审核、待转账、处理中、不确定，或存在活动提现尝试；
- 订单履约仍处理中/不确定，或有未完成预留数量；
- 钱包任何现金/赠金可用余额或冻结余额非零。

错误码包括 `CUSTOMER_HAS_UNFINISHED_ORDERS`、`CUSTOMER_HAS_PENDING_PAYMENT`、`CUSTOMER_HAS_PENDING_REFUND`、`CUSTOMER_HAS_PENDING_WITHDRAWAL`、`CUSTOMER_HAS_UNRESOLVED_FULFILLMENT` 和 `CUSTOMER_HAS_WALLET_BALANCE`。如果交易已完成、收款已结清、履约完成、没有待处理退款或其他义务且余额为零，历史交易不阻止删除。

允许删除时仅更新顾客身份：状态改为 `deleted`，清除用户名、密码摘要、邮箱、手机号及验证时间，并撤销全部会话。保留顾客 UUID、钱包账户、订单/支付/退款/提现/库存记录、资金流水及必要审计。不会自动退款、关闭订单、清零余额或改写交易状态。外键采用保护交易历史的 `RESTRICT`，不存在危险级联删除。

并发保护使用顾客行作为串行化锚点：订单创建触发器对顾客行取 `FOR KEY SHARE`，删除先取得更强的顾客行锁；先创建的订单会在删除检查时可见，先删除的账户不能再创建订单。管理员资料、密码、状态操作与顾客登录、改密遵循顾客行优先；顾客资料 PATCH 在取得顾客行锁后重新锁定并验证原会话，消除认证前置检查与资料写入之间的撤销竞态。

## 审计

`customer_management_audit` 记录管理员 UUID、顾客 UUID、操作类型、数据库时间和受约束的摘要。操作类型为 `username_updated`、`contact_updated`、`password_reset`、`disabled`、`restored`、`deleted`。摘要只保留变更字段名、状态和撤销会话数量，不保存用户名/联系方式新值、临时密码、密码摘要、Cookie 或完整会话 token。业务写入和对应审计在同一事务中提交；数据库触发器拒绝 `UPDATE`、`DELETE` 和 `TRUNCATE`。

这组端点不提供钱包账本、余额编辑、订单状态操作、退款操作、提现操作或购买权益管理。上述业务不属于④-3。
