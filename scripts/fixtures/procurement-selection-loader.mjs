const replacement = 'data:text/javascript,' + encodeURIComponent(`
export function selectCheckoutProcurementSources() {
  const value = process.env.AIKAYUN_SYNTHETIC_PROCUREMENT_SELECTION || '[]'
  const rows = JSON.parse(value)
  if (!Array.isArray(rows)) throw new Error('Synthetic procurement selection must be an array')
  return rows
}
`)

export async function resolve(specifier, context, nextResolve) {
  // This loader is installed only by isolated procurement/recovery fixtures.
  // The exact relative specifier is the checkout order route's selector in both
  // the compiled production API and the TSX signed auxiliary API.
  if (specifier === './procurement-source-selection.js' || specifier === './procurement-source-selection.ts') {
    return { url: replacement, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
