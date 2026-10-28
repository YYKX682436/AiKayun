# ⑦-1A：全仓生产发行与经营权限代码审计

审计日期：2026-10-28。基线 `main@5cf764d575549bb32b95e513c4c0b424e72d24a0`，已 fetch 核对 `HEAD == origin/main`，开始时工作区干净。本文所有代码行号都对应此基线，后续实现发生变化时应重新核对。

本轮读取根 `AGENTS.md`、全仓跟踪目录、现有架构/部署/开发文档及阶段④～⑥相关拥有文档，并追踪生产源码、DB迁移/触发器、worker、恢复CLI和CI。文档中早期阶段的未开放描述不能替代最新代码。未读取实际 `.env` 秘密，未连接生产或本地业务DB，未调用真实供应商；下述是静态代码审计，不是生产运行证明。实际验证另见[验证记录](./evidence/phase-7-1a/verification.md)。

配套：[发行架构](./production-release-architecture-7-1a.md)、[授权协议](./license-protocol-7-1a.md)、[开发与验收](./release-license-acceptance-7-1a.md)。

## 结论与统一优先级

当前仓库有完整交易与履约安全基础，但尚不满足本轮商业发行定义；不能直接把现有Compose交给客户并声称正式发行。未发现必须在本轮修改业务才能完成设计的问题，下列缺口全部登记后续阶段，不扩大本轮范围。

| 优先级 | 能力/缺口及影响 | 修复/验收责任 |
| --- | --- | --- |
| P0 发行阻塞 | 客户需源码build，无独立发行清单/镜像渠道/HTTPS初始化；不可商业交付 | ⑦-2发行流水线、⑦-3安装 |
| P0 授权基础缺失 | 无实例身份、许可证验证或状态机；误用全局写gate会中断旧资金与交付 | ⑦-1B协议基础与独立中心，⑦-1C精准事务接入 |
| P0 恢复可用性门禁 | v2联合备份未纳入配置/业务历史key/身份；只备DB与文件可能无法解密原付款或历史交付 | ⑦-5完整加密备份/密钥托管，⑦-6演练；⑦-2先提供清单与CLI边界 |
| P0 采购边界 | 真实卡易信协议和商户证据仍未验证，代码故意隔离；许可证不得启用 | 保持原供应商专项边界，⑦-2/⑦-7发行清单明示未开放 |
| P1 升级 | 无schema/release兼容闸门、迁移checksum/部署锁或完整失败边界 | ⑦-2清单/检查、⑦-5升级流程、⑦-6失败演练 |
| P1 健康与恢复 | ready仅SELECT1，无worker积压/最老unknown指标；支付unknown主要靠回调/刷新/管理员对账 | ⑦-4可观测/告警/runbook，⑦-6恢复演练 |
| P1 生产秘密与制品 | env自动探测、无_FILE、API发行files白名单及sourceMap待实物扫描 | ⑦-2制品与秘密注入、⑦-3生产预检 |
| P1 迁移单执行者 | 中心active唯一不阻止离线克隆或历史worker双执行 | ⑦-1B/1C承认协议边界，⑦-5/6停写迁移与外部事实核对 |
| P2 后续强化 | DB角色最小权限、公开OpenAPI策略、文件回收排程、负载/磁盘配额 | ⑦-4～⑦-7，各项商业上线前关闭 |

以下各节中的 `commerce/`、`payments/`、`media/`、`auth/`、`catalog/` 均相对于 `apps/api/src/`；无前缀的迁移文件名均在 `apps/api/src/db/migrations/`。表中缩写只用于降低重复，文件与关键行号可在基线直接复核。

## A. 资金与经营义务

### 实际入口与调用链

