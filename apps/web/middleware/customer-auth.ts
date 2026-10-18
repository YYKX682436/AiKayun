export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path !== '/account') return

  const customerApi = useCustomerApi()
  if (!customerApi.sessionResolved.value) {
    const sessionCookie = useCookie<string | null>('aikayun_customer_session')
    if (import.meta.server && !sessionCookie.value) customerApi.sessionResolved.value = true
    else await customerApi.refreshSession()
  } else if (customerApi.session.value) {
    await customerApi.refreshSession()
  }
  if (!customerApi.session.value) {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }
})
