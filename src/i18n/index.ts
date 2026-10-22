import { ar } from './ar'
import { en } from './en'

export const translations = {
  ar,
  en,
}

export type TranslationLanguage = keyof typeof translations

export type AppTranslations = typeof en