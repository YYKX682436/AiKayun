# 外部 API 自动发货（⑤-4）

⑤-4 将外部供应商交付接入现有订单履约链路。它继续使用 `product_variant_fulfillment`、`product_variant_fulfillment_versions`、订单项成交快照、`order_item_fulfillment_attempts`、`order_item_fulfillment_deliveries`、原库存预留/消费事件和 `startDigitalDeliveryWorker`；新增迁移只向前扩展，不另建订单、支付、库存或履约体系。

首版只支持下述 `http_json_v1` 协议。它是一个明确的通用协议，不代表兼容任意 JSON API。商业供应商必须明确实现全部身份回显、稳定幂等和两种查单能力，并通过真实环境验收；未指定或未接入的供应商不在已验证支持范围内。

## 供应商协议：`http_json_v1`

供应商配置保存一个 HTTPS 基础地址和一项 Bearer 凭据。系统不把凭据放在 URL、商品参数、请求日志或响应中。下列端点追加在配置的基础路径上；端点与正文都使用 UTF-8 JSON。

### 能力与查单验收

`GET /capabilities` 必须返回：

```json
{
  "protocol": "http_json_v1",
  "idempotencyGuaranteed": true,
  "statusQueryByIdempotency": true,
  "statusQueryBySupplierOperationId": true
}
```

连接测试还会查询已知不存在的固定探针幂等键与供应商操作 ID，两者都必须返回合法的 `not_found` 状态信封。只有端点与响应都通过验证，连接才可启用。能力声明是协议承诺，不能替代供应商对真实执行、幂等和查询一致性的履约责任。

### 创建一个交付单位

每个商城操作只请求一个单位。数量为 N 的订单会为每件创建独立且持久的操作，不会把整批数量交给供应商：

```http
POST /deliveries
Authorization: Bearer <configured-secret>
Content-Type: application/json
```

```json
{
  "protocol": "http_json_v1",
  "operationId": "<stable-uuid>",
  "idempotencyKey": "aikayun:<stable-uuid>",
  "productId": "vendor-product-42",
  "quantity": 1,
  "unitAmount": "12.50",
  "currency": "CNY",
  "parameters": { "region": "cn" }
}
```

`operationId` 是本地持久操作 UUID；`idempotencyKey` 是基于它生成、跨进程重启不变的稳定键。供应商必须对相同键保证至多执行一次，并在重放时返回同一操作及其当前状态。`unitAmount` 是成交快照中的单件金额；它不是支付授权，也不允许供应商改变商城收款事实。`parameters` 只允许商家保存的非敏感键值对，不支持任意代码或脚本映射。

所有 JSON 状态信封必须回显完全一致的 `protocol`、`operationId`、`idempotencyKey`、`productId`、`quantity`、`unitAmount` 与 `currency`。任一身份或金额不匹配均进入人工核对，不生成商城交付。

### 结果信封

处理中：

```json
{
  "protocol": "http_json_v1",
  "operationId": "<stable-uuid>",
  "idempotencyKey": "aikayun:<stable-uuid>",
  "productId": "vendor-product-42",
  "quantity": 1,
  "unitAmount": "12.50",
  "currency": "CNY",
  "supplierOperationId": "vendor-op-123",
  "status": "accepted",
  "result": null
}
```

终态状态为 `succeeded`、`rejected` 或 `not_found`。`rejected` 必须包含非空 `error.code` 且不能包含交付内容；它表示供应商确认没有交付。`not_found` 的 `supplierOperationId` 和 `result` 必须为 `null`。接受值 `accepted` 与 `processing` 都必须提供非空 `supplierOperationId`，且 `result` 必须为 `null`。

成功结果仅允许以下固定类型：

```json
{ "type": "code", "content": "授权码", "title": null, "instructions": null }
{ "type": "text", "content": "交付文本", "title": "可选标题", "instructions": "可选说明" }
{ "type": "redemption", "content": "兑换说明或 HTTPS 兑换地址", "title": null, "instructions": null }
{ "type": "link", "content": "https://delivery.example/item/123", "title": null, "instructions": null }
{ "type": "completed", "content": null, "title": null, "instructions": null }
```

