# ⑦-1A 非侵入验证记录

日期：2026-10-28（Asia/Shanghai）。代码审计基线 `5cf764d575549bb32b95e513c4c0b424e72d24a0`；开始时main工作区干净，执行 `git fetch origin main` 后确认 `HEAD == origin/main`。文档中的代码行号均指此基线，架构概览新增设计索引后会有行号位移。

## 实际执行

| 项目 | 命令/方法 | 实际结果 |
| --- | --- | --- |
| 仓库与指令 | `pwd`、根AGENTS、`git status --short --branch`、fetch/log/rev-parse | 路径正确，最新main为上述SHA，无起始未提交改动；未读取真实.env |
| 目录与调用链 | rg全仓目录；源码逐行读取；搜索orders/payment_attempts TS与SQL写入、路由、worker启动、DB约束/触发器 | 基线509个跟踪文件；三条并行审计分别复核部署/SSR、资金入口、履约采购；证据已归档到正式审计文档 |
| 标准核实 | 查阅RFC 7515/8037/8725/7638/9864/9421/9530、维护方jose支持说明及Docker/PG官方文档 | 确定标准JWS/JWT + Ed25519标识与HTTP签名配置，链接保存在协议/发行文档；没有安装新依赖或生成签名材料 |
| diff格式 | `git diff --check`（提交前亦检查staged内容） | 通过 |
| 全仓lint | `pnpm lint` | exit 0；0错误、7条原有Vue格式警告，全部在未修改的 `apps/web/pages/products/[id].vue:1610,1631-1633`；未执行自动修复 |
| 现有备份/恢复脚本语法 | `bash -n scripts/backup-compose-data.sh scripts/restore-test-compose-data.sh` | exit 0；仅解析语法，没有执行脚本 |
| Compose静态解析 | `docker compose --env-file .env.example -f compose.yaml config --no-interpolate --quiet` | exit 0；显式使用示例env，不读取真实秘密、不启动容器、不连接Docker业务服务 |
| 文档证据与链接 | 临时内联Python校验正式审计中可解析的file:line引用存在且未越界、四份文档相对链接存在；人工复核关键语义 | 120处可解析代码引用和34处相对文档链接通过；同时修正架构概览两处原有相对链接。这是路径/范围及设计一致性校验，不是运行行为测试 |
| 交叉复审 | 对协议/发行/验收进行独立只读复审 | 补齐未来时钟水位恢复、签名challenge校时、乱序投影比较、key验证保留窗口、迁移重绑journal和短期ticket领取时机 |

本轮没有产品代码、迁移、依赖、Compose或秘密变更。未跑本地数据库集成、浏览器、构建、SIGKILL或备份恢复：本轮仅文档，避免制造额外运行状态。既有CI工作流包含这些回归，不代表本轮本地已运行。

## CI与提交核对

文档提交推送main后，以最终HEAD查询对应CI并在交付消息报告SHA、run链接及实际状态。本记录不预填CI通过；排队/运行中必须明确写未完成，其他commit的CI不能替代本提交。最终工作区与远端一致性、清理结果也在交付前实查。

## 临时产物和未验证边界

本轮临时审计文件位于 `/tmp/aikayun-7-1a-{commerce,fulfillment,deployment}-audit.md`，归档后已删除；内联验证脚本未保存，未产生构建/浏览器截图/录屏/DB测试卷。检查已有项目缓存/忽略文件，另清理根目录与DB目录两处无用.DS_Store，保留原有构建缓存；仅清理可确认无用的临时物，不删除原有.env、node_modules、持久业务文件或历史验收证据。

尚未验证：正式客户镜像/安装器/授权中心及运行时（均未实现）、客户许可和生产签名key（未创建）、生产DB/真实支付/供应商、两平台发行实物、完整生产备份和历史解密、并发授权gate/迁移重绑/校时协议的实际执行、生产RPO/RTO和负载。⑦-1B/1C与⑦-2～⑦-7的验收清单要求后续用隔离证据关闭。生产卡易信自动采购继续关闭，本轮没有新增真实采购能力。
