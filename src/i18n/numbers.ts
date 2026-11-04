import type { Language } from '../types'

export function numberLocale(language: Language): string {
  return language === 'ar' ? 'ar-EG-u-nu-latn' : 'en-EG-u-nu-latn'
}

export function toLatinDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0)
    return String.fromCharCode(code >= 0x6f0 ? code - 0x6f0 + 0x30 : code - 0x660 + 0x30)
  })
}

export function normalizeDigitsInData<T>(value: T): T {
  if (typeof value === 'string') return toLatinDigits(value) as T
  if (Array.isArray(value)) return value.map(normalizeDigitsInData) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, normalizeDigitsInData(child)]),
    ) as T
  }
  return value
}
