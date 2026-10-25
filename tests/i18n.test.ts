// @vitest-environment happy-dom

import { enableAutoUnmount, mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  browserLocale,
  createI18n,
  i18n,
  LANGUAGE_STORAGE_KEY,
  useLanguageEnvironment
} from '@/i18n'
import { messages } from '@/i18n/messages'
import { runtimeMessages } from '@/i18n/runtimeMessages'
import LanguageSelect from '@/components/LanguageSelect.vue'
import TxModal from '@/components/TxModal.vue'
import type { TxStepState } from '@/core/txManager'

const LanguageHost = defineComponent({
  components: { LanguageSelect },
  setup() {
    useLanguageEnvironment()
  },
  template: '<LanguageSelect />'
})

enableAutoUnmount(afterEach)
afterEach(() => {
  vi.restoreAllMocks()
  i18n.setPreference('auto')
  localStorage.removeItem(LANGUAGE_STORAGE_KEY)
})

function fixture(languages = ['en-US']) {
  const values = new Map<string, string>()
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value)
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key)
    })
  }
  const environment = { languages: () => languages, storage: () => storage }
  return { values, storage, environment, translator: createI18n(environment) }
}

describe('language preferences', () => {
  it.each(['zh', 'zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-CN', 'zh-Hans-CN', 'ZH-tw'])(
    'uses Traditional Chinese for browser locale %s',
    (language) => {
      expect(browserLocale([language, 'en'])).toBe('zh-Hant')
    }
  )
  it.each([
    [['en-GB', 'zh-TW'], 'en'],
    [['fr-FR', 'zh-HK', 'en'], 'zh-Hant'],
    [['ja-JP'], 'en'],
    [[], 'en'],
    [['zhx', 'english'], 'en']
  ] as const)(
    'respects supported preference order and falls back safely: %j',
    (languages, expected) => {
      expect(browserLocale(languages)).toBe(expected)
    }
  )

  it('remembers a manual choice, then removes only the language key when returning to auto', () => {
    const { translator, environment, values } = fixture(['zh-TW'])
    values.set('sm.vmuLocks', 'keep-original-evidence')
    translator.restore()
    expect(translator.locale.value).toBe('zh-Hant')
    translator.setPreference('en')
    const reloaded = createI18n(environment)
    reloaded.restore()
    expect(reloaded.preference.value).toBe('en')
    expect(reloaded.locale.value).toBe('en')
    reloaded.setPreference('auto')
    expect(reloaded.locale.value).toBe('zh-Hant')
    expect(values.has(LANGUAGE_STORAGE_KEY)).toBe(false)
    expect(values.get('sm.vmuLocks')).toBe('keep-original-evidence')
  })

  it('ignores malformed preferences without deleting stored data', () => {
    const { translator, values, storage } = fixture(['zh-HK'])
    values.set(LANGUAGE_STORAGE_KEY, '{broken')
    translator.restore()
    expect(translator.preference.value).toBe('auto')
    expect(translator.locale.value).toBe('zh-Hant')
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(values.get(LANGUAGE_STORAGE_KEY)).toBe('{broken')
  })

  it('still switches language when access to localStorage throws', () => {
    const translator = createI18n({
      languages: () => ['zh-TW'],
      storage: () => {
        throw new Error('blocked')
      }
    })
    expect(() => translator.restore()).not.toThrow()
    expect(translator.locale.value).toBe('zh-Hant')
    expect(() => translator.setPreference('en')).not.toThrow()
    expect(translator.locale.value).toBe('en')
    expect(translator.preferenceSaved.value).toBe(false)
    expect(() => translator.setPreference('auto')).not.toThrow()
    expect(translator.locale.value).toBe('zh-Hant')
  })

  it('updates browser detection without overriding a manual choice', () => {
    const languages = ['en-US']
    const { translator } = fixture(languages)
    translator.restore()
    languages[0] = 'zh-HK'
    translator.syncBrowser()
    expect(translator.locale.value).toBe('zh-Hant')
    translator.setPreference('en')
    translator.syncBrowser()
    expect(translator.locale.value).toBe('en')
  })
})

