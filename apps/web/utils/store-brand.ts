import { clampChroma, converter, formatHex, parse, wcagContrast } from 'culori'

export interface StoreBrandConfig {
  storeName: string
  storeLogoUrl: string
  storeBrandColor: string
}

export interface StoreBrandInput {
  storeName?: unknown
  storeLogoUrl?: unknown
  storeBrandColor?: unknown
}

export const defaultStoreBrand: StoreBrandConfig = {
  storeName: 'AiKayun 数字商城',
  storeLogoUrl: '',
  storeBrandColor: '#2563EB',
}

const hexColor = /^#(?:[\da-f]{3}|[\da-f]{6})$/i
const toOklch = converter('oklch')
const shades = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const

export function resolveStoreBrand(input: StoreBrandInput): StoreBrandConfig {
  const storeName = typeof input.storeName === 'string'
    ? input.storeName.trim().slice(0, 80)
    : ''
  const storeBrandColor = normalizeHex(input.storeBrandColor) ?? defaultStoreBrand.storeBrandColor

  return {
    storeName: storeName || defaultStoreBrand.storeName,
    storeLogoUrl: resolveLogoUrl(input.storeLogoUrl),
    storeBrandColor,
  }
}

export function normalizeHex(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const color = value.trim()
  if (!hexColor.test(color)) return undefined
  if (color.length === 4) {
    return `#${color.slice(1).split('').map(channel => channel + channel).join('')}`.toUpperCase()
  }
  return color.toUpperCase()
}

export function createStorefrontThemeStyle(brandColor: string): string {
  const validColor = normalizeHex(brandColor) ?? defaultStoreBrand.storeBrandColor
  const parsed = parse(validColor)
  const seed = parsed ? toOklch(parsed) : undefined
  if (!seed) return createStorefrontThemeStyle(defaultStoreBrand.storeBrandColor)

  const chroma = seed.c ?? 0
  const makeHex = (lightness: number, chromaFactor: number) => formatHex(clampChroma({
    mode: 'oklch',
    l: Math.max(0, Math.min(1, lightness)),
    c: chroma * chromaFactor,
    h: seed.h,
  }, 'oklch', 'rgb')).toUpperCase()

  let lightModeLightness = seed.l
  while (lightModeLightness > 0 && wcagContrast(makeHex(lightModeLightness, 1), '#FFFFFF') < 4.5) {
    lightModeLightness = Math.max(0, lightModeLightness - 0.01)
  }

  let darkModeLightness = Math.min(1, Math.max(seed.l + 0.12, 0.72))
  while (darkModeLightness < 1 && wcagContrast(makeHex(darkModeLightness, 0.95), '#020617') < 4.5) {
    darkModeLightness = Math.min(1, darkModeLightness + 0.01)
  }

  const values: Record<typeof shades[number], string> = {
    50: makeHex(darkModeLightness + 0.24, 0.1),
    100: makeHex(darkModeLightness + 0.18, 0.2),
    200: makeHex(darkModeLightness + 0.11, 0.4),
    300: makeHex(darkModeLightness + 0.05, 0.7),
    400: makeHex(darkModeLightness, 0.95),
    500: makeHex((darkModeLightness + lightModeLightness) / 2, 1),
    600: makeHex(lightModeLightness, 1),
    700: makeHex(lightModeLightness - 0.09, 0.96),
    800: makeHex(lightModeLightness - 0.17, 0.9),
    900: makeHex(lightModeLightness - 0.26, 0.82),
    950: makeHex(lightModeLightness - 0.34, 0.72),
  }

  return shades.map(shade => `--ui-color-primary-${shade}:${values[shade]}`).join(';')
}

function resolveLogoUrl(value: unknown): string {
  if (typeof value !== 'string') return ''
  const candidate = value.trim()
  if (!candidate || candidate.includes('\\') || [...candidate].some(character => character.charCodeAt(0) <= 0x1F)) return ''
  if (candidate.startsWith('/') && !candidate.startsWith('//')) return candidate

  try {
    const url = new URL(candidate)
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : ''
  } catch {
    return ''
  }
}
