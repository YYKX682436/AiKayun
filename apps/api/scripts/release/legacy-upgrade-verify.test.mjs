import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('legacy node verify invokes the existing verifier in read-only mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aikayun-legacy-verify-'))
  try {
    await mkdir(join(root, 'dist'))
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    await copyFile(new URL('./legacy-upgrade-verify.mjs', import.meta.url), join(root, 'verify'))
    await writeFile(join(root, 'dist', 'production-install-init.js'),
      'process.stdout.write(JSON.stringify({entry:process.argv[1],mode:process.argv[2],length:process.argv.length}))')
    const result = spawnSync(process.execPath, ['verify', 'init'], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { entry: '/app/dist/production-install-init.js', mode: 'verify', length: 3 })
  } finally { await rm(root, { recursive: true, force: true }) }
})