| 操作 | 实际代码证据 | 授权设计结论 |
|---|---|---|
| 顾客/游客创建订单（legacy/v2）、零元领取 | `apps/api/src/commerce/orders.ts:1354` POST `/api/v1/checkout/orders` → `createOrderWithRetry():700` → `db.transaction():756` → `createOrderTransaction():572` → `orders INSERT:629`；检索生产 src 仅此一处 TS orders INSERT。 | `CREATE_ORDER` 必须在最终事务、已有幂等返回后、新 INSERT 前检查；含零元领取，不能仅拦支付。 |
| v2 下单附件准备 | `orders.ts:711` 预检事务，`723-726` 先幂等重放；`744-750` 在最终事务前复制准备附件；`753-765` SQL 可重试错误最多3次。 | 预检可提供 UX 提示但不作授权权威；每次最终事务均重读授权。拦截时沿用附件未知提交保护与对账清理，不因授权错误主动删除可能已提交附件。 |
| 新钱包充值 | `apps/api/src/payments/routes.ts:1064` POST `/api/v1/customer/wallet/top-ups` → `createTopUpAttempt():826` → 最终事务 `838`；customer/wallet UPDATE锁 `839-842`，幂等返回 `843-859`，新 attempt INSERT `900`，秘密快照 `922-925`，provider requesting状态 `927-929`。 | `CREATE_TOPUP` 放在已有幂等返回后、新 attempt INSERT 前，且 provider.create 只能在该事务提交后调用。 |
| 订单外部支付新 attempt | `routes.ts:961` → `createOrReuseAttempt():477`，事务 `489`，原订单可付与原截止检查 `493-498`，幂等 `505-521`，活跃 attempt恢复 `523-538`，INSERT `578`。 | 属原订单付款义务；授权过期仍允许在原订单有效期内创建首个或后续安全 attempt，不挂 `CREATE_ORDER/TOPUP`。保留原业务付款期限、资金证据冲突、渠道可用规则。 |
| 订单纯钱包/组合支付 | `routes.ts:481-482` 分流 `createOrReuseWalletOrderPayment():280`；事务 `298`；先重放 `302-325`、活跃恢复 `327-348`；原订单状态/截止 `350-356`；`433` 调 `apps/api/src/finance/wallet.ts:38 recordWalletOrderPayment`。wallet函数顾客→订单→钱包锁 `46-88`，先写冻结/扣账 operation `104`，再 payment_attempt `116`、ledger `148`、钱包收款凭据 `161`。 | 同属原订单付款；绝不能把“创建 payment_attempt”全部视为新充值。付款将冻结或扣除钱包，但不因 license到期阻断。 |
| DB 内组合支付转钱包结算 | `apps/api/src/db/migrations/202610180001_trade_foundation.ts:977` `resolve_order_wallet_hold`，`1061` SQL INSERT payment_attempts。由 `202610200004_wallet_payments.ts:245` 收款触发器调用；晚款则 `247` 释放。 | 直接SQL创建历史结算 attempt，必须保持；不能给 payment_attempts 全表统一加新经营授权触发器。 |
| 新退款申请/审核/人工尝试 | `apps/api/src/commerce/refunds.ts:567`→事务 `575`，重放 `578-583`，来源凭据锁/余额 `584-600`，申请 `601`；审批 `620`/分配 `636-648`；顾客退款钱包原子完成 `651-657`；游客人工尝试 `746`、解决 `782`。 | 新增退款记录履行旧债，过期继续允许。保留请求幂等、支付/采购冲突保护、原来源分配、unknown不能盲重试。 |
| 新提现申请、审核与人工打款 | `apps/api/src/commerce/withdrawals.ts:321` 事务 `327`，customer→wallet锁 `329-331`，重放 `334-340`，仅cash余额/配置 `343-354`，冻结 operation `370`、申请 `374`；打款解决 `513-566`。 | 新提现同样清偿已有钱包债务，过期继续允许，不能以“新记录”为由阻断。unknown `520-532` 保持冻结，只有可证实失败/成功落结果 `540-554`。 |
| 购物车、草稿、报价 | `apps/api/src/commerce/customer-cart.ts:406` 加车、`1102` merge、`1214` quote；报价事务 `1228-1244` 仅读报价/校验资料。 | 未形成交易义务，继续可读/准备；最终订单权威拦截，UI可展示停购但不作安全边界。 |

补充：新授权应覆盖全部商品履约类型，不能漏 legacy、v2、游客、顾客、零元、代码池、固定内容、文件、API、未来采购来源。当前采购选择器在 `orders.ts:623-626` 明确生产返回空（其他履约审计详查其拥有源）。

### 原有幂等、约束与事务安全（必须保留）

