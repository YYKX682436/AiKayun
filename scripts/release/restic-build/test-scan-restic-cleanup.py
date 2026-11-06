#!/usr/bin/env python3
"""No-network test of the real scanner wrapper's uncertain-cleanup boundary."""
import hashlib
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


class ScannerCleanupTest(unittest.TestCase):
    def test_unverified_container_keeps_private_work_for_a_late_writer(self):
        root = Path(tempfile.mkdtemp(prefix='aikayun-restic-scan-test-')).resolve()
        try:
            bindir = root / 'bin'; bindir.mkdir(mode=0o700)
            work = root / 'work'; work.mkdir(mode=0o700)
            subset = root / 'subset.json'; subset.write_text('{}')
            proof = root / 'proof.json'; proof.write_text('{}')
            docker = bindir / 'docker'
            docker.write_text('''#!/bin/sh
if [ "$1" = run ]; then ( sleep 1; printf alive > "$FIXTURE_WORK/writer" ) >/dev/null 2>&1 & exit 1; fi
if [ "$1" = container ] && [ "$2" = ls ]; then exit 9; fi
exit 9
''')
            docker.chmod(0o700)
            env = {**os.environ, 'PATH': f'{bindir}:{os.environ["PATH"]}', 'FIXTURE_WORK': str(work)}
            script = Path(__file__).with_name('scan-restic-sbom.sh')
            result = subprocess.run(['bash', str(script), str(subset), str(proof),
                                     hashlib.sha256(proof.read_bytes()).hexdigest(), str(work)],
                                    env=env, capture_output=True, timeout=15, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b'cleanup could not be verified', result.stderr)
            time.sleep(1.5)
            self.assertEqual((work / 'writer').read_text(), 'alive')
        finally:
            import shutil
            shutil.rmtree(root)


if __name__ == '__main__':
    unittest.main()
