#!/usr/bin/env python3
"""Test the module transformation with an authenticated upstream zip argument."""
import hashlib
import subprocess
import sys
import tempfile
from pathlib import Path
from zipfile import ZipFile

root = Path(__file__).resolve().parent
if len(sys.argv) != 2:
    raise SystemExit('usage: test-make-module.py AUTHENTICATED_UPSTREAM_ZIP')
upstream = Path(sys.argv[1]).resolve()
assert hashlib.sha256(upstream.read_bytes()).hexdigest() == '7d434c06bee279cc0378a23e91e369de8baef9addb64cf968b388ef4bb75ef34'

with tempfile.TemporaryDirectory(prefix='aikayun-restic-module-test-') as tmp:
    work = Path(tmp)
    mod = root / 'go.mod.lock'
    sums = root / 'go.sum.lock'

    def run(source, mod_lock, sum_lock, output):
        return subprocess.run([sys.executable, str(root / 'make-module.py'), str(source),
                               str(mod_lock), str(sum_lock), str(output)], capture_output=True)

    assert run(upstream, mod, sums, work / 'good').returncode == 0
    result = work / 'good/github.com/restic/restic/@v/v0.19.1-aikayun.2.zip'
    with ZipFile(upstream) as original, ZipFile(result) as patched:
        old_prefix = 'github.com/restic/restic@v0.19.1/'
        new_prefix = 'github.com/restic/restic@v0.19.1-aikayun.2/'
        old_files = {name[len(old_prefix):]: original.read(name) for name in original.namelist() if not name.endswith('/')}
        new_files = {name[len(new_prefix):]: patched.read(name) for name in patched.namelist() if not name.endswith('/')}
        assert old_files.keys() == new_files.keys()
        changed = {name for name in old_files if old_files[name] != new_files[name]}
        assert changed == {'go.mod', 'go.sum', 'internal/global/global.go'}
        assert new_files['go.mod'] == mod.read_bytes()
        assert new_files['go.sum'] == sums.read_bytes()
        assert new_files['internal/global/global.go'] == old_files['internal/global/global.go'].replace(
            b'const Version = "0.19.1"', b'const Version = "0.19.1-aikayun.2"')

    bad_mod = work / 'bad.mod'
    bad_mod.write_bytes(mod.read_bytes() + b'\n')
    assert run(upstream, bad_mod, sums, work / 'bad-mod').returncode != 0
    bad_sum = work / 'bad.sum'
    bad_sum.write_bytes(sums.read_bytes() + b'\n')
    assert run(upstream, mod, bad_sum, work / 'bad-sum').returncode != 0
    bad_zip = work / 'bad.zip'
    bad_zip.write_bytes(upstream.read_bytes() + b'\n')
    assert run(bad_zip, mod, sums, work / 'bad-zip').returncode != 0
    print('module patch and three altered-input rejections passed')
