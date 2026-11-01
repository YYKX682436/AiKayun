import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The signed test API already reset and initialized the isolated database before listening. */
export default function globalSetup(): void {
  if (process.env.PLAYWRIGHT_EXTERNAL_SERVER === 'true') return
  const mediaRoot = join(tmpdir(), 'aikayun-d7-playwright-media')
  const privateFileRoot = join(tmpdir(), 'aikayun-private-file-playwright')
  rmSync(mediaRoot, { recursive: true, force: true })
  rmSync(privateFileRoot, { recursive: true, force: true })
  mkdirSync(mediaRoot, { recursive: true })
  mkdirSync(privateFileRoot, { recursive: true, mode: 0o700 })
}
