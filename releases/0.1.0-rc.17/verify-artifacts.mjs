// apps/api/scripts/release/manifest.mjs
import { createPrivateKey, createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { relative, resolve, sep } from "node:path";

// node_modules/.pnpm/canonicalize@5.1.0/node_modules/canonicalize/lib/canonicalize.js
function serializeString(value) {
  if (!value.isWellFormed()) {
    throw new Error("Lone surrogate is not allowed");
  }
  return JSON.stringify(value);
}
function serializePrimitive(value) {
  switch (typeof value) {
    case "number":
      if (isNaN(value)) {
        throw new Error("NaN is not allowed");
      }
      if (!isFinite(value)) {
        throw new Error("Infinity is not allowed");
      }
      return JSON.stringify(value);
    case "string":
      return serializeString(value);
    case "boolean":
      return value ? "true" : "false";
    default:
      return JSON.stringify(value);
  }
}
function enterValue(value, seen) {
  let wrappers = null;
  while (value !== null && typeof value === "object" && typeof value.toJSON === "function") {
    if (seen.has(value)) {
      throw new Error("Circular reference detected");
    }
    seen.add(value);
    (wrappers ??= []).push(value);
    value = value.toJSON();
  }
  if (value instanceof Number || value instanceof String || value instanceof Boolean) {
    value = value.valueOf();
  }
  if (value === null || typeof value !== "object") {
    if (wrappers !== null) {
      for (const wrapper of wrappers) seen.delete(wrapper);
    }
    return serializePrimitive(value);
  }
  if (seen.has(value)) {
    throw new Error("Circular reference detected");
  }
  seen.add(value);
  return {
    container: value,
    // null marks an array frame; object frames carry their sorted keys.
    // `sort()`'s default comparator orders by UTF-16 code unit, which is the
    // order JCS requires.
    keys: Array.isArray(value) ? null : Object.keys(value).sort(),
    // Next child to serialize; the frame resumes here after a nested
    // container's subtree completes.
    index: 0,
    // Whether no member has been emitted yet (controls comma placement).
    first: true,
    // toJSON wrappers to release from `seen` when this frame completes.
    wrappers
  };
}
function canonicalize(object) {
  if (object === null || typeof object !== "object") {
    return serializePrimitive(object);
  }
  const seen = /* @__PURE__ */ new Set();
  const root = enterValue(object, seen);
  if (typeof root !== "object") {
    return root;
  }
  let result = root.keys === null ? "[" : "{";
  const stack = [root];
  outer:
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const container = frame.container;
      if (frame.keys === null) {
        while (frame.index < container.length) {
          const i = frame.index++;
          if (i > 0) {
            result += ",";
          }
          const element = container[i];
          const value = element === void 0 || typeof element === "symbol" || typeof element === "function" ? null : element;
          if (value === null || typeof value !== "object") {
            result += serializePrimitive(value);
            continue;
          }
          const child = enterValue(value, seen);
          if (typeof child !== "object") {
            result += child === void 0 ? "null" : child;
            continue;
          }
          result += child.keys === null ? "[" : "{";
          stack.push(child);
          continue outer;
        }
        result += "]";
      } else {
        const keys = frame.keys;
        while (frame.index < keys.length) {
          const key = keys[frame.index++];
          const value = container[key];
          if (value === void 0 || typeof value === "symbol" || typeof value === "function") {
            continue;
          }
          if (value === null || typeof value !== "object") {
            if (frame.first) {
              frame.first = false;
            } else {
              result += ",";
            }
            result += serializeString(key) + ":" + serializePrimitive(value);
            continue;
          }
          const child = enterValue(value, seen);
          if (child === void 0) {
            continue;
          }
          if (frame.first) {
            frame.first = false;
          } else {
            result += ",";
          }
          result += serializeString(key) + ":";
          if (typeof child !== "object") {
            result += child;
            continue;
          }
          result += child.keys === null ? "[" : "{";
          stack.push(child);
          continue outer;
        }
        result += "}";
      }
      seen.delete(container);
      if (frame.wrappers !== null) {
        for (const wrapper of frame.wrappers) seen.delete(wrapper);
      }
      stack.pop();
    }
  return result;
}

