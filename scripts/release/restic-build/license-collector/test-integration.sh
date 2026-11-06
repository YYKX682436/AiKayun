#!/usr/bin/env bash
set -euo pipefail
set +x
if [ "$#" -ne 4 ]; then
  echo 'Usage: test-integration.sh BINARY SBOM MODULE_CACHE arm64|amd64' >&2
  exit 2
fi
binary=$(cd "$(dirname "$1")" && printf '%s/%s' "$PWD" "$(basename "$1")")
sbom=$(cd "$(dirname "$2")" && printf '%s/%s' "$PWD" "$(basename "$2")")
cache=$(cd "$3" && pwd -P)
arch=$4
[[ "$arch" == arm64 || "$arch" == amd64 ]] || exit 2
source_dir=$(cd "$(dirname "$0")" && pwd -P)
work=$(mktemp -d "${TMPDIR:-/tmp}/aikayun-license-test.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
chmod 700 "$work"
go_image='golang@sha256:c65ecfe613b539ac74c62a4c3b2c27e8f8a6076384c8f27e8a3c0f3be17cc385'
docker run --rm --mount "type=bind,source=$source_dir,target=/source,readonly" \
  --mount "type=bind,source=$work,target=/work" -w /source "$go_image" \
  sh -ec 'go test -mod=readonly ./...; go build -mod=readonly -trimpath -o /work/collector .' >/dev/null
run_collector() {
  local source_sbom=$1 source_cache=$2 destination=$3
  local container_name="aikayun-license-${work##*.}-$destination"
  python3 - "$container_name" "$work" "$binary" "$source_sbom" "$source_cache" "$go_image" "$arch" "$destination" <<'PY'
import subprocess, sys
name, work, binary, sbom, cache, image, arch, destination = sys.argv[1:]
cmd = ['docker', 'run', '--rm', '--name', name, '--read-only', '--network', 'none',
       '--memory', '1g', '--cpus', '2', '--pids-limit', '64',
       '--mount', f'type=bind,source={work}/collector,target=/collector,readonly',
       '--mount', f'type=bind,source={binary},target=/binary,readonly',
       '--mount', f'type=bind,source={sbom},target=/sbom.json,readonly',
       '--mount', f'type=bind,source={cache},target=/cache,readonly',
       '--mount', f'type=bind,source={work},target=/output', '--entrypoint', '/collector', image,
       '/binary', '/sbom.json', '/cache', '/usr/local/go', arch, f'/output/{destination}']
try:
    sys.exit(subprocess.run(cmd, timeout=180, check=False).returncode)
except subprocess.TimeoutExpired:
    subprocess.run(['docker', 'rm', '--force', name], stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, timeout=15, check=False)
    print('collector timed out', file=sys.stderr)
    sys.exit(124)
PY
}
run_collector "$sbom" "$cache" good >/dev/null
python3 - "$work/good" <<'PY'
import json, os, stat, sys
from pathlib import Path
p=Path(sys.argv[1]); f=p/'license-evidence.json'; doc=json.loads(f.read_text())
assert stat.S_IMODE(p.stat().st_mode)==0o700 and stat.S_IMODE(f.stat().st_mode)==0o600
assert doc['modules']==80 and len(doc['licenses'])==119
assert all(x['path'] and x['sha256'] and x['content'] for x in doc['licenses'])
PY
python3 - "$sbom" "$work/bad-sbom.json" <<'PY'
import json,sys
p=json.load(open(sys.argv[1])); p['components']=[x for x in p['components'] if x.get('name')!='github.com/restic/chunker']
with open(sys.argv[2],'w') as f: json.dump(p,f)
PY
if run_collector "$work/bad-sbom.json" "$cache" bad-sbom >"$work/bad-sbom.log" 2>&1 || [ -e "$work/bad-sbom" ] || ! grep -q 'SBOM is missing binary modules' "$work/bad-sbom.log"; then
  echo 'Collector accepted an incomplete SBOM or created evidence.' >&2; exit 1
fi
python3 - "$sbom" "$work/bad-purl.json" <<'PY'
import json,sys
p=json.load(open(sys.argv[1])); x=next(x for x in p['components'] if x.get('name')=='github.com/restic/chunker'); x['purl']='pkg:golang/github.com/other/module@v0.4.0'
with open(sys.argv[2],'w') as f: json.dump(p,f)
PY
if run_collector "$work/bad-purl.json" "$cache" bad-purl >"$work/bad-purl.log" 2>&1 || [ -e "$work/bad-purl" ] || ! grep -q 'SBOM PURL differs from component' "$work/bad-purl.log"; then
  echo 'Collector accepted a misleading PURL or created evidence.' >&2; exit 1
fi
cp "$binary" "$work/bad-binary"
python3 - "$work/bad-binary" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); data=p.read_bytes(); p.write_bytes(data[:-1]+bytes([data[-1]^1]))
PY
original_binary=$binary
binary="$work/bad-binary"
if run_collector "$sbom" "$cache" bad-binary-output >"$work/bad-binary.log" 2>&1 || [ -e "$work/bad-binary-output" ] || ! grep -q 'binary does not match the verified build artifact' "$work/bad-binary.log"; then
  echo 'Collector accepted an altered binary or created evidence.' >&2; exit 1
