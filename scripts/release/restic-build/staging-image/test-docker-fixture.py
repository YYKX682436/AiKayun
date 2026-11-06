#!/usr/bin/env python3
"""Exercise tar validation on a new, isolated scratch image; no registry access."""
import hashlib
import importlib.util
import json
import secrets
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('staging_image', Path(__file__).with_name('verify-staging-image.py'))
subject = importlib.util.module_from_spec(spec)
spec.loader.exec_module(subject)


def docker(*args, timeout=60):
    return subprocess.run(['docker', *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, check=True, timeout=timeout)


token = secrets.token_hex(12)
tag = f'aikayun-restic-extract-fixture:{token}'
name = f'aikayun-restic-extract-fixture-{token}'
payload = b'isolated scratch image fixture\n'
with tempfile.TemporaryDirectory(prefix='aikayun-restic-image-fixture-') as directory:
    root = Path(directory)
    (root / 'restic').write_bytes(payload)
    (root / 'Dockerfile').write_text('FROM scratch\nCOPY --chmod=0555 restic /usr/bin/restic\nCMD ["/usr/bin/restic"]\n')
    try:
        docker('build', '--network=none', '--tag', tag, str(root), timeout=120)
        image = json.loads(docker('image', 'inspect', tag).stdout)[0]
        docker('create', '--name', name, '--label', f'{subject.LABEL}={token}', '--pull=never', tag)
        container = json.loads(docker('container', 'inspect', name).stdout)[0]
        if image['Id'] != container['Image'] or container['State']['Running']:
            raise RuntimeError('fixture container image/state mismatch')
        subject.verify_root_directory(name)
        archive = root / 'rootfs.tar'
        with archive.open('xb') as output:
            subprocess.run(['docker', 'export', name], stdin=subprocess.DEVNULL, stdout=output,
                           stderr=subprocess.PIPE, check=True, timeout=60)
        with archive.open('rb') as source:
            subject.validate_tar(source, archive.stat().st_size, payload, root / 'verified')
        if (root / 'verified').read_bytes() != payload:
            raise RuntimeError('fixture contents mismatch')
        if not subject.cleanup_container(name, token):
            raise RuntimeError('could not prove fixture container cleanup')
    finally:
        subprocess.run(['docker', 'rm', '--force', '--volumes', name], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, check=False, timeout=30)
        subprocess.run(['docker', 'image', 'rm', tag], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, check=False, timeout=30)
        containers = docker('container', 'ls', '--all', '--filter', f'name=^/{name}$', '--format', '{{.ID}}')
        images = docker('image', 'ls', '--filter', f'reference={tag}', '--format', '{{.ID}}')
        if containers.stdout.strip() or images.stdout.strip():
            raise RuntimeError('fixture resources could not be proven cleaned')
    print('isolated Docker export: verified root-owned 0555 file and safe ancestors; SHA-256',
          hashlib.sha256(payload).hexdigest())
