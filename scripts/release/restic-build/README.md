# Internal Restic reader build and release evidence

This directory contains the independent Restic reader's locked source, license
tooling, and historical experiments. The customer command is the signed host
launcher `/opt/aikayun/aikayun backup create`. It runs a host-side Docker broker
from the signed release package; the API image contains no Docker CLI, Compose
CLI, Bash, or Docker socket. The separate reader remains a fixed-digest,
least-privilege image with read-only business sources and no socket.

The R3 local worktree has not been published or signed by the formal release
workflow. The R2 API archive scan finding for `libtinfo6` came from a helper
tool layer that R3 removes from the API target. R3 must rebuild and scan full
API image archives for both architectures with the same Trivy version, database
and parameters before code acceptance; the baseline `zlib1g` HIGH remains a
formal release blocker unless a supported fix becomes available. Earlier local
reader archives had 82 SBOM components, zero HIGH/CRITICAL and zero secret
findings. Those historical unsigned results do not substitute for this round's
re-scan or prove a production release digest, signature, or GHCR publication.

No CVE is ignored, scan threshold is not lowered, and the full image SBOM is
never replaced by a Restic-only scan input. The historical helper-tool and
system-library experiments below are not part of the production API or reader
runtime.

The development-only `license-collector/` checks the actual binary build info
against the platform SBOM and each module ZIP using the pinned official Go
`x/mod` ZIP validator and directory hash. It pins the main-module h1 and the
independently reproduced binary SHA-256 for each supported architecture, and
checks both SBOM component identities and PURLs. It collects all files whose names
match LICENSE, LICENCE, NOTICE, COPYING or COPYRIGHT (including nested files)
and records their module version, original path, SHA-256 and full text. It also
conservatively collects matching files from the pinned Go toolchain directory.
Its integration test runs offline with read-only inputs and exercises missing
SBOM entries and PURLs, altered binary, ZIP hashes and contents, and unsafe ZIP paths. Supply a
private, immutable module-cache snapshot: a read-only container mount does not
prevent a separate host process from modifying the same files. The Go root must
come from the fixed toolchain image above, not an arbitrary directory.

Collector output is private (directory `0700`, file `0600`) and may contain
unreviewed upstream text. It must be secret-scanned before inclusion in any
release. Matching these filenames does not establish legal compatibility or
prove that differently named required notices do not exist. This collector does
not replace the existing release NOTICE generator or validate a final image.

The independent `staging-image/` candidate checks an authenticated OCI index,
the selected local staging child image and rootfs, and the actual restic bytes.
`extract-system-notices.py` derives the original system NOTICE inputs from that
same rootfs; `prepare-notice.mjs` independently repeats this extraction, feeds
verified Go notices through a private offline cache to the **unchanged**
existing NOTICE generator, retains all non-Go checks, and secret-scans the
completed NOTICE files and raw OCI index. Its output contains only bounded
`NOTICE-*` files: the original image NOTICE, complete verified restic licenses,
their machine-readable Go and system source evidence, the index, sanitized
staging/SBOM proof projections, an evidence binding and a sanitized scanner
declaration. It does not publish the rootfs, module cache, or private local
paths. The signed verifier checks that the human-readable restic NOTICE matches
its full Go evidence and independently regenerates the entire original NOTICE
offline from the signed full SBOM and signed license evidence, requiring exact
bytes. The sanitized proof projections bind their fields and the hashes of the
private source proofs as signed build statements; they do not allow an outside
verifier to reconstruct the private source-proof bytes. The original private
license evidence hash is likewise a build statement; published canonical
license evidence has its own digest and cannot reconstruct those original bytes.
Unrecognized fields in source license evidence are rejected before publication.

`verify-release-binding.mjs` uses the existing canonical manifest/JWS and
artifact verifier, requires an independently pinned public-key digest, checks
all of those files and the original API SBOM against the signed manifest, and
validates the included index against the signed platform child. A signed scan
declaration proves what the signer asserted; it does not independently prove
that Trivy ran. The trusted build must run the real scanner before signing or
the verifier must rescan. Inputs and staging proof must come from a controlled
workflow on a trusted Docker daemon, trusted Python/Docker executables and PATH,
with an immutable private snapshot. The
candidate has not been wired into that workflow, and real GHCR staging
digest-to-extraction behavior has not been exercised. Synthetic staging
identities used by local tests are not release evidence.

