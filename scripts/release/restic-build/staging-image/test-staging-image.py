#!/usr/bin/env python3
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import stat
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('staging_image', Path(__file__).with_name('verify-staging-image.py'))
subject = importlib.util.module_from_spec(spec)
spec.loader.exec_module(subject)


def tar_fixture(payload, *, change=None, extra=None):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w', format=tarfile.PAX_FORMAT) as archive:
        for name in (*subject.PARENTS, subject.TARGET):
            member = tarfile.TarInfo(name)
            member.uid = member.gid = 0
            member.mode = 0o755 if name != subject.TARGET else 0o555
            member.type = tarfile.DIRTYPE if name != subject.TARGET else tarfile.REGTYPE
            member.size = 0 if name != subject.TARGET else len(payload)
            if change:
                change(member)
            archive.addfile(member, io.BytesIO(payload) if member.isfile() else None)
        if extra:
            archive.addfile(extra)
    stream.seek(0)
    return stream


class TarChecks(unittest.TestCase):
    def verify(self, stream, payload=b'test-restic'):
        with tempfile.TemporaryDirectory() as work:
            subject.validate_tar(stream, len(stream.getvalue()), payload, Path(work) / 'restic')
            return (Path(work) / 'restic').read_bytes()

    def test_accepts_exact_root_owned_regular_0555(self):
        self.assertEqual(self.verify(tar_fixture(b'test-restic')), b'test-restic')

    def test_rejects_dangerous_metadata_and_changed_bytes(self):
        def mutate(field, value, path=subject.TARGET):
            return lambda item: setattr(item, field, value) if item.name == path else None
        for field, value, path in [('mode', 0o755, subject.TARGET), ('uid', 1000, subject.TARGET),
                                   ('mode', 0o777, 'usr/bin'), ('type', tarfile.SYMTYPE, 'usr/bin')]:
            with self.subTest(field=field, path=path), self.assertRaises(subject.Reject):
                self.verify(tar_fixture(b'test-restic', change=mutate(field, value, path)))
        with self.assertRaises(subject.Reject):
            self.verify(tar_fixture(b'evil-restic'))
        with self.assertRaises(subject.Reject):
            self.verify(tar_fixture(b'test-restic', change=mutate('pax_headers', {'SCHILY.xattr.security.capability': 'x'})))

    def test_rejects_duplicate_traversal_hardlink_and_trailing_data(self):
        for name, typ, link in [(subject.TARGET, tarfile.REGTYPE, ''), ('../escape', tarfile.REGTYPE, ''),
                                ('alias', tarfile.LNKTYPE, subject.TARGET)]:
            item = tarfile.TarInfo(name)
            item.type = typ
            item.linkname = link
            with self.subTest(name=name), self.assertRaises(subject.Reject):
                self.verify(tar_fixture(b'test-restic', extra=item))
        stream = tar_fixture(b'test-restic')
        stream.seek(0, io.SEEK_END)
        stream.write(b'nonzero trailing payload')
        stream.seek(0)
        with self.assertRaises(subject.Reject):
            self.verify(stream)

    def test_rejects_missing_parent(self):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w') as archive:
            item = tarfile.TarInfo(subject.TARGET)
            item.mode = 0o555
            item.size = len(b'test-restic')
            archive.addfile(item, io.BytesIO(b'test-restic'))
        stream.seek(0)
        with self.assertRaises(subject.Reject):
            self.verify(stream)


class IndexChecks(unittest.TestCase):
    def test_only_trusted_matching_unique_staging_child(self):
        child = 'sha256:' + '2' * 64
        ref = subject.REPOSITORY + '@' + child
        descriptor = {'digest': child, 'size': 1234, 'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                      'platform': {'os': 'linux', 'architecture': 'arm64'}}
        index = {'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json', 'manifests': [descriptor]}
        data = json.dumps(index).encode()
        digest = 'sha256:' + hashlib.sha256(data).hexdigest()
        self.assertEqual(subject.select_index(data, digest, 'arm64', ref), child)
        with self.assertRaises(subject.Reject):
            subject.select_index(data, digest, 'amd64', ref)
        with self.assertRaises(subject.Reject):
            subject.select_index(data, 'sha256:' + '3' * 64, 'arm64', ref)
        with self.assertRaises(subject.Reject):
            subject.select_index(data, digest, 'arm64', 'ghcr.io/other/api@' + child)
        index['manifests'].append(descriptor)
        data = json.dumps(index).encode()
        with self.assertRaises(subject.Reject):
            subject.select_index(data, 'sha256:' + hashlib.sha256(data).hexdigest(), 'arm64', ref)
        duplicate = b'{"schemaVersion":2,"schemaVersion":2}'
        with self.assertRaises(subject.Reject):
            subject.select_index(duplicate, 'sha256:' + hashlib.sha256(duplicate).hexdigest(), 'arm64', ref)

    def test_rejects_symlinked_trusted_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'input').write_bytes(b'valid')
            (root/'link').symlink_to(root/'input')
            with self.assertRaises(OSError):
                subject.read_regular(root/'link', 32)


