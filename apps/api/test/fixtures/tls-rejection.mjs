import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { createHttpJsonV1Delivery } from '/app/dist/commerce/http-json-v1.js'
import { readConfig } from '/app/dist/config.js'

let requests = 0
const server = createServer({ key: await readFile('/tls/key.pem'), cert: await readFile('/tls/cert.pem') }, (_request, response) => {
  requests++
  response.end('{}')
})
await new Promise(resolve => server.listen(443, '93.184.216.34', resolve))
try {
  await assert.rejects(createHttpJsonV1Delivery(readConfig({ NODE_ENV: 'test' }), {
    baseUrl: 'https://93.184.216.34', bearerToken: 'isolated-tls-test-token',
  }, { operationId: '00000000-0000-4000-8000-000000000001', idempotencyKey: 'aikayun:00000000-0000-4000-8000-000000000001',
    productId: 'tls-probe', unitAmount: '0.00', parameters: {} }), { classification: 'transport_unknown' })
  assert.equal(requests, 0, 'TLS must reject before sending supplier credentials or request content')
  console.log('Untrusted TLS rejected before HTTP request')
} finally { await new Promise(resolve => server.close(resolve)) }
