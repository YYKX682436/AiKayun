#!/bin/bash
set -euo pipefail
umask 077
backup_dir="$HOME/Library/Application Support/AiKayun/Store Backups"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
temporary=$(mktemp "$backup_dir/.incoming.XXXXXXXX")
trap 'rm -f "$temporary"' EXIT
# The same lock as the customer backup command prevents copying an incomplete set.
/usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 myshop-prod \
  'sudo -n /usr/bin/flock -s -w 600 /run/lock/aikayun-install.lock /usr/bin/bash -c '\''test "$(systemctl show -p ActiveState --value aikayun-backup.service)" = inactive && test "$(systemctl show -p Result --value aikayun-backup.service)" = success && exec /usr/bin/tar -C /var/lib/aikayun-backup -cf - repository publications journal'\''' > "$temporary"
/usr/bin/tar -tf "$temporary" >/dev/null
if [[ -f "$backup_dir/current.tar" ]] && cmp -s "$temporary" "$backup_dir/current.tar"; then
  printf '%s 服务器上的备份没有变化。\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
  exit 0
fi
if [[ -f "$backup_dir/current.tar" ]]; then
  mv -f "$backup_dir/current.tar" "$backup_dir/previous.tar"
fi
mv -f "$temporary" "$backup_dir/current.tar"
printf '%s 已同步服务器上的加密备份。\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
