# ⑦-1A：后续开发接口、验收与运维问题清单

状态：本阶段交接契约，不是开工授权。⑦-1A完成后停止，等待用户验收；不得自动进入⑦-1B。本文件按本轮设计给出⑦-2～⑦-7的建议责任分组，后续具体任务命名以用户开工指令为准，所有列项最晚在⑦-7商业交付前关闭或由用户明确接受限制。

配套：[审计证据](./production-code-audit-7-1a.md)、[发行架构](./production-release-architecture-7-1a.md)、[协议与状态机](./license-protocol-7-1a.md)。代码证据基线 `5cf764d575549bb32b95e513c4c0b424e72d24a0`。以下模块、表、API均是拟开发接口，当前仓库不存在对应正式授权实现。

## 1. ⑦-1B：独立授权协议基础

### 1.1 交付边界

独立私有授权中心项目：license、订阅权益事件、单实例激活、challenge/持钥证明、lease签发、状态回执、操作幂等查询、撤销/恢复、正常迁移/灾备、受审校时、签名key/trust轮换、管理员认证与审计。项目位置、正式中心域名和生产秘密托管在实际开工时绑定；本轮不创建仓库或生产凭据。

商城侧仅实现基础：安装身份/DB binding、协议契约和验签、状态投影、单调水位与校时epoch、续签调度、管理员只读状态/激活恢复接口。基础模块不修改订单、支付、退款、发货，不把模拟中心接成正式服务。⑦-1B不能宣称已保护生产新订单，业务准入留到⑦-1C。

建议模块与函数归属：

| 项目/模块 | 接口 | 必须保证 |
| --- | --- | --- |
| 独立中心 contracts | v1 HTTP请求与多种JWT typed schema | 算法/typ/issuer/aud隔离，未知schema拒绝 |
| 中心 activations/entitlements | `activate/renew/revoke/restore/prepareTransfer/commitTransfer/disasterTransfer` | license行锁、部分唯一索引、generation/revision递增、只追加审计 |
| 中心 protocol | RFC9421/RFC9530验证、challenge、`queryOperation` | 单nonce、同operation摘要幂等、请求/响应绑定、超时未知恢复 |
| 中心 signer/trust | `signLease/signStatus/signTransfer/signTimeReset` | 标准JWS，签名用途分离、固定kid，生产私钥不进商城 |
| 商城 `src/licensing/contracts.ts` | 内部Snapshot/Evidence/Decision类型 | bigint字符串、时间半开区间、严格schema |
| 商城 `identity.ts` | `loadBinding/checkIdentity/stageRecovery` | 缺失不自动覆盖，DB/文件/key匹配；唯一父表`local_license_operations`与逐attempt子表可恢复 |
| 商城 `evidence.ts` | `verifyAndProjectEvidence` | `jose`严格验证，last-good保留，旧证据不回滚 |
| 商城 `state.ts` | `persistLicenseEvidence/getLicenseSnapshot` | 事务内重读当前投影、水位与拒新优先级；不锁订单 |
| 商城 `renewal.ts` | `startLicenseRenewalWorker` | API内定时/DB选主、超时退避、状态不影响旧worker |
| 商城 `recovery.ts` | `applyActivationTransfer/applyTimeReset` | pending操作+签名回执、epoch/代次提升授权、文件DB可恢复切换 |
| `packages/contracts` | 脱敏admin状态与public commerce-status | 不暴露密钥/token/中心内部字段，不接受客户端投影 |

锁序统一：旧业务锁保持原序；需要准入时再取 `installation_binding FOR SHARE → instance_license_state FOR UPDATE`。普通证据提交同序，恢复流程取binding UPDATE→projection UPDATE→pending；这些授权写方禁止反向获取业务对象锁。每条路径必须给出实际锁图与PG并发用例，不能仅靠TypeScript类型承诺一致性。

### 1.2 验收标准

