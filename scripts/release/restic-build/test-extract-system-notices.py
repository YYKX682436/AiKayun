#!/usr/bin/env python3
"""Fault tests for the experimental rootfs notice extractor."""
import hashlib, io, json, subprocess, sys, tarfile, tempfile, unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('extract-system-notices.py')
NODE_LICENSE = Path(__file__).with_name('node-24-LICENSE').read_bytes()
FLOCK_LICENSE = (Path(__file__).parent.parent / 'upstream-notices/util-linux-2.41.5-COPYRIGHT').read_bytes()

class NoticeExtractionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='aikayun-system-notice-test-')
        self.root = Path(self.tmp.name)
    def tearDown(self): self.tmp.cleanup()
    def run_case(self, change=None, trusted=True):
        archive = self.root/'rootfs.tar'
        with tarfile.open(archive,'w') as t:
            d=tarfile.TarInfo('nodejs'); d.type=tarfile.DIRTYPE; d.mode=0o755; d.uid=d.gid=0
            if change=='writable-directory': d.mode=0o777
            t.addfile(d)
            f=tarfile.TarInfo('nodejs/LICENSE'); f.uid=f.gid=0; f.mode=0o644
            content=NODE_LICENSE
            if change=='link': f.type=tarfile.SYMTYPE; f.linkname='/etc/passwd'; f.size=0; t.addfile(f)
            else:
                if change=='non-root': f.uid=1000
                if change=='oversized': content=b'x'*(1024*1024+1)
                f.size=len(content); t.addfile(f,io.BytesIO(content))
            if change=='duplicate': t.addfile(f,io.BytesIO(content))
            if change=='traversal':
                bad=tarfile.TarInfo('../escape'); bad.size=1; t.addfile(bad,io.BytesIO(b'x'))
            for name in ('usr','usr/share','usr/share/doc','usr/share/doc/util-linux'):
                d=tarfile.TarInfo(name);d.type=tarfile.DIRTYPE;d.uid=d.gid=0;d.mode=0o755;t.addfile(d)
            if change!='missing-flock':
                data=FLOCK_LICENSE+(b'tampered' if change=='changed-flock' else b'')
                f=tarfile.TarInfo('usr/share/doc/util-linux/copyright');f.uid=f.gid=0;f.mode=0o644;f.size=len(data);t.addfile(f,io.BytesIO(data))
        h=hashlib.sha256(archive.read_bytes()).hexdigest()
        proof=self.root/'proof.json'; proof.write_text(json.dumps({'schema':'aikayun.restic-staging-extraction.v1','arch':'arm64','rootfs_tar_path':str(archive),'rootfs_tar_sha256':h}))
        digest=hashlib.sha256(proof.read_bytes()).hexdigest() if trusted else '0'*64
        output=self.root/'result'
        r=subprocess.run([sys.executable,str(SCRIPT),str(proof),digest,str(output)],capture_output=True)
        return r,output
    def test_valid(self):
        r,out=self.run_case(); self.assertEqual(r.returncode,0); self.assertEqual((out/'nodejs/LICENSE').read_bytes(),NODE_LICENSE)
    def test_rejects_tampering_and_unsafe_tar(self):
        for change in ('writable-directory','link','non-root','oversized','duplicate','traversal','missing-flock','changed-flock','untrusted-proof'):
            with self.subTest(change=change), tempfile.TemporaryDirectory(prefix='aikayun-system-subtest-') as sub:
                self.root=Path(sub)
                r,out=self.run_case(None if change=='untrusted-proof' else change, trusted=change!='untrusted-proof')
                self.assertNotEqual(r.returncode,0); self.assertFalse(out.exists())
    def test_rejects_linked_rootfs_or_proof(self):
        r,out=self.run_case(); self.assertEqual(r.returncode,0)
        archive=self.root/'rootfs.tar'; proof=self.root/'proof.json'; link=self.root/'link'
        link.symlink_to(archive); data=json.loads(proof.read_text()); data['rootfs_tar_path']=str(link); proof.write_text(json.dumps(data))
        digest=hashlib.sha256(proof.read_bytes()).hexdigest(); target=self.root/'bad-rootfs'
        r=subprocess.run([sys.executable,str(SCRIPT),str(proof),digest,str(target)],capture_output=True)
        self.assertNotEqual(r.returncode,0); self.assertFalse(target.exists())
        proof_link=self.root/'proof-link';proof_link.symlink_to(proof); target=self.root/'bad-proof'
        r=subprocess.run([sys.executable,str(SCRIPT),str(proof_link),digest,str(target)],capture_output=True)
        self.assertNotEqual(r.returncode,0);self.assertFalse(target.exists())

if __name__=='__main__': unittest.main()
