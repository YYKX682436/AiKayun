#!/usr/bin/env python3
"""Validate a candidate raw OCI index without performing any registry operation."""
import importlib.util
import sys
from pathlib import Path
sys.dont_write_bytecode = True
spec=importlib.util.spec_from_file_location('staging_image',Path(__file__).with_name('verify-staging-image.py'))
subject=importlib.util.module_from_spec(spec);spec.loader.exec_module(subject)
try:
    if len(sys.argv)!=5: raise subject.Reject('invalid arguments')
    path,digest,arch,ref=sys.argv[1:]
    subject.select_index(subject.read_regular(path,1024*1024),digest,arch,ref)
    print('OCI index identity verified')
except (subject.Reject,OSError,ValueError,TypeError):
    print('OCI index rejected',file=sys.stderr)
    raise SystemExit(1)
