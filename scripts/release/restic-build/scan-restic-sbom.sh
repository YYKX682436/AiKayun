#!/usr/bin/env bash
# Development-only supplement. The full-image vulnerability and secret gates remain mandatory.
set -euo pipefail
set +x
umask 077
if [ "$#" -ne 4 ]; then echo 'Usage: scan-restic-sbom.sh SUBSET PROOF EXPECTED_PROOF_SHA PRIVATE_WORK_DIR' >&2; exit 2; fi
subset=$(cd "$(dirname "$1")" && printf '%s/%s' "$PWD" "$(basename "$1")")
proof=$(cd "$(dirname "$2")" && printf '%s/%s' "$PWD" "$(basename "$2")")
expected_proof=$3
[[ "$expected_proof" =~ ^[a-f0-9]{64}$ ]] || { echo 'Invalid trusted proof digest.' >&2; exit 2; }
work=$(cd "$4" && pwd -P)
script_dir=$(cd "$(dirname "$0")" && pwd -P)
python3 - "$work" <<'PY'
import os,stat,sys
s=os.stat(sys.argv[1]);
if s.st_uid != os.getuid() or stat.S_IMODE(s.st_mode) != 0o700:
 raise SystemExit('Scan work directory must be private and owned by the caller.')
PY
[[ ! -e "$work/restic-trivy.json" ]] || { echo 'Scan output already exists.' >&2; exit 1; }
mkdir -p "$work/trivy-cache"
python3 - "$subset" "$work" "$script_dir" <<'PY'
import importlib.util,secrets,signal,sys
from pathlib import Path
sys.dont_write_bytecode=True
subset,work,script_dir=sys.argv[1:]
spec=importlib.util.spec_from_file_location('staging',Path(script_dir)/'staging-image/verify-staging-image.py')
staging=importlib.util.module_from_spec(spec);spec.loader.exec_module(staging)
token=secrets.token_hex(24);name='aikayun-restic-sbom-'+token
args=['run','--rm','--name',name,'--label',f'{staging.LABEL}={token}','--pull=never',
     '--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
     '--memory','1g','--cpus','2','--pids-limit','64','--tmpfs','/tmp:rw,noexec,nosuid,size=256m',
     '--mount',f'type=bind,source={subset},target=/input/subset.json,readonly',
     '--mount',f'type=bind,source={work},target=/output',
     '--mount',f'type=bind,source={work}/trivy-cache,target=/root/.cache/trivy',
     'aquasec/trivy@sha256:33f816d414b9d582d25bb737ffa4a632ae34e222f7ec1b50252cef0ce2266006',
     'sbom','--scanners','vuln','--severity','HIGH,CRITICAL','--exit-code','0',
     '--format','json','--output','/output/restic-trivy.json','/input/subset.json']
previous={sig:signal.signal(sig,staging.alarm_handler) for sig in (signal.SIGALRM,signal.SIGTERM,signal.SIGINT)}
signal.setitimer(signal.ITIMER_REAL,240)
attempted=False; uncertain=True; status=1
try:
 attempted=True
 status,_=staging.bounded_command(args,1024*1024,timeout=180)
 uncertain=False
except (staging.Reject,OSError):
 pass
finally:
 signal.setitimer(signal.ITIMER_REAL,0)
 for sig,handler in previous.items(): signal.signal(sig,handler)
 clean=not attempted or staging.cleanup_container(name,token)
if not clean or uncertain or status:
 print('Restic-only scanner failed or cleanup could not be verified; private work retained.',file=sys.stderr);sys.exit(1)
PY
node "$script_dir/verify-restic-sbom-scan.mjs" "$subset" "$proof" "$expected_proof" "$work/restic-trivy.json"
