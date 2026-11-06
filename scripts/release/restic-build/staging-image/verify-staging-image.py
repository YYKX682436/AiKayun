#!/usr/bin/env python3
"""Experimental, local-only staging image evidence; not a release gate."""
import argparse
import hashlib
import io
import json
import os
import re
import secrets
import select
import shutil
import signal
import stat
import subprocess
import tarfile
import time
from pathlib import Path

REPOSITORY = 'ghcr.io/yykx682436/aikayun-staging-api'
SHA = re.compile(r'^sha256:[a-f0-9]{64}$')
HASHES = {'arm64': '26c5b4d898ef5ea434d638fcbab616c319761dbd71ffe0d3585b37a9af62a2e1',
          'amd64': '2f516a8aebbc0510806a501a88efdca5f199e52f9c6b720f044157a25684d84e'}
TARGET = 'usr/bin/restic'
PARENTS = ('usr', 'usr/bin')
MAX_TAR = 2 * 1024 * 1024 * 1024
MAX_BINARY = 128 * 1024 * 1024
LABEL = 'io.aikayun.restic-evidence-token'


class Reject(Exception):
    pass


def read_regular(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size <= 0 or st.st_size > limit:
            raise Reject('invalid input file')
        with os.fdopen(fd, 'rb', closefd=False) as f:
            data = f.read(limit + 1)
        if len(data) != st.st_size or len(data) > limit:
            raise Reject('input changed or exceeds limit')
        return data
    finally:
        os.close(fd)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Reject('duplicate JSON key')
        result[key] = value
    return result


def select_index(index_bytes, expected_index, arch, ref):
    if arch not in HASHES or not SHA.fullmatch(expected_index) or not ref.startswith(REPOSITORY + '@'):
        raise Reject('invalid staging reference, index digest or architecture')
    child = ref[len(REPOSITORY) + 1:]
    if not SHA.fullmatch(child) or 'sha256:' + hashlib.sha256(index_bytes).hexdigest() != expected_index:
        raise Reject('staging reference or trusted index does not match')
    index = json.loads(index_bytes, object_pairs_hook=unique_object)
    if not isinstance(index, dict) or index.get('schemaVersion') != 2 or index.get('mediaType') not in (
            'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'):
        raise Reject('invalid OCI index')
    manifests = index.get('manifests')
    if not isinstance(manifests, list) or len(manifests) > 100:
        raise Reject('invalid OCI index manifests')
    matches = [x for x in manifests if isinstance(x, dict) and isinstance(x.get('platform'), dict)
               and x['platform'].get('os') == 'linux' and x['platform'].get('architecture') == arch]
    same_digest = [x for x in manifests if isinstance(x, dict) and x.get('digest') == child]
    if len(matches) != 1 or matches[0].get('digest') != child or len(same_digest) != 1:
        raise Reject('platform child digest is absent or ambiguous')
    selected = matches[0]
    if selected.get('mediaType') not in ('application/vnd.oci.image.manifest.v1+json',
                                         'application/vnd.docker.distribution.manifest.v2+json') or \
       type(selected.get('size')) is not int or not 0 < selected['size'] <= 4 * 1024 * 1024 or \
       selected['platform'].get('variant') not in ((None, '', 'v8') if arch == 'arm64' else (None, '')):
        raise Reject('invalid platform image descriptor')
    return child


def bounded_command(args, limit, timeout=20):
    process = None
    try:
        process = subprocess.Popen(['docker', *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + timeout
        output = bytearray()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([process.stdout], [], [], remaining)[0]:
                raise Reject('Docker command timed out')
            block = os.read(process.stdout.fileno(), min(65536, limit + 1 - len(output)))
            if not block:
                break
            output.extend(block)
            if len(output) > limit:
                raise Reject('Docker output exceeds limit')
        status = process.wait(timeout=max(0.01, deadline - time.monotonic()))
        return status, bytes(output)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Reject('local Docker command failed') from exc
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)
            if process.stdout:
                process.stdout.close()


def docker_json(args):
    status, output = bounded_command(args, 1024 * 1024)
    if status:
        raise Reject('local Docker inspection failed')
    data = json.loads(output, object_pairs_hook=unique_object)
    if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], dict):
        raise Reject('ambiguous Docker inspection')
    return data[0]


def inspect_image(ref, arch):
    image = docker_json(['image', 'inspect', ref])
    if image.get('Os') != 'linux' or image.get('Architecture') != arch or not SHA.fullmatch(image.get('Id', '')):
        raise Reject('local image platform or ID mismatch')
    digests = image.get('RepoDigests')
    if not isinstance(digests, list) or ref not in digests:
        raise Reject('local image lacks the exact staging child reference')
    cfg = image.get('Config')
    if not isinstance(cfg, dict) or cfg.get('Volumes') not in (None, {}):
        raise Reject('image declares volumes or invalid configuration')
    return image['Id']


