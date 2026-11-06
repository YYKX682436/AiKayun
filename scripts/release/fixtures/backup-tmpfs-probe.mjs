// Runs only inside the isolated Linux container created by test-backup-tmpfs.sh.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { assertNoSwapTmpfs, assertTmpfsPayload, createTmpfsPayload, createTmpfsStaging, removeTmpfsStaging } from '/test/tmpfs-staging.mjs'

const root = '/stage'
const options = id => ({ mountRoot: root, backupSetId: id, assertLock: async () => {}, assertSafeCleanup: async () => {} })
await assert.rejects(assertNoSwapTmpfs('/tmp'), /STAGING_MOUNT_UNSAFE/)
await assert.rejects(assertNoSwapTmpfs('/dev/shm'), /STAGING_MOUNT_UNSAFE/)
await mkdir('/tmp/not-tmpfs', { mode: 0o700 })
await assert.rejects(assertNoSwapTmpfs('/tmp/not-tmpfs'), /STAGING_MOUNT_UNSAFE/)
await assert.rejects(assertNoSwapTmpfs('/swap-stage'), /STAGING_MOUNT_UNSAFE/)
await symlink('/stage', '/tmp/stage-link')
await assert.rejects(assertNoSwapTmpfs('/tmp/stage-link'), /STAGING_MOUNT_UNSAFE/)
await mkdir('/stage/not-a-mount', { mode: 0o700 })
await assert.rejects(assertNoSwapTmpfs('/stage/not-a-mount'), /STAGING_MOUNT_UNSAFE/)
await rm('/stage/not-a-mount', { recursive: true })
const available = await assertNoSwapTmpfs(root)
await assertNoSwapTmpfs('/bind-stage')
await assert.rejects(assertNoSwapTmpfs(root, available + 1n), /STAGING_SPACE_INSUFFICIENT/)
const first = options(randomUUID())
const firstPath = await createTmpfsStaging(first, 1n)
await symlink('/etc/passwd', `${firstPath}/database.dump`)
await assert.rejects(removeTmpfsStaging(first), /STAGING_CONTENT_UNSAFE/)
await rm(`${firstPath}/database.dump`)
await assert.rejects(removeTmpfsStaging({ ...first, assertSafeCleanup: async () => { throw new Error('writer still active') } }), /writer still active/)
await assert.rejects(writeFile(`${firstPath}/database.dump`, Buffer.alloc(8 * 1024 * 1024)), error => error.code === 'ENOSPC')
await removeTmpfsStaging(first)

// Process death leaves an identified staged set. The survivor explicitly
// checks writer safety before removing it, under the caller-supplied lock.
const second = options(randomUUID())
const childCode = `import {createTmpfsStaging} from '/test/tmpfs-staging.mjs';import{writeFile}from'node:fs/promises';const p=await createTmpfsStaging({mountRoot:'/stage',backupSetId:'${second.backupSetId}',assertLock:async()=>{},assertSafeCleanup:async()=>{}},1n);await writeFile(p+'/database.dump','synthetic');console.log('READY');setInterval(()=>{},1000)`
const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], { stdio: ['ignore', 'pipe', 'inherit'] })
const ready = await Promise.race([
  once(child.stdout, 'data'),
  once(child, 'exit').then(() => { throw new Error('fixture child exited before preparation') }),
  new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('fixture child timed out')), 10000); timer.unref() }),
])
assert.equal(String(ready[0]).trim(), 'READY')
const exited = once(child, 'exit')
child.kill('SIGKILL')
const [, signal] = await exited
assert.equal(signal, 'SIGKILL')
await assert.rejects(removeTmpfsStaging({ ...second, assertSafeCleanup: async () => { throw new Error('writer still active') } }), /writer still active/)
await removeTmpfsStaging(second)
const third = options(randomUUID())
const payload = await createTmpfsPayload(third, 1n)
assert.deepEqual(await readdir(payload), [])
await assertTmpfsPayload(third)
await writeFile(`${payload}/database.dump`, 'synthetic')
await writeFile(`${payload}/unknown`, 'unrecognized')
await assert.rejects(removeTmpfsStaging(third), /STAGING_CONTENT_UNSAFE/)
await rm(`${payload}/unknown`)
await removeTmpfsStaging(third)
const interrupted = options(randomUUID())
const interruptedPayload = await createTmpfsPayload(interrupted, 1n)
await writeFile(`${interruptedPayload}/database.dump`, 'synthetic')
await writeFile(`${interruptedPayload}/state.tar`, 'synthetic')
let checks = 0
await assert.rejects(removeTmpfsStaging({ ...interrupted, assertSafeCleanup: async () => {
  if (++checks === 5) throw new Error('lock lost during cleanup')
} }), /lock lost during cleanup/)
assert.equal((await readdir(interruptedPayload)).length, 1)
assert.ok((await readdir(`${root}/set-${interrupted.backupSetId}`)).includes('.stage-owner.json'))
await removeTmpfsStaging(interrupted)
const orphan = options(randomUUID())
await mkdir(`${root}/set-${orphan.backupSetId}`, { mode: 0o700 })
await assert.rejects(removeTmpfsStaging(orphan), /STAGING_CONTENT_UNSAFE/)
console.log('noswap tmpfs, space exhaustion, link rejection and explicit SIGKILL cleanup passed')