| 编号 | 必须验证的情形 | 可验收结果 |
| --- | --- | --- |
| B01 标准互操作 | 标准Ed25519 JWS和HTTP签名测试向量、Node24和固定依赖实际签验 | 正确向量通过；bit改动、错误曲线/算法、none/HMAC/重复key/未知crit/jku等全部拒绝 |
| B02 信任隔离 | 测试/生产issuer、aud、typ、kid交叉；缺公钥/轮换/泄露吊销 | 不混用；常规退休不提前废缓存；受信bundle单调且不下载任意URL |
| B03 激活竞争 | 同license两个实例并发、同instance激活不同license、同操作重放/改body | 中心最多一条active；同请求同结果，冲突409，不产生双代次 |
| B04 权益边界 | 月末、闰日、提前/到期后续费、重复支付事件、now==end | 中心端精确账期；事件不重复延长；exp永不越end/7天 |
| B05 网络故障 | 失联1h/6d/7d、剩余订阅不足7d、坏签名403/429/5xx/超时 | last-good仅剩余窗口可经营；无可信证据不延长、不伪撤销 |
| B06 乱序/回放 | 旧lease晚到、同iat不同jti、撤销后重放active、旧generation/query | 事务内比较水位；旧许可不覆盖拒新；普通renew不能升代次 |
| B07 身份 | 重建容器、换域名、复制DB缺key、替换身份、完整复制 | 正常保持；不匹配禁新且历史不受license禁用；明确承认完整离线复制限制 |
| B08 时钟 | 回拨、进程重启、水位文件失败、跳未来后校时 | 不延长；异常禁新；仅受审time-reset升epoch可解除未来水位锁定 |
| B09 迁移恢复 | 正常ticket、旧机死、身份丢失、commit丢响应、DB/文件每步强杀 | generation唯一升代，签名重绑保留database_id/业务UUID，journal幂等补写；旧机不可普通renew获新代次 |
| B10 协议故障 | nonce过期/重复、签名目标URL改写、大body、TLS不可信、签名时间失准 | 拒绝且不改权益；signed challenge可校准请求时间但不授经营许可 |
| B11 秘密与日志 | 全流程请求/异常/诊断/浏览器资源扫描 | 无私钥、activation code、raw JWT、业务凭据/个人数据泄露 |
| B12 激活崩溃恢复 | 中心commit activation/code消费后丢响应；商城强杀于发送前、响应返回前、响应保存后、投影commit未知 | 恢复本地operation；中心返回原结果；code只消费一次、generation只增一次；投影jti读回后才清密文 |
| B13 续签崩溃恢复 | pending先提交后强杀；中心已commit但商城未保存lease；商城证据事务commit未知 | 原operation续接/查询；lease仍有效则按原凭证恢复，过期则只作历史证据并走新恢复operation；revision不回退、不重复权益操作 |
| B14 nonce过期与迟到请求 | 原请求未提交且nonce过期，取新challenge续接同operation；旧请求和新请求并发争同一operation advisory锁 | 旧请求仅可终态一次；后到者回放终态，旧事务回滚后新attempt可继续；一次not_found不作围栏 |
| B15 状态与围栏 | operation committed/rejected/cancelled、锁等待中的in-flight观测、瞬时not-found/unknown，重复激活码与过期签名 | 持久状态只有三种不可逆终态；in-flight非DB状态；未知沿用原op；新attempt只更新nonce/签名/时间，intent固定；cancel原子墓碑不可复活 |
| B16 database_id错配 | DB dump与实例身份文件/签名claims/中心activation分别错配及合法恢复 | 任一不一致进入identity_mismatch、拒新；合法transfer按binding_revision恢复，历史义务继续 |
| B17 中心终态认证边界 | 未认证身份/坏HTTP签名、过期nonce、5xx、确定性业务拒绝、commit后重放、取消与迟到请求并发 | 未认证请求不触碰操作表；retryable失败不终结；确定性拒绝/成功与attempt同事务落终态；墓碑不可更新/删除/复活 |
| B18 已提交激活长期恢复 | activation/code已commit；商城丢失响应并强杀；原lease过exp后带原operation、nonce/digest和当前PoP恢复；分别注入订阅过期、撤销、generation替换 | 旧lease只存档；有效权益下签发新的恢复凭证且不重激活/耗码/增generation；任何拒新事实均无新lease并保持历史义务 |
| B19 本地pending一致性与密钥灾备 | 激活请求发送前强杀；恢复同一DB操作表与pending密钥备份；分别缺密文/缺key/错误key恢复 | 父操作状态唯一、attempt行有FK且次序可恢复；匹配备份才能核对原nonce/digest并续接；缺key时fail-closed，不误判未发送、不新建操作 |