def normalized(name):
    if not isinstance(name, str) or len(name) > 4096 or '\\' in name or '\x00' in name or name.startswith('/'):
        raise Reject('unsafe tar path')
    if name.startswith('./'):
        name = name[2:]
    name = name.rstrip('/')
    if name in ('', '.'):
        return ''
    if any(p in ('', '.', '..') for p in name.split('/')):
        raise Reject('unsafe tar path')
    return name


def safe_metadata(member, target):
    if member.uid != 0 or member.gid != 0 or member.mode & 0o7022:
        raise Reject('unsafe target ownership or permissions')
    if member.linkname or member.sparse is not None:
        raise Reject('target is linked or sparse')
    allowed = {'mtime', 'atime', 'ctime', 'path', 'size'}
    if any(key not in allowed for key in member.pax_headers):
        raise Reject('target has unexpected extended metadata')
    if target:
        if member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE) or member.mode != 0o555:
            raise Reject('target must be a regular root-owned 0555 file')
    elif member.type != tarfile.DIRTYPE or member.mode & 0o111 != 0o111:
        raise Reject('target ancestor is not an accessible directory')


def validate_tar(fileobj, total, trusted, binary_output):
    seen = set()
    link_targets = []
    expected = set(PARENTS) | {TARGET}
    last_end = 0
    entries = 0
    with tarfile.open(fileobj=fileobj, mode='r:') as archive:
        for member in archive:
            entries += 1
            if entries > 200000:
                raise Reject('image archive has too many entries')
            if member.name.endswith('/') and not member.isdir():
                raise Reject('non-directory tar path has a trailing slash')
            name = normalized(member.name)
            end = member.offset_data + ((member.size + 511) // 512) * 512
            last_end = max(last_end, end)
            if member.islnk():
                link_targets.append(normalized(member.linkname))
            if name not in expected:
                continue
            if name in seen:
                raise Reject('duplicate target or ancestor')
            seen.add(name)
            safe_metadata(member, name == TARGET)
            if name != TARGET:
                continue
            if member.size != len(trusted):
                raise Reject('target size differs from verified artifact')
            source = archive.extractfile(member)
            if source is None:
                raise Reject('cannot read target')
            fd = os.open(binary_output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as output:
                offset = 0
                while True:
                    block = source.read(1024 * 1024)
                    if not block:
                        break
                    if block != trusted[offset:offset + len(block)]:
                        raise Reject('target bytes differ from verified artifact')
                    output.write(block)
                    offset += len(block)
                if offset != len(trusted):
                    raise Reject('truncated target file')
    if seen != expected or TARGET in link_targets:
        raise Reject('target or safe ancestor is missing, or target has a hard link')
    if last_end + 1024 > total:
        raise Reject('truncated tar terminator')
    fileobj.seek(last_end)
    while True:
        block = fileobj.read(1024 * 1024)
        if not block:
            break
        if any(block):
            raise Reject('nonzero data after tar terminator')


def alarm_handler(_signum, _frame):
    raise Reject('staging extraction timed out')


class LimitedReader(io.RawIOBase):
    def __init__(self, stream, limit):
        self.stream = stream
        self.remaining = limit

    def read(self, size=-1):
        if size < 0 or size > self.remaining:
            raise Reject('root directory tar exceeds limit')
        data = self.stream.read(size)
        self.remaining -= len(data)
        return data

    def readable(self):
        return True


def verify_root_directory(container):
    process = None
    try:
        process = subprocess.Popen(['docker', 'cp', container + ':/', '-'], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        with tarfile.open(fileobj=LimitedReader(process.stdout, 1024 * 1024), mode='r|') as archive:
            root = archive.next()
            if root is None or normalized(root.name) != '':
                raise Reject('root directory metadata is absent')
            safe_metadata(root, False)
    except (OSError, tarfile.TarError) as exc:
        raise Reject('cannot verify root directory metadata') from exc
    finally:
        if process is not None:
            if process.stdout:
                process.stdout.close()
            if process.poll() is None:
                process.kill()
            process.wait(timeout=10)


def cleanup_container(name, token):
    try:
        query = ['docker', 'container', 'ls', '--all', '--filter', f'name=^/{name}$', '--format', '{{.ID}}']
        status, output = bounded_command(query[1:], 1024)
        if status:
            return False
        identifiers = output.decode('ascii').splitlines()
        if not identifiers:
            return True
        if len(identifiers) != 1 or not re.fullmatch(r'[a-f0-9]{12,64}', identifiers[0]):
            return False
        owned = docker_json(['container', 'inspect', identifiers[0]])
        config = owned.get('Config')
        labels = config.get('Labels') if isinstance(config, dict) else None
        owned_id = owned.get('Id')
        if not isinstance(owned_id, str) or not re.fullmatch(r'[a-f0-9]{64}', owned_id) or \
           not owned_id.startswith(identifiers[0]) or owned.get('Name') != '/' + name or \
           not isinstance(labels, dict) or labels.get(LABEL) != token:
            return False
        removed = subprocess.run(['docker', 'rm', '--force', '--volumes', identifiers[0]], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20, check=False)
        if removed.returncode:
            return False
        status, output = bounded_command(query[1:], 1024)
        return status == 0 and not output.strip()
    except (Reject, OSError, UnicodeError, ValueError, TypeError, subprocess.TimeoutExpired):
        return False


def run(args):
    ref, index_path, index_digest, arch, trusted_path, output_path = args
    output = Path(output_path)
    if not output.is_absolute() or output.name in ('', '.', '..'):
        raise Reject('output directory must be an absolute new path')
    parent = output.parent
    parent_info = parent.lstat()
    if not stat.S_ISDIR(parent_info.st_mode) or parent_info.st_uid != os.geteuid() or stat.S_IMODE(parent_info.st_mode) != 0o700:
        raise Reject('output parent must be a private owned directory')
    index_bytes = read_regular(index_path, 1024 * 1024)
    child = select_index(index_bytes, index_digest, arch, ref)
    trusted = read_regular(trusted_path, MAX_BINARY)
    digest = hashlib.sha256(trusted).hexdigest()
    if digest != HASHES[arch]:
        raise Reject('trusted build artifact digest mismatch')
    os.mkdir(output, 0o700)
    success = False
    attempted = False
    creation_uncertain = False
    proof = None
    token = secrets.token_hex(24)
    container = 'aikayun-restic-evidence-' + token
    previous = {sig: signal.signal(sig, alarm_handler) for sig in (signal.SIGALRM, signal.SIGTERM, signal.SIGINT)}
    signal.setitimer(signal.ITIMER_REAL, 120)
    try:
        image_id = inspect_image(ref, arch)
        attempted = True
        creation_uncertain = True
        status, create_output = bounded_command(['create', '--name', container, '--label', f'{LABEL}={token}',
                                                  '--pull=never', '--platform', f'linux/{arch}', ref], 128)
        if status or not re.fullmatch(rb'[a-f0-9]{64}\s*', create_output):
            raise Reject('cannot create isolated image inspection container')
        creation_uncertain = False
        inspected = docker_json(['container', 'inspect', container])
        config = inspected.get('Config')
        state = inspected.get('State')
        if inspected.get('Id') != create_output.decode('ascii').strip() or inspected.get('Image') != image_id or \
           not isinstance(config, dict) or config.get('Image') != ref or \
           not isinstance(config.get('Labels'), dict) or config['Labels'].get(LABEL) != token or \
           not isinstance(state, dict) or state.get('Running') is not False or inspected.get('Mounts') not in (None, []):
            raise Reject('inspection container does not match local image')
        verify_root_directory(container)
        rootfs_fd = os.open(output / 'rootfs.tar', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(rootfs_fd, 'w+b') as export:
            try:
                process = subprocess.Popen(['docker', 'export', container], stdin=subprocess.DEVNULL,
                                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                total = 0
                rootfs_hash = hashlib.sha256()
                try:
                    while True:
                        block = process.stdout.read(1024 * 1024)
                        if not block:
                            break
                        total += len(block)
                        if total > MAX_TAR:
                            raise Reject('image archive exceeds limit')
                        rootfs_hash.update(block)
                        export.write(block)
                    if process.wait(timeout=20) != 0:
                        raise Reject('image export failed')
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=10)
                    if process.stdout:
                        process.stdout.close()
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise Reject('image export failed') from exc
            export.seek(0)
            validate_tar(export, total, trusted, output / 'restic')
        proof = {'schema': 'aikayun.restic-staging-extraction.v1', 'image_ref': ref,
                 'platform_manifest_digest': child, 'index_digest': index_digest, 'arch': arch,
                 'local_image_id': image_id,
                 'binary_sha256': digest, 'binary_path': str(output / 'restic'),
                 'rootfs_tar_sha256': rootfs_hash.hexdigest(), 'rootfs_tar_path': str(output / 'rootfs.tar')}
        evidence_fd = os.open(output / 'evidence.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(evidence_fd, 'w', encoding='utf8') as f:
            json.dump(proof, f, sort_keys=True, separators=(',', ':'))
            f.write('\n')
        success = True
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        try:
            clean = not attempted or cleanup_container(container, token)
        except Exception:
            clean = False
        if not success or not clean or creation_uncertain:
            shutil.rmtree(output)
        if not clean or creation_uncertain:
            raise Reject('container creation or cleanup could not be verified; inspect the labeled Docker artifacts')
    print('staging image evidence created')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reference')
    parser.add_argument('index')
    parser.add_argument('index_digest')
    parser.add_argument('arch', choices=('amd64', 'arm64'))
    parser.add_argument('trusted_binary')
    parser.add_argument('new_output_directory')
    values = parser.parse_args()
    try:
        run((values.reference, values.index, values.index_digest, values.arch, values.trusted_binary, values.new_output_directory))
    except (Reject, OSError, ValueError, TypeError, RecursionError, tarfile.TarError) as error:
        print('staging image evidence rejected:', str(error) if isinstance(error, Reject) else 'invalid input or environment', file=__import__('sys').stderr)
        raise SystemExit(1)
