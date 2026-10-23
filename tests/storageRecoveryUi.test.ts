// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import StorageRecovery from '@/components/StorageRecovery.vue'
import { recoverTransactionStorage } from '@/core/storageRecovery'
import { ReadTimeoutError } from '@/core/readDeadline'

vi.mock('@/core/storageRecovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/storageRecovery')>()),
  recoverTransactionStorage: vi.fn()
}))

const wallet = '0x1111111111111111111111111111111111111111'
const onOpen = vi.fn()
let wrapper: ReturnType<typeof mount> | undefined
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((element) => element.textContent?.trim() === label)!
const status = () => document.querySelector('[role="status"]')!.textContent!
async function open() {
  wrapper = mount(StorageRecovery, {
    attachTo: document.body,
    props: { chain: 'eth', wallet, disabled: false, onOpen }
  })
  await wrapper.get('button').trigger('click')
  return wrapper
}
async function authorize() {
  button('Export backup').click()
  document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
  await flushPromises()
}
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  localStorage.setItem('sm.vmuLocks', JSON.stringify([{ unknown: true }]))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:offline-test')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  vi.mocked(recoverTransactionStorage)
    .mockReset()
    .mockResolvedValue({
      repaired: 0,
      blocked: 1,
      backupKey: null,
      blockedReasons: { unidentified: 1, otherContext: 0, unconfirmed: 0, readLimit: 0 }
    })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it.each(['export', 'acknowledge'] as const)(
  'requires both permissions, not only %s',
  async (step) => {
    await open()
    if (step === 'export') button('Export backup').click()
    else document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
    await flushPromises()
    expect(button('Verify and repair').disabled).toBe(true)
    button('Verify and repair').click()
    expect(recoverTransactionStorage).not.toHaveBeenCalled()
    if (step === 'export')
      document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
    else button('Export backup').click()
    await flushPromises()
    expect(button('Verify and repair').disabled).toBe(false)
  }
)

it('shows damage classifications without rendering the damaged payload', async () => {
  localStorage.setItem('sm.vmuLocks', '{broken')
  localStorage.setItem('sm.pendingOps', '{}')
  localStorage.setItem(
    'sm.pendingOps.event.broken',
    JSON.stringify({ record: '<img src=x onerror=alert(1)>' })
  )
  await open()
  const issues = document.querySelector('.recovery-issues')!
  expect(issues.textContent).toContain('sm.vmuLocks: Unreadable JSON (1)')
  expect(issues.textContent).toContain('sm.pendingOps: Expected a record array (1)')
  expect(issues.textContent).toContain('sm.pendingOps.event.broken: Invalid record structure (1)')
  expect(issues.textContent).not.toContain('onerror')
  expect(issues.querySelector('img')).toBeNull()
})

it('explains the no-hash limitation and displays the blocked result returned by recovery', async () => {
  const evidence = JSON.stringify([{ chain: 'eth', wallet, ids: ['1'], batch: 'damaged' }])
  localStorage.setItem('sm.vmuLocks', evidence)
  await open()
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('without a transaction hash cannot be verified here')
  expect(dialog.textContent).toContain('exported backup for manual investigation')
  expect(dialog.textContent).toContain('mining stays blocked for this site in this browser profile')
  await authorize()
  button('Verify and repair').click()
  await flushPromises()
  expect(status()).toContain('1 record(s) remain blocked')
  expect(localStorage.getItem('sm.vmuLocks')).toBe(evidence)
})

it('explains all retained-record reasons and requires fresh authorization after verification', async () => {
  vi.mocked(recoverTransactionStorage).mockResolvedValue({
    repaired: 0,
    blocked: 4,
    backupKey: null,
    blockedReasons: { unidentified: 1, otherContext: 1, unconfirmed: 1, readLimit: 1 }
  })
  const view = await open()
  await authorize()
  button('Verify and repair').click()
  await flushPromises()
  expect(status()).toContain(
    '0 settled record(s) archived and repaired. 4 record(s) remain blocked.'
  )
  expect(status()).toContain('1 missing or unreadable transaction identities.')
  expect(status()).toContain('1 belong to another account or network.')
  expect(status()).toContain('1 without a matching mined receipt.')
  expect(status()).toContain(
    '1 deferred by the 20-record verification limit; inspect again to continue.'
  )
  expect(button('Verify and repair').disabled).toBe(true)
  expect(view.emitted('changed')).toHaveLength(1)
  expect(localStorage.getItem('sm.vmuLocks')).toBe(JSON.stringify([{ unknown: true }]))
})

