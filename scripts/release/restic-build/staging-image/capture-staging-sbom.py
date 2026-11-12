#!/usr/bin/env python3
"""Experimental local staging SBOM capture; never a substitute for release scans."""
import argparse
import hashlib
import importlib.util
import json
import os
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('staging_image', Path(__file__).with_name('verify-staging-image.py'))
staging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(staging)
SYFT = 'anchore/syft@sha256:825cad3a952c87676a6d07e9a3bb05ac9c401d598360070e970aa46d54c1727e'
MAX_ARCHIVE = 2 * 1024 * 1024 * 1024
MAX_SBOM = 16 * 1024 * 1024


def reject_nonfinite(_value):
    raise staging.Reject('non-finite JSON value')


def validate_stage(proof, proof_sha):
    if not re.fullmatch(r'[a-f0-9]{64}', proof_sha) or not isinstance(proof, dict):
        raise staging.Reject('invalid trusted staging proof')
    arch = proof.get('arch')
    child = proof.get('platform_manifest_digest')
    if proof.get('schema') != 'aikayun.restic-staging-extraction.v1' or arch not in staging.HASHES or \
       not isinstance(child, str) or not staging.SHA.fullmatch(child) or \
       proof.get('image_ref') != staging.REPOSITORY + '@' + child or \
       not isinstance(proof.get('index_digest'), str) or not staging.SHA.fullmatch(proof['index_digest']) or \
       not isinstance(proof.get('local_image_id'), str) or not staging.SHA.fullmatch(proof['local_image_id']) or \
       proof.get('binary_sha256') != staging.HASHES[arch] or not isinstance(proof.get('binary_path'), str) or \
       not os.path.isabs(proof['binary_path']):
        raise staging.Reject('invalid staging identity')
    binary = staging.read_regular(proof['binary_path'], staging.MAX_BINARY)
    if hashlib.sha256(binary).hexdigest() != proof['binary_sha256']:
        raise staging.Reject('staging binary differs from verified artifact')
    return arch, hashlib.sha1(binary).hexdigest()


def validate_sbom(data, binary_sha, binary_sha1):
    sbom = json.loads(data, object_pairs_hook=staging.unique_object, parse_constant=reject_nonfinite)
    if not isinstance(sbom, dict) or sbom.get('bomFormat') != 'CycloneDX' or sbom.get('specVersion') != '1.6' or \
       not isinstance(sbom.get('metadata'), dict) or not isinstance(sbom['metadata'].get('component'), dict) or \
       sbom['metadata']['component'].get('name') != '/input/image.tar' or \
       not isinstance(sbom.get('components'), list) or not 1 <= len(sbom['components']) <= 100000 or \
       not isinstance(sbom.get('dependencies'), list):
        raise staging.Reject('invalid complete-image SBOM')
    components = sbom['components']
    if any(not isinstance(c, dict) for c in components):
        raise staging.Reject('invalid SBOM component')
    restic = [c for c in components if c.get('type') == 'file' and c.get('name') == '/usr/bin/restic']
    go = [c for c in components if isinstance(c.get('purl'), str) and c['purl'].startswith('pkg:golang/')]
    if len(restic) != 1 or len(go) != 81:
        raise staging.Reject('SBOM missing expected restic components')
    hashes = restic[0].get('hashes')
    if not isinstance(hashes, list) or len(hashes) != 2 or any(not isinstance(h, dict) for h in hashes) or \
       sum(1 for h in hashes if h.get('alg') == 'SHA-256' and h.get('content') == binary_sha) != 1 or \
       sum(1 for h in hashes if h.get('alg') == 'SHA-1' and h.get('content') == binary_sha1) != 1:
        raise staging.Reject('SBOM restic SHA differs from staging evidence')
    seen = set()
    for component in go:
        name, version, purl = component.get('name'), component.get('version'), component['purl']
        if not isinstance(name, str) or not isinstance(version, str) or not name or not version or \
           '?' in purl or re.search(r'%(?![0-9A-Fa-f]{2})', purl):
            raise staging.Reject('invalid Go component identity')
        locator = purl[len('pkg:golang/'):].split('#')
        if len(locator) > 2 or (len(locator) == 2 and not locator[1]) or '@' not in locator[0]:
            raise staging.Reject('invalid Go component identity')
        encoded_name, encoded_version = locator[0].rsplit('@', 1)
        actual_name = unquote(encoded_name, errors='strict')
        if len(locator) == 2:
            fragment = unquote(locator[1], errors='strict')
            if not fragment or fragment.startswith('/') or fragment.endswith('/'):
                raise staging.Reject('invalid Go component identity')
            actual_name += '/' + fragment
        actual_version = unquote(encoded_version, errors='strict')
        expected_version = version.removeprefix('go') if name == 'stdlib' else version
        if actual_name != name or actual_version != expected_version or (name, version) in seen:
            raise staging.Reject('Go component identity differs from PURL')
        seen.add((name, version))
        props = component.get('properties', [])
        if not isinstance(props, list) or any(not isinstance(p, dict) for p in props):
            raise staging.Reject('invalid Go component locations')
        locations = [p.get('value') for p in props if re.fullmatch(r'syft:location:\d+:path', str(p.get('name', '')))]
        if not locations or any(p != '/usr/bin/restic' for p in locations):
            raise staging.Reject('Go component is outside the restic binary')
    if ('github.com/restic/restic', 'v0.19.1-aikayun.3') not in seen or ('stdlib', 'go1.27.3') not in seen:
        raise staging.Reject('SBOM restic module or Go standard library is missing')


