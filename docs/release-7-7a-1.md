# ⑦-7A-1 官方镜像安全更新

基线：`9ee67328d8137d53de608a41eb6ddf166416658e`。本轮只更新 PostgreSQL 18 与 Caddy 的发行候选官方 digest，并保留未修复项的发行阻断。

## 官方候选与摘要

均从官方 registry 按不可变 multi-arch index 拉取；Trivy/Syft archive 配置确认导出平台与请求平台一致。

| 镜像 | 当前锁定 index | 官方候选 index | AMD64 / ARM64 manifest |
|---|---|---|---|
| Distroless Node.js 24 Debian 13 nonroot | `b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba` | **相同 digest，尚无新 index** | AMD64 `1dfdd0613f3163fe913861ded2540584525b281d65541749726c7d3906382c06` / ARM64 `e87b0071f3ba73d76f841f5d3e013d73a9cfaed916dcb7274d2dcd06d7419a3f` |
| PostgreSQL 18 Alpine | `77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873` | `123b17998ccaf47e53b502e8c6a1e79afd8f579c6f3eec83c563da026f957395` (`18.6-alpine3.24`) | AMD64 `300ebd02c6d4de9ee27ad7f6855d5d21b4d3a4a5117767c1197d284c635d9736` / ARM64 `c935aff069a7bbe5c286411a08e9678850d79be7848b190a0e4637b266478626` |
| Caddy | `e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5` (`2.11.7-alpine`) | `0bbb055bda6793c999bde78b1b5ce3e89f829fb031af2cf50056ea1246559fee` (`2.11.9-alpine`) | AMD64 `fc9cbc100585871d18d4e451cca7021785c90a7006087427ae5ceb3e4efe6424` / ARM64 `9ee998103a2bc0d4392bbe9738b4069da1562d6920b3cd8088cfd098a8270120` |

Official PostgreSQL 18.6 Trixie was also checked once: index `e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42`, AMD64 `e923a22ac074261dd73970c57edf659475bf0497cb9456f17d98ed7cdd3ca913`, ARM64 `a8a18afebc8b2b529112c931f193151b712e566b7a49563dc0f328d51f652087`. It is not adopted.

## Trivy results

Used the existing full-image vulnerability and secret scan script, pinned Trivy `aquasec/trivy@sha256:33f816d414b9d582d25bb737ffa4a632ae34e222f7ec1b50252cef0ce2266006` (0.69.0), with the same vulnerability DB for baseline and candidates. DB update time was `2026-11-08T06:39:21.614725497Z`; DB SHA-256 `931e0ee11580d5df452259b34184bea504d07cd3b1ad50254a2d1b8093d97c18`. All six adopted-candidate scans (AMD64/ARM64) had zero scanner errors and zero secret findings.

| Image / platform | Current lock H/C | Candidate H/C | Candidate findings |
|---|---:|---:|---|
| Distroless runtime AMD64 | 2 | 2 | HIGH: CVE-2026-76844 and CVE-2026-85091 on `zlib1g 1:1.3.dfsg+really1.3.1-1+b1`; both fixed version shown by Trivy is `1:1.3.dfsg+really1.3.1-1+deb13u1`. |
| Distroless runtime ARM64 | 2 | 2 | Same two zlib findings and package version as AMD64. |
| PostgreSQL 18 Alpine AMD64 | 31 (2 CRITICAL, 29 HIGH) | 26 (1 CRITICAL, 25 HIGH) | Five baseline findings cleared, including CRITICAL CVE-2026-111497 (brotli-libs) and HIGH CVE-2026-85091 (Alpine zlib). Remaining findings are Go stdlib `v1.24.6`, including CRITICAL CVE-2025-68121. |
| PostgreSQL 18 Alpine ARM64 | 31 (2 CRITICAL, 29 HIGH) | 26 (1 CRITICAL, 25 HIGH) | Same finding set as AMD64. |
| Caddy AMD64 | 11 (1 CRITICAL, 10 HIGH) | 2 HIGH | Nine baseline records cleared, including CRITICAL CVE-2026-111497 (brotli-libs); remaining HIGH findings are CVE-2026-116587 on `github.com/go-jose/go-jose/v3 v3.0.5` (no fixed version reported) and CVE-2026-78661 on `golang.org/x/net v0.60.0` (fixed version `v0.62.0`). |
| Caddy ARM64 | 11 (1 CRITICAL, 10 HIGH) | 2 HIGH | Same finding set as AMD64. |

The new PostgreSQL Alpine archive contains `zlib 1.3.2-r1` on Alpine 3.24.4; the previous archive contained `zlib 1.3.2-r0` on Alpine 3.24.2. The official PG18.6 Trixie archive still contains Debian `zlib1g 1:1.3.dfsg+really1.3.1-1+b1`; its full image scan is blocked at 93 HIGH/CRITICAL (2 CRITICAL, 91 HIGH) plus one sanitized `private-key` secret finding on each architecture. Changing to that base is not acceptable.

## Result and validation

- Updated only the release builder's PostgreSQL and Caddy pinned index digests. PostgreSQL remains major version 18 and version 18.6.
- Extended the existing isolated runtime validation script to accept optional PostgreSQL/Caddy validation references only when they are official, digest-pinned images. Its defaults match the new release candidates.
- Built local development API/Web runtime images for AMD64 and ARM64, then ran the existing production runtime validation with the new official PostgreSQL/Caddy candidates. Both platforms passed database startup/role setup, migrations, API/Web health, SSR and fail-closed license checks. Test volumes and containers were isolated under the script's unique project names and cleaned by the script.
- `pnpm test:release`, `scripts/release/test-scan-gate.sh`, `scripts/release/test-bundle-extraction.sh`, `pnpm typecheck`, and `pnpm lint` passed. Lint reported 7 existing product-page warnings and 0 errors.
- No formal release build, signature, release tag, or publication was created.

Commercial release remains blocked: distroless Node.js 24 Debian 13 has not published a new digest containing Debian's fix, and the newer official PG/Caddy candidates still fail the unchanged HIGH/CRITICAL gate. The next upstream conditions are a rebuilt distroless Node.js 24 Debian 13 multi-architecture image with the DSA-6613-1 zlib package, a PostgreSQL 18 official image with its bundled Go stdlib fixed, and a Caddy image whose full scan clears the remaining two HIGH findings.

Official references: [Debian DSA-6613-1](https://lists.debian.org/debian-security-announce/2026/msg00532.html), [Distroless published tags and Debian update policy](https://github.com/GoogleContainerTools/distroless), [Docker Official PostgreSQL images](https://github.com/docker-library/official-images/blob/master/library/postgres), [Caddy v2.11.9 release](https://github.com/caddyserver/caddy/releases/tag/v2.11.9).
