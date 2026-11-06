import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

test('API release rejects incomplete SBOMs and any recognized restic helper evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aikayun-release-helper-check-'))
  const gate = join(dirname(fileURLToPath(import.meta.url)), 'reject-unverified-restic-helper.mjs')
  try {
    const run = async (name, value, ok) => {
      const path = join(root, name)
      await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 })
      const result = spawnSync(process.execPath, [gate, path], { encoding: 'utf8', timeout: 10000 })
      assert.equal(result.status, ok ? 0 : 1, name)
    }
    const sbom = component => ({ bomFormat: 'CycloneDX', components: [component] })
    await run('ordinary', sbom({ name: 'nodejs', purl: 'pkg:deb/debian/nodejs@1' }), true)
    for (const component of [{ name: '/usr/local/bin/restic' }, { name: '/usr/bin/restic' }, { name: 'restic' }, { name: 'github.com/restic/chunker' }, { name: 'other', purl: 'pkg:golang/github.com/restic/restic@v1' }]) await run(`bad-${Object.keys(component).join('-')}-${JSON.stringify(component).length}`, sbom(component), false)
    await run('missing-components', { bomFormat: 'CycloneDX' }, false)
    await run('empty', sbom(null), false)
    await run('malformed', '{', false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