// apps/api/scripts/release/manifest.mjs
var digestPattern = /^[a-f0-9]{64}$/;
var semverPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
var platforms = ["linux/amd64", "linux/arm64"];
var imageNames = ["api", "web", "postgres", "caddy", "backup"];
var imageRepositories = {
  api: "ghcr.io/yykx682436/aikayun-api",
  web: "ghcr.io/yykx682436/aikayun-web",
  postgres: "ghcr.io/yykx682436/aikayun-postgres",
  caddy: "docker.io/library/caddy",
  backup: "ghcr.io/yykx682436/aikayun-backup-restic"
};
function isCanonicalReleaseSemVer(value) {
  return typeof value === "string" && semverPattern.test(value);
}
function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error(`Invalid ${label} fields`);
  }
}
function validateReleaseManifest(value) {
  exactKeys(value, [
    "schema",
    "product",
    "release_id",
    "version",
    "channel",
    "built_at",
    "source_commit",
    "platforms",
    "images",
    "artifacts",
    "database",
    "license",
    "distribution"
  ], "release manifest");
  if (value.schema !== 1 || value.product !== "aikayun" || typeof value.release_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value.release_id) || typeof value.version !== "string" || !isCanonicalReleaseSemVer(value.version) || value.release_id !== `aikayun-${value.version}` || !["candidate", "stable"].includes(value.channel) || typeof value.built_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.built_at) || !Number.isFinite(Date.parse(value.built_at)) || typeof value.source_commit !== "string" || !/^[a-f0-9]{40}$/.test(value.source_commit)) throw new Error("Invalid release manifest identity");
  if (!Array.isArray(value.platforms) || value.platforms.join(",") !== platforms.join(",")) {
    throw new Error("Release manifest must list exactly the tested amd64 and arm64 platforms in order");
  }
  exactKeys(value.distribution, ["https_origin", "release_path"], "release distribution");
  if (typeof value.distribution.https_origin !== "string" || typeof value.distribution.release_path !== "string" || !/^\/releases\/[A-Za-z0-9][A-Za-z0-9.+-]{0,63}\/$/.test(value.distribution.release_path)) {
    throw new Error("Invalid release distribution location");
  }
  const distributionOrigin = new URL(value.distribution.https_origin);
  if (distributionOrigin.protocol !== "https:" || distributionOrigin.origin !== value.distribution.https_origin || distributionOrigin.username || distributionOrigin.password || isIP(distributionOrigin.hostname) || distributionOrigin.hostname === "localhost" || distributionOrigin.hostname.endsWith(".localhost") || /(^|\.)(test|example|invalid|local)$/i.test(distributionOrigin.hostname) || /(^|\.)example\.(com|net|org)$/i.test(distributionOrigin.hostname)) {
    throw new Error("Release distribution must use the configured public HTTPS origin");
  }
  exactKeys(value.images, imageNames, "release image map");
  for (const name of imageNames) {
    const image = value.images[name];
    exactKeys(image, ["reference", "platform_digests", "sbom_sha256"], `${name} image`);
    if (typeof image.reference !== "string" || !image.reference.startsWith(`${imageRepositories[name]}@sha256:`) || !/@sha256:[a-f0-9]{64}$/.test(image.reference)) {
      throw new Error(`Invalid ${name} image reference`);
    }
    exactKeys(image.platform_digests, platforms, `${name} platform digest map`);
    for (const platform of platforms) if (!digestPattern.test(image.platform_digests[platform])) {
      throw new Error(`Invalid ${name} ${platform} manifest digest`);
    }
    exactKeys(image.sbom_sha256, platforms, `${name} platform SBOM digest map`);
    for (const platform of platforms) if (!digestPattern.test(image.sbom_sha256[platform])) {
      throw new Error(`Invalid ${name} ${platform} SBOM digest`);
    }
  }
  if (!Array.isArray(value.artifacts)) throw new Error("Release artifacts must be an array");
  const artifactNames = /* @__PURE__ */ new Set();
  for (const artifact of value.artifacts) {
    exactKeys(artifact, ["name", "size", "sha256"], "release artifact");
    if (typeof artifact.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(artifact.name) || artifact.name.includes("..") || artifactNames.has(artifact.name) || !Number.isSafeInteger(artifact.size) || artifact.size < 0 || !digestPattern.test(artifact.sha256)) throw new Error("Invalid or duplicate release artifact");
    artifactNames.add(artifact.name);
  }
  if (value.artifacts.length < 1) throw new Error("Release manifest must identify downloadable artifacts");
  exactKeys(value.database, [
    "engine_major",
    "migration_head",
    "migration_checksums_sha256",
    "readable_heads",
    "writable_heads",
    "upgrade_from_releases",
    "rollback_to_releases",
    "requires_write_quiescence"
  ], "database compatibility");
  const database = value.database;
  if (database.engine_major !== 18 || typeof database.migration_head !== "string" || !/^[0-9]{12}_[A-Za-z0-9_-]+$/.test(database.migration_head) || !digestPattern.test(database.migration_checksums_sha256) || !Array.isArray(database.readable_heads) || !database.readable_heads.includes(database.migration_head) || !Array.isArray(database.writable_heads) || !database.writable_heads.includes(database.migration_head) || database.requires_write_quiescence !== true) throw new Error("Invalid database compatibility declaration");
  for (const [name, releases] of [
    ["upgrade_from_releases", database.upgrade_from_releases],
    ["rollback_to_releases", database.rollback_to_releases]
  ]) {
    if (!Array.isArray(releases) || releases.length > 32 || new Set(releases).size !== releases.length || releases.some((release) => typeof release !== "string" || release.length > 64 || !release.startsWith("aikayun-") || !isCanonicalReleaseSemVer(release.slice("aikayun-".length)) || release === value.release_id)) {
      throw new Error(`Invalid database ${name} declaration`);
    }
  }
  exactKeys(
    value.license,
    [
      "protocol_versions",
      "trust_configuration_id",
      "issuer",
      "offline_root_kid",
      "online_signer_kids",
      "minimum_bundle_version"
    ],
    "license release configuration"
  );
  const license = value.license;
  if (!Array.isArray(license.protocol_versions) || license.protocol_versions.length !== 1 || license.protocol_versions[0] !== 1 || typeof license.trust_configuration_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(license.trust_configuration_id) || typeof license.issuer !== "string" || typeof license.offline_root_kid !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(license.offline_root_kid) || typeof license.minimum_bundle_version !== "string" || !/^[1-9][0-9]{0,18}$/.test(license.minimum_bundle_version)) throw new Error("A trusted production license configuration is required");
  if (!Array.isArray(license.online_signer_kids) || license.online_signer_kids.length === 0 || license.online_signer_kids.some((kid) => typeof kid !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(kid)) || new Set(license.online_signer_kids).size !== license.online_signer_kids.length || license.online_signer_kids.includes(license.offline_root_kid)) {
    throw new Error("The production authorization-center online signer KIDs must be explicitly pinned");
  }
  const issuer = new URL(license.issuer);
  if (issuer.protocol !== "https:" || issuer.origin !== license.issuer || issuer.username || issuer.password || ["localhost", "127.0.0.1", "::1"].includes(issuer.hostname) || isIP(issuer.hostname) || /(^|\.)(test|example|invalid|local)$/i.test(issuer.hostname) || /(^|\.)example\.(com|net|org)$/i.test(issuer.hostname)) {
    throw new Error("Release license issuer must be a production HTTPS origin");
  }
  return value;
}
function canonicalManifestBytes(value) {
  validateReleaseManifest(value);
  const serialized = canonicalize(value);
  if (!serialized) throw new Error("Release manifest cannot be canonicalized");
  return Buffer.from(serialized, "utf8");
}
async function verifyReleaseArtifacts(manifestPath2, artifactDirectory2) {
  const manifestBytes = await readFile(manifestPath2);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  validateReleaseManifest(manifest);
  if (!manifestBytes.equals(canonicalManifestBytes(manifest))) throw new Error("Manifest file is not canonical JSON");
  const root = await realpath(resolve(artifactDirectory2));
  for (const artifact of manifest.artifacts) {
    const path = resolve(root, ...artifact.name.split("/"));
    const pathRelative = relative(root, path);
    if (pathRelative === "" || pathRelative.startsWith(`..${sep}`) || pathRelative === ".." || pathRelative.startsWith(sep)) {
      throw new Error(`Artifact path escapes the release directory: ${artifact.name}`);
    }
    let current = root;
    for (const part of artifact.name.split("/")) {
      current = resolve(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink() || current !== path && !info.isDirectory() || current === path && !info.isFile()) {
        throw new Error(`Artifact path must contain only regular files and directories: ${artifact.name}`);
      }
    }
    const bytes = await readFile(path);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== artifact.size || digest !== artifact.sha256) {
      throw new Error(`Release artifact size or SHA-256 mismatch: ${artifact.name}`);
    }
  }
  return { release_id: manifest.release_id, verified_artifacts: manifest.artifacts.length };
}

// apps/api/scripts/release/verify-artifacts.mjs
var [manifestPath, artifactDirectory] = process.argv.slice(2);
if (!manifestPath || !artifactDirectory) {
  process.stderr.write("Usage: node verify-artifacts.mjs RELEASE_MANIFEST ARTIFACT_DIRECTORY\n");
  process.exitCode = 2;
} else {
  const result = await verifyReleaseArtifacts(manifestPath, artifactDirectory);
  process.stdout.write(`${JSON.stringify(result)}
`);
}
