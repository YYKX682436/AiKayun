import { randomUUID } from 'node:crypto'
import { send, setResponseHeaders, setResponseStatus, type H3Error, type H3Event } from 'h3'

// Nitro's default production handler logs the full URL and raw error for
// unhandled failures. Neither is safe for payment callbacks or private data.
export default function errorHandler(error: H3Error, event: H3Event) {
  const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
    ? error.statusCode : 500
  const requestId = randomUUID()
  if (status >= 500) {
    const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(event.method) ? event.method : 'OTHER'
    console.error(JSON.stringify({ event: 'web_request_failed', requestId, method,
      route: event.path.startsWith('/api/') ? '/api/*' : 'page', status, errorCode: 'WEB_REQUEST_FAILED' }))
  }
  setResponseStatus(event, status)
  setResponseHeaders(event, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' })
  return send(event, JSON.stringify({ error: true, statusCode: status,
    message: status >= 500 ? 'Server Error' : 'Request Error', requestId }))
}