The isolated candidate sequence is: authenticate the staging OCI index and
extract the child with `staging-image/verify-staging-image.py`; capture a new
full-image SBOM with `staging-image/capture-staging-sbom.py`; derive system
notices from that extraction with `extract-system-notices.py`; run the Go
license collector against the extracted binary, captured SBOM and immutable
module snapshot; and pass the independently retained proof hashes to
`prepare-notice.mjs`. After the existing release assembler includes the
resulting `NOTICE-*` files and SBOM, the signed manifest can be checked with
`verify-release-binding.mjs`. None of these steps replaces the existing
full-image Trivy gate, independent artifact verification or image signing.
The full-image SBOM is never replaced by the restic-only scan input.

`prepare-helper-evidence.py` executes that private pre-sign sequence against
one selected staging child and independently builds the collector and module
cache with the non-default `restic-evidence` Dockerfile target. The helper
candidate's fixed executable path is `/usr/bin/restic`. On failed or uncertain
collector execution it retains its private directory; the NOTICE and restic
scanner similarly preserve their mounts when container cleanup cannot be
proven. The non-default helper target also includes Docker, Compose, tar, shell
tools and same-source helper scripts, but its additional Go dependencies do not
yet have complete license evidence, and the real full-image vulnerability gate
blocks the current two library findings. It cannot be released or treated as a
complete production helper. No release script currently invokes this pipeline.

On 2026-11-05 isolated `runtime-helper` images built and ran the fixed tool
probe on arm64 and amd64. Both included Docker 29.9.3 and Compose 5.7.0 from
Docker's fixed multi-platform image, and the checked-in build verifies their
separate architecture-specific hashes and self-reported versions. Syft's
arm64 full-image SBOM identified all eleven added Debian package records and
196 Go components. The existing unmodified Trivy image gate **blocked both
architectures**, each with two HIGH findings: CVE-2025-69720 for libtinfo6 and
CVE-2026-54369 for libacl1. The result is not a release pass.

An independent disposable fixture installed the Debian-signed sid tar
1.35+dfsg-7 and libacl1 2.4.0-1 after verifying each downloaded `.deb` against
its fixed architecture-specific SHA-256. Its metadata reported those real
package versions, but the same Trivy image gate still reported the libacl
finding under the trixie image's security data; no finding was suppressed.
Separate two-architecture tests exercised basic file and extended ACL archive
round trips, but did not verify xattr round trips or a complete backup. These
packages are not used by the production or candidate Dockerfile.

