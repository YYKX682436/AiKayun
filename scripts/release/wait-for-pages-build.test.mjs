import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waitForPagesBuild } from './wait-for-pages-build.mjs'

const commit = 'expected-release-commit'
const noWait = async () => {}

test('accepts a successful build when a parallel build of the same commit fails first', async () => {
  const polls = [
    [{ commit, status: 'errored' }, { commit, status: 'building' }],
    [{ commit, status: 'built' }, { commit, status: 'errored' }],
  ]
  await waitForPagesBuild(async () => polls.shift(), commit, { attempts: 2, wait: noWait })
  assert.equal(polls.length, 0)
})

test('does not accept a failed build or a successful build of a different commit', async () => {
  const builds = [{ commit, status: 'errored' }, { commit: 'another-commit', status: 'built' }]
  await assert.rejects(waitForPagesBuild(async () => builds, commit, { attempts: 2, wait: noWait }), /build failed/)
})

test('times out without a successful build of the requested commit', async () => {
  await assert.rejects(waitForPagesBuild(async () => [{ commit: 'another-commit', status: 'built' }], commit,
    { attempts: 2, wait: noWait }), /Timed out/)
})
