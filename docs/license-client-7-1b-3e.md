# ⑦-1B-3E：正常续签、自动续签与故障恢复

商城实施基线：`d5acdf5314b33b69c3431d07ee111ebefaee30b6`；互操作使用只读授权中心 `a5cf99439e3bf92b65f19d60c013bca088cf221a`。

## 实现与边界

- 正常续签使用中心 `/v1/leases/renew` 的 `kind=renewal`，复用安装身份、挑战、HTTP 签名、Trust Store、可信时间和既有 operation/attempt 加密账本。每轮使用新 operation；未知结果优先 query，只有签名 `not_found` 才对同一意图 continue。请求出站前持久化 attempt，结果经签名及原请求、身份、代次和修订绑定验证后才投影。
- 现有投影拒新证据增加中心签名 `expired`；旧 lease 不能覆盖到期或撤销水位，只有同代次、更高 revision 的合法 lease 可恢复，`superseded` 不能由普通续签解除。过期的已提交 lease 仅能作为历史事实结算原 operation，不能授予许可；其他 operation 的错误归档不会污染新结果。投影及续签结案在同一事务内完成，未知 COMMIT 按投影指纹及 operation 状态读回。
- API 内的轻量 Worker 基于签名 `renew_after` 和稳定抖动调度，在到期前留出一个轮询周期；通过 PostgreSQL 会话锁协调实例，先恢复未完成操作，在请求签名时间锚前持久预约有界退避，到期或撤销后低频检查。续签前核验安装身份、当前 Trust Store、签名时间锚及 3D-2 时间水位；停止时等待进行中的工作。网络请求不进入商城业务事务。短 lease 的实际续签完成时间仍取决于调度与网络，绝不延长原许可截止。
- 沿用 3D-2 文件先于数据库的时间水位与故障关闭规则，以及 v5 密钥/数据库配对恢复检查。未引入授权状态表、额外服务、公开 API、经营门禁或中心修改；订单、支付、退款、提现、履约与下载逻辑未改动。

## 验证

定向测试使用独立 PostgreSQL 18 和冻结中心 HTTPS，覆盖正常及连续续签、相同 revision、新 revision、旧 lease 过期后续签、订阅到期和续费恢复、撤销与 superseded、签名和绑定错误、重放、429/503/断线/超时、提交后丢响应、query/continue、多个实际 SIGKILL、未知 COMMIT、双 Worker、退避与停止、Trust Store 更新及 signer 吊销、时间水位和 v5 配对恢复。

- 最终冻结中心互操作及 operation store 回归：130/130 通过。
- 最终 `pnpm verify`：lint、类型检查、生产构建通过；money 16/16，API/PostgreSQL 547 通过、117 跳过；浏览器主套件 93/93，备用品牌 1/1、SSR 错误 3/3、开发预览 1/1、生产品牌 1/1。lint 保留商品详情页既有 7 条 Vue 格式警告。授权中心相关跳过用例另由上面的独立互操作套件执行。

旧投影若依赖的历史 query 外层回执 signer 已被吊销，且没有待恢复 renewal，现有证据无法证明该回执在密钥失效前产生；自动新建续签保持 fail closed。已有 pending 仍可按当前信任配置验证并恢复。3D-2 已记录的协同回滚信任边界仍然存在；本阶段不实现时间重置、迁移、最终经营门禁或生产部署。完成后等待独立验收，不自动进入 ⑦-1C。
