const replacement = 'data:text/javascript,' + encodeURIComponent(`
export function selectCheckoutProcurementSources() {
  const value = process.env.AIKAYUN_SYNTHETIC_PROCUREMENT_SELECTION || '[]'
  const rows = JSON.parse(value)
  if (!Array.isArray(rows)) throw new Error('Synthetic procurement selection must be an array')
  return rows
}
`)

export async function resolve(specifier, context, nextResolve) {
  if (specifier === './procurement-source-selection.js'
    && context.parentURL?.endsWith('/dist/commerce/orders.js')) {
    return { url: replacement, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
