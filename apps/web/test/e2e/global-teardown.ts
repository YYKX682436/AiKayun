import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default async function globalTeardown(): Promise<void> {
  if (process.env.PLAYWRIGHT_EXTERNAL_SERVER === 'true') return
  rmSync(join(tmpdir(), 'aikayun-d7-playwright-media'), { recursive: true, force: true })
  rmSync(join(tmpdir(), 'aikayun-private-file-playwright'), { recursive: true, force: true })
}