- `orders.ts:533-541` 以 owner type/id + key 取得 advisory xact lock，`543-563` 同 owner查 request hash；`599-601` 最终事务先返回旧订单。因此授权状态判断不能移到身份认证、路由 preHandler 或幂等之前。
- 订单锁序：`orders.ts:588-590` 顾客 UPDATE先于session SHARE；`509-530` 商品→SKU→数量库存→履约配置固定排序；`603-621` 锁策略/商品后重报价，过期报价拒绝。`676-691` 资料快照、采购冻结来源、库存预留和订单写入同事务；`694` seal。
- `202610180001_trade_foundation.ts:111-112` 顾客/游客各自部分唯一幂等索引；`259` payment_attempt idempotency全局UNIQUE；`278` 订单/充值单一目标 CHECK；`308` 单订单一个 created/pending；`326` 单attempt单source_bucket凭据；`343-344` provider transaction、wallet line唯一；`428-430` ledger各资金来源幂等唯一；`253` wallet hold只允许解决一次。
- 钱包不能任意覆盖余额：`202610180001_trade_foundation.ts:619` guard_wallet_account_balance_write；`677` ledger trigger应用资金；`641` immutable trade history；`974` deferred操作必须具备ledger entries。不要用授权异常触发资金表清理或补偿。
- 零元订单也创建新交付义务：`202610180001_trade_foundation.ts:1104` validate_new_order，`1138-1143` 零元直接processing；付费期限由DB按被锁策略clock_timestamp生成。
- 原期限不可因授权而延长：`202610190004_orders.ts:39-87` 新 external attempt 必须将来截止、pending须未过期、deadline immutable、更新使用订单advisory fence；`128-130` BEFORE触发器。
- 退款：`202610200005_refunds.ts:376` enforce_order_refund_claim_capacity，`471` validate_refund_allocation；`487-489` order→refund→receipt锁；`123` 仅一个人工活跃attempt；`548` allocation更新约束。提现：`202610210001_withdrawals.ts:146` 成功转账凭据唯一；`279/334/360` 结果插入、终态和deferred终态一致性。均不能插授权依赖。

### 历史资金证据与恢复调用链

1. `routes.ts:976-981`、`1078-1082` 先事务创建持久attempt再外网请求；`660-680 startProviderRequest` 捕获超时→unknown，不自动新建；保存响应事务 `631`、`654-656`。进程在提交后、请求前或响应未落库死亡，恢复走同 merchant_order_no 查单；不得因到期要求新key或新充值。
2. `payments/settlement.ts:141-161` 读取 attempt自己的支付凭据快照，轮换渠道后也能验签/查单；业务密钥备份不能只留最新key。
3. `settlement.ts:665-740 handleProviderCallback`：验签→`718-720` 先持久化签名资金证据→原服务商query→`processProviderQuery():512`。query结果身份检查 `247-263`，事件唯一写入 `546-561`；冲突 `562-589` 保留对账case而不直接履约；`591` 写认证凭据。
4. `202610200004_wallet_payments.ts:33-129` receipt触发器用数据库clock分类 on_time/late/excess/amount_mismatch；`214-265` 只有无未决证据且足额才processing；`272-304` 充值在 succeeded + 等额on_time真实receipt + 无冲突时以 receipt.id 幂等记账。license过期不能阻断这些触发器。
5. `settlement.ts:621-645 refreshPaymentAttempt`、`647-663 resolvePaymentReconciliation` 使用已有attempt/query，不创建新充值；`610-618` DB抢query cooldown。
6. `orders.ts:882-938 expireDueUnpaidOrders` 仅无未解决attempt、未退资金、退款、processing/unknown履约或履约数量预留时关闭；FOR UPDATE SKIP LOCKED `923`，`927` 再检查保护。`commerce/unpaid-order-expiry.ts:28-49` 启动即恢复，60秒轮询。授权不能关闭此worker。
7. 可观察缺口：`apps/api/src/index.ts:16-17` 仅启动过期订单和数字履约worker；未见独立支付自动查单worker，支付恢复由回调、顾客refresh、管理reconcile推动。因此“恢复”不能宣传所有资金unknown都会无人值守自动完成；⑦-2/运维阶段须监控 stale requesting、unknown、open reconciliation、冻结钱包年龄并给人工runbook。

## B. 履约、供应商与所有生产worker

