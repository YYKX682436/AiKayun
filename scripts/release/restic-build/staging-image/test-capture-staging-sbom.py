#!/usr/bin/env python3
"""Real local Docker/Syft fixture with an explicitly synthetic staging mapping."""
import hashlib
import importlib.util
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

if len(sys.argv) != 2:
    raise SystemExit('usage: test-capture-staging-sbom.py VERIFIED_ARM64_RESTIC')
binary = Path(sys.argv[1]).resolve(strict=True)
expected = '2afe80670531f7cc4eb7f445fe6edfe70faa691a679be4a0d78df088a72d24b6'
if hashlib.sha256(binary.read_bytes()).hexdigest() != expected:
    raise SystemExit('fixture binary does not match fixed arm64 candidate')
real_docker = shutil.which('docker')
if not real_docker:
    raise SystemExit('Docker is unavailable')
script = Path(__file__).with_name('capture-staging-sbom.py')
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('capture_staging', script)
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)
token = secrets.token_hex(12)
tag = f'aikayun-sbom-fixture:{token}'
staging_ref = 'ghcr.io/yykx682436/aikayun-staging-api@sha256:' + 'a' * 64

wrapper = r'''#!/usr/bin/env python3
import json, os, subprocess, sys, time
args=sys.argv[1:]; real=os.environ['REAL_DOCKER']; ref=os.environ['FIXTURE_REF']; tag=os.environ['FIXTURE_TAG']
if args[:2]==['image','inspect'] and len(args)==3 and args[2].startswith('anchore/syft@') and os.environ.get('WRAPPER_MODE')=='syft_missing': sys.exit(1)
if args[:2]==['image','inspect'] and len(args)==3 and args[2]==ref:
 r=subprocess.run([real,'image','inspect',tag],capture_output=True,check=False)
 if r.returncode: sys.exit(r.returncode)
 x=json.loads(r.stdout); x[0]['RepoDigests']=[ref] if os.environ.get('WRAPPER_MODE')!='bad_reference' else []
 sys.stdout.write(json.dumps(x)); sys.exit(0)
if args[:3]==['image','save',ref]: os.execv(real,[real,'image','save',tag])
if args and args[0]=='pull': sys.exit(19)
if args and args[0]=='run':
 if not all(x in args for x in ('--pull=never','--network=none','--read-only','--memory=1g','--cpus=2','--pids-limit=64','--cap-drop=ALL','--security-opt=no-new-privileges','--user','/tmp:rw,noexec,nosuid,size=512m,mode=1777')): sys.exit(20)
 open(os.environ['FIXTURE_CONTAINER'],'w').write(args[args.index('--name')+1])
 if os.environ.get('WRAPPER_MODE')=='scanner_fail': sys.exit(21)
 if os.environ.get('WRAPPER_MODE')=='scanner_hang': time.sleep(60); sys.exit(22)
 if os.environ.get('WRAPPER_MODE')=='scanner_hang_real':
  name=args[args.index('--name')+1]; label=args[args.index('--label')+1]
  os.execv(real,[real,'run','--rm','--pull=never','--name',name,'--label',label,'--network=none','--read-only',
                 '--memory=128m','--cpus=1','--pids-limit=16','--cap-drop=ALL','--security-opt=no-new-privileges',
                 '--user','65534:65534','--entrypoint','/bin/sh',
                 'golang@sha256:c65ecfe613b539ac74c62a4c3b2c27e8f8a6076384c8f27e8a3c0f3be17cc385','-c','sleep 60'])
 if os.environ.get('WRAPPER_MODE') in ('no_sbom','bad_json'):
  if os.environ['WRAPPER_MODE']=='bad_json':
   target=next(x for x in args if x.startswith('type=bind,source=') and x.endswith(',target=/out'))
   path=target.removeprefix('type=bind,source=').removesuffix(',target=/out'); open(path+'/sbom.json','w').write('{invalid')
  sys.exit(0)
os.execv(real,[real,*args])
'''

