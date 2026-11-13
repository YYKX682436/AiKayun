# AiKayun 0.1.0-rc.13 candidate package

This bundle is an immutable signed release candidate. It contains no application source checkout, build system, credentials, customer data, or test trust keys.

1. Verify `release-manifest.cosign.bundle` with Cosign, the Sigstore trust root and the published release workflow identity.
2. Verify `release-manifest.json` and its detached JWS with `release-signing-root.jwk.json` using `release-verifier.mjs`; step 1 authenticates this JWS root.
3. Compare every artifact SHA-256 and every OCI image reference with the signed manifest before using `compose.yaml`.
4. Bootstrap bundle extraction on Linux with Docker using the digest-pinned pull/create/cp interface. The signed HTTPS artifact `extract-release-bundle.sh` provides that interface without Node, pnpm or source; it is also included in the OCI payload for later installer runs.
5. The bundle includes one currently valid offline-root-signed Trust Bundle JWS. The signed shell installer accepts no user-provided signing key; it verifies Cosign, JWS, every artifact hash and the OCI bundle before deployment.
6. The installer requires an existing Linux Docker Engine/Compose v2, public DNS for the store hostname, open TCP 80/443 and sufficient disk. It does not install Docker or change firewall rules.
7. Use the server-local `setup-token` command only after HTTPS/ACME is ready. The token is printed only to that terminal and expires after 30 minutes.
8. After installation, run `sudo /opt/aikayun/aikayun backup initialize-repository` once, then `sudo /opt/aikayun/aikayun backup create`; inspect sets with `list` and `verify`.
9. Before initialization, provision `/var/lib/aikayun-backup` and its `repository`, `journal`, `publications`, and `staging` directories as root:root mode `0700`; mount `staging` as a Linux noswap tmpfs. Provision `/etc/aikayun-backup` as root:root `0700` and `/etc/aikayun-backup/restic-password` as root:root `0600`. Keep the password outside the repository and deployment secrets.
10. Use only the image digests rendered into `compose.yaml`; do not replace them with tags.

The signed release index and artifacts are served from the HTTPS download location recorded in the signed manifest and index.