| 范围 | 真实代码证据 | 事务、约束及失败边界 | 授权接入要求 |
| --- | --- | --- | --- |
| 进程与 worker | `apps/api/src/index.ts:7-25` 读取配置、建 DB/App 后启动两个 worker，信号处理等待停止；`commerce/unpaid-order-expiry.ts:6-54` 60s/100 条、启动即扫描；`commerce/code-pool-delivery-worker.ts:1541-1608` 1s/20 条，本地与供应商两个独立循环 | worker 与 API 同进程，无独立队列服务；本地 scan 和供应商 I/O 不互相等待；失败记录日志后下一轮；多副本由 PostgreSQL 锁分摊 | 不把启动、API listen、DB pool、worker poll 或停止信号受授权状态控制。到期仍须回收超时订单和库存、交付已付订单 |
| 候选付款保护 | `commerce/code-pool-delivery-worker.ts:81-165` 候选只取 processing、未履约完、无未知付款/退款/对账；事务再次 `paymentAllowsDelivery()` | 只认 on_time 实付总额精确相等；禁止已退款/退款预留/开放 reconciliation；零元订单可本地履约 | 不增加授权条件。到期不能越过已有付款、退款、库存冲突保护 |
| 卡密 | 同文件 `222-345`：订单 `FOR UPDATE SKIP LOCKED` → item → product/SKU → inventory/config → reserved code；核对池计数和 remaining，解密旧条目再加密交付 | 交付行和 attempt succeeded 在同一事务；`202610180001_trade_foundation.ts:2519-2591` 的 AFTER trigger 同步 item 数量、inventory consume 和订单完成；`202610210002_code_pool.ts:563-591` consume 必须对应成功 attempt、reserved 卡密并将其 delivered | 只是履行原订单。不得因到期拒绝读取历史 code/key 或阻断消费预留库存 |
| 固定内容、链接 | 同文件 `380-537` 从订单冻结 `fulfillment_content_version_id` 读取，不读当前内容头；复核数量库存 reservation/events | 冻结版本解密后为每单位建立加密交付；失败按最多 5min 退避；`recordUnexpectedFailure():168-218` 按 operation_id 查已提交结果，避免未知 COMMIT 后重复 | 允许到期后首发、重试、历史读取；不允许用“禁用商品”替代授权门禁 |
| 私有文件交付 | 同文件 `555-744` 事务外 `openVerified()`，事务内重新锁订单、item、库存和冻结版本并复核摘要/大小/对象身份；`media/private-file-storage.ts:167-224` 私有 0700 root、拒绝符号链接与越界 | 只在对象 available 且 SHA/size 一致时记录引用式交付；丢失/损坏标记 missing/corrupt、关闭当前文件自动交付 ready；finally 关 fd；失败并不伪造成功 | 原订单文件校验与恢复继续运行；授权不得代替文件完整性错误，也不得删除文件 |
| 历史文件下载 | `commerce/private-file-downloads.ts:82-192,267-291` customer/guest 两入口（HEAD 同授权）；会话/owner、processing/completed、on_time 金额、无开放对账、冻结版本/交付单位/摘要再验证文件；`195-258` private,no-store + range | UUID 不是访问凭据；404/410/416 保持原语义；所有权和付款校验继续有效 | 到期、撤销、离线过期均不能单独阻断；续费/迁移不改变 order owner/版本/对象 UUID |
| 历史数字内容 | `commerce/orders.ts:291-356` 依据交付类型和被冻结 item/version 解密 code/fixed/link/API；procurement 合成结果仅 confirmation | key ID + AAD 包含 SKU、订单项、交付、版本等稳定身份；缺历史 key 无法恢复明文；不是订阅重新派生加密密钥 | 业务密钥必须独立于授权密钥与订阅期限；不能到期删 key、删历史凭据/内容版本 |
| 旧外部 API 新交付 operation | `commerce/code-pool-delivery-worker.ts:782-914` 订单/item/库存锁下再验付款、冻结履约/连接/凭据版本；每原订单单位 1 个 operation，UUID 幂等键 `aikayun:<id>`、CNY、数量 1 和 request SHA | 准备 operation 与 attempt 同事务；先持久化 `create_pending` 再网络发送；预检缺 key 记录可诊断失败；失败重试授权只消费一次 | 即使第一次 operation 在订阅到期后建立，它也属于已有订单履约，继续允许；不能把所有 INSERT supplier-operation 认作新销售 |
| 旧外部 API 请求恢复 | 同文件 `945-984` `FOR UPDATE SKIP LOCKED`、30s lease/token、一次最多 4；过期 in_flight 只 query；`1082-1261` 状态/证据与 token 围栏；`1265-1327` 网络在事务外；`1338-1513` 已加密保存结果再 finalize | 供应商号矛盾/结果冲突转 manual_review，网络未知 query；`1124-1138` 未知上游号的 query not_found 可以回 create_pending，但始终沿用同幂等键；这是 **http_json_v1** 协议既有保证，`http-json-v1.ts:190-213` 要求 capabilities 明示幂等及两种查单，探测不发送 create | 续订/换服务器不得换原 operation/idempotency key。到期允许 query/finalize 以及为履行旧订单而受原规则约束的 create/retry；不能把此 not_found 规则复制给卡易信 |
| 人工交付、供应商管理恢复 | `commerce/orders.ts:1554-1620` 安全 query/原成功 finalize；`1623-1687` 仅明确 supplier_rejected 且未交付才设 retry_after，消费审计防重复替代；`1690-1784` manual operationId 锁及请求内容摘要，重放返回原结果 | 人工发货事务内 owner/order/item/数量/付款对账保护，数据库 trigger 再兜底；未知供应商结果不允许靠人工伪完成 | 到期继续可用，管理员鉴权/CSRF/业务门禁保留。管理商品/配置/补库存也不应全局封禁，以便履行旧订单 |

