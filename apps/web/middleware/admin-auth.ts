export default defineNuxtRouteMiddleware(async (to) => {
  if (!to.path.startsWith('/admin') || to.path === '/admin/login') return

  try {
    const requestFetch = useRequestFetch()
    await requestFetch('/api/v1/admin/session')
  } catch {
    return navigateTo({ path: '/admin/login', query: { redirect: to.fullPath } })
  }
})
