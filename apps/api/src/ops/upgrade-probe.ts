export function isUpgradeProbeOnly(value = process.env.AIKAYUN_UPGRADE_PROBE_ONLY): boolean {
  const normalized = value ?? 'false'
  if (normalized !== 'true' && normalized !== 'false') {
    throw new Error('AIKAYUN_UPGRADE_PROBE_ONLY must be true or false')
  }
  return normalized === 'true'
}
