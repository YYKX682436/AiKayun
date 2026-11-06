#!/usr/bin/env python3
"""Isolated positive-control test; generated markers are not real credentials."""
import json, os, secrets, subprocess, sys, tempfile
from pathlib import Path

image='aquasec/trivy@sha256:33f816d414b9d582d25bb737ffa4a632ae34e222f7ec1b50252cef0ce2266006'
files=['NOTICE-image-api-linux-arm64.txt','NOTICE-restic-licenses-linux-arm64.txt','NOTICE-restic-index-linux-arm64.txt',
       'NOTICE-restic-evidence-linux-arm64.txt','NOTICE-restic-system-linux-arm64.txt',
       'NOTICE-restic-stage-proof-linux-arm64.txt','NOTICE-restic-sbom-proof-linux-arm64.txt','NOTICE-restic-binding-linux-arm64.txt']
name='aikayun-notice-canary-'+secrets.token_hex(12)
try:
    with tempfile.TemporaryDirectory(prefix='aikayun-notice-canary-') as directory:
        root=Path(directory); incoming=root/'in'; outgoing=root/'out'; incoming.mkdir(mode=0o700); outgoing.mkdir(mode=0o700)
        for filename in files:
            marker='AWS_ACCESS_KEY_ID='+'AKIA'+secrets.token_hex(8).upper()+'\n'
            p=incoming/filename
            with p.open('x') as f: f.write(marker)
            os.chmod(p,0o600)
        cmd=['docker','run','--rm','--name',name,'--pull=never','--network','none','--read-only','--memory','1g','--cpus','2','--pids-limit','64',
             '--tmpfs','/tmp:rw,noexec,nosuid,size=32m','--tmpfs','/root/.cache/trivy:rw,noexec,nosuid,size=32m',
             '--mount',f'type=bind,source={incoming},target=/input,readonly',
             '--mount',f'type=bind,source={outgoing},target=/out',image,'fs','--scanners','secret','--format','json',
             '--output','/out/scan.json','--exit-code','0','/input']
        r=subprocess.run(cmd,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=120,check=False)
        if r.returncode: raise ValueError('secret canary scanner failed')
        report=json.loads((outgoing/'scan.json').read_text())
        if report.get('SchemaVersion')!=2 or report.get('Trivy',{}).get('Version')!='0.69.0': raise ValueError('unexpected scanner report')
        found=report.get('Results');
        if not isinstance(found,list) or len(found)!=len(files): raise ValueError('secret canary coverage incomplete')
        counts={Path(x.get('Target','')).name:len(x.get('Secrets',[])) for x in found}
        if counts!={x:1 for x in files}: raise ValueError('secret canary did not cover every target')
    print('Passed: secret scanner positive controls cover all eight NOTICE file names.')
except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
    print('NOTICE secret canary rejected.',file=sys.stderr)
    raise SystemExit(1)
finally:
    try:
        subprocess.run(['docker','rm','--force',name],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15,check=False)
        checked=subprocess.run(['docker','container','ls','--all','--filter',f'name=^/{name}$','--format','{{.ID}}'],
                               stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=15,check=False)
        if checked.returncode or checked.stdout.strip(): raise ValueError('canary container cleanup unverified')
    except (OSError, ValueError, subprocess.TimeoutExpired):
        print('NOTICE secret canary cleanup could not be verified.',file=sys.stderr)
        raise SystemExit(1)
