import { verifyReleaseArtifacts } from './manifest.mjs'

const [manifestPath, artifactDirectory] = process.argv.slice(2)
if (!manifestPath || !artifactDirectory) {
  process.stderr.write('Usage: node verify-artifacts.mjs RELEASE_MANIFEST ARTIFACT_DIRECTORY\n')
  process.exitCode = 2
} else {
  const result = await verifyReleaseArtifacts(manifestPath, artifactDirectory)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
