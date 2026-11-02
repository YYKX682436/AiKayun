import { exportReleaseTrustRoot, signReleaseManifest, verifyReleaseManifest } from './manifest.mjs'

const [command, ...args] = process.argv.slice(2)
if (command === 'sign' && args.length === 3) {
  const [manifestPath, signaturePath, privateKeyPath] = args
  const result = await signReleaseManifest(manifestPath, signaturePath, privateKeyPath,
    process.env.AIKAYUN_RELEASE_SIGNING_KEY_PASSWORD === undefined
      ? {} : { passphrase: process.env.AIKAYUN_RELEASE_SIGNING_KEY_PASSWORD })
  process.stdout.write(`${JSON.stringify({ kid: result.kid, manifest_sha256: result.manifest_sha256 })}\n`)
} else if (command === 'public-key' && args.length === 2) {
  const result = await exportReleaseTrustRoot(args[0], args[1],
    process.env.AIKAYUN_RELEASE_SIGNING_KEY_PASSWORD === undefined
      ? {} : { passphrase: process.env.AIKAYUN_RELEASE_SIGNING_KEY_PASSWORD })
  process.stdout.write(`${JSON.stringify({ kid: result.kid })}\n`)
} else if (command === 'verify' && args.length === 3) {
  const result = await verifyReleaseManifest(args[0], args[1], args[2])
  process.stdout.write(`${JSON.stringify({ kid: result.kid, manifest_sha256: result.manifest_sha256, release_id: result.manifest.release_id })}\n`)
} else {
  process.stderr.write('Usage: node cli.mjs public-key PRIVATE_KEY OUTPUT_JWK | sign MANIFEST SIGNATURE PRIVATE_KEY | verify MANIFEST SIGNATURE PUBLIC_JWK\n')
  process.exitCode = 2
}