FAKE_DOCKER = r'''#!/usr/bin/env python3
import json, os, pathlib, shutil, sys, tarfile
root=pathlib.Path(os.environ['FAKE_DOCKER_ROOT']); args=sys.argv[1:]; state=root/'state.json'
ref=os.environ['FAKE_REF']; image_id='sha256:'+'1'*64; ident='3'*64
if args[:2]==['image','inspect']:
 if args[2:]!=[ref]: sys.exit(1)
 mode=os.environ.get('FAKE_MODE'); print(json.dumps([{'Id':image_id,'Os':'linux','Architecture':'amd64' if mode=='wrong_arch' else 'arm64','RepoDigests':[] if mode=='wrong_digest' else [ref],'Config':{'Volumes':{'/data':{}} if mode=='volumes' else None}}]))
elif args[0]=='create':
 if '--pull=never' not in args or args[args.index('--platform')+1]!='linux/arm64' or args[-1]!=ref: sys.exit(1)
 name=args[args.index('--name')+1]; label=args[args.index('--label')+1].split('=',1)[1]
 state.write_text(json.dumps({'name':name,'label':label})); print(ident)
 if os.environ.get('FAKE_MODE')=='uncertain': sys.exit(1)
elif args[:2]==['container','inspect']:
 if not state.exists(): sys.exit(1)
 x=json.loads(state.read_text()); mode=os.environ.get('FAKE_MODE'); print(json.dumps([{'Id':('4'*64) if mode=='wrong_container' else ident,'Name':'/'+x['name'],'Image':('sha256:'+'4'*64) if mode=='wrong_id' else image_id,'Config':{'Image':ref,'Labels':{'io.aikayun.restic-evidence-token':x['label']}},'State':{'Running':mode=='running'},'Mounts':[]}]))
elif args[:2]==['container','ls']:
 if state.exists(): print(ident[:12])
elif args[0]=='export':
 if not state.exists() or args[1]!=json.loads(state.read_text())['name']: sys.exit(1)
 with open(root/'rootfs.tar','rb') as src: shutil.copyfileobj(src,sys.stdout.buffer)
elif args[0]=='cp':
 if not state.exists() or args[1]!=json.loads(state.read_text())['name']+':/' or args[2]!='-': sys.exit(1)
 with tarfile.open(fileobj=sys.stdout.buffer,mode='w|') as out:
  member=tarfile.TarInfo('.'); member.type=tarfile.DIRTYPE; member.uid=member.gid=0
  member.mode=0o777 if os.environ.get('FAKE_MODE')=='bad_root' else 0o755; out.addfile(member)
elif args[0]=='rm':
 if os.environ.get('FAKE_MODE')=='cleanup_fail': sys.exit(1)
 state.unlink(missing_ok=True); print(ident)
else: sys.exit(1)
'''


