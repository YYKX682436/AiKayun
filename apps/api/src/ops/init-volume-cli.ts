import { initializeVolumeDirectory } from './volume-directory.js'

const [directory, requestedMode, ...extra] = process.argv.slice(2)
const uid = process.getuid?.()

if (!directory || !requestedMode || extra.length !== 0 || uid !== 0) {
  process.stderr.write('Usage: init-volume-cli <absolute-directory> <0700|0755> (root required)\n')
  process.exitCode = 2
} else {
  const mode = requestedMode === '0700' ? 0o700 : requestedMode === '0755' ? 0o755 : undefined
  if (mode === undefined) {
    process.stderr.write('Volume mode must be 0700 or 0755\n')
    process.exitCode = 2
  } else {
    await initializeVolumeDirectory(directory, mode)
  }
}
