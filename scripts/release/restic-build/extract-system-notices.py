#!/usr/bin/env python3
"""Experimental; derive NOTICE source files only from the verified staging rootfs."""
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tarfile
from pathlib import Path

MAX_TAR = 2 * 1024 * 1024 * 1024
MAX_FILE = 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024
MAX_MEMBERS = 200_000
LICENSE = re.compile(r'^(copyright|license|licence|copying|notice)([._-].*)?$', re.I)


def sha_stream(source):
    digest = hashlib.sha256()
    total = 0
    source.seek(0)
    for block in iter(lambda: source.read(1024 * 1024), b''):
        total += len(block)
        if total > MAX_TAR: raise ValueError('rootfs exceeds limit')
        digest.update(block)
    source.seek(0)
    return digest.hexdigest()


def open_regular(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_size <= 0 or s.st_size > maximum:
            raise ValueError('invalid input file')
        return os.fdopen(fd, 'rb')
    except BaseException:
        os.close(fd)
        raise


def mapping(name):
    for original, target in [('usr/share/doc/', 'doc/'), ('usr/share/common-licenses/', 'common-licenses/'),
                             ('usr/share/licenses/', 'licenses/')]:
        if name.startswith(original) and LICENSE.fullmatch(name.rsplit('/', 1)[-1]):
            return target + name[len(original):]
    if name == 'nodejs/LICENSE': return 'nodejs/LICENSE'
    if name == 'lib/apk/db/installed': return 'lib/apk/db/installed'
    return None


def main():
    os.umask(0o077)
    if len(sys.argv) != 4:
        raise ValueError('usage: extract-system-notices.py STAGING_PROOF EXPECTED_PROOF_SHA NEW_OUTPUT_DIR')
    proof_path, trusted, output = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
    if not re.fullmatch(r'[a-f0-9]{64}', trusted): raise ValueError('invalid proof digest')
    with open_regular(proof_path, 1024 * 1024) as source:
        proof_bytes = source.read(1024 * 1024 + 1)
    if len(proof_bytes) > 1024 * 1024 or hashlib.sha256(proof_bytes).hexdigest() != trusted: raise ValueError('staging proof digest mismatch')
    proof = json.loads(proof_bytes)
    if proof.get('schema') != 'aikayun.restic-staging-extraction.v1' or proof.get('arch') not in ('arm64','amd64'):
        raise ValueError('invalid staging proof')
    archive = Path(proof['rootfs_tar_path'])
    if not archive.is_absolute() or not re.fullmatch(r'[a-f0-9]{64}', proof['rootfs_tar_sha256']): raise ValueError('invalid rootfs proof')
    archive_stream = open_regular(archive, MAX_TAR)
    if sha_stream(archive_stream) != proof['rootfs_tar_sha256']:
        archive_stream.close()
        raise ValueError('rootfs digest mismatch')
    if not output.is_absolute(): raise ValueError('output must be absolute')
    parent = output.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid() or stat.S_IMODE(parent.st_mode) != 0o700:
        raise ValueError('output parent must be private')
    output.mkdir(mode=0o700)
    success = False
    try:
        selected = []; dirs = {}; seen = set(); total = 0
        with tarfile.open(fileobj=archive_stream, mode='r:') as tar:
            for i, member in enumerate(tar):
                if i >= MAX_MEMBERS: raise ValueError('rootfs has too many entries')
                name = member.name.rstrip('/')
                parts = name.split('/')
                if not name or name.startswith('/') or '\\' in name or any(p in ('', '.', '..') for p in parts):
                    raise ValueError('invalid rootfs path')
                if name in seen: raise ValueError('duplicate rootfs path')
                seen.add(name)
                if member.isdir(): dirs[name] = member
                destination = mapping(name)
                if destination is None: continue
                if not member.isfile() or member.issym() or member.islnk() or member.uid != 0 or member.gid != 0 or member.mode & 0o022:
                    raise ValueError('unsafe notice source')
                if any(k.startswith(('SCHILY.xattr.', 'LIBARCHIVE.xattr.')) for k in member.pax_headers): raise ValueError('notice source has extended attributes')
                if member.size <= 0 or member.size > MAX_FILE: raise ValueError('notice source size out of bounds')
                total += member.size
                if total > MAX_TOTAL: raise ValueError('notice sources exceed total limit')
                selected.append((member, destination))
            records = []
            for member, destination in selected:
                parts = member.name.rstrip('/').split('/')
                for n in range(1, len(parts)):
                    directory = dirs.get('/'.join(parts[:n]))
                    if directory is None or directory.uid != 0 or directory.gid != 0 or directory.mode & 0o022:
                        raise ValueError('unsafe notice ancestor')
                source = tar.extractfile(member)
                if source is None: raise ValueError('unreadable notice source')
                data = source.read(MAX_FILE + 1)
                if len(data) != member.size: raise ValueError('notice source truncated')
                path = output / destination
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'wb') as target: target.write(data)
                records.append({'source':member.name, 'path':destination, 'size':len(data), 'sha256':hashlib.sha256(data).hexdigest()})
        required = {'nodejs/LICENSE':'5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace',
                    'doc/util-linux/copyright':'56b67e2eb8bac5a15d91e261d558d73f1f029113cced229753138194997366b6'}
        found = {record['path']:record['sha256'] for record in records}
        if any(found.get(path) != digest for path,digest in required.items()):
            raise ValueError('required runtime notice missing or changed')
        if sha_stream(archive_stream) != proof['rootfs_tar_sha256']:
            raise ValueError('rootfs changed during notice extraction')
        record = {'schema':'aikayun.restic-system-notices.v1','staging_proof_sha256':trusted,
                  'rootfs_tar_sha256':proof['rootfs_tar_sha256'],'arch':proof['arch'],'files':sorted(records,key=lambda x:x['path'])}
        fd = os.open(output/'system-notices-proof.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as target: json.dump(record,target,separators=(',',':')); target.write('\n')
        success=True
        print(json.dumps({'arch':proof['arch'],'verified_system_notice_files':len(records)}))
    finally:
        archive_stream.close()
        if not success: shutil.rmtree(output)


if __name__ == '__main__':
    try: main()
    except (OSError, ValueError, KeyError, tarfile.TarError, json.JSONDecodeError):
        print('System notice extraction rejected.', file=sys.stderr)
        raise SystemExit(1)
