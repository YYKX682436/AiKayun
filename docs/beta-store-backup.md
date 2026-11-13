# 商城内测备份操作

> 当前状态：**尚未启用**。已安装的 `0.1.0-rc.14` 在初始化时拒绝项目自有 PostgreSQL 镜像，尚无正式完整备份。下面是已准备、待修复版本验证后启用的方案，不代表已完成配置或恢复演练。

本配置复用 `0.1.0-rc.14` 正式发行的备份入口。服务器 systemd 每天北京时间 **03:00** 运行 `sudo /opt/aikayun/aikayun backup create`；错过计划时开机会补跑。备份期间原有机制会短暂停止商城 API、Web 和 Caddy，Caddy 同时承载授权中心入口，因此两个公网入口都会短暂不可用。命令结束后原容器按原状态启动，保留现有 Caddy overlay。

服务器上的加密 Restic 仓库为 `/var/lib/aikayun-backup/repository`，配对记录和初始化记录分别位于同级 `publications` 与 `journal`；解密密码单独保存在 `/etc/aikayun-backup/restic-password`。临时数据写入单独的 768 MiB `noswap` tmpfs `/var/lib/aikayun-backup/staging`，该挂载由 systemd 管理。空间不足会导致备份失败，需要检查并处理；不要关闭 `noswap` 检查。授权中心数据库是独立数据库，不包含在商城备份中。

Mac 登录且联网时，用户级 launchd 每小时尝试复制；登录时也会尝试一次。复制通过 SSH 和现有部署锁，只有最近一次定时服务正常结束时才发布新副本；中途失败保留原副本。副本是整个加密仓库及其 `publications`、`journal` 的归档，分别保存在：

- `~/Library/Application Support/AiKayun/Store Backups/current.tar`
- `~/Library/Application Support/AiKayun/Store Backups/previous.tar`（有后续变化后出现）
- 解密密码：`~/.config/aikayun-store-backup/restic-password`（独立文件，权限 0600）

Mac 关机、未登录、休眠或网络不可用期间不能实时同步；恢复登录、唤醒和联网后会重试。因此每天的服务器备份不会保证当日立即出现在 Mac 上。Mac 的解密密码应另存到自己控制的加密介质；丢失密码将无法解密备份。仓库没有自动清理旧快照，需留意服务器 `/` 和 Mac 空间。

查看备份和同步状态：

```sh
ssh myshop-prod 'sudo systemctl status aikayun-backup.timer aikayun-backup.service --no-pager'
ssh myshop-prod 'sudo /opt/aikayun/aikayun backup list'
ssh myshop-prod 'sudo /opt/aikayun/aikayun backup verify SET_ID'
ls -lh "$HOME/Library/Application Support/AiKayun/Store Backups/"
tail -20 "$HOME/Library/Application Support/AiKayun/backup-sync.log"
```

如需手动创建并让下一次 Mac 同步识别该成功结果，使用 `ssh myshop-prod 'sudo systemctl start aikayun-backup.service'`。如果备份失败，应先查看 `sudo journalctl -u aikayun-backup.service`、现有 `backup list` 和服务状态；维护状态不明时不要自行删除 journal、暂存目录或快照。

## 恢复检查与限制

当前发行提供隔离恢复检查，不会覆盖线上商城：

```sh
ssh myshop-prod 'sudo /opt/aikayun/aikayun backup verify SET_ID'
ssh myshop-prod 'sudo /opt/aikayun/aikayun backup restore-plan SET_ID'
ssh myshop-prod 'sudo /opt/aikayun/aikayun backup restore-isolated SET_ID'
# 上条输出 RESTORE_ID；检查完成后只清除此隔离演练的资源：
ssh myshop-prod 'sudo /opt/aikayun/aikayun backup cleanup-isolated RESTORE_ID'
```

服务器副本损坏或丢失时，Mac 上的 `current.tar` / `previous.tar` 与独立密码是可搬迁的加密材料；应先保存原始副本，在兼容的 Linux/Docker 环境核对解密和快照。现有发行的 `restore-isolated` 仍依赖一套经过认证的安装环境，**没有提供生产原地覆盖或全新服务器一键灾难恢复命令**。不要把隔离恢复成功误认为已验证正式商城的原地恢复；真实灾难恢复需另行制定并验证操作方案。

服务器重启时还发现现有 `aikayun-license-relay.socket` 与 Docker 的启动顺序形成循环，导致授权中心入口返回 502。`deploy/beta-backup/aikayun-license-relay.socket` 使用原有监听地址并允许提前绑定，移除该循环；重启后的实际开机验证尚未完成。
