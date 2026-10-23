# 卡易信客户 API V3 只读接入（⑥-1）

本轮从阶段⑤冻结提交 `75c2f1ffce397b9a63c346804a3dec0cd5a31fb2` 向前扩展。开始时本地 main、origin/main 与 `git ls-remote` 的实际 main 均等于该提交，工作区干净。阶段⑤的验收结论、历史迁移、订单、资金与履约状态机保持冻结；本轮不部署生产、不进入⑥-2。

## 实现与操作

在原有「供应商连接」页面点击「新增连接」，选择「卡易信客户 V3 · 只读」，填写站点 HTTPS 基础地址及商户 AppID/AppSecret。文档密码不是 API 凭据。保存后清空凭据输入框，服务端只返回凭据存在标记、协议和版本元数据。

同页支持保存新配置版本、成对轮换 AppID/AppSecret、查看历史地址/认证版本及审计、重封装全部历史凭据、测试当前只读连接。测试依次读取账户、第一页商品，以及非空第一页的第一个商品详情；空目录只证明账户和空列表读取。审计保存实际完成的操作名，不把未执行的详情读取算成成功。

「上游账户与商品」支持单独读取余额、按名称/编号搜索、逐页读取及上一页/下一页、查看商品详情、单规格/多规格/多单规格、报价、供货观察、数量规则和购买填写模板。每次观察带连接 ID、配置版本 ID/序号和读取时间。失败显示安全原因和重试入口；失败后不沿用该操作旧结果。配置变化清空浏览状态，服务端拒绝配置更新期间返回的旧观察。

详情、购买提醒、正则及模板均作为不可信文本展示。图片仅提供规范 HTTPS 外链，不由服务器下载、代理或嵌入；不执行 HTML、上游脚本或正则，不填写或提交购买参数。本轮没有目录导入、自动同步、批量铺货、采购、定价、顾客退款、对外供货 API。

## 文档依据与协议差异