### 冻结规则在数据库中的真实落点

1. `apps/api/src/db/migrations/202610230002_digital_fulfillment_acceptance.ts:17-43`：退款批准/执行必须等待未知或 in-flight fulfillment 消解；确认的原路退款外部事实例外保留。
2. 同文件 `45-95,98-122`：交付插入与 attempt 成功都检查付款、退款、对账；跨 attempt 相同 item/unit 不可重复交付；API 交付须保留原结果密文和单位身份。
3. 同文件 `125-174`：supplier operation 的单位与已记录 providerOperationId 不变；成功状态必须先有原单位最终交付。
4. `202610230001_external_api_delivery.ts:653-720`：履约 attempt identity/quantity/result 不变；合法 processing/unknown 转移；成功不得超量；终态完成时间由 DB 控制。
5. `202610270003_procurement_identity.ts:45-97`：采购来源只能在 **未封口的原下单事务** 插入，必须匹配审核映射、连接/凭据/模板版本与成交资料摘要；永久不可变，不能给既有订单补当前来源。
6. 同文件 `102-117,145-160`：采购付款资格比普通零元交付更严（正金额已全付，无 pending/reconciliation/refund）；每 order_item/unit 只有一个非 rejected 采购义务。
7. `202610270005_procurement_execution.ts:15-25,43-71,86-145`：每操作只有一个 submit intent；generation 唯一；准备 request/新 operation/预算同事务；意图/证据/冲突不可改删；request identity 必须原 local_business_number。
8. `202610270007_procurement_global_conflicts.ts:8-62,86-101,123-185`：跨操作撞号和同单位旧执行事实全局阻断 request/finalize/竞争人工履约及退款；迟到撞号可恢复已释放风险；不能授权到期时清空 unknown 或风险桶。
9. `202610270004_procurement_risk_budget.ts:8-49`：policy 只能 TST，预算按 global/supplier/SKU 维度与 UTC day；`commerce/procurement-risk-budget.ts:35-36,86-127` 应用同样拒绝真实币种，pause 只阻止新 send，不抹历史风险。

### 卡易信真实采购仍未开放：多层直接证据

- `commerce/procurement-source-selection.ts:1-16` 固定返回 []，没有 env/DB/admin 开关；checkout 虽有冻结来源持久化能力，生产没有可选采购来源。
- `commerce/procurement-preparation.ts:15,23-28,124-132`：内部只读 `prepareOrderItemProcurement()`、`purchaseEligible:false` 恒定；显式阻断 currency/maximum_debit/fees/quantity_conversion/safe_price/outer_number/protocol_encoding，必要时加 image/cascade/conditional；结果含客户资料不得日志/HTTP 输出；它不分配 operation 或风险。
- `commerce/procurement-identity.ts:67-70,115-118` 付款准备资格和身份分配不授权供应商发送。
- `commerce/procurement-executor.ts:7-27,257-307` 只有调用方注入的受控 fixture transport/source resolver；生产 index/app 未接入。`procurement-finalization.ts:6-8` 仅合成逐单位完成内核；没有生产传输、调度器、HTTP 路由。
- `commerce/kayixin-customer-v3.ts:12-17` 仅 account/list/detail 三个固定只读路径；`catalog/admin-supplier-connections.ts:164,441` 只能 http_json_v1 获得 fulfillmentEligible 或 enabled；`catalog/admin-api-fulfillment.ts:194` 拒绝卡易信作为 API 履约源。
- `apps/api/src/db/migrations/202610240001_kayixin_readonly.ts:47-91` DB 阻止卡易信 enabled/tested_version、api fulfillment version/config 和 supplier operation；正常 SQL 配置不能开启现有 API 通道。管理员完全控制服务器仍可改代码/DDL，不宣称绝对防绕过。
- `commerce/procurement-executor.ts:119-155` submit_in_flight 失租转 unknown，之后 action=query；`175-253` 先追加迟到证据，再以 lease+generation 判断改状态；not_found 仍 unknown，拒绝/身份冲突转人工，不自动释放预算；`procurement-finalization.ts:23-25,63-94` 同原单位幂等完成且须 matching success+delivery_confirmed，库存消费与交付同提交。
- ⑥-4C-2 最新文档确认商户币种、数量、手续费、safePrice、outerNumber、图片和资料、状态、退款与跨凭据查单仍 NOT_VERIFIED；离线 fixture 不构成生产资格。

### 购买资料与文件持久化

