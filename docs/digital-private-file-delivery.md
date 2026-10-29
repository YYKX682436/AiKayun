# 私有文件自动交付与安全下载

阶段⑤-3把数字商品文件接入⑤-2的不可变履约版本。它继续使用同一 `product_variant_fulfillment`、`product_variant_fulfillment_versions`、订单项快照、`order_item_fulfillment_attempts`、`order_item_fulfillment_deliveries`、库存预留/事件和 `startDigitalDeliveryWorker`。新增前向迁移为 `202610210005_private_file_delivery`；不新建订单、支付、履约或下载授权状态机。

## 存储边界与格式

`PRIVATE_FILE_ROOT` 是绝对路径，默认位于仓库之外的 `$XDG_DATA_HOME/aikayun/private-files`。配置启动检查会拒绝相对路径、仓库内路径以及与公开 `MEDIA_ROOT` 相同或互相嵌套的目录。Compose 通过独立 `private_files` 命名卷持久化它，并由一次性 root 初始化容器把挂载根目录交给非 root API 用户。公开商品图继续留在 `product_media` 卷。私有对象不进入 web 静态目录、公开图片路由或 CDN。

⑥-2A在同一私有卷中增加隔离的 `purchase-attachments/` 子目录，但附件不属于本文件的数字商品交付对象；本文件的 `private-files:check/repair` 不会扫描或删除该命名空间。购买图片模型、授权与独立 `purchase-drafts:check/repair` 见[本地填写模板与私有草稿基础](purchase-form-preparation-6-2a.md)。

服务端当前限制单文件最大 **100 MiB**，每个 API 实例最多同时处理 4 个上传。允许 ZIP、PDF、UTF-8 TXT/Markdown/CSV/JSON、PNG/JPEG/WebP/GIF、MP3 和 MP4；需要解码的图片限制为最多 1600 万像素。服务端不信任浏览器 MIME 声明：按扩展名和内容结构检查格式，拒绝空内容、扩展名与文件头不匹配、无效 UTF-8、缺少 ZIP 目录结束记录、缺少 PDF 结束标志和无法完整解码的图片。大文件通过 Node 流式写入和 SHA-256 计算，不以整个文件缓冲区入内存。磁盘文件名由随机 UUID 生成；上传名只作受限元数据，展示名单独保存并检查危险控制字符和格式扩展名。

对象布局为 `objects/<UUID前两位>/<UUID>.bin`，临时状态留在 `.staging/<UUID>.part`。目录与文件不跟随符号链接，使用独占创建、不覆盖硬链接发布、文件/目录 `fsync`、只读权限以及打开句柄 inode/根目录复验。发布顺序是：先写 `uploading` 行和临时文件；完整写盘、内容校验与摘要完成后原子发布对象，再把数据库行改为 `staged`。失败时清理对象并保留可识别的失败状态。上传结果本身不能销售。

固定文本⑤-2存于数据库时继续使用已有密钥环加密。⑤-3不再加密整文件副本：文件已经限制访问到独立受权限保护的私有卷，逐块静态加密会引入新的密钥托管/轮换契约、分块 AEAD 索引、随机 Range 读取和恢复依赖。首版选择由部署主机/云盘提供卷级静态加密，并要求备份介质也加密、密钥在部署平台外单独保管；不得把云盘密钥或备份密钥提交给仓库，也不要在生产初始化应用文件密钥。若目标存储不能提供卷级加密，应先为该主机配置加密块设备/加密卷再启动 Compose。TLS 保护传输，不替代静态加密。

## 文件对象、版本和可售原子边界

上传校验后的 `private_file_objects` 保存随机 ID、上传展示名、MIME、字节数、SHA-256 与有限状态。对象 ID 不是下载凭据。文件版本扩展⑤-2同一版本表，以 `method='file'`、`private_file_object_id`、展示文件名和 SHA-256 关联对象；文件不复制到数据库或订单。对象元数据与版本创建后不可修改，已被任一 SKU 版本引用的对象和版本都不能删除。商品复制会沿用原商品内容/公开媒体规则，但不复制私有文件、履约配置或启用资格。