describe('presentation-only translation', () => {
  it('keeps placeholder sets identical in every translation', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    for (const [source, target] of Object.entries({ ...messages, ...runtimeMessages })) {
      expect(placeholders(target), source).toEqual(placeholders(source))
      expect(target.trim(), source).not.toBe('')
    }
    expect(Object.keys(messages).filter((key) => Object.hasOwn(runtimeMessages, key))).toEqual([])
  })

  it('interpolates numbers without formatting or mutating identifiers', () => {
    const { translator } = fixture(['zh-TW'])
    translator.restore()
    expect(translator.t('Mint VMUs (max {max})', { max: 128 })).toBe('鑄造 VMU（最多 128 個）')
    expect(translator.message('ids 1, 9, 18 · re-mint 10d')).toBe('ID 1, 9, 18 · 重新鑄造 10 天')
    expect(
      translator.t('Verified full result: {matched}/{expected} VMUs are {status}.', {
        matched: 2,
        expected: 3,
        status: translator.message('EMPTY')
      })
    ).toBe('完整結果已驗證：2/3 個 VMU 的狀態為 空槽。')
    translator.setPreference('en')
    expect(translator.t('Mint VMUs (max {max})', { max: 128 })).toBe('Mint VMUs (max 128)')
  })

  it('preserves unknown, prototype-like, and malicious diagnostics verbatim', () => {
    const { translator } = fixture(['zh-TW'])
    translator.restore()
    for (const text of [
      '__proto__',
      'constructor',
      'denied',
      'custom',
      'invalid',
      '<script>alert(1)</script>',
      '0x123abc',
      'd'.repeat(9_000)
    ]) {
      expect(translator.message(text)).toBe(text)
    }
    expect(translator.message('Preparation failed: denied')).toBe('準備失敗：denied')
    expect(translator.message('')).toBe('')
    expect(translator.message(null)).toBe('')
    // UI interpolation templates are not patterns for untrusted provider diagnostics.
    const unknown = `1 (${'a '.repeat(3_000)}`
    expect(translator.message(unknown)).toBe(unknown)
  })

  it('relocalizes existing activity without altering state, enabling signing or injecting markup', async () => {
    i18n.setPreference('en')
    const state: TxStepState = {
      estimate: 'done',
      send: 'error',
      confirm: 'wait',
      readyToSign: false,
      error: 'Preparation failed: <img src=x onerror=alert(1)>',
      logs: [{ at: 1, status: 'done', message: 'Configured RPC is available.' }]
    }
    const original = structuredClone(state)
    const wrapper = mount(TxModal, {
      props: { visible: true, chain: 'eth', title: 'Claim & Re-Mint (10 days)', state }
    })
    i18n.setPreference('zh-Hant')
    await nextTick()
    expect(wrapper.text()).toContain('領取並重新鑄造（10 天）')
    expect(wrapper.text()).toContain('設定的 RPC 可用。')
    expect(wrapper.get('.err-text').text()).toBe('準備失敗：<img src=x onerror=alert(1)>')
    expect(wrapper.find('img, script').exists()).toBe(false)
    expect(wrapper.findAll('button').some((button) => button.text().includes('簽署'))).toBe(false)
    expect(state).toEqual(original)
    expect(wrapper.emitted()).toEqual({})
    i18n.setPreference('en')
    await nextTick()
    expect(wrapper.text()).toContain('Configured RPC is available.')
    expect(state).toEqual(original)
  })
})

describe('language environment and control', () => {
  it('discloses a failed preference save while keeping the chosen language usable', async () => {
    i18n.setPreference('en')
    const wrapper = mount(LanguageHost)
    const write = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('blocked')
    })
    await wrapper.get('select').setValue('zh-Hant')
    expect(wrapper.get('[role="status"]').text()).toBe('無法儲存語言選擇，目前僅套用於此分頁。')
    expect(document.documentElement.lang).toBe('zh-Hant')
    write.mockRestore()
    await wrapper.get('select').setValue('en')
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
  })
  it('changes document language, handles browser/storage changes and removes listeners on unmount', async () => {
    const browserLanguages = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['zh-TW'])
    localStorage.removeItem(LANGUAGE_STORAGE_KEY)
    const remove = vi.spyOn(window, 'removeEventListener')
    const wrapper = mount(LanguageHost)
    expect(document.documentElement.lang).toBe('zh-Hant')
    await wrapper.get('select').setValue('en')
    expect(document.documentElement.lang).toBe('en')
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en')
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'zh-Hant')
    window.dispatchEvent(
      new StorageEvent('storage', { key: LANGUAGE_STORAGE_KEY, storageArea: localStorage })
    )
    await nextTick()
    expect(document.documentElement.lang).toBe('zh-Hant')
    browserLanguages.mockReturnValue(['en-GB'])
    window.dispatchEvent(new Event('languagechange'))
    await nextTick()
    expect(document.documentElement.lang).toBe('zh-Hant')
    await wrapper.get('select').setValue('auto')
    expect(document.documentElement.lang).toBe('en')
    browserLanguages.mockReturnValue(['zh-HK'])
    window.dispatchEvent(new Event('languagechange'))
    await nextTick()
    expect(document.documentElement.lang).toBe('zh-Hant')
    wrapper.unmount()
    expect(remove).toHaveBeenCalledWith('languagechange', expect.any(Function))
    expect(remove).toHaveBeenCalledWith('storage', expect.any(Function))
  })

  it('ignores unrelated/session storage events and restores auto on a local preference removal', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['zh-TW'])
    i18n.setPreference('en')
    mount(LanguageHost)
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: LANGUAGE_STORAGE_KEY,
        newValue: 'zh-Hant',
        storageArea: sessionStorage
      })
    )
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'sm.vmuLocks', storageArea: localStorage })
    )
    await nextTick()
    expect(document.documentElement.lang).toBe('en')
    localStorage.removeItem(LANGUAGE_STORAGE_KEY)
    window.dispatchEvent(
      new StorageEvent('storage', { key: LANGUAGE_STORAGE_KEY, storageArea: localStorage })
    )
    await nextTick()
    expect(document.documentElement.lang).toBe('zh-Hant')
  })
})
