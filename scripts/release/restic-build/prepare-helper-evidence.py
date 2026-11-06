#!/usr/bin/env python3
"""Private pre-sign evidence pipeline. Never promotes, signs or publishes."""
import hashlib
import importlib.util
import os
import re
import secrets
import signal
import stat
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
GO_IMAGE = 'golang@sha256:c65ecfe613b539ac74c62a4c3b2c27e8f8a6076384c8f27e8a3c0f3be17cc385'
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('staging', HERE / 'staging-image/verify-staging-image.py')
staging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(staging)


def command(args, timeout=180):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, timeout=timeout, check=False)
    if result.returncode:
        raise staging.Reject('required evidence step failed')


def digest(path, limit=16 * 1024 * 1024):
    return hashlib.sha256(staging.read_regular(path, limit)).hexdigest()


def main():
    os.umask(0o077)
    if len(sys.argv) != 6:
        raise staging.Reject('usage: REFERENCE INDEX INDEX_DIGEST ARCH NEW_PRIVATE_DIRECTORY')
    ref, index, index_digest, arch, output_arg = sys.argv[1:]
    output = Path(output_arg)
    parent = output.parent.lstat()
    if not output.is_absolute() or os.path.abspath(output) != str(output) or output.parent.resolve() != output.parent or \
       not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid() or \
       stat.S_IMODE(parent.st_mode) != 0o700 or any(c in str(output) for c in ',\r\n'):
        raise staging.Reject('output parent must be private and mount-safe')
    if arch not in staging.HASHES or not re.fullmatch(r'sha256:[a-f0-9]{64}', index_digest):
        raise staging.Reject('invalid platform identity')
    os.mkdir(output, 0o700)
    ok = False
    attempted = False
    uncertain = False
    token = secrets.token_hex(24)
    container = 'aikayun-restic-collector-' + token
    previous = {sig: signal.signal(sig, staging.alarm_handler) for sig in (signal.SIGALRM, signal.SIGTERM, signal.SIGINT)}
    signal.setitimer(signal.ITIMER_REAL, 1800)
    try:
        inputs = output / 'inputs'
        # This builds only the private build/cache target and never pushes.
        command(['docker', 'buildx', 'build', '--platform', 'linux/' + arch, '--target', 'restic-evidence',
                 '--output', 'type=local,dest=' + str(inputs), '-f', str(ROOT / 'apps/api/Dockerfile'), str(ROOT)], 1200)
        binary = inputs / 'restic'
        if digest(binary, 128 * 1024 * 1024) != staging.HASHES[arch]:
            raise staging.Reject('independently built helper differs from fixed identity')
        command([sys.executable, str(HERE / 'staging-image/verify-staging-image.py'), ref, index,
                 index_digest, arch, str(binary), str(output / 'stage')])
        stage_path = output / 'stage/evidence.json'; stage_sha = digest(stage_path, 1024 * 1024)
        command([sys.executable, str(HERE / 'staging-image/capture-staging-sbom.py'), str(stage_path),
                 stage_sha, str(output / 'sbom')], 240)
        command([sys.executable, str(HERE / 'extract-system-notices.py'), str(stage_path), stage_sha,
                 str(output / 'system')])
        command(['docker', 'pull', GO_IMAGE], 300)
        # The built collector checks all binary build-info and Go ZIP h1 values.
        args = ['docker', 'run', '--rm', '--name', container, '--label', f'{staging.LABEL}={token}',
                '--pull=never', '--network=none', '--read-only', '--memory=1g', '--cpus=2', '--pids-limit=64',
                '--user', f'{os.geteuid()}:{os.getegid()}', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                '--mount', f'type=bind,source={inputs}/collector,target=/collector,readonly',
                '--mount', f'type=bind,source={output}/stage/restic,target=/binary,readonly',
                '--mount', f'type=bind,source={output}/sbom/api.cdx.json,target=/sbom.json,readonly',
                '--mount', f'type=bind,source={inputs}/module-cache,target=/cache,readonly',
                '--mount', f'type=bind,source={output},target=/output', '--entrypoint', '/collector', GO_IMAGE,
                '/binary', '/sbom.json', '/cache', '/usr/local/go', arch, '/output/licenses']
        attempted = True; uncertain = True
        command(args, 240)
        uncertain = False
        if not staging.cleanup_container(container, token):
            raise staging.Reject('collector cleanup could not be verified')
        attempted = False
        sbom_proof = output / 'sbom/evidence.json'
        evidence = output / 'licenses/license-evidence.json'
        system_proof = output / 'system/system-notices-proof.json'
        command(['node', str(HERE / 'prepare-notice.mjs'), str(stage_path), stage_sha, index,
                 str(sbom_proof), digest(sbom_proof, 1024 * 1024), str(evidence), digest(evidence),
                 str(output / 'system'), digest(system_proof, 1024 * 1024), str(output / 'notices')], 300)
        ok = True
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        for sig, handler in previous.items(): signal.signal(sig, handler)
        clean = not attempted or staging.cleanup_container(container, token)
        if not clean or uncertain:
            raise staging.Reject('collector creation or cleanup could not be verified')
        # On any failure retain the private output for controlled inspection:
        # timed-out builders or child processes may still have unknown writers.
        # Production integration must prove those writers gone before cleanup.
    print('private helper evidence prepared')


if __name__ == '__main__':
    try: main()
    except (staging.Reject, OSError, ValueError, subprocess.TimeoutExpired):
        print('helper evidence preparation rejected', file=sys.stderr)
        raise SystemExit(1)
