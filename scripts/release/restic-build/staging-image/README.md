# Experimental staging image evidence

This is an isolated candidate, **not a release gate or production command**.
It performs no pull, registry write, image promotion, signing or container
start. It trusts the local Docker daemon and requires a caller-supplied OCI
index digest from a separately authenticated source; passing a digest obtained
from the same untrusted index does not authenticate that index. The staging
child reference must already be present locally under the exact staging repo
and digest. A missing digest is rejected, not pulled.

Invocation, after obtaining a trusted index and fixed-source binary for one
architecture:

```sh
python3 scripts/release/restic-build/staging-image/verify-staging-image.py \
  'ghcr.io/yykx682436/aikayun-staging-api@sha256:CHILD' \
  /private/index.json sha256:TRUSTED_INDEX amd64 /private/verified-restic \
  /private/new-evidence-directory
```

The parent of the new evidence directory must be owned by the invoking user
and have mode `0700`. The helper checks the index hash and unique platform
child, local digest reference, platform, image ID, no image-declared volumes,
and an unstarted inspection container's image ID. Because Docker export omits
the root-directory entry, its ownership and permissions are separately checked
from the first header of `docker cp CONTAINER:/ -` for the same container.
`local_image_id` is a Docker
identifier; **it is not the OCI child digest**. The Docker export is parsed as
tar without filesystem extraction. The target and its ancestors must have the
required root ownership and permissions; duplicate paths, hard links, unsafe
metadata, truncation and trailing nonzero data are rejected. The target is
compared byte-for-byte with the separately verified binary and its pinned
platform SHA-256. Time, archive, entry and binary limits apply.

On success the output directory contains `restic`, `rootfs.tar`, and
`evidence.json` (files mode `0600`, directory `0700`). The JSON binds the
reference, child and index digests, architecture, local image ID, binary SHA
and path, and rootfs SHA and path. The tar is the same export that was checked;
it can contain sensitive image material. Keep the entire directory private,
ensure no concurrent writer can change it, check its recorded SHA before every
consumer, and remove it after use. Do not publish the raw tar.

An unknown Docker create outcome or failure to prove cleanup rejects the
operation and removes output. SIGKILL or loss of the daemon can still leave an
unstarted, randomly named `aikayun-restic-evidence-*` container; inspect its
unique `io.aikayun.restic-evidence-token` label and clean it only after proving
ownership. A cleanup-uncertain message does not assert that a container exists.
No helper can prove local image content against a malicious Docker daemon.

`test-staging-image.py` checks real tar fixtures and a simulated daemon.
`test-docker-fixture.py` creates a uniquely named scratch image/container,
checks an actual Docker export and removes those resources; it does not test
an authenticated GHCR staging child digest. A real digest-addressed staging
fixture, consumer integration, system-file tar extraction, SBOM/NOTICE/manifest
binding and full-image release scans remain separate unfinished work.

## Experimental raw SBOM capture

`capture-staging-sbom.py` accepts a staging extraction `evidence.json`, its
independently trusted SHA-256, and a new output directory under a private
`0700` parent. It checks the staging identity and extracted binary, requires
the exact child reference to exist locally, and compares Docker's local image
ID before and after saving and scanning. It never pulls an image. A bounded
private Docker image archive is passed to the fixed Syft image in a read-only,
network-disabled, capability-free, resource-limited container running as the
caller's UID/GID. The Syft `/tmp` tmpfs is limited to 512 MiB and container
memory to 1 GiB; insufficient space or memory rejects the capture. A missing scanner, scanner
failure or malformed/incomplete restic component set rejects the capture.
The saved archive is deleted after the scan; only the unmodified complete
CycloneDX SBOM and its evidence JSON remain in the private output directory.

The evidence schema `aikayun.restic-staging-sbom.v1` records the staging proof
SHA, architecture, image reference, index and platform manifest digests, local
image ID, temporary image-archive SHA, raw SBOM SHA/path, and fixed Syft image
reference. The caller must authenticate the staging proof digest independently
and keep the staging proof, binary and private workspace immutable throughout
the operation. The local daemon and trusted execution environment remain
assumptions. A timeout or unknown scanner creation/cleanup outcome fails closed
and may leave an unstarted or running randomly named
`aikayun-restic-syft-*` container; inspect its unique evidence-token label
before cleaning. SIGKILL can also leave private temporary files.

For an isolated integration check, run `test-capture-staging-sbom.py` with the
fixed arm64 restic binary. The test creates and removes its own scratch image,
executes the **real pinned Syft**, and uses a temporary Docker wrapper solely to
map a synthetic staging reference onto that local image. The wrapper does not
prove a real GHCR digest mapping. This capture does not run Trivy, validate
license compliance, sign an artifact, or replace any full-image release gate.