Debian sid's fixed libtinfo binary requires glibc 2.42 and fails to start Bash
on this image's glibc 2.41. As an exploratory check, Debian ncurses
6.6+20260608-2 source obtained through the signed apt source index was compiled
on the pinned trixie toolchain for both
architectures. The resulting libraries retained all 276 defined dynamic symbol
records, including symbol versions, from the previous libraries and ran a basic Bash check. This is not a
complete ABI, reproducibility, vulnerability or packaging proof: no authentic
locally rebuilt Debian package, complete source/patch/build-dependency lock,
Go-tool licenses, signed evidence or backup regression has been completed.
The exploratory binaries are not copied into the image. See Debian's
[ncurses tracker](https://security-tracker.debian.org/tracker/CVE-2025-69720)
and [ACL tracker](https://security-tracker.debian.org/tracker/CVE-2026-54369).

A later isolated ARM64 Debian-rules build used a distinct local package
revision `6.6+20260608-2+aikayun1`, the original Debian source and patches,
and a fixed `SOURCE_DATE_EPOCH`. Two offline containers using the same locally
prepared trixie build image produced identical target `libtinfo6` packages
(SHA-256 `69fd14c738ec929ff50e14a6830e11b4f83c55a557d8f2afe70b188fad34c2b9`);
three other output packages differed. An independent comparison found their
file contents, control archives and metadata identical except for directory
mtimes differing by one second; the originating command was not identified.
Build dependencies were recorded by
version but were not locked to verified package hashes. A real Debian 13
image with that installed package was identified correctly by Syft; Trivy
still reported CVE-2025-69720 HIGH against the local revision, so the existing
image gate blocked. The scan used Trivy DB v2 updated at
`2026-11-04T13:16:53.670958885Z`, whose local `trivy.db` SHA-256 was
`a67ff9c9be87f4da4e9c18da5ecf1c32954ff62d489f0771f08e7fd508c74e64`.
These point-in-time results do not establish a reproducible full release build
or authorize bypassing that finding.

The first experiment's fixed epoch was later than the actual UTC build clock,
so ordinary creation times were not clamped by the packager. With the local
changelog and `SOURCE_DATE_EPOCH` moved to `2026-11-04T00:00:00Z`, two new
offline ARM64 containers using the same local build environment produced all
11 `.deb` files byte-identically; the target package SHA-256 was
`dc75e5c208e10348e792f01409eeb3e3f61084f648e5f725e72d2002f61477ab`.
The target ELF matched the first experiment byte-for-byte. The same procedure
also produced 11 byte-identical AMD64 `.deb` files in two isolated containers
under Docker Desktop emulation; the target package SHA-256 was
`91894078c89c658189ce43bbf3913680a39caba42ffd8e612e3d963ed14079d8`,
and its ELF also matched the first AMD64 experiment. Trivy blocked both
architectures on the locally rebuilt libtinfo in the trixie image. These remain
same-environment experiments with unpinned build-dependency packages and no
native AMD64 verification, not an independently reproducible release supply
chain or a passed scanner gate.

The Debian signed apt source index supplied the ncurses `.dsc`, upstream tar,
and Debian patch tar with SHA-256 values
`d12b31c11fad1c5baf42e36d643edd72cecacec67c2d14e759da42a61759582a`,
`3b91eb714ba61b9ebfcfe09cf8e7c1c45cf2e8a6282f5887fb942db514ae93bd`, and
`52a49c453121bd90d21edef53903beac9d9d8229e0ef4f49d3b0252e49932f4c`.
The local changelog revision had SHA-256
`eb618790d9cdc5d2ffea65200bcb425dc0ed5835dfad7669a2d82cd8e5e1d245`.
Its epoch-adjusted version had SHA-256
`fa1ca3e26dc99da5439d0bfc729642fd28e4674ba063e54a23232f3c84a1945a`.
The upstream detached signature was not separately verified. These hashes
record the experiment; there is not yet a retained, authenticated source and
build-dependency lock or a production build path.
The verified source's `COPYING` and Debian `copyright` files had SHA-256
`a85ca5bef8ce71f013bc5f4306c681881b248450f3b63722589891f0b69ea52d` and
`092096e25403d2e395484d111623a75e8584d4c87ce98e9cb2c509c048756211`.
The Debian file lists MIT/X11, X11 and BSD-3-Clause material; these references
do not replace the full source-file and distribution-license review.

An isolated alternative based on the fixed Debian forky-slim index
`sha256:04db4720574d184e24353e77e46dbbe4377edad01c9ba50a67aa1473cef9b9d4`
also included the API, same-source helper scripts, Docker/Compose and restic.
Both architectures passed the existing image and secret scans and the basic
offline tool probe. On the Docker Desktop overlay filesystem, extended ACL and
user xattr archive round trips passed for both architectures; the corresponding
tmpfs test returned `Operation not supported` when creating an ACL. This was
a disposable test image, not a release artifact or a complete backup test.
Both architectures also rejected a synthetic archive containing an ACL-bearing
file under a symlink that pointed outside the extraction directory; the test
victim's content and mode were unchanged. This static test did not exercise a
concurrent symlink race or establish general TOCTOU safety.
The full ARM64 Syft SBOM reported 196 Go components, but its Trivy SBOM scan
had an empty Debian OS version; Docker CLI's official binary also had no Go
module/dependency records in `go version -m`, and Syft reported its main module
as UNKNOWN. These are unknown coverage, not a full SBOM or license pass.
Debian identifies forky as [testing without stable security-update support](https://www.debian.org/releases/forky/index),
so an empty image-scan result is not evidence that this base is suitable for a
commercial release. No OS labels or findings were changed to obtain the result.
For comparison, the official Ubuntu 26.04.1 LTS base with fixed index digest
`sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c`
passed the ARM64 image/secret scan and [Ubuntu lists ncurses as not affected](https://ubuntu.com/security/CVE-2025-69720),
but its actual `libacl1 2.3.2-2` binary had none of the newer `acl_*_at`
exports. Ubuntu's status for CVE-2026-54369 was unavailable during the check;
the zero scan therefore does not prove ACL safety or qualify this base for use.

An independent, disposable helper-image experiment used the genuine Amazon
Linux 2023 index
`sha256:bb1c85fe00170acd8a653de5f68cf77c7ec67234a130b18fad7ca1de1f61e3d3`.
Its RPM database identified `libacl 2.4.0-1.amzn2023.0.1` and
`ncurses-libs 6.6-1.amzn2023.0.1`; [AWS lists the ACL issue fixed](https://explore.alas.aws.amazon.com/CVE-2026-54369.html)
and [ncurses not affected](https://explore.alas.aws.amazon.com/CVE-2025-69720.html).
Both architectures passed the existing image/secret scans with Amazon Linux
2023 detected, and passed a basic offline helper-tool probe. An auxiliary test
image passed ACL and user-xattr round trips and a static symlink escape test
on both architectures; no concurrent TOCTOU or complete backup was tested.
The RPM repository snapshot and all build dependency hashes have not been
locked. Fixed Trivy reported the full Syft SBOM's `amzn` OS family as
unsupported even though the command exited zero; its image scan saw only the Docker CLI's Go stdlib, not its
unrecorded third-party dependencies. Neither result is an independently
complete component scan or license evidence; there is no signed helper image
or production integration. No OS metadata or findings were modified.

A separate static Bash experiment did not establish a releasable replacement.
Debian's signed `bash-static` binaries contain static ncurses code which the
tested Syft inventory did not identify. A source build with readline disabled
removed that ncurses dependency, but the upstream tests still produced
differences including a missing `complete` builtin when rerun as a non-root
user with a PTY and an installed UTF-8 locale. The upstream test driver did
not reliably report those differences in its exit status. An amd64 repeat
build also timed out before comparison. The statically linked glibc inventory,
vulnerability coverage and corresponding license obligations were not fully
verified. Neither static binary was integrated into a release image.

The experimental `make-restic-sbom.mjs` accepts Syft SBOMs for the same API
image before and after adding restic, trusted input digests, the extracted
binary, and verified license evidence. It requires every baseline component to
remain identical and the complete delta to be exactly the restic file and its
81 Go components; it preserves original component records and writes a
hash-bound proof. The companion `scan-restic-sbom.sh` invokes pinned Trivy and
requires its report to enumerate all 81 Go packages with no HIGH/CRITICAL
findings. The expected input and proof digests must come from the trusted
workflow, which must itself generate the SBOMs from the corresponding fixed
image digests and keep all inputs immutable. These scripts alone do not prove
that their caller provided authentic image-derived inputs.

This is a **restic-only supplemental scan**. It neither filters nor replaces
the raw full-image SBOM, full-image Trivy vulnerability and secrets scans, or
any other release check. Keep full-SBOM findings visible. The current isolated
full API SBOM reports four util-linux HIGH findings even though the isolated
restic-only supplement has none. Production use also requires fail-closed
integration, final-image digest and byte binding, private immutable evidence,
NOTICE secret scanning, and signature/manifest coverage.

## Superseded API candidate scan records

The following earlier API scan records precede the current R1 architecture
summary at the top of this README. They do not describe the current
`runtime-helper` candidate.

On 2026-11-05, the additional Trivy scan of each unmodified, full Syft API
SBOM reported CVE-2026-76642, CVE-2026-78408, CVE-2026-78409 and
CVE-2026-78410 against `util-linux 2.41.5-0+deb13u1`; the full image scan and
secrets scan reported no HIGH/CRITICAL or secret findings for the isolated API
images. This discrepancy is retained as an unresolved full-SBOM finding, not
suppressed by the restic-only result. Debian identifies the first, third and
fourth findings with mount/libmount and the second with nsenter; isolated image
inspection did not find those programs or libmount, and the shipped flock ELF
did not dynamically link libmount. That evidence does not prove the absence of
all reachable paths or authorize bypassing a release gate. See the Debian
security tracker entries for [76642](https://security-tracker.debian.org/tracker/CVE-2026-76642),
[78408](https://security-tracker.debian.org/tracker/CVE-2026-78408),
[78409](https://security-tracker.debian.org/tracker/CVE-2026-78409) and
[78410](https://security-tracker.debian.org/tracker/CVE-2026-78410). The pinned
PostgreSQL 18 image also failed its full-image vulnerability scan in separate
tests; these results do not establish readiness of the four-image release.

The last pre-externalization API archive scan on 2026-11-05 used local ARM64
`release` candidate `sha256:9445bccb106626b4091fa7ee08a487435dbd5d2186072ffd07e11cc16c513e5c`.
Syft found 1,769 components, including the embedded Restic binary and Go
components. Trivy reported three HIGH matches and zero secret findings:
CVE-2026-54369 on `libacl1 2.3.2-2+b1`, CVE-2025-69720 on
`libtinfo6 6.5+20250216-2`, and CVE-2026-76844 on
`zlib1g 1:1.3.dfsg+really1.3.1-1+b1`. The API SBOM was also rejected by
`reject-unverified-restic-helper.mjs` at that point. These findings are kept as
history for that image only; the current two-platform API scan and current
Restic-free SBOM gate results are recorded at the top of this README.

The build authenticates `github.com/restic/restic@v0.19.1` with the Go checksum
database and requires its canonical module zip SHA-256
`7d434c06bee279cc0378a23e91e369de8baef9addb64cf968b388ef4bb75ef34` and source
commit `6aa3a516ce654808a1f28f9fa21e9b7c8e6e90bf`. The locked `go.mod` and
`go.sum` upgrade dependencies from that release. The generated private module
`v0.19.1-aikayun.2` also changes the version constant so that the executable
identifies the patch; it does not represent an upstream restic release.

The module zip, dependency locks, Go 1.27.3 toolchain image, resulting Go module
checksum and expected upstream source are verified inside the build. Go's
public checksum database remains enabled for third-party dependencies. Only the
locally generated private restic module is excluded from that database; its
exact zip SHA-256 is checked instead. The build disables the optional self-update
command and uses `-trimpath` and `CGO_ENABLED=0`.

For isolated testing, build either platform with Docker BuildKit, for example:

```sh
docker buildx build --platform linux/arm64 --load \
  -t aikayun-restic-candidate:local scripts/release/restic-build
```

The scratch image carries only `/restic`; a production runtime must independently
provide any required trust roots and runtime support. Its binary metadata and
`restic version` must both identify the patched version, and its SBOM, notices,
and vulnerability and secrets scans must be checked for each target platform.
Those checks do not constitute full application or commercial release approval.
The current binary SHA-256 pins were reproduced on an arm64 builder, including
cross-compilation for amd64; independent reproduction with an amd64-native
toolchain remains to be established.

## R1 isolated direct-volume reader candidate

The official multi-platform `restic/restic:0.19.1` index
`sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510`
was executed and scanned separately on AMD64 and ARM64 with the locked Trivy
0.69.0 image. Both platforms were rejected by the unchanged HIGH/CRITICAL gate:
13 Alpine package findings per platform (10 HIGH, 3 CRITICAL) plus 22 Go binary
findings. The report was not modified and no finding was ignored.

`apps/api/Dockerfile` now has an isolated `restic-runtime` target based on
`scratch`, containing the fixed-source, statically linked Restic binary and
the public CA bundle needed for HTTPS repositories. Its AMD64 and ARM64 images
were built and actually run. Syft 1.38.0 reported one file and 81 Go components
per image; Trivy 0.69.0's vulnerability scan reported zero HIGH/CRITICAL
findings for both, and its secret scan emitted no secret finding. These are
local candidate image results, not signed release evidence. The `restic-runtime`
image is now represented in the release manifest, and its NOTICE preparation
path has been exercised locally on both platforms. Final GHCR child digests,
release signatures, and anonymous pull verification are still absent.

After adding the CA certificate package's copyright file to the image, the
two platform candidates were rebuilt and re-scanned on 2026-11-05. The locked
Trivy 0.69.0 reports were created at `2026-11-05T06:38:02Z` (AMD64) and
`2026-11-05T06:38:06Z` (ARM64); each had zero HIGH/CRITICAL vulnerabilities
and zero secret findings. Syft 1.38.0 reported 82 components per image. The
image NOTICE generator also completed on both architectures using the exact
binary/license evidence and offline Go cache; a fixed Trivy secret-scan
positive control detected synthetic markers in all eight tested NOTICE file
names. Those NOTICE runs used synthetic image digests and are only local
script evidence; the files are not release artifacts.

A Linux Docker-volume experiment mounted source data read-only into the
`restic-runtime` container, with no Docker socket, no network, read-only root,
and only `CAP_DAC_READ_SEARCH`. A 1 GiB sparse file, ACL, user xattr, hard link,
symlink, UID/GID, mode, content digest and 0400 private-key fixture all survived
encrypted snapshot and `restore --sparse --verify`. This used a Docker Desktop
Linux VM volume and synthetic files; it does not prove the final production
Compose mounts, signed runtime, host kernel or customer data path.
