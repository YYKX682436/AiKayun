#!/usr/bin/env bash
# Synthetic private directories and tmpfs inside a disposable container only.
set -Eeuo pipefail
set +x
umask 077
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/aikayun-fixed-paths.XXXXXX")"
cleanup() { python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1])' "$work"; }
trap cleanup EXIT
pnpm --dir "$root" exec esbuild apps/api/src/backup/fixed-backup-paths.ts --bundle --platform=node --format=esm --target=node24 --outfile="$work/paths.mjs" >/dev/null
cat > "$work/probe.mjs" <<'JS'
import { chmod, rm, symlink, writeFile } from 'node:fs/promises'
import { loadFixtureBackupPaths } from './paths.mjs'
const root = process.argv[2], pass = `${root}/credentials/restic-password`
await loadFixtureBackupPaths(root, 1024n * 1024n)
await chmod(pass, 0o644)
let failed = false
try { await loadFixtureBackupPaths(root, 1024n * 1024n) } catch { failed = true }
if (!failed) throw new Error('unsafe password mode accepted')
await chmod(pass, 0o600)
await rm(pass); await symlink('/etc/passwd', pass)
failed = false
try { await loadFixtureBackupPaths(root, 1024n * 1024n) } catch { failed = true }
if (!failed) throw new Error('symlinked password accepted')
await rm(pass); await writeFile(pass, 'fixture', { mode: 0o600 })
failed = false
try { await loadFixtureBackupPaths(root, 8n * 1024n * 1024n) } catch { failed = true }
if (!failed) throw new Error('insufficient staging space accepted')
process.stdout.write('fixed storage paths: valid, bad mode, symlink and insufficient space passed\n')
JS
image='node:24.22.0-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c'
docker run --rm --network none --cap-add SYS_ADMIN --user 0:0 --mount "type=bind,source=$work,target=/fixture,readonly" --entrypoint bash "$image" -c '
  set -Eeuo pipefail; umask 077
  base="/tmp/aikayun-75a-paths-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d " \\n")"
  mkdir -m 700 "$base" "$base/backup" "$base/credentials"
  mkdir -m 700 "$base/backup/repository" "$base/backup/journal" "$base/backup/publications" "$base/backup/staging"
  printf fixture > "$base/credentials/restic-password"; chmod 600 "$base/credentials/restic-password"
  printf "#!/bin/sh\\nexit 0\\n" > "$base/restic"; chmod 700 "$base/restic"
  mount -t tmpfs -o noswap,nosuid,nodev,noexec,mode=0700,size=4m tmpfs "$base/backup/staging"
  NODE_ENV=test node /fixture/probe.mjs "$base"
  umount "$base/backup/staging"
  if NODE_ENV=test node --input-type=module -e "import {loadFixtureBackupPaths as load} from \"/fixture/paths.mjs\"; await load(process.argv[1],1n)" "$base" >/dev/null 2>&1; then
    echo "ordinary disk accepted as staging" >&2; exit 1
  fi
  mount -t tmpfs -o nosuid,nodev,noexec,mode=0700,size=4m tmpfs "$base/backup/staging"
  if NODE_ENV=test node --input-type=module -e "import {loadFixtureBackupPaths as load} from \"/fixture/paths.mjs\"; await load(process.argv[1],1n)" "$base" >/dev/null 2>&1; then
    echo "swap-capable tmpfs accepted as staging" >&2; exit 1
  fi
  printf "%s\n" "ordinary and swap-capable staging rejected"
'