class LocalBoundary(unittest.TestCase):
    def fixture(self, root, payload):
        fake = root / 'docker'
        fake.write_text(FAKE_DOCKER)
        fake.chmod(0o700)
        (root / 'rootfs.tar').write_bytes(tar_fixture(payload).getvalue())
        child = 'sha256:' + '2' * 64
        ref = subject.REPOSITORY + '@' + child
        index = json.dumps({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json',
                            'manifests': [{'digest': child, 'size': 1234, 'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                                           'platform': {'os': 'linux', 'architecture': 'arm64'}}]}).encode()
        (root / 'index').write_bytes(index)
        (root / 'trusted').write_bytes(payload)
        return ref, 'sha256:' + hashlib.sha256(index).hexdigest()

    def test_success_and_cleanup_with_isolated_fake_daemon(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); payload = b'test-restic'; ref, digest = self.fixture(root, payload)
            env = {'PATH': str(root) + os.pathsep + os.environ['PATH'], 'FAKE_DOCKER_ROOT': str(root), 'FAKE_REF': ref}
            with patch.dict(os.environ, env), patch.dict(subject.HASHES, {'arm64': hashlib.sha256(payload).hexdigest()}), contextlib.redirect_stdout(io.StringIO()):
                subject.run((ref, root/'index', digest, 'arm64', root/'trusted', root/'out'))
            proof = json.loads((root/'out/evidence.json').read_text())
            self.assertEqual(proof['schema'], 'aikayun.restic-staging-extraction.v1')
            self.assertEqual(proof['image_ref'], ref)
            self.assertEqual(proof['index_digest'], digest)
            self.assertEqual(proof['arch'], 'arm64')
            self.assertEqual(proof['local_image_id'], 'sha256:' + '1' * 64)
            self.assertEqual(proof['platform_manifest_digest'], ref.split('@')[1])
            self.assertEqual((root/'out/restic').read_bytes(), payload)
            self.assertEqual(proof['rootfs_tar_sha256'], hashlib.sha256((root/'out/rootfs.tar').read_bytes()).hexdigest())
            self.assertEqual(proof['binary_path'], str(root/'out/restic'))
            self.assertEqual(proof['rootfs_tar_path'], str(root/'out/rootfs.tar'))
            self.assertEqual(stat.S_IMODE((root/'out').stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((root/'out/restic').stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE((root/'out/evidence.json').stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE((root/'out/rootfs.tar').stat().st_mode), 0o600)
            self.assertFalse((root/'state.json').exists())

    def test_uncertain_create_and_cleanup_failure_reject_output(self):
        for mode in ('uncertain', 'cleanup_fail'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as d:
                root = Path(d); payload = b'test-restic'; ref, digest = self.fixture(root, payload)
                env = {'PATH': str(root) + os.pathsep + os.environ['PATH'], 'FAKE_DOCKER_ROOT': str(root),
                       'FAKE_REF': ref, 'FAKE_MODE': mode}
                with patch.dict(os.environ, env), patch.dict(subject.HASHES, {'arm64': hashlib.sha256(payload).hexdigest()}), self.assertRaises(subject.Reject):
                    subject.run((ref, root/'index', digest, 'arm64', root/'trusted', root/'out'))
                self.assertFalse((root/'out').exists())
                self.assertEqual((root/'state.json').exists(), mode == 'cleanup_fail')

    def test_rejects_image_or_container_identity_mismatch(self):
        for mode in ('wrong_arch', 'wrong_digest', 'volumes', 'wrong_id', 'wrong_container', 'running', 'bad_root'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as d:
                root = Path(d); payload = b'test-restic'; ref, digest = self.fixture(root, payload)
                env = {'PATH': str(root) + os.pathsep + os.environ['PATH'], 'FAKE_DOCKER_ROOT': str(root),
                       'FAKE_REF': ref, 'FAKE_MODE': mode}
                with patch.dict(os.environ, env), patch.dict(subject.HASHES, {'arm64': hashlib.sha256(payload).hexdigest()}), self.assertRaises(subject.Reject):
                    subject.run((ref, root/'index', digest, 'arm64', root/'trusted', root/'out'))
                self.assertFalse((root/'out').exists())
                self.assertEqual((root/'state.json').exists(), mode == 'wrong_container')

    def test_archive_limit_fails_and_cleans(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); payload = b'test-restic'; ref, digest = self.fixture(root, payload)
            env = {'PATH': str(root) + os.pathsep + os.environ['PATH'], 'FAKE_DOCKER_ROOT': str(root), 'FAKE_REF': ref}
            with patch.dict(os.environ, env), patch.dict(subject.HASHES, {'arm64': hashlib.sha256(payload).hexdigest()}), \
                 patch.object(subject, 'MAX_TAR', 100), self.assertRaises(subject.Reject):
                subject.run((ref, root/'index', digest, 'arm64', root/'trusted', root/'out'))
            self.assertFalse((root/'out').exists())
            self.assertFalse((root/'state.json').exists())


if __name__ == '__main__':
    unittest.main()