仅依据[卡易信商家客户 API 3.0](https://7qsaa0ye9g.apifox.cn/?pwd=kayixin)，通过其正常文档密码验证读取。没有混用后台管理 API 或反向支付 API。

| 项目 | http_json_v1 | kayixin_customer_v3 |
| --- | --- | --- |
| 认证 | Bearer Token | 独立结构化 AppID/AppSecret |
| 配置认证类型 | bearer | app_signature_v3 |
| 请求 | 原能力 GET、交付 POST、查单 GET | 固定只读业务操作的 POST |
| 测试范围 | fulfillment_v1：能力、按幂等键及供应商 ID 负查单 | catalog_read_v3：账户、列表、可用时的详情 |
| 新自动销售 | 保留原测试/连接启用/SKU 启用链路 | 禁止 |
| 出站请求上限 | 16 KiB | 16 KiB |
| 响应上限 | 保留 64 KiB | 账户 64 KiB；列表 1 MiB；详情 2 MiB |
| 超时 | 总计 8 秒 | 总计 8 秒 |

V3 基础地址仅允许站点根地址（不含 API 路径）；版本保存及运行调用均校验这一限制，不接受任意路径前缀。只开放三个固定出站路径：

- `/api/v3/user/getAccount`：POST，按文档使用空正文，参与签名的正文是空字符串。
- `/api/v3/goods/getList`：POST，发送明确的 `page/goodsType/keyWord/skuType/showDirId/dirId/brandId` JSON 字段。
- `/api/v3/goods/getDetail`：POST，正文为 `goodsId`。

分类、采购、转账、查单、退款、投诉、卡券作废、后台处理及反向支付均未开放给此适配器。没有任意路径代理、方法选择或脚本入口；后台请求不能指定新的上游路径。没有创建“测试采购订单”。只读由业务操作定义，POST 本身不意味着写业务。

依据[签名规则](https://7qsaa0ye9g.apifox.cn/7507763m0)，`X-APP-ID`、`X-Version=3.0`、10 位秒级 `X-Timestamp` 与 `X-Signature` 分别发送为 HTTP 头；签名为 `MD5(AppID + AppSecret + "3.0" + timestamp + bodyJson)`，无分隔符，使用 UTF-8、小写十六进制。协议先生成最终 bodyJson，以同一字符串计算签名和 Buffer；共享传输不再 JSON 序列化。固定向量使用合成凭据，由 Python hashlib 与 OpenSSL 两种独立实现核对，另有真实 HTTP 夹具捕获请求字节。

共享 `supplier-http.ts` 只抽取两个实际协议共用的 URL/TLS、全 DNS 答案检查、地址固定、禁止重定向、总超时及有界字节传输。旧协议重新导出原导入名和同一错误类身份，保留分类/错误代码、请求顺序及 JSON 编码、能力探针和两种查单语义。没有修改操作 UUID、幂等键、请求摘要或历史结果。

## 测试范围与履约资格

新增的只追加 `supplier_connection_tests` 绑定连接、协议、配置版本、测试范围、结果、安全错误代码和时间。实际已完成操作写入原审计。配置版本切换后只读取新版本测试；测试响应提交前锁定连接并复验当前版本，发生竞争返回 409，不给新版本写成功。

卡易信成功测试的 `queryCapable=false`，不会写入旧 `tested_version_id`，`enabled=false`，`fulfillmentEligible=false`，观察商品始终 `procurementReady=false`。UI 明确显示「只读连接正常」与「自动采购尚未开放」，SKU 供应商选择器只列出有履约资格的旧协议。

API 层拒绝启用卡易信销售与保存其 API 履约版本。前向迁移同时约束连接协议不可变、版本/凭据/连接的协议及认证组合；直接 SQL 也不能设置卡易信 `tested_version_id`/`enabled`，不能将它写为 API 履约版本、履约配置或供应商交付操作。没有给旧 worker 增加卡易信采购分支。

## 商品契约和未知语义

`packages/contracts/src/supplier-catalog.ts` 定义明确的 TypeBox 运行时响应契约，适配器对每个消费字段校验/映射，不把上游整份响应 Any 透传。商品关键身份、名称、类型及状态缺失/错误会拒绝；不明但格式合法的类型/状态保留原数值并警示。详情返回的 goodsId 必须等于查询目标。

- `quote` 表达上游账户参考报价；`actualDebitVerified=false`。数字 JSON token 在 Node 24 JSON reviver 中保留原十进制字面量，经过 `packages/money`/Decimal.js 校验后作为字符串返回；支持最多 24 位整数与 18 位小数，不经过 Number、不舍入两位、不写本地成本或零售价。超出支持精度或格式不合法则拒绝，缺失报价为 null。
- 文档没有声明币种，因此本轮 `currency=null`，页面显示「币种未声明」。进入采购前需要站点确认，不能凭中文站点猜测 CNY。
- `stock.reportedCount/availability` 仅是读取时上游报告。缺失为 null/unknown，0 表示报告无库存，不解释为无限；负数/错误格式拒绝。`status` 与规格上架状态独立保留。
- `quantityRules` 保留 minQuantity、maxQuantity、multiple 原值，缺失为 null，`conversionVerified=false`，不计算实际采购数量或总价。
- skuType=1 保留 typeNames/skuNames 与每项 sku、names 组合、money、count、status；skuType=2 保留 goodsSpec 分类及每项独立规格。重复规格编码或结构异常拒绝。
- `purchaseFields` 保留 type、title、placeholder、required、regex 和 options/children/expand 的结构。支持查看文档的 0 文本、1 图片、13 数字、14 单选、15 多行、16 级联，未知类型只展示原值。深度、节点数、项数和文本均有边界；没有动态脚本执行或任意正则执行。模板缺失为 null，空模板与缺失不同。
- 商品能力保留重复下单、允许退单/退款、旧 warrantyDays 与新 warrantyTime/warrantyUnit；这些是上游声明，不能替代真实售后结果或本店顾客退款依据。
- `upstreamPagination` 保留 allCount/allPage 原值。文档将 allCount 标题写为总页数、allPage 写为总条数，而例子呈现相反含义。本轮只按请求页码前后浏览，不据此计算总页数或发起全量同步。

以下必须在⑥-2实际采购前继续确认，⑥-1没有选择其中一种解释用于采购：

1. count、minQuantity、maxQuantity、multiple 的实际换算关系、单位和扣费基数。
2. safePrice 是精确预期金额还是价格上限，精度、费用及最终扣费怎样处理。
3. outerNumber 的真实去重保证、范围、时限和冲突行为。
4. 负查单的一致性边界，何时足以证明没有执行。
5. 图片、级联选择和扩展字段的实际提交编码。
6. 分页字段名称、描述和示例冲突，以及页大小/结束条件。
7. 站点币种、可见账户报价与实际扣费、商品售后能力的对应关系。

## 凭据历史和密钥保留

V3 凭据使用现有支付凭据 AES-256-GCM 密钥环，但独立 AAD：`aikayun:supplier-connection:credential:kayixin_customer_v3:v1:<connectionId>:<credentialVersion>`，加密内容只有 appId/appSecret。旧 Bearer 继续使用原 `aikayun:supplier-connection:credential:v1:<connectionId>:<credentialVersion>` 和原 `{bearerToken}` 密文解释，不重写历史。

连接协议在建立时固定；换协议必须新建连接。地址/名称/凭据轮换形成新配置版本，轮换凭据形成新凭据版本。协议/认证元数据由组合 CHECK、复合外键及不可变触发器共同保护。重封装按每行协议解密并以同一协议/身份 AAD 加密，只替换信封；历史版本引用不变。

部署切换活动密钥前，所有实例须先保留新旧密钥；旧凭据、订单操作或交付仍引用旧键时不能删除。缺键或 AEAD 校验失败明确阻止读取，不生成空凭据成功。响应、审计、SSR 和错误不返回 Secret；日志维持安全错误摘要并增加请求体凭据字段脱敏。上游业务 msg 不回显，避免供应商把凭据或敏感正文塞进错误。

## 站点核实与 NOT_VERIFIED

2026-10-24，未携带 AppID/AppSecret，只访问站点 HTTPS 首页并向允许的只读账户路径发送空 POST，未跟随重定向：

| 站点 | 已核实 | 未核实 |
| --- | --- | --- |
| `https://sup.im01.cn` | HTTPS TLS 校验通过；账户路径 HTTP 200，code=1001、提示 X-APP-ID 不能为空 | 真实 V3 签名认证、账户、商品与完整字段语义 |
| `https://hr.89oo.cn` | 提供的 HTTP 域名存在可通过 TLS 校验的 HTTPS 入口；同一账户路径返回上述未认证错误 | 真实 V3 签名认证、账户、商品与完整字段语义 |
| `https://mc.mc520.top` | HTTPS TLS 校验通过；同一账户路径 HTTP 200，code=1001、提示 X-APP-ID 不能为空 | 真实 V3 签名认证、账户、商品与完整字段语义 |

未收到可用的真实商户 API 凭据。所有成功认证、余额、商品读取和浏览器演示使用明确标记的本机合成协议夹具；真实站点认证及数据读取一律 **NOT_VERIFIED**。三个站点共享未认证错误不证明它们完整实现相同版本。没有修改生产 HTTPS 要求；HTTP 例外仍仅限 NODE_ENV=test、明确 origin 白名单和本机地址，不能作为正式配置使用。

补验需要：每个站点分别提供授权的 AppID/AppSecret（通过部署端安全配置，不写进仓库/报告/聊天）、API 权限和最终 HTTPS 基础地址，以及可核对的账户/商品/规格/模板样本。只允许账户、列表、详情三项只读认证联调。采购、幂等/查单恢复、扣费和售后实证须由后续⑥-2单独确定和授权，不能用本轮只读通过代替。

## 可重放验证

2026-10-24，本机专用 PostgreSQL 测试库的完整 `pnpm verify` 退出 0：金额 12 项、15 个 API 文件共 293 项、Chromium 共 55 项（主流程 49、备用品牌 1、SSR 3、开发预览 1、生产运行时品牌 1）全部通过。补充的生产构建供应商浏览器回归 2 项也通过，其中实际打开 SKU 页面验证只读连接不能取得自动履约入口。最终固定路径/HTTPS 传输保护补验 3 个文件 18 项通过，API TypeScript 构建通过。Lint 无错误，保留 52 条既有 Vue 格式警告；字体外网元数据告警没有导致构建或浏览器失败。

另以真实 Fastify 日志开启方式执行 7 项新 PostgreSQL 集成场景，捕获请求及失败日志并检查，未出现合成 V3 Secret、轮换后的 Secret 或旧 Bearer 明文。成功认证的证据均来自受控夹具，不代表真实商业站点验收。原始临时日志和截图在核对后清理，保留可重放测试、本文和最终提交的 Actions 日志。

- `apps/api/test/kayixin-customer-v3.test.ts`：独立签名向量、真实字节、中文/特殊字符、空正文、报价精度、分页、两种规格、六种填写项及级联扩展、畸形/缺失字段、认证、非法 JSON、重定向、超时、超大响应和固定只读路径。
- `apps/api/test/kayixin-readonly.integration.test.ts`：真实冻结 schema 向前升级、旧密文原样保留、V3 创建/版本/轮换、两协议重封装、密文不能跨协议解释、API 与 SQL 资格防绕过、测试/配置竞争、无目录/库存/资金副作用、权限与凭据不泄露。
- `apps/web/test/e2e/kayixin-readonly.spec.ts`：实际 Chromium 创建、协议固定、认证失败及修复、轮换、只读测试、余额/列表/详情、规格/级联模板、分页、文本转义、SSR、移动端宽度和重封装。
- `apps/api/test/external-api-delivery.integration.test.ts`：原 39 项履约与恢复场景继续执行，涵盖稳定操作/幂等键、超时与丢响应、历史凭据、重封装、真实 SIGKILL、租约晚到、混单、退款保护与旧查询恢复。
- `apps/api/test/http-json-v1.test.ts`：共用 DNS/IP 防线、混合 DNS 答案、解析超时与重新解析；原 CI 继续执行隔离无外网 TLS 验收脚本。

使用专用 `_test` PostgreSQL：`TEST_DATABASE_URL='<专用测试连接>' pnpm verify`。对应 main 提交 SHA、完整门禁实测数字和实际 CI 运行链接在交付回复记录；CI 创建或排队不算通过。此次改动不要求重跑与供应商接入无关的本地大文件性能基准或整套生产演练。
