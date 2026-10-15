import { defineEventHandler, proxyRequest } from 'h3'
import { useRuntimeConfig } from '#imports'

export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event)
  const target = new URL(event.path, `${config.apiInternalUrl}/`)
  return proxyRequest(event, target.toString())
})