`code` 最长 1,024 个字符；其他正文最多 20,000 个 UTF-8 字节；`title` 最多 160 个字符，`instructions` 最多 4,000 个字符。内容必须无控制字符。`link` 必须是没有用户名/密码的规范 HTTPS URL；商城把它作为普通链接展示，不访问、嵌入或执行供应商返回的 HTML/脚本。`completed` 只表示供应商已确认完成一项不需要向顾客展示正文的业务动作。

### 查单

```http
GET /deliveries/<url-encoded-supplierOperationId>
GET /deliveries/by-idempotency/<url-encoded-idempotencyKey>
Authorization: Bearer <configured-secret>
```

商城有供应商操作 ID 时优先按 ID 查单；创建响应丢失、尚未保存供应商 ID 时按原幂等键查单。查单必须返回同一状态信封并回显全部身份字段。未知操作返回 `not_found`。协议启用要求两种查单都可用。

⑤-5补足“租约已提交但请求尚未发出即崩溃”的负查单契约：供应商从未收到请求时不可能知道商品和金额。按幂等键负查单可返回以下最小信封；操作 ID 和幂等键必须匹配原查询，额外提供的商品、数量、金额和币种也必须匹配：

```json
{
  "protocol": "http_json_v1",
  "operationId": "<原操作uuid>",
  "idempotencyKey": "aikayun:<原操作uuid>",
  "supplierOperationId": null,
  "status": "not_found",
  "result": null
}
```

按供应商 ID 查询不到时，可用 `queriedSupplierOperationId` 精确回显查询目标，代替未知的商城身份；也兼容完整且一致的旧信封。裸404、没有绑定查询键的负结果、身份矛盾均不能证明未执行。只有从未保存供应商 ID 的操作，才可在可靠负查单后用原操作和原幂等键重发；已保存 ID 后查不到则保留该 ID 并进入 `manual_review`，不清空身份或重新创建操作。


所有请求使用固定路径和 JSON，不允许重定向。总超时为 8 秒，包含 DNS 等待；请求最多 16 KiB，响应最多 64 KiB。只处理 `application/json`；非 2xx、无效 JSON、身份不符、未知状态或不合规结果均按不确定/完整性问题进入恢复或人工处理，不会被当作成功。

## 凭据、版本和销售资格

供应商连接的地址/名称版本与凭据版本只追加保存。Bearer 凭据通过支付配置现有 AES-GCM 密钥环加密，AAD 绑定连接及凭据版本；常规读取、SSR、日志、审计备注和 API 错误不会返回明文。凭据轮换生成新版本并停用连接，历史订单仍可按订单操作引用的连接版本/凭据版本查单。可使用管理页的凭据重封装操作把保留的历史凭据改用当前密钥加密；部署密钥环切换前必须让全部实例同时保留历史密钥。

SKU 每次保存供应商商品标识与非敏感参数时，会在同一个 `product_variant_fulfillment_versions` 体系中追加不可变履约版本，并暂停该 SKU 的新自动销售。商家测试并启用供应商连接后，仍须显式启用 SKU 自动销售。旧报价包含配置修订，配置变化即失效；已下单项引用成交时版本与供应商凭据，不受改价、停用、SKU 退役或商品归档影响。商品复制不复制履约配置、凭据或自动销售资格。

## 事务边界、状态和恢复

1. 商城事务按订单 → 订单项 → 商品/SKU → 数量库存 → 履约配置与操作的既定锁序，验证订单仍为 `processing`、付款事实有效（零元允许）、没有开放支付对账，并持久化每件的操作 UUID、幂等键、不可变请求摘要、状态事件与领取租约。
2. 事务提交后，worker 在数据库事务/行锁之外调用供应商 HTTP。
3. 另一事务验证租约和响应身份，再记录供应商操作 ID、加密结果或状态/错误事件。成功结果随后由同一履约历史事务创建原有交付行；原订单触发器确认支付、消费数量库存并完成订单。
4. 进程重启或租约到期后，worker 按已保存的供应商操作 ID 优先查询；没有 ID 时按原幂等键查询。绝不因未知而新建不同操作或改幂等键。

