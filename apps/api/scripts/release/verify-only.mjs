import { verifyReleaseManifest } from './manifest.mjs'

const [manifestPath, signaturePath, publicJwkPath] = process.argv.slice(2)
if (!manifestPath || !signaturePath || !publicJwkPath) {
  process.stderr.write('Usage: node release-verifier.mjs MANIFEST DETACHED_JWS RELEASE_PUBLIC_JWK\n')
  process.exitCode = 2
} else {
  const result = await verifyReleaseManifest(manifestPath, signaturePath, publicJwkPath)
  process.stdout.write(`${JSON.stringify({
    release_id: result.manifest.release_id,
    version: result.manifest.version,
    manifest_sha256: result.manifest_sha256,
    signer_kid: result.kid,
    images: result.manifest.images,
  }, null, 2)}\n`)
}