- `commerce/purchase-order-attachments.ts:31-70` 先 readVerified/复制归档，再登记 prepared；`125-159` 原订单事务内加密 values、锁 object、插引用并 retained；保留冻结订单资料，不依赖草稿继续存在。
- 同文件 `324-384` repair 仅把 >=24h、无引用 prepared 在锁内改 deleting，提交后才 unlink；失败保留 deleting 重试；retained 缺文件只报告。不能把整个 private root 视作缓存清理。
- `media/private-file-reconcile.ts:38-92` 冻结履约版本引用对象逐个校验 SHA/size；repair 可恢复状态/关闭坏文件 ready；`95-125` 只清过期上传/无登记孤儿。
- `apps/api/package.json:15-22` 产品媒体、私有文件、购买草稿、订单附件为显式 CLI check/repair；生产 index 没有它们的自动 scheduler。check/repair 区别必须在运维产品化中保留。
- `commerce/purchase-form-crypto.ts:106-147` 订单资料从 payment credential ring 派生用途 key；`supplier-api-crypto.ts:40-79,111-155` 供应商凭据用 payment ring、交付用 codePool ring；`fixed-delivery-crypto.ts:38-44,97-143` 与 `code-pool-crypto.ts:25-84` 使用 codePool ring 和稳定 AAD。必须保全 **所有历史 key ID**、旧供应商 credential/config versions、order/item/delivery/object UUID。

### 供应商网络与公开下载安全

- `apps/api/src/commerce/supplier-http.ts:107-161,171-214,249-269` 强制HTTPS（仅test loopback allowlist例外）、全DNS地址公网校验与固定解析、TLS证书校验、8秒总超时、请求/响应字节上限并拒绝重定向。授权/采购阶段不能新增通用任意URL代理绕过现有边界。
- `apps/api/src/commerce/private-file-downloads.ts:93-192` 会话/owner、付款、冻结版本和摘要校验覆盖HEAD/Range；订阅到期只保留访问资格，不能跳过这些实际业务授权。

## C. 部署、配置、权限、SSR和公开API

