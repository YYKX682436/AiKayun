#!/usr/bin/env python3
"""Exercise the real private entry point with *all* subprocesses replaced.

No Docker daemon, network, signing, or publication is used. Synthetic artifacts
test sequencing and fail-closed behavior only; they do not prove image identity,
the evidence tools, or the release workflow's sign/promotion ordering.
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('helper_evidence_entry', HERE / 'prepare-helper-evidence.py')
subject = importlib.util.module_from_spec(spec)
spec.loader.exec_module(subject)

STEPS = ('build', 'stage', 'sbom', 'system', 'pull', 'collector', 'notice')
PAYLOAD = b'fixture-only-helper-binary'


class Fixture:
    def __init__(self, root, fail=None, omit=None, cleanup=True, timeout=None, payload=PAYLOAD):
        root = root.resolve()
        self.root = root
        self.fail = fail
        self.omit = omit
        self.cleanup_ok = cleanup
        self.timeout = timeout
        self.payload = payload
        self.events = []
        self.containers = []
        self.index = root / 'index.json'
        self.index.write_text('{}')
        self.out = root / 'evidence'

    def run(self, args, **kwargs):
        # Deny every unknown external program and every unexpected command.
        # Returning a fake result cannot invoke a daemon, executable or socket.
        if args[:3] == ['docker', 'buildx', 'build']:
            step = 'build'
            assert '--push' not in args and '--target' in args
            assert args[args.index('--target') + 1] == 'restic-evidence'
        elif len(args) >= 2 and args[0] == sys.executable:
            step = {'verify-staging-image.py': 'stage', 'capture-staging-sbom.py': 'sbom',
                    'extract-system-notices.py': 'system'}.get(Path(args[1]).name)
        elif args[:2] == ['docker', 'pull'] and args[2:] == [subject.GO_IMAGE]:
            step = 'pull'
        elif args[:2] == ['docker', 'run']:
            step = 'collector'
            assert '--network=none' in args and '--pull=never' in args
            self.containers.append(args[args.index('--name') + 1])
        elif len(args) >= 2 and args[0] == 'node' and Path(args[1]).name == 'prepare-notice.mjs':
            step = 'notice'
        else:
            raise AssertionError('unexpected external command')
        if step not in STEPS:
            raise AssertionError('unexpected evidence subprocess')
        self.events.append(step)
        if self.timeout == step:
            raise subprocess.TimeoutExpired(args, 1)
        if self.fail == step:
            return subprocess.CompletedProcess(args, 1)
        outputs = {
            'build': ('inputs/restic', self.payload),
            'stage': ('stage/evidence.json', b'{}'),
            'sbom': ('sbom/evidence.json', b'{}'),
            'system': ('system/system-notices-proof.json', b'{}'),
            'collector': ('licenses/license-evidence.json', b'{}'),
        }
        if step in outputs and self.omit != step:
            name, data = outputs[step]
            path = self.out / name
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            path.write_bytes(data)
        return subprocess.CompletedProcess(args, 0)

    def cleanup(self, name, token):
        self.events.append('cleanup')
        assert name == 'aikayun-restic-collector-' + token
        assert len(token) == 48 and all(c in '0123456789abcdef' for c in token)
        return self.cleanup_ok

    def invoke(self, arch='arm64', output=None):
        argv = ['prepare-helper-evidence.py', 'fixture-reference', str(self.index),
                'sha256:' + 'a' * 64, arch, str(output or self.out)]
        with patch.object(sys, 'argv', argv), patch.object(subject.subprocess, 'run', self.run), \
             patch.object(subject.staging, 'cleanup_container', self.cleanup), \
             patch.dict(subject.staging.HASHES, {arch: hashlib.sha256(PAYLOAD).hexdigest()} if arch in ('arm64', 'amd64') else {}), \
             contextlib.redirect_stdout(io.StringIO()):
            return subject.main()


class EntrySequencing(unittest.TestCase):
    def fixture(self, root, **kwargs):
        os.chmod(root, 0o700)
        return Fixture(Path(root), **kwargs)

    def test_normal_sequence_and_private_output(self):
        with tempfile.TemporaryDirectory(prefix='aikayun-helper-entry-test-') as tmp:
            f = self.fixture(tmp)
            for arch in ('arm64', 'amd64'):
                with self.subTest(arch=arch), tempfile.TemporaryDirectory(dir=tmp) as child:
                    f = self.fixture(child)
                    f.invoke(arch=arch)
                    self.assertEqual(f.events, ['build', 'stage', 'sbom', 'system', 'pull', 'collector', 'cleanup', 'notice'])
                    self.assertEqual(f.out.stat().st_mode & 0o777, 0o700)
                    self.assertEqual(len(f.containers), 1)

    def test_each_subprocess_failure_stops_at_that_step(self):
        for failed in STEPS:
            with self.subTest(failed=failed), tempfile.TemporaryDirectory(prefix='aikayun-helper-entry-test-') as tmp:
                f = self.fixture(tmp, fail=failed)
                with self.assertRaises(subject.staging.Reject):
                    f.invoke()
                self.assertEqual([x for x in f.events if x != 'cleanup'], list(STEPS[:STEPS.index(failed) + 1]))
                self.assertTrue(f.out.is_dir(), 'failed private output must be retained')
                self.assertEqual(f.events.count('cleanup'), 1 if failed == 'collector' else (1 if failed == 'notice' else 0))

    def test_missing_intermediate_material_stops(self):
        # Each material is consumed later by an actual digest() call.
        expected = {'build': ['build'], 'stage': ['build', 'stage'],
                    'sbom': ['build', 'stage', 'sbom', 'system', 'pull', 'collector', 'cleanup'],
                    'system': ['build', 'stage', 'sbom', 'system', 'pull', 'collector', 'cleanup'],
                    'collector': ['build', 'stage', 'sbom', 'system', 'pull', 'collector', 'cleanup']}
        for missing, events in expected.items():
            with self.subTest(missing=missing), tempfile.TemporaryDirectory(prefix='aikayun-helper-entry-test-') as tmp:
                f = self.fixture(tmp, omit=missing)
                with self.assertRaises(OSError):
                    f.invoke()
                self.assertEqual(f.events, events)
                self.assertTrue(f.out.is_dir())

    def test_collector_cleanup_uncertain_stops_notice(self):
        with tempfile.TemporaryDirectory(prefix='aikayun-helper-entry-test-') as tmp:
            f = self.fixture(tmp, cleanup=False)
            with self.assertRaises(subject.staging.Reject):
                f.invoke()
            self.assertEqual(f.events, ['build', 'stage', 'sbom', 'system', 'pull', 'collector', 'cleanup', 'cleanup'])
            self.assertTrue(f.out.is_dir())

    def test_timeout_stops_later_steps_and_retains_output(self):
        for step in STEPS:
            with self.subTest(step=step), tempfile.TemporaryDirectory(prefix='aikayun-helper-entry-test-') as tmp:
                f = self.fixture(tmp, timeout=step)
                # Collector timeout is intentionally replaced by an unsafe-cleanup
                # rejection in the actual entry point's finally block.
                error = subject.staging.Reject if step == 'collector' else subprocess.TimeoutExpired
                with self.assertRaises(error):
                    f.invoke()
                self.assertEqual([x for x in f.events if x != 'cleanup'], list(STEPS[:STEPS.index(step) + 1]))
                self.assertTrue(f.out.is_dir())

    def test_changed_helper_bytes_reject_before_stage(self):
        with tempfile.TemporaryDirectory(prefix='aikayun-helper-entry-test-') as tmp:
            f = self.fixture(tmp, payload=b'different-binary')
            with self.assertRaises(subject.staging.Reject):
                f.invoke()
            self.assertEqual(f.events, ['build'])
            self.assertTrue(f.out.is_dir())

    def test_invalid_platform_or_unsafe_parent_never_runs_commands(self):
        with tempfile.TemporaryDirectory(prefix='aikayun-helper-entry-test-') as tmp:
            f = self.fixture(tmp)
            with self.assertRaises(subject.staging.Reject):
                f.invoke(arch='other')
            self.assertEqual(f.events, [])
            self.assertFalse(f.out.exists())
            os.chmod(tmp, 0o755)
            with self.assertRaises(subject.staging.Reject):
                f.invoke()
            self.assertEqual(f.events, [])
            self.assertFalse(f.out.exists())

    def test_existing_destination_is_not_overwritten(self):
        with tempfile.TemporaryDirectory(prefix='aikayun-helper-entry-test-') as tmp:
            f = self.fixture(tmp)
            f.out.mkdir(mode=0o700)
            marker = f.out / 'marker'
            marker.write_text('fixture')
            with self.assertRaises(FileExistsError):
                f.invoke()
            self.assertEqual(marker.read_text(), 'fixture')
            self.assertEqual(f.events, [])

    def test_symlink_and_noncanonical_parent_rejected(self):
        with tempfile.TemporaryDirectory(prefix='aikayun-helper-entry-test-') as tmp:
            f = self.fixture(tmp)
            link = f.root / 'link'
            link.symlink_to(f.root, target_is_directory=True)
            for output in (link / 'new-output', f.root / 'link' / '..' / 'new-output'):
                with self.subTest(output=str(output)), self.assertRaises(subject.staging.Reject):
                    f.invoke(output=output)
            self.assertFalse((f.root / 'new-output').exists())
            self.assertEqual(f.events, [])


if __name__ == '__main__':
    unittest.main()
