// Pure formatter shared by the internal preparation and signed verification candidates.
export function renderResticLicenses(evidence, binarySha) {
  const lines = ['Verified restic and Go toolchain license evidence', `Binary SHA-256: ${binarySha}`,
    'License manifest SHA-256: 92f0c44844b7e9e16956e00f7c5c9a5805ac7ab55d2febe048b5d6c5ecba6be2', '']
  for (const item of evidence.licenses) lines.push(`----- BEGIN ${item.module}@${item.version} ${item.path} SHA256 ${item.sha256} -----`, '', item.content, `----- END ${item.path} -----`, '')
  return `${lines.join('\n')}\n`
}
