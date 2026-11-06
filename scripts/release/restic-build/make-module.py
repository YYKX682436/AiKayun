#!/usr/bin/env python3
"""Produce the identified AiKayun restic module from the verified upstream zip."""
import hashlib
import json
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

UPSTREAM_SHA256 = '7d434c06bee279cc0378a23e91e369de8baef9addb64cf968b388ef4bb75ef34'
MOD_SHA256 = '385c29dcede271f8ef0bc873433de2530140385324fdbabcfef66a9692ff1d9d'
SUM_SHA256 = 'b8e813329ad962b916656e163d562dcb3f314a91cba4fec8cacff1d6914547ed'
PATCHED_ZIP_SHA256 = '9261f2f631339c5e5285775df96051e7e944c717190ecc60e39b9ef8c0c1d179'
UPSTREAM_PREFIX = 'github.com/restic/restic@v0.19.1/'
VERSION = 'v0.19.1-aikayun.2'
OUTPUT_PREFIX = f'github.com/restic/restic@{VERSION}/'


def verified(path, expected):
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError(f'input digest mismatch: {path.name}')
    return data


def main():
    if len(sys.argv) != 5:
        raise SystemExit('usage: make-module.py UPSTREAM_ZIP MOD_LOCK SUM_LOCK PROXY_DIRECTORY')
    upstream, mod, sums, proxy = map(Path, sys.argv[1:])
    verified(upstream, UPSTREAM_SHA256)
    locked = {'go.mod': verified(mod, MOD_SHA256), 'go.sum': verified(sums, SUM_SHA256)}
    output = proxy / 'github.com/restic/restic/@v'
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f'{VERSION}.zip'
    seen = set()
    with ZipFile(upstream) as source, ZipFile(archive, 'x', compression=ZIP_DEFLATED, compresslevel=9) as target:
        for name in sorted(source.namelist()):
            if name.endswith('/'):
                continue
            if not name.startswith(UPSTREAM_PREFIX) or name in seen:
                raise ValueError('invalid or duplicate upstream module path')
            seen.add(name)
            relative = name[len(UPSTREAM_PREFIX):]
            if not relative or any(part in ('', '.', '..') for part in relative.split('/')):
                raise ValueError('invalid upstream module path')
            data = locked.get(relative)
            if data is None:
                data = source.read(name)
            if relative == 'internal/global/global.go':
                original = b'const Version = "0.19.1"'
                if data.count(original) != 1:
                    raise ValueError('upstream version constant differs from the reviewed source')
                data = data.replace(original, b'const Version = "0.19.1-aikayun.2"')
            info = ZipInfo(OUTPUT_PREFIX + relative, (1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            target.writestr(info, data)
    verified(archive, PATCHED_ZIP_SHA256)
    (output / f'{VERSION}.mod').write_bytes(locked['go.mod'])
    (output / f'{VERSION}.info').write_text(json.dumps(
        {'Version': VERSION, 'Time': '2026-07-05T07:52:50Z'}, separators=(',', ':')) + '\n')


if __name__ == '__main__':
    main()
