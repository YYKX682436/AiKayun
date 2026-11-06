// Keep private collector fields out of public, signed evidence.
export function hasOnlyLicenseEvidenceFields(evidence) {
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
  return Boolean(exact(evidence, ['binary_sha256', 'go_version', 'arch', 'modules', 'licenses']) && Array.isArray(evidence.licenses) && evidence.licenses.every(item => exact(item, ['module', 'version', 'module_h1', 'path', 'sha256', 'content'])))
}
