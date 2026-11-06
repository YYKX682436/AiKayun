const marker = 'aikayun-state-volume-v1'

/** The initializer writes one trailing LF; older prepared volumes may omit it. */
export function isValidStateVolumeMarker(value: Uint8Array): boolean {
  const contentLength = marker.length
  const hasCanonicalContent = value.length === contentLength ||
    (value.length === contentLength + 1 && value[contentLength] === 0x0a)
  if (!hasCanonicalContent) return false
  for (let index = 0; index < contentLength; index++) {
    if (value[index] !== marker.charCodeAt(index)) return false
  }
  return true
}

export const stateVolumeMarkerLength = marker.length