it.each([
  ['WALLET_CONTEXT_CHANGED', 'Wallet account or network changed'],
  ['READ_TIMEOUT', 'Wallet or network read timed out'],
  ['LOCK_STORAGE_INVALID', 'Local transaction storage is unavailable or damaged'],
  ['PENDING_STORAGE_READ_FAILED', 'Local transaction storage is unavailable or damaged'],
  ['WALLET_EVIDENCE_UNAVAILABLE', 'Wallet transaction evidence is unavailable']
])('shows actionable text for %s without raw prefixes', async (code, message) => {
  vi.mocked(recoverTransactionStorage).mockRejectedValue(new Error(`${code}: fixture details`))
  await open()
  await authorize()
  button('Verify and repair').click()
  await flushPromises()
  expect(status()).toContain(message)
  expect(status()).not.toContain(code)
  expect(status()).toMatch(/Do not (?:clear site data or )?resend/)
  expect(status()).not.toContain('Open transaction storage recovery')
  if (code === 'LOCK_STORAGE_INVALID' || code === 'PENDING_STORAGE_READ_FAILED')
    expect(status()).toContain('Restore storage access, then inspect again.')
  expect(localStorage.getItem('sm.vmuLocks')).toBe(JSON.stringify([{ unknown: true }]))
})

it('preserves the wallet receipt timeout label in recovery without raw error prefixes', async () => {
  vi.mocked(recoverTransactionStorage).mockRejectedValue(
    new ReadTimeoutError('Wallet eth_getTransactionReceipt', 15_000)
  )
  await open()
  await authorize()
  button('Verify and repair').click()
  await flushPromises()
  expect(status()).toContain('Wallet eth_getTransactionReceipt exceeded 15000 ms.')
  expect(status()).toContain('Do not resend.')
  expect(status()).not.toContain('READ_TIMEOUT')
})

it.each(['wallet', 'chain', 'unmount'] as const)(
  'aborts and reports closed when %s changes',
  async (kind) => {
    let signal: AbortSignal | undefined
    vi.mocked(recoverTransactionStorage).mockImplementation(
      (_snapshot, _chain, _wallet, active) => {
        signal = active
        return new Promise((_resolve, reject) =>
          active!.addEventListener('abort', () => reject(new Error('READ_ABORTED')))
        )
      }
    )
    const view = await open()
    await authorize()
    button('Verify and repair').click()
    await flushPromises()
    if (kind === 'wallet')
      await view.setProps({ wallet: '0x2222222222222222222222222222222222222222' })
    else if (kind === 'chain') await view.setProps({ chain: 'polygon' })
    else {
      view.unmount()
      wrapper = undefined
    }
    await flushPromises()
    expect(signal?.aborted).toBe(true)
    expect(onOpen).toHaveBeenLastCalledWith(false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  }
)

it.each(['close button', 'backdrop'] as const)(
  'aborts in-flight recovery through the %s without losing evidence or reopening the dialog',
  async (interaction) => {
    let signal: AbortSignal | undefined
    let reject!: (error: Error) => void
    vi.mocked(recoverTransactionStorage).mockImplementation(
      (_snapshot, _chain, _wallet, active) => {
        signal = active
        return new Promise((_resolve, fail) => {
          reject = fail
        })
      }
    )
    const evidence = localStorage.getItem('sm.vmuLocks')
    const view = await open()
    await authorize()
    button('Verify and repair').click()
    await flushPromises()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    dialog.click()
    await flushPromises()
    expect(signal?.aborted).toBe(false)
    if (interaction === 'close button')
      document.querySelector<HTMLButtonElement>('[aria-label="Close recovery"]')!.click()
    else document.querySelector<HTMLElement>('.recovery-mask')!.click()
    await flushPromises()
    expect(signal?.aborted).toBe(true)
    expect(onOpen).toHaveBeenLastCalledWith(false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    reject(new Error('Late recovery response'))
    await flushPromises()
    expect(view.emitted('changed')).toHaveLength(1)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(localStorage.getItem('sm.vmuLocks')).toBe(evidence)
    await view.get('button').trigger('click')
    expect(status()).toBe('')
    expect(button('Verify and repair').disabled).toBe(true)
    expect(recoverTransactionStorage).toHaveBeenCalledOnce()
  }
)

it('cancels at the 30 second UI deadline and leaves all evidence unchanged', async () => {
  vi.useFakeTimers()
  vi.mocked(recoverTransactionStorage).mockImplementation(
    (_snapshot, _chain, _wallet, signal) =>
      new Promise((_resolve, reject) =>
        signal!.addEventListener('abort', () => reject(new Error('READ_ABORTED')))
      )
  )
  const view = await open()
  await authorize()
  button('Verify and repair').click()
  await vi.advanceTimersByTimeAsync(30_000)
  await flushPromises()
  expect(status()).toContain('Recovery cancelled or timed out')
  expect(button('Verify and repair').disabled).toBe(false)
  expect(view.emitted('changed')).toHaveLength(1)
  expect(localStorage.getItem('sm.vmuLocks')).toBe(JSON.stringify([{ unknown: true }]))
})