R2协议收口的确定性测试计划（全部未来⑦-1B/1C实现，不在⑦-1A创建假运行时）：

1. **中心激活已提交、本地响应丢失并强杀：** 中心断言activation、code消费、generation、`license_operations=committed`及attempt在同一事务各一次；杀商城进程后由同一`local_license_operations.operation_id`新challenge续接，核对中心原request_nonce_hash/request_digest/jkt/kid及返回历史原结果，不再消费码；若lease已过exp，绝不投影为经营许可。
2. **原操作未提交、nonce过期后恢复：** 让原nonce超时且原业务事务回滚，旧请求不得建立终态；使用新challenge及递增attempt_no，保持operation_id/intent_digest/业务payload不变后续接成功；码/代次只变一次，不因一次`not_found`另建operation。
3. **原请求迟到与新挑战并发：** 门闩分别控制旧请求/新attempt争取同一operation advisory锁；穷举旧先commit、旧rollback、新先commit、cancel先commit。最多一个终态和一个业务效果，后到请求只重放结果，墓碑不能被复活。
4. **中心成功、本地证据事务提交未知：** 中心先commit并返回；商城投影事务真实提交后模拟连接确认丢失，重启读取jti/operation后幂等确认；再覆盖实际rollback分支，由原attempt恢复；不得产生第二activation/generation，也不得在结果未知时删pending。
5. **数据库与实例身份错配：** 对安装binding.database_id、中心activation.database_id、签名claims.database_id逐一和组合篡改；普通续签及恢复凭证均拒绝新经营。认证失败不得终结目标operation；获准transfer只可按签名receipt切binding并保留业务database_id。
6. **过期授权下v2附件预检与幂等重放：** 已完成订单的相同key/hash在预检前原样重放；新key含大附件必须在归档/写prepared之前轻量预检拒绝；预检后并发过期仍由最终数据库事务拒绝；确认无多余prepared文件且unknown-commit附件保持原保护语义。
7. **pending密钥配对恢复：** 对含未完成activation pending和本机AES key的同一备份点完整恢复，验证原attempt证据可解密并续接；分别移除/替换key，确保fail-closed、保留记录、不把操作当未发送，并给出安全诊断而不泄漏密文。

测试只用隔离中心/临时测试key和`_test`库；生产构建无可切换的绕过入口。不得把测试key加到生产trust bundle，不能用真实客户license验收。中心生产管理面、安全备份、托管与告警仍需后续发行运维门禁，不因B阶段测试通过而直接上线。

## 2. ⑦-1C：精准经营准入与历史义务验收

### 2.1 接入清单

仅允许在已实现B接口基础上改两处新经营事务及对应产品提示：

1. `apps/api/src/commerce/orders.ts` 的v2轻量预检须位于owner/idempotency锁及同key/hash重放之后、购买附件昂贵归档之前；非权威投影检查只用于避免失效实例制造prepared孤儿文件，不能拒绝已有幂等订单。最终 `createOrderTransaction` 仍在原owner/幂等返回和原有有序锁/报价验证之后、`orders INSERT`之前取得权威准入，所有retry重新检查。legacy/v2/零元/游客/顾客全部覆盖。
2. `apps/api/src/payments/routes.ts` 的 `createTopUpAttempt`：原customer/wallet锁和同key返回之后，新充值INSERT之前调用准入，拒绝时无attempt/secrets/provider_state残留，更不能出站发起支付。
3. 新拒绝错误稳定返回403，状态不可读503；同key同hash旧结果优先，原hash冲突仍409。前后台显示通用停购和管理员诊断，不能用全局写middleware/停API或停worker实现。