保存新版本先完整校验已落盘对象，再在 PostgreSQL 事务中把对象从 `staged` 转为 `available`、追加同一版本表记录、改 SKU 当前版本并强制暂停新销售。SKU 的原 `configuration_revision` 会随触发器递增。商家必须重新核验摘要并明确启用；数据库拒绝启用缺失/不可用对象、未启用或退役 SKU、非数字商品或不受支持的库存模式。每次新报价都会检查对象路径仍位于私有根目录、文件是普通文件且 inode/大小与元数据一致；检测到丢失或尺寸异常时，报价暂停当前版本销售并递增修订，让此前报价不能继续下单。完整 SHA-256 在上传、保存、启用、自动交付和每次下载时校验，报价快速检查不重复读取整个大文件。

无法把文件系统和 PostgreSQL 做成一个物理原子提交，所以系统只允许按安全方向推进：

1. 文件尚未完整写盘时，数据库最多只有 `uploading` 行，不可关联版本或销售。
2. 文件已经发布但数据库状态更新失败时，它仍是未售文件；过期上传/孤儿检查可安全回收。
3. 保存版本的数据库事务失败时，对象仍保持可重试的暂存状态，不存在可售版本。
4. 只有已完整落盘并重新 SHA-256 校验的对象，才进入版本保存事务；保存版本仍默认暂停。
5. 销售启用会完整核验文件；新订单报价会重新核验对象路径、inode 与大小，无法读取时暂停销售；下单事务原子绑定版本 ID。

崩溃恢复由 `pnpm private-files:check` 和 `pnpm private-files:repair` 提供。检查报告只输出计数，不输出磁盘路径、对象内容、下载令牌或顾客信息。修复重新校验所有已引用文件；文件缺失/损坏时将对象状态标记并暂停相应当前 SKU 的自动销售。只有超过 24 小时且没有任何历史版本引用的失败/暂存对象与生成孤儿文件可以清理。已引用文件只能在磁盘恢复同一摘要后重新标记可用，不能被清理器删除。

## 自动交付与支付/库存

原 `startDigitalDeliveryWorker` 按订单项快照 `fulfillment_content_version_id` 读取文件，不使用 SKU 最新版本。它在原有订单锁、订单项锁、库存/支付检查和 `SKIP LOCKED` 多实例领取流程中，先对打开文件的只读句柄完成大小、inode、根路径和完整 SHA-256 校验，再写一条共享履约尝试和每件一条文件版本引用交付。交付行没有文件字节、密文副本或公开 URL。PostgreSQL 成功触发器再次要求 `processing`、零元或足额按时付款、无未决支付/开放对账，并检查交付数量、订单绑定版本、对象状态和摘要。

成功表示商城已把受保护的订单下载授权写入历史，不表示顾客已经实际下载。数量为 N 时记录 N 个 `unit_index`；`quantity` 库存通过原消费事件扣减，`unlimited` 不产生数量库存事件。文件暂时缺失/损坏则记录失败尝试、暂停受影响的新销售并退避重试，不会回滚收款回执。重启会重新扫描仍在 `processing` 且未成功的订单。SKU 替换/暂停、商品归档或退款不会改变旧订单绑定和交付历史。

## 订单下载授权

顾客订单详情只在成功交付行上显示名称、大小和专用受保护入口；不返回存储路径、对象 ID、签名永久链接或文件内容。下载接口为：

- `GET` / `HEAD /api/v1/customer/orders/:orderId/items/:itemId/deliveries/:deliveryId/file`
- `GET` / `HEAD /api/v1/guest/orders/:orderId/items/:itemId/deliveries/:deliveryId/file`