with tempfile.TemporaryDirectory(prefix='aikayun-capture-fixture-') as directory:
    root = Path(directory)
    try:
        shutil.copyfile(binary, root / 'restic')
        (root / 'Dockerfile').write_text('FROM scratch\nCOPY --chmod=0555 restic /usr/bin/restic\n')
        subprocess.run([real_docker, 'build', '--network=none', '--platform=linux/arm64', '-t', tag, str(root)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=120)
        image = json.loads(subprocess.run([real_docker, 'image', 'inspect', tag], capture_output=True, check=True, timeout=20).stdout)[0]
        fakebin = root / 'fakebin'; fakebin.mkdir(mode=0o700)
        fake = fakebin / 'docker'; fake.write_text(wrapper); fake.chmod(0o700)
        env = dict(os.environ, PATH=str(fakebin) + os.pathsep + os.environ['PATH'], REAL_DOCKER=real_docker,
                   FIXTURE_REF=staging_ref, FIXTURE_TAG=tag, FIXTURE_CONTAINER=str(root/'scanner-container'))
        stage = {'schema':'aikayun.restic-staging-extraction.v1', 'arch':'arm64', 'image_ref':staging_ref,
                 'platform_manifest_digest':'sha256:' + 'a'*64, 'index_digest':'sha256:' + 'b'*64,
                 'local_image_id':image['Id'], 'binary_sha256':expected, 'binary_path':str(binary)}
        stage_path = root / 'stage.json'; stage_path.write_text(json.dumps(stage))
        def run_case(label, value, *, mode='', expected_error=None, supplied_sha=None):
            stage_path.write_text(json.dumps(value)); raw = stage_path.read_bytes()
            sha = supplied_sha or hashlib.sha256(raw).hexdigest()
            output = root / ('out-' + label)
            result = subprocess.run([sys.executable, str(script), str(stage_path), sha, str(output)],
                                    env=dict(env, WRAPPER_MODE=mode), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    timeout=240, check=False, text=True)
            if expected_error:
                if result.returncode == 0 or expected_error not in result.stderr or output.exists():
                    raise RuntimeError(f'fixture rejection failed: {label}: {result.stderr}')
            elif result.returncode:
                raise RuntimeError(f'fixture capture failed: {label}: {result.stderr}')
            return output
        result = run_case('good', stage)
        proof = json.loads((result/'evidence.json').read_text()); sbom = (result/'api.cdx.json').read_bytes()
        if proof['schema'] != 'aikayun.restic-staging-sbom.v1' or proof['image_ref'] != staging_ref or \
           proof['local_image_id'] != image['Id'] or proof['sbom_sha256'] != hashlib.sha256(sbom).hexdigest() or \
           proof['staging_proof_sha256'] != hashlib.sha256(stage_path.read_bytes()).hexdigest() or \
           proof['platform_manifest_digest'] != stage['platform_manifest_digest'] or proof['index_digest'] != stage['index_digest'] or \
           proof['sbom_path'] != str(result/'api.cdx.json') or proof['syft_image'] != capture.SYFT or \
           not re.fullmatch(r'[a-f0-9]{64}', proof['image_archive_sha256']) or \
           proof['arch'] != 'arm64' or stat.S_IMODE(result.stat().st_mode) != 0o700 or \
           any(stat.S_IMODE((result/name).stat().st_mode) != 0o600 for name in ('api.cdx.json','evidence.json')):
            raise RuntimeError('captured SBOM identity or permissions mismatch')
        sha1 = hashlib.sha1(binary.read_bytes()).hexdigest()
        capture.validate_sbom(sbom, expected, sha1)
        semantic_errors = {'missing':'SBOM missing expected restic components', 'wrong-hash':'SBOM restic SHA differs',
                           'wrong-purl':'Go component identity differs', 'wrong-location':'Go component is outside',
                           'duplicate':'Go component identity differs', 'nonfinite':'non-finite JSON value'}
        for case, reason in semantic_errors.items():
            item = json.loads(sbom)
            go = [c for c in item['components'] if c.get('purl', '').startswith('pkg:golang/')]
            file = next(c for c in item['components'] if c.get('type') == 'file' and c.get('name') == '/usr/bin/restic')
            if case == 'missing': item['components'].remove(go[0])
            elif case == 'wrong-hash': next(h for h in file['hashes'] if h['alg'] == 'SHA-256')['content'] = '0'*64
            elif case == 'wrong-purl': go[0]['purl'] = 'pkg:golang/forged/module@v0.0.1'
            elif case == 'wrong-location': next(p for p in go[0]['properties'] if p['name'].startswith('syft:location:') and p['name'].endswith(':path'))['value'] = '/other'
            elif case == 'duplicate': item['components'][item['components'].index(go[0])] = go[1]
            else: item['invalid'] = float('nan')
            try: capture.validate_sbom(json.dumps(item).encode(), expected, sha1)
            except capture.staging.Reject as error:
                if reason not in str(error): raise RuntimeError('unexpected rejection: ' + case) from error
            else: raise RuntimeError('tampered SBOM accepted: ' + case)
        run_case('untrusted-proof', stage, supplied_sha='0'*64, expected_error='trusted staging proof digest mismatch')
        changed = dict(stage, local_image_id='sha256:'+'c'*64)
        run_case('wrong-id', changed, expected_error='local image differs from staging evidence')
        changed = dict(stage, arch='amd64')
        run_case('wrong-arch', changed, expected_error='invalid staging identity')
        run_case('wrong-reference', stage, mode='bad_reference', expected_error='exact staging child reference')
        run_case('scanner-failure', stage, mode='scanner_fail', expected_error='Syft scan failed')
        run_case('missing-syft', stage, mode='syft_missing', expected_error='local Docker inspection failed')
        run_case('missing-sbom', stage, mode='no_sbom', expected_error='invalid input or environment')
        run_case('invalid-sbom-json', stage, mode='bad_json', expected_error='invalid input or environment')
        marker = root/'scanner-container'; marker.unlink(missing_ok=True)
        stage_path.write_text(json.dumps(stage)); stage_sha = hashlib.sha256(stage_path.read_bytes()).hexdigest()
        interrupt_out = root/'out-interrupt'
        process = subprocess.Popen([sys.executable,str(script),str(stage_path),stage_sha,str(interrupt_out)],
                                   env=dict(env,WRAPPER_MODE='scanner_hang_real'),stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
        deadline = time.monotonic() + 15
        while not marker.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        if not marker.exists():
            process.kill(); process.wait(timeout=10)
            raise RuntimeError('fixture scanner did not reach interrupt point')
        name = marker.read_text()
        running = False
        while process.poll() is None and time.monotonic() < deadline:
            inspect = subprocess.run([real_docker,'container','inspect',name],capture_output=True,timeout=5,check=False)
            if inspect.returncode == 0 and json.loads(inspect.stdout)[0]['State']['Running']:
                running = True; break
            time.sleep(0.05)
        if not running:
            process.kill(); process.wait(timeout=10)
            raise RuntimeError('fixture scanner container did not enter running state')
        process.terminate(); _, stderr = process.communicate(timeout=15)
        if process.returncode == 0 or interrupt_out.exists() or 'could not be verified' not in stderr:
            raise RuntimeError('interrupted capture did not fail closed and remove its output')
        if (root/'scanner-container').exists():
            name = (root/'scanner-container').read_text()
            remaining = subprocess.run([real_docker,'container','ls','--all','--filter',f'name=^/{name}$','--format','{{.ID}}'],
                                       capture_output=True,check=True,timeout=20)
            if remaining.stdout.strip(): raise RuntimeError('fixture scanner container not cleaned')
    finally:
        scanner_clean = True
        if (root/'scanner-container').exists():
            name = (root/'scanner-container').read_text()
            match = re.fullmatch(r'aikayun-restic-syft-([a-f0-9]{48})', name)
            scanner_clean = bool(match) and capture.staging.cleanup_container(name, match.group(1))
        subprocess.run([real_docker,'image','rm',tag],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False,timeout=30)
        remaining = subprocess.run([real_docker,'image','ls','--filter',f'reference={tag}','--format','{{.ID}}'],
                                   capture_output=True,check=True,timeout=20)
        if not scanner_clean or remaining.stdout.strip(): raise RuntimeError('fixture resources cleanup unverified')
print('Passed: real local Syft, synthetic staging mapping, identity/failure cases and isolated cleanup.')
