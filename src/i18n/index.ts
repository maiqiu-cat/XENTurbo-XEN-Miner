import { computed, onScopeDispose, readonly, ref, watch } from 'vue'
import { messages } from './messages'
import { runtimeMessages } from './runtimeMessages'

export type Locale = 'en' | 'zh-Hant'
export type LanguagePreference = 'auto' | Locale
export const LANGUAGE_STORAGE_KEY = 'xenturbo.language.v1'
type Params = Record<string, string | number>
type MessageKey = keyof typeof messages
const catalog: Readonly<Record<string, string>> = { ...messages, ...runtimeMessages }
const numericParameters = new Set([
  'max',
  'count',
  'days',
  'hours',
  'minutes',
  'seconds',
  'available',
  'total',
  'repaired',
  'blocked',
  'groups',
  'page',
  'pages',
  'matched',
  'expected',
  'actual'
])

export function browserLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return 'zh-Hant'
    if (/^en(?:-|$)/i.test(language)) return 'en'
  }
  return 'en'
}

function preferenceFrom(value: unknown): LanguagePreference {
  return value === 'en' || value === 'zh-Hant' ? value : 'auto'
}

function interpolate(template: string, params: Params): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
    Object.hasOwn(params, key) ? String(params[key]) : placeholder
  )
}

// Only whole, known application messages are localized. Provider diagnostics and identifiers
// that do not match the catalog remain verbatim; transaction state is never translated.
const patterns = Object.entries(runtimeMessages)
  .filter(([source]) => /\{\w+\}/.test(source))
  .map(([source, translated]) => {
    const keys: string[] = []
    const parts = source.split(/(\{\w+\})/g)
    const pattern = parts
      .map((part) => {
        if (/^\{\w+\}$/.test(part)) {
          const key = part.slice(1, -1)
          keys.push(key)
          return numericParameters.has(key) ? '(\\d+)' : '([\\s\\S]*?)'
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      })
      .join('')
    return { regex: new RegExp(`^${pattern}$`), keys, translated }
  })

export function createI18n(environment: {
  languages: () => readonly string[]
  storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}) {
  const preference = ref<LanguagePreference>('auto')
  const detected = ref<Locale>('en')
  const locale = computed<Locale>(() =>
    preference.value === 'auto' ? detected.value : preference.value
  )

  function syncBrowser() {
    detected.value = browserLocale(environment.languages())
  }
  function restore() {
    syncBrowser()
    try {
      preference.value = preferenceFrom(environment.storage().getItem(LANGUAGE_STORAGE_KEY))
    } catch {
      preference.value = 'auto'
    }
  }
  function setPreference(value: LanguagePreference) {
    preference.value = preferenceFrom(value)
    syncBrowser()
    try {
      if (preference.value === 'auto') environment.storage().removeItem(LANGUAGE_STORAGE_KEY)
      else environment.storage().setItem(LANGUAGE_STORAGE_KEY, preference.value)
    } catch {
      // Language stays usable for this tab even when browser storage is blocked.
    }
  }
  function t(key: MessageKey, params: Params = {}): string {
    return interpolate(locale.value === 'en' ? key : messages[key], params)
  }
  function message(source: string | null | undefined, depth = 0): string {
    if (!source || locale.value === 'en') return source ?? ''
    if (Object.hasOwn(catalog, source)) return catalog[source]
    if (source.length > 8_192 || depth >= 3) return source
    for (const { regex, keys, translated } of patterns) {
      const match = regex.exec(source)
      if (!match) continue
      const params = Object.fromEntries(keys.map((key, index) => [key, match[index + 1]]))
      for (const key of ['error', 'detail', 'status', 'action']) {
        if (params[key]) params[key] = message(params[key], depth + 1)
      }
      return interpolate(translated, params)
    }
    return source
  }
  return {
    preference: readonly(preference),
    locale,
    setPreference,
    syncBrowser,
    restore,
    t,
    message
  }
}

export const i18n = createI18n({
  languages: () => (navigator.languages?.length ? navigator.languages : [navigator.language]),
  storage: () => window.localStorage
})
export const { t, message } = i18n

export function useLanguageEnvironment() {
  i18n.restore()
  const stop = watch(
    i18n.locale,
    (locale) => {
      document.documentElement.lang = locale
    },
    { immediate: true }
  )
  const languageChanged = () => i18n.syncBrowser()
  const storageChanged = (event: StorageEvent) => {
    if (event.key !== null && event.key !== LANGUAGE_STORAGE_KEY) return
    try {
      if (event.storageArea === window.localStorage) i18n.restore()
    } catch {
      /* A blocked storage area cannot provide a preference. */
    }
  }
  window.addEventListener('languagechange', languageChanged)
  window.addEventListener('storage', storageChanged)
  onScopeDispose(() => {
    stop()
    window.removeEventListener('languagechange', languageChanged)
    window.removeEventListener('storage', storageChanged)
  })
}