| 范围 | 文件/关键行 | 实际行为与边界 |
| --- | --- | --- |
| 仓库运行边界 | `docs/architecture/overview.md:15-23`; `docs/deployment.md:3,7-12,30-40` | Nuxt SSR/BFF + Fastify + PostgreSQL 模块单体；现有安装要求获得源码、`up --build` 和管理员 CLI。文档明确尚无客户安装器、更新器、授权中心。 |
| PostgreSQL 持久化 | `compose.yaml:3-18,145-150` | PG18 固定 digest；命名卷挂载 `/var/lib/postgresql`；只绑定宿主 loopback 端口。`pg_isready` 只测连接就绪。 |
| 构建/发行 | `compose.yaml:20-24,37-40,49-52,61-64,103-106` | migrate/API/init/web 均 `build: .`，没有客户发行镜像地址。Caddy/PG 的上游镜像 digest 固定不等于自有产品发行已建立。 |
| API 镜像 | `apps/api/Dockerfile:1-29`; `apps/api/package.json:1-44`; `tsconfig.base.json:15-16` | 多阶段 Node24、锁文件安装、pnpm deploy --prod、runtime 非 root。但 API 包无 `files` 白名单，构建生成 source maps；目前不能证明客户镜像只包含审定 runtime 文件。须在发行流水线检查 layer/archive，排除 TS 源码、测试、`.env`、内部文档、source maps。闭源 JS 运行产物仍可被服务器管理员读取，不能承诺抗逆向。 |
| Web 镜像 | `apps/web/Dockerfile:1-27` | 多阶段只复制 `.output`，非 root Node server；仍须扫描 Nitro server/client map 与静态资源实际产物。 |
| 构建上下文隔离 | `.dockerignore:1-12`; `.gitignore:1-12` | `.env*` 排除（保留示例），排除依赖、dist、.output、测试报告；这不替代 runtime 发行内容扫描。 |
| 网络/TLS | `compose.yaml:69-71,81-85,111-115,129-143`; `deploy/Caddyfile:1-13` | 对外只经 Caddy → Web → BFF → API，API/Web 只 expose。默认绑定 localhost/8080/8443、本地 HTTP；Caddy security headers/TLS 依赖显式域名配置。客户生产包必须拒绝本地默认配置。 |
| 环境加载 | `apps/api/src/config.ts:6-12,132-145,170-209`; `.env.example:12-33` | 自动寻找 `.env`；env parse 不分独立开发/测试/生产文件，生产仅限制非 loopback Cookie secure，并未直接要求 origin HTTPS 或校验全部端口。正式发行应由单独校验器形成已解析配置，不将 `.env` 自动探测等同生产配置隔离。 |
| 存储分区 | `apps/api/src/config.ts:147-168`; `compose.yaml:37-59,79-85` | media/private 必须绝对路径、仓库外、互不重叠；一次性 root init 修复属主，API 非 root；私有根 chmod700。 |
| 密钥环 | `apps/api/src/config.ts:58-129,208-209`; `.env.example:19-25` | 两组 API-only AES256 keyring，规范 Base64 32字节、active id存在、最多16把；缺失可为 null，不是启动即完整依赖检查。PG 环境密码目前注入为 env。没有 `_FILE` secret读取、实例私钥或授权公钥设施。 |
| 历史解密 | `apps/api/src/payments/credentials.ts:18-55`; `apps/api/src/commerce/code-pool-crypto.ts:26-31,68-85`; `fixed-delivery-crypto.ts:39-44,124-145`; `supplier-api-crypto.ts:50-64,112-117,140-158`; `purchase-form-crypto.ts:27-29,47-70,106-148` | 密文 envelope 保存 keyId，AES-GCM + AAD；缺历史 key明确失败。支付环还承载供应商凭据和购买填写快照的派生密钥；卡密环还承载固定内容/外部API交付结果及摘要。备份不保留所有被引用历史key会使历史支付/发货/订单资料不可用。 |
| 数据库迁移 | `apps/api/src/db/migrate.ts:5-15`; `migration-provider.ts:47-95`; `compose.yaml:20-35,92-100` | Kysely migrateToLatest，在独立一次性容器，API依赖成功完成；应用启动不隐式迁移。固定显式迁移列表当前最新 `202610270007_procurement_global_conflicts`。没有产品 release/schema 兼容区间、迁移文件 checksum清单或升级编排协议。不能从代码简单承诺自动down/跨PG大版本升级。 |
| 连接边界 | `apps/api/src/db/pool.ts:6-18` | Pool max10、5秒连接超时、30秒idle；API/migrate仍共用同一用户配置，没有迁移角色/业务角色隔离。 |
| 管理员初始化 | `apps/api/src/admin-init.ts:6-39` | CLI验证email/14+位密码，hash后事务取得 `pg_advisory_xact_lock('aikayun:admin:init')`，确认admin_users计数为0才写入；已具并发一次性基础，但没有HTTPS网页初始化、一次性bootstrap令牌与安装身份绑定。 |
| API健康 | `apps/api/src/app.ts:163-187`; `compose.yaml:86-91,118-123` | live仅进程；ready仅SELECT1，未查schema版本、缺key、文件根读写、队列积压/worker停滞。web健康用首页HTML，并非专用SSR/BFF诊断。现有健康与许可无关应保留；授权过期不得使数据库/服务整体unhealthy。 |
| Worker生命周期 | `apps/api/src/index.ts:16-25` | API进程启动expiry与digital worker，SIGTERM顺序等待stop、close、db destroy；备份暂停API相应停止这两组内置worker。若以后独立worker/修复CLI/其他写实例存在，当前备份脚本并不能自动冻结它们。 |
| 请求与权限 | `apps/api/src/app.ts:73-83,111-125,127-157`; `auth/admin.ts:48-75,99-102,145-175`; `auth/security.ts:21-29,32-59` | Fastify每条admin路由requireAdmin查token hash+过期/撤销/active，写路由同源Origin+双提交CSRF；登录5次/分钟。错误日志避开DB整行，cookie/body等redact。单一admin角色，没有细分RBAC；/api/docs当前公开。发行阶段需确认公开文档策略，不能把前端菜单当权限。 |
| 前台SSR/BFF | `apps/web/nuxt.config.ts:50-67`; `apps/web/server/api/[...path].ts:4-7`; `apps/web/middleware/admin-auth.ts:1-10`; `apps/web/server/api/customer/session.get.ts:11-26` | 内部API URL runtime config，public仅品牌/siteUrl；BFF proxy，admin middleware SSR useRequestFetch取真实session后重定向；customer session no-store并转发set-cookie。生产禁用dev-preview。授权中心地址/凭据不得进public runtimeConfig，SSR页面的按钮状态只做提示，交易事务仍是最终判断。 |
| 联合备份 | `scripts/backup-compose-data.sh:9-47`; `docs/deployment.md:46-50` | 停API→PG custom dump→media tar→全部private tar→v2 manifest+SHA256→原子rename；EXIT会恢复API。覆盖私有交付及购买附件目录，但不包含配置、两组历史密钥、安装实例身份、release/schema信息、Caddy证书卷。单API/无外部写者前提才能形成静止备份点。 |
| 隔离恢复 | `scripts/restore-test-compose-data.sh:8-67` | 明确只允许YES、test/restore project、_test DB、项目专属media/private卷；校验v2 hashes，先停API/Web/Caddy再恢复，失败保持停机。不是生产恢复工具；不应改掉这些防护拿来恢复客户数据。 |
| 文件诊断 | `apps/api/src/media/reconcile-cli.ts:6-35`; `private-file-reconcile-cli.ts:6-19`; `apps/api/package.json:14-22`; `scripts/reconcile-digital-fulfillment.sql` | 已有只读check、独立显式repair及>=24h媒体孤儿宽限；购买draft/order attachment各有check/repair。正式诊断应默认check、脱敏、输出结构化报告，保留修复审批及业务约束。 |
| CI | `.github/workflows/ci.yml:12-115`; `scripts/verify-digital-recovery.mjs:1-4,14-61,85-108` | CI有lint/typecheck、真实_test PG集成、构建、Chromium、生产品牌、Compose重建数据保留、隔离真实SIGKILL/联合备份恢复/TLS拒绝。当前无产品OCI发布、manifest签名、SBOM/扫描/安装包验收。恢复脚本特意创建独立project和随机密码/key，不能把其测试结果说成生产已演练。 |

