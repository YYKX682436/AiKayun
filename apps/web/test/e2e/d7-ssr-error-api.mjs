import { createServer } from 'node:http'

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  response.setHeader('content-type', 'application/json; charset=utf-8')

  if (url.pathname === '/health') {
    response.writeHead(200).end('{"status":"ok"}')
    return
  }
  if (url.pathname === '/api/v1/public/categories') {
    response.writeHead(200).end('{"data":{"categories":[]}}')
    return
  }
  if (/^\/api\/v1\/public\/products\/[0-9a-f-]+$/iu.test(url.pathname)) {
    response.writeHead(500).end(JSON.stringify({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'private database stack marker',
        stack: 'D7_PRIVATE_DATABASE_STACK_TRACE',
        requestId: 'ssr-error-probe',
      },
    }))
    return
  }
  response.writeHead(404).end('{"error":{"code":"NOT_FOUND","message":"Not found"}}')
})

server.listen(3111, '127.0.0.1')
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
