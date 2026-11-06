// Pure formatter shared by the internal preparation and signed verification candidates.
export function renderResticLicenses(evidence, binarySha) {
  const lines = ['Verified restic and Go toolchain license evidence', `Binary SHA-256: ${binarySha}`,
    'License manifest SHA-256: 1798e78a9b8d8d24bd901c8c9bccdce77bf14d98215f2a708beeb6f320dae63b', '']
  for (const item of evidence.licenses) lines.push(`----- BEGIN ${item.module}@${item.version} ${item.path} SHA256 ${item.sha256} -----`, '', item.content, `----- END ${item.path} -----`, '')
  return `${lines.join('\n')}\n`
}
