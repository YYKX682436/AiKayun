import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('production logging boundary', () => {
  it('records route and status without URL data, credentials, body or exception text', () => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'test/fixtures/logging-probe.ts'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: 'postgres://test:test@127.0.0.1:1/aikayun_test' },
    })
    expect(child.status, child.stderr).toBe(0)
    const output = child.stdout + child.stderr
    expect(output).not.toContain('PRIVATE_')
    expect(output).toContain('/logging-probe/:id')
    expect(output).toContain('request completed')
    expect(output).toContain('statusCode')
    expect(output).toContain('reqId')
  })
})
