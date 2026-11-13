// A branch update and the explicit build request can start concurrent Pages
// builds for the same commit. One may fail while another is still building.
// A release is accepted only after an actual successful build of its commit.
export async function waitForPagesBuild(getBuilds, commit, options = {}) {
  const attempts = options.attempts ?? 120
  const wait = options.wait ?? (() => new Promise(resolve => setTimeout(resolve, 5000)))
  let sawError = false
  for (let attempt = 0; attempt < attempts; attempt++) {
    const builds = await getBuilds()
    if (!Array.isArray(builds)) throw new Error('GitHub Pages build response is invalid')
    const matching = builds.filter(build => build?.commit === commit)
    if (matching.some(build => build.status === 'built')) return
    if (matching.some(build => build.status === 'errored')) sawError = true
    if (attempt + 1 < attempts) await wait()
  }
  throw new Error(sawError ? 'GitHub Pages build failed' : 'Timed out waiting for the GitHub Pages release build')
}