外部请求发出后断线或超时会标为 `unknown`，不当作失败或成功。只有可靠供应商查单能够证实成功或明确拒绝；`not_found` 后才可重新尝试创建，且只能复用该供应商宣称保证的原幂等键。HTTP 临时错误仍进入同操作查单退避。供应商没有可靠幂等与两种查单能力时无法启用本协议。身份错配、结果损坏、操作 ID 冲突、重复凭证或密钥不可用均保留原操作进入人工核对，不能手工伪造成功。人工操作只留下只追加审计证据，不提供“标成成功”入口。

一个订单数量 N 创建 N 个操作和履约尝试。部分成功单位立刻写入原履约历史并消费其预留；明确拒绝的单位保留失败状态，只允许管理员确认后重试该单位；未知/处理中单位不重发、不允许普通取消绕过。重试授权在替换操作事务中逐单位消费，重复排队不追加审计，已消费的旧操作不能再次授权；worker必须在锁内复验，旧候选不能隐式授权其他失败单位。剩余未履约数量继续由既有库存和资金保护规则约束。`unlimited` 不生成数量库存事件。

⑤-5把本地扫描和供应商网络扫描放在同一 worker 的两个独立轮询任务中。本地每轮最多20项；供应商每轮只领取4个租约并并发执行，避免领取后排队超过30秒租约，也避免慢供应商阻塞其他方式。结果持久化在锁内比较原租约 token，旧 worker 的晚到结果及错误均不能覆盖新领取者已写入的状态或追加错误事件。未知结果指数退避，处理中操作每5秒查询；退避上限5分钟。

API操作单位、已确认供应商 ID、请求摘要和版本关系受到数据库保护。交付插入必须属于活动尝试，同一订单单位不能跨尝试重复交付。供应商商品级 advisory lock 串行化跨 SKU、跨活动密钥的卡密去重与插入。该商品历史使用的指纹密钥必须全部保留；缺失时在新请求前记录可恢复失败，已保存结果保持待完成，恢复密钥后继续原操作，不把无法比对的卡密发出。

退款与交付共用订单行锁。进行中/未知履约阻止新退款申请、批准和钱包入账；存在活动退款、退款预留或已退款事实时，不能开始新交付、发出新供应商创建请求或把待完成结果变成交付。真实收款及已记录的原路退款凭证继续保留；退款后已成功交付的内容和文件仍按原归属授权读取。

## 请求安全和隐私

生产只允许 HTTPS。配置拒绝 URL 用户信息、查询参数、片段、编码路径分隔符和路径穿越。DNS 解析时检查所有 IPv4/IPv6 答案；任一答案属于环回、私网、链路本地、共享地址、保留/文档、组播或非全球单播范围就拒绝；连接时将请求固定到已检查的地址，避免 DNS 重绑定。客户端不自动跟随重定向。HTTP 仅可在 `NODE_ENV=test` 且 URL origin 与显式 `SUPPLIER_HTTP_TEST_ALLOWLIST` 完全匹配时访问本机受控测试夹具；生产配置不能开启此例外。

供应商响应中的交付正文使用现有履约加密密钥环以 AEAD 加密后持久化，并通过现有顾客/游客订单归属与真实履约成功授权展示。操作和审计只保留响应摘要、状态、错误分类及操作身份，不记录请求正文、Bearer 凭据或交付明文。顾客只看到交付进度和成功交付内容，不看到供应商凭据、接口报文或内部错误。

## 当前实现与验收边界

首版测试服务是受控 HTTP 夹具，不是商业供应商。它用于本地/CI 验证协议、超时、响应丢失、幂等、部分成功和恢复；不得据此声称已兼容任何未指定或未验收的商业供应商。正式商业供应商的契约、真实凭据、金额/交付语义和端到端发货仍需单独验证。

⑤-5真实 SIGKILL、账实核对、文件基准及容器恢复证据见[全局数字履约验收](digital-fulfillment-acceptance.md)。