`createOrReuseAttempt`、`createOrReuseWalletOrderPayment`、`recordWalletOrderPayment`、DB `resolve_order_wallet_hold`、收款触发器、refund/withdrawal及所有履约链路不加拒新gate。原订单付款可产生新的attempt，原订单交付可产生新的supplier operation；都是历史义务。将来批量下单、导入订单或其他新销售入口必须重新审计并接入同一事务接口，不能只靠这两个函数名长期覆盖新功能。

首版接受决策点线性化，准入事务可在截止后短暂commit，明确上限与测试。不得用进程内缓存boolean作为事务权威；不得在事务内HTTP请求中心。局部投影状态变化与时间截止都要在锁后fresh clock检查。

### 2.2 实际数据库与故障验收

| 编号 | 场景 | 不变量 |
| --- | --- | --- |
| C01 新订单 | active/offline_valid可创建，其余状态legacy/v2/零元/全部商品类型拒新 | 无新增订单项、库存预留、交付、冻结采购来源；已准备附件按原未知提交保护回收 |
| C02 幂等 | 原订单/充值成功后到期再同key重放，不同payload重放 | 原结果稳定；不重复出站/落账/预留；冲突409不变 |
| C03 新充值 | 到期前后并发、状态锁等待跨期、相同顾客多个key | 锁后按fresh时间判定；拒绝无新attempt/凭据/账本/外网调用 |
| C04 旧订单付款 | 到期后原deadline前首付/重试外部、钱包、组合，零元旧单自动交付 | 保留原可付期限和业务约束；不因license到期拒绝；过原期限按原规则处理 |
| C05 旧资金证据 | 请求发出/响应未知跨期、回调重复/迟到、query冲突、通道轮换 | 原凭据/原商户号、exactly-once、late/excess/mismatch与对账保护不变 |
| C06 退款/提现 | 到期后新建申请、审批、unknown打款核实、重复resolve | 允许清偿；不双退/双打；礼金不可提现、冻结与结果唯一约束不变 |
| C07 履约 | 到期后首次卡密/固定/文件/旧http_json API交付、人工发货、超时重查 | 原付款/退款/库存冲突保护、lease/fence/同原单位幂等不变 |
| C08 历史读取 | 到期/撤销/失联后顾客/游客内容、资料、Range/HEAD下载 | owner/付款/冻结版本/SHA校验不变；无越权，不因license移除历史访问 |
| C09 竞争 | 撤销更新先/后于交易锁，两个API进程、重试、transaction timeout/rollback | 只有线性化点许可者提交；旧响应不回滚；无新死锁或全局业务冻结 |
| C10 中心断网 | 中心DNS/TLS/5xx/超时、续签进程崩溃 | 每笔订单无中心请求；未到窗口继续，过窗口禁新；所有旧worker仍运行 |
| C11 强杀/恢复 | 准入后commit未知、v2附件复制后拒新、恢复旧备份 | 重放先查实际结果；不双单/丢附件；恢复核对中心水位后才新经营 |
| C12 采购关闭 | 完整回归卡易信read-only、selector恒空、TST预算、无dispatcher | 生产采购保持关闭，许可active也不能开启 |
| C13 v2预检与幂等 | 到期状态已有key/hash重放；新key含附件；预检期间授权失效并发请求 | 已有订单原样重放；新单在复制/写prepared前提示拒绝；绕过预检仍被最终事务拒绝；无效孤儿不增长 |

必须同时运行原资金/库存/履约PG集成、既有真实SIGKILL恢复和浏览器关键流程。新增测试要能证明业务边界与竞争结果，不能只有mock状态机。CI记录对应精确commit，不用其他阶段绿灯替代。不得连接真实商户做这个阶段的验收。

## 3. ⑦-2～⑦-7必须完成的运维问题