每次请求从真实服务端订单、顾客会话或游客 Cookie、订单归属、已履约单位、成功尝试、订单版本快照、不可变文件版本、对象元数据、已确认付款和对账状态重新授权。仅知道订单、项或交付 ID 不足以下载；顾客和游客身份不能混用。商品 ID/文件对象 ID 没有下载路由。`HEAD` 同样做全部授权和完整 SHA 校验，不产生下载成功记录。`Range` 仅接受单一字节范围；成功校验后才返回正确的 `206` 与 `Content-Range`，不支持/无效范围返回 `416`。授权通过前不会有重定向、静态 URL、条件缓存或 CDN 内容。

响应使用 `Content-Disposition: attachment`，包含 RFC 5987 UTF-8 文件名；设置 `private, no-store`、`nosniff` 与 `Accept-Ranges: bytes`。响应从已验证的文件句柄流式读取，不把完整文件装入 Node 内存。文件缺失或摘要不符时返回明确安全失败并将文件状态记为缺失/损坏，不发送部分内容或伪报成功。顾客可在订单页重新下载；下载中断不会改变履约历史。

## Compose 备份、恢复与运维

Compose 的 `private_files` 命名卷与 `product_media`、`postgres_data` 分开持久化。只重建容器不会删除这些卷；不要在需要保留数据时执行 `docker compose down -v`。部署根目录的 `.env` 应显式设置 `PRIVATE_FILE_ROOT=/var/lib/aikayun/private-files`，并保持该路径独立于 `MEDIA_ROOT`。

`scripts/backup-compose-data.sh BACKUP_ROOT` 会停 API，在同一静止窗口导出 PostgreSQL、公开媒体、私有文件和独立安装身份目录，写入 `aikayun-compose-backup-v3` 清单及各归档 SHA-256 校验后恢复 API。身份归档包括 Ed25519 PKCS#8 私钥，备份应保存在访问受控、静态加密的异地介质中，解密材料单独托管。测试恢复使用隔离 `_test` 项目和完整 v3 配对备份，不要把恢复脚本用于生产。建议定期在独立测试 Compose 项目执行：

```sh
COMPOSE_PROJECT_NAME=aikayun-private-restore-test \
POSTGRES_DB=aikayun_private_restore_test \
PG_PORT=15433 HTTP_PORT=28080 HTTPS_PORT=28443 \
docker compose up -d --build

ALLOW_TEST_DATABASE_RESTORE=YES \
scripts/restore-test-compose-data.sh /secure/backups/20261021T120000Z

docker compose exec -T api node dist/media/private-file-reconcile-cli.js --check
```

恢复脚本仅接受 `_test` 数据库、`test`/`restore` 项目、完整 v2 备份、校验通过的三个归档及项目专属媒体/私有文件卷。恢复后要求检查器报告全部历史对象已验证，再登录顾客订单下载历史文件并对下载字节做 SHA-256 对比；仅仅看到版本元数据或目录文件名不够。出现缺失/损坏时先从同一备份恢复整组 PostgreSQL/媒体/私有文件，不要仅恢复数据库或覆盖包含较新订单的数据卷。

`private-files:check` 只读核验当前对象；`private-files:repair` 只修复状态、暂停损坏版本的当前销售，并清理超过 24 小时、已确认无历史引用的孤儿/暂存文件。没有未解决问题时再次检查应报告 `needsAttention=false`；仍缺失或损坏的历史引用会继续报告 `needsAttention=true`，必须先从完整备份恢复同一摘要的文件。修复工具不删历史对象，也不重新开启销售；管理员应在后台核对摘要并明确启用。

⑤-3 不初始化生产密钥、不迁移生产文件、不部署生产，也不进入⑤-4。

## ⑤-5全局交叉验收

全局状态图、退款与履约串行保护、真实SIGKILL、跨密钥去重、文件性能、账实核对SQL及数据库/文件一致恢复见[数字履约全局验收](digital-fulfillment-acceptance.md)。退款后保留历史交付及授权读取；进行中或未知履约阻止新退款动作，活动退款及已退款事实阻止新交付。本地交付与供应商网络轮询各自推进，复用同一 worker 和数据库历史。