### 前台与公开API的额外源码追踪

- 目录SQL从 `apps/api/src/catalog/public-products.ts:228` 限定active商品，SKU资格在 `:145-152` 同时验证enabled/retired/规格完整性；分类CTE在 `:155-169` 从可见根递归，不把隐藏父节点子树暴露。公开路由在 `:647-761` 分别注册独立public响应schema（首页、分类、搜索、详情、sitemap），详情事务读取在 `:509-541`。公开查询没有直接复用后台详情，不能因授权到期关停公开目录。
- 真实页面 `apps/web/pages/index.vue:12-32`、`pages/categories/[id].vue:18-48`、`pages/search.vue:39-115`、`pages/products/[id].vue:7-24,1255-1262` 使用await useAsyncData完成SSR；详情只对明确404跳首页302，API故障保留安全502。`apps/web/utils/public-page-response.ts:1-27` 去掉上游错误body，并设置no-store和诚实HTTP失败状态。
- `apps/web/utils/public-site-url.ts:1-26` 只由受信配置生成origin；`apps/web/server/routes/sitemap.xml.ts:13-37` 从内部API拉取当前公开集合并输出no-store XML。换域名应更新这一配置，不能绑定Host/IP作为许可证身份。
- 管理路由实际证据例如 `apps/api/src/catalog/admin-products.ts:342-347,399`、`admin-product-management.ts:819-844,868-994`：读取走authenticate，写入走authenticate+csrfCheck；SSR守卫只辅助导航。当前仅统一管理员身份，不具备销售版细分RBAC。
- 已查 `docs/development.md`、`docs/storefront.md`、`docs/architecture/overview.md`。旧文档部分描述落后于现状，例如 `docs/storefront.md:22,50-52` 仍说公开详情不返回SKU ID，而实际 `public-products.ts:408` 返回用于当前下单链路的 `skuId`，`pages/products/[id].vue:103-105` 读取它；`storefront.md:42` 也保留早期支付未开放描述。不能把这些旧阶段文字当成当前产品能力证明；后续发行文档统一清理应明确归于文档/发行阶段，本轮审计以实际代码为准。

## D. 审计覆盖与边界

- 全仓目录边界：`apps/api`拥有配置、鉴权、资金、catalog、commerce、DB及media；`apps/web`拥有SSR/BFF和前后台页面；`packages/contracts`为TypeBox接口、`packages/money`为精确金额唯一基础；`deploy`、`scripts`、`.github`覆盖部署与恢复验收。测试夹具不是生产入口，检索新订单/支付attempt写入同时覆盖TS与SQL，不只按函数名判断。
- 已追踪现有所有常驻worker启动点；显式reconcile/check/repair CLI不是另一个自动worker。生产没有支付/退款/提现或卡易信独立自动调度器，不能把模块函数存在等同已接入生产。
- 资金/库存约束由真实PG触发器、唯一约束、外键和订单锁共同承担；授权是新增经营准入层，不重写这些安全不变量。
- 授权协议最终取舍以配套协议文档为准：首版准入采用授权单例 `FOR UPDATE` 并维护可信时间水位；不会将全表payment_attempts或所有POST挂授权闸门。
- 本审计发现的是商业发行准备缺口，并未验证真实服务商、生产数据完整性、镜像内实际敏感文件、各平台容量或备份可恢复性；这些必须在后续验收中用实物证据关闭。