def inspect_syft():
    image = staging.docker_json(['image', 'inspect', SYFT])
    if image.get('Os') != 'linux' or not isinstance(image.get('Id'), str) or not staging.SHA.fullmatch(image['Id']) or \
       not isinstance(image.get('RepoDigests'), list) or SYFT not in image['RepoDigests'] or \
       not isinstance(image.get('Config'), dict) or image['Config'].get('Volumes') not in (None, {}):
        raise staging.Reject('pinned local Syft image is unavailable or unsafe')


def save_image(ref, archive):
    process = None
    try:
        process = subprocess.Popen(['docker', 'image', 'save', ref], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        total = 0
        h = hashlib.sha256()
        fd = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as target:
            while True:
                block = process.stdout.read(1024 * 1024)
                if not block:
                    break
                total += len(block)
                if total > MAX_ARCHIVE:
                    raise staging.Reject('image archive exceeds limit')
                h.update(block)
                target.write(block)
        if not total or process.wait(timeout=20) != 0:
            raise staging.Reject('local image save failed')
        return h.hexdigest()
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise staging.Reject('local image save failed') from exc
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)
            if process.stdout:
                process.stdout.close()


def archive_sha256(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size <= 0 or info.st_size > MAX_ARCHIVE:
            raise staging.Reject('image archive size changed')
        h = hashlib.sha256()
        total = 0
        with os.fdopen(fd, 'rb', closefd=False) as source:
            for block in iter(lambda: source.read(1024 * 1024), b''):
                total += len(block)
                if total > MAX_ARCHIVE:
                    raise staging.Reject('image archive size changed')
                h.update(block)
        if total != info.st_size:
            raise staging.Reject('image archive changed')
        return h.hexdigest()
    finally:
        os.close(fd)


def run(stage_path, stage_sha, output_path):
    stage_bytes = staging.read_regular(stage_path, 1024 * 1024)
    if not re.fullmatch(r'[a-f0-9]{64}', stage_sha) or hashlib.sha256(stage_bytes).hexdigest() != stage_sha:
        raise staging.Reject('trusted staging proof digest mismatch')
    proof = json.loads(stage_bytes, object_pairs_hook=staging.unique_object, parse_constant=reject_nonfinite)
    arch, binary_sha1 = validate_stage(proof, stage_sha)
    output = Path(output_path)
    if not output.is_absolute() or output.name in ('', '.', '..'):
        raise staging.Reject('output must be a new absolute directory')
    parent = output.parent
    parent_info = parent.lstat()
    if not stat.S_ISDIR(parent_info.st_mode) or parent_info.st_uid != os.geteuid() or stat.S_IMODE(parent_info.st_mode) != 0o700 or \
       ',' in str(parent) or '\n' in str(parent) or '\r' in str(parent):
        raise staging.Reject('output parent must be private and mount-safe')
    os.mkdir(output, 0o700)
    work = None
    attempted = False
    scanner_uncertain = False
    success = False
    token = secrets.token_hex(24)
    container = 'aikayun-restic-syft-' + token
    previous = {sig: signal.signal(sig, staging.alarm_handler) for sig in (signal.SIGALRM, signal.SIGTERM, signal.SIGINT)}
    signal.setitimer(signal.ITIMER_REAL, 180)
    try:
        image_id = staging.inspect_image(proof['image_ref'], arch)
        if image_id != proof['local_image_id']:
            raise staging.Reject('local image differs from staging evidence')
        inspect_syft()
        work = Path(tempfile.mkdtemp(prefix='.aikayun-sbom-work-', dir=parent))
        archive = work / 'image.tar'
        archive_hash = save_image(proof['image_ref'], archive)
        if staging.inspect_image(proof['image_ref'], arch) != image_id:
            raise staging.Reject('local image changed during save')
        scan_dir = work / 'scan'
        os.mkdir(scan_dir, 0o700)
        args = ['run', '--rm', '--name', container, '--label', f'{staging.LABEL}={token}', '--pull=never',
                '--network=none', '--read-only', '--memory=1g', '--cpus=2', '--pids-limit=64',
                '--user', f'{os.geteuid()}:{os.getegid()}', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                '--env', 'HOME=/tmp', '--env', 'SYFT_CHECK_FOR_APP_UPDATE=false',
                '--tmpfs', '/tmp:rw,noexec,nosuid,size=512m,mode=1777',
                '--mount', f'type=bind,source={archive},target=/input/image.tar,readonly',
                '--mount', f'type=bind,source={scan_dir},target=/out', SYFT,
                'scan', 'docker-archive:/input/image.tar', '-o', 'cyclonedx-json=/out/sbom.json']
        attempted = True
        scanner_uncertain = True
        status, _ = staging.bounded_command(args, 1024 * 1024, timeout=120)
        if status:
            raise staging.Reject('Syft scan failed')
        scanner_uncertain = False
        sbom = staging.read_regular(scan_dir / 'sbom.json', MAX_SBOM)
        validate_sbom(sbom, proof['binary_sha256'], binary_sha1)
        if archive_sha256(archive) != archive_hash or \
           hashlib.sha256(staging.read_regular(stage_path, 1024 * 1024)).hexdigest() != stage_sha or \
           hashlib.sha256(staging.read_regular(proof['binary_path'], staging.MAX_BINARY)).hexdigest() != proof['binary_sha256']:
            raise staging.Reject('staging input changed during scan')
        if staging.inspect_image(proof['image_ref'], arch) != image_id:
            raise staging.Reject('local image changed during scan')
        sbom_path = output / 'api.cdx.json'
        fd = os.open(sbom_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as target:
            target.write(sbom)
        report = {'schema': 'aikayun.restic-staging-sbom.v1', 'staging_proof_sha256': stage_sha,
                  'arch': arch, 'image_ref': proof['image_ref'], 'index_digest': proof['index_digest'],
                  'platform_manifest_digest': proof['platform_manifest_digest'], 'local_image_id': image_id,
                  'image_archive_sha256': archive_hash, 'sbom_sha256': hashlib.sha256(sbom).hexdigest(),
                  'sbom_path': str(sbom_path), 'syft_image': SYFT}
        fd = os.open(output / 'evidence.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w', encoding='utf8') as target:
            json.dump(report, target, sort_keys=True, separators=(',', ':'))
            target.write('\n')
        success = True
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        try:
            clean = not attempted or staging.cleanup_container(container, token)
        except Exception:
            clean = False
        if work is not None:
            try:
                shutil.rmtree(work)
            except OSError:
                clean = False
        if not success or not clean or scanner_uncertain:
            shutil.rmtree(output)
        if not clean or scanner_uncertain:
            raise staging.Reject('Syft scan failed; container creation or cleanup could not be verified')
    print('staging image SBOM evidence created')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('staging_proof')
    parser.add_argument('staging_proof_sha256')
    parser.add_argument('new_output_directory')
    args = parser.parse_args()
    try:
        run(args.staging_proof, args.staging_proof_sha256, args.new_output_directory)
    except (staging.Reject, OSError, ValueError, TypeError, RecursionError) as error:
        print('staging SBOM capture rejected:', str(error) if isinstance(error, staging.Reject) else 'invalid input or environment', file=sys.stderr)
        raise SystemExit(1)