fi
binary=$original_binary
module_dir='cache/download/cloud.google.com/go/auth/oauth2adapt/@v'
version='v0.2.8'
mkdir -p "$work/bad-cache/$module_dir"
cp "$cache/$module_dir/$version.zip" "$work/bad-cache/$module_dir/$version.zip"
printf '%s\n' 'h1:incorrect' > "$work/bad-cache/$module_dir/$version.ziphash"
if run_collector "$sbom" "$work/bad-cache" bad-hash >"$work/bad-hash.log" 2>&1 || [ -e "$work/bad-hash" ] || ! grep -q 'cached ZIP hash differs from binary' "$work/bad-hash.log"; then
  echo 'Collector accepted an altered hash or created evidence.' >&2; exit 1
fi
cp "$cache/$module_dir/$version.ziphash" "$work/bad-cache/$module_dir/$version.ziphash"
python3 - "$work/bad-cache/$module_dir/$version.zip" <<'PY'
from pathlib import Path
from zipfile import ZipFile
import sys
p=Path(sys.argv[1]); replacement=p.with_suffix('.changed'); altered=False
with ZipFile(p) as original, ZipFile(replacement,'w') as out:
 for item in original.infolist():
  data=original.read(item)
  if not altered and not item.is_dir(): data+=b'changed'; altered=True
  out.writestr(item,data)
assert altered
replacement.replace(p)
PY
if run_collector "$sbom" "$work/bad-cache" bad-zip >"$work/bad-zip.log" 2>&1 || [ -e "$work/bad-zip" ] || ! grep -q 'module ZIP content differs from binary' "$work/bad-zip.log"; then
  echo 'Collector accepted altered module contents or created evidence.' >&2; exit 1
fi
cp "$cache/$module_dir/$version.zip" "$work/bad-cache/$module_dir/$version.zip"
python3 - "$work/bad-cache/$module_dir/$version.zip" <<'PY'
from zipfile import ZipFile
import sys
with ZipFile(sys.argv[1], 'a') as archive:
    archive.writestr('cloud.google.com/go/auth/oauth2adapt@v0.2.8/../escape', b'invalid')
PY
if run_collector "$sbom" "$work/bad-cache" bad-path >"$work/bad-path.log" 2>&1 || [ -e "$work/bad-path" ] || ! grep -q 'module ZIP failed Go path validation' "$work/bad-path.log"; then
  echo 'Collector accepted an unsafe ZIP path or created evidence.' >&2; exit 1
fi
printf 'Passed: evidence collection, incomplete SBOM, misleading PURL, altered binary, ZIP hash, ZIP contents and unsafe ZIP path.\n'
