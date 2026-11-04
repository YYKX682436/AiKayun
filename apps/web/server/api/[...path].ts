import { createError, defineEventHandler, proxyRequest } from 'h3'
import { useRuntimeConfig } from '#imports'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const target = new URL(event.path, `${config.apiInternalUrl}/`)
  try {
    return await proxyRequest(event, target.toString())
  } catch {
    // h3 retains the fetch error as a cause, which can include the full URL.
    throw createError({ statusCode: 502, statusMessage: 'Bad Gateway' })
  }
})
