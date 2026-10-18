import { randomUUID } from 'node:crypto'
import {
  appendResponseHeader,
  defineEventHandler,
  getRequestHeader,
  setResponseHeader,
  setResponseStatus,
} from 'h3'
import { useRuntimeConfig } from '#imports'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const target = new URL('/api/v1/customer/session', config.apiInternalUrl)
  const response = await fetch(target, {
    headers: { cookie: getRequestHeader(event, 'cookie') ?? '' },
  })

  for (const cookie of response.headers.getSetCookie()) appendResponseHeader(event, 'set-cookie', cookie)
  setResponseHeader(event, 'cache-control', 'no-store')

  if (response.status === 401) {
    return { data: null, meta: { requestId: randomUUID() } }
  }

  setResponseStatus(event, response.status)
  return response.json()
})