| ID/优先级 | 建议阶段 | 必须交付/关闭证据 |
| --- | --- | --- |
| O01/P0 | ⑦-2 发行 | 独立HTTPS/OCI渠道；SemVer不可覆盖；manifest全digest、每平台测试、签名/SBOM/依赖审查；客户无GitHub/源码/编译工具仍能安装 |
| O02/P1 | ⑦-2 制品 | 实际扫描API/Web镜像层，审定runtime文件白名单、无秘密/测试夹具/公开map，闭源及第三方NOTICE边界明确 |
| O03/P1 | ⑦-2 配置 | 生产schema预检、secrets _FILE互斥加载、API/web权限分离、历史key inventory、迁移/业务DB角色最小权限 |
| O04/P0 | ⑦-3 安装 | 一条命令、签名工件验证、HTTPS setup单次token+并发锁、防首访抢管理员、失败resume、已有数据不被重装覆盖 |
| O05/P1 | ⑦-3 网络 | DNS/ACME/80/443/代理信任边界、Secure Cookie、同源配置、测试overlay拒绝、端口/容量前置检查 |
| O06/P1 | ⑦-4 健康 | schema/key/file诊断，worker last-tick/last-success/backlog/oldest unknown，授权状态独立于live/ready；支付unknown/冻结款有明确告警与人工查单SLA |
| O07/P1 | ⑦-4 日志 | API/Caddy/BFF回调query脱敏、日志轮转/保留/导出、request/operation关联、诊断不含secret/个人数据；公开OpenAPI策略 |
| O08/P1 | ⑦-4 回收 | media/private/draft/order附件check与repair分开、≥24h宽限、staging/prepared/deleting排程、retained缺失只报告；磁盘不足不会误删历史 |
| O09/P0 | ⑦-5 备份 | DB+公开/全部私有卷+全部历史业务key+身份/配置/release/trust完整backup set；静止所有写者；加密异地备份、独立解密key托管和保留策略 |
| O10/P1 | ⑦-5 升级 | migration checksum/精确schema兼容矩阵，部署排他锁，停写/备份/失败保持边界；不自动down、不混PG主版本升级、不用旧备份覆盖新资金事实 |
| O11/P1 | ⑦-5 迁移 | 单执行者停旧/切流流程；域名变更的旧回调兼容；未决支付/采购/提现清单、原凭据与原幂等号恢复，不误认license fence为外部资金fence |
| O12/P0 | ⑦-6 灾备 | 隔离恢复完整历史解密/文件SHA/账实核对；从每个强杀点补写身份/代次/校时epoch；旧机未死的双执行处置；灾备环境无真实出站 |
| O13/P1 | ⑦-6 故障 | 中心长期失联/密钥泄露轮换/错误时钟/磁盘满/DB断连/慢供应商/回调积压演练，记录RPO/RTO实测及未达项，不空填承诺 |
| O14/P1 | ⑦-6 容量 | 两平台生产负载、DB锁等待、授权单例gate吞吐、下载完整摘要成本、worker积压/内存/磁盘容量，给支持范围 |
| O15/P0 | ⑦-7 交付 | 新机端到端安装→激活→经营→到期→历史义务→续费→升级→迁移→恢复，客户仅发行包；每一门禁有精确版本证据 |
| O16/P0 | ⑦-7 商业上线 | 中心账号/签名key托管和恢复责任、软件/第三方条款、支持/撤销/订阅到期文案、支持版本/回滚窗口明确；卡易信仍标未开放，未验证商户能力不得营销为已支持 |

所有P0是商业交付阻塞，P1也是正式生产运维门禁；P2可由用户明确接受有限首发范围，但不能无声遗漏。问题清单是本轮审计的后续工作，不授权本轮自动实现。

## 4. 本轮完成定义

⑦-1A仅交付真实代码审计、发行规范、标准签名/实例身份/状态机、时序、交易准入矩阵、B/C接口验收和运维问题。检查仅限静态、文档一致性和必要非侵入验证；不建立生产环境、客户license、签名私钥或授权测试绕过。提交推送main后核对精确HEAD、工作区和对应CI，CI未完成明确报告；完成即停止。
