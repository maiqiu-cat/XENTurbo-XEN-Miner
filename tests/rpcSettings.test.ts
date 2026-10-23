// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RpcSettings from '@/components/RpcSettings.vue'
import {
  MAX_RPC_ENDPOINTS,
  MAX_RPC_INPUT_LENGTH,
  MAX_RPC_URL_LENGTH,
  RPC_CHECK_CONCURRENCY,
  readCustomRpc,
  writeCustomRpc
} from '@/config/chains'
import { resetProviders, validateRpcEndpoint } from '@/core/rpc'

vi.mock('@/config/chains', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/chains')>()
  return {
    ...actual,
    readCustomRpc: vi.fn(() => []),
    writeCustomRpc: vi.fn()
  }
})

vi.mock('@/core/rpc', () => ({
  resetProviders: vi.fn(),
  validateRpcEndpoint: vi.fn()
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('RpcSettings validation context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(readCustomRpc).mockReturnValue([])
    vi.mocked(validateRpcEndpoint)
      .mockReset()
      .mockImplementation(async (url, chainId) => ({ url, chainId, checkedAt: 1 }))
  })

  it('does not save a validated Ethereum URL after the selected chain changes', async () => {
    const validation = deferred<{ url: string; chainId: number; checkedAt: number }>()
    vi.mocked(validateRpcEndpoint).mockReturnValue(validation.promise)
    const wrapper = mount(RpcSettings, { props: { chain: 'eth' } })

    await wrapper.get('button').trigger('click')
    await wrapper.get('textarea').setValue('https://rpc.example')
    await wrapper.get('.btn-primary').trigger('click')
    expect(validateRpcEndpoint).toHaveBeenCalledWith('https://rpc.example/', 1)

    await wrapper.setProps({ chain: 'polygon' })
    validation.resolve({ url: 'https://rpc.example', chainId: 1, checkedAt: Date.now() })
    await flushPromises()

    expect(writeCustomRpc).not.toHaveBeenCalled()
    expect(resetProviders).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Network changed while RPC validation was running')
    wrapper.unmount()
  })

  it.each([
    Array.from({ length: MAX_RPC_ENDPOINTS + 1 }, (_, i) => `https://rpc${i}.example`).join('\n'),
    `https://rpc.example/${'x'.repeat(MAX_RPC_URL_LENGTH)}`,
    ' '.repeat(MAX_RPC_INPUT_LENGTH + 1)
  ])('rejects oversized input before any request or persistence', async (input) => {
    const wrapper = mount(RpcSettings, { props: { chain: 'eth' } })
    await wrapper.get('button').trigger('click')
    await wrapper.get('textarea').setValue(input)
    await wrapper.get('.btn-primary').trigger('click')
    await flushPromises()
    expect(wrapper.find('.rpc-error').exists()).toBe(true)
    expect(validateRpcEndpoint).not.toHaveBeenCalled()
    expect(writeCustomRpc).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('validates at most four endpoints at once and saves a deduplicated full boundary list', async () => {
    const gate = deferred<void>()
    let active = 0
    let peak = 0
    vi.mocked(validateRpcEndpoint).mockImplementation(async (url, chainId) => {
      active += 1
      peak = Math.max(peak, active)
      await gate.promise
      active -= 1
      return { url, chainId, checkedAt: 1 }
    })
    const urls = Array.from({ length: MAX_RPC_ENDPOINTS }, (_, i) => `https://rpc${i}.example/`)
    const wrapper = mount(RpcSettings, { props: { chain: 'eth' } })
    await wrapper.get('button').trigger('click')
    await wrapper.get('textarea').setValue([...urls, urls[0]].join('\n'))
    await wrapper.get('.btn-primary').trigger('click')
    expect(validateRpcEndpoint).toHaveBeenCalledTimes(RPC_CHECK_CONCURRENCY)
    gate.resolve()
    await flushPromises()
    expect(peak).toBe(RPC_CHECK_CONCURRENCY)
    expect(validateRpcEndpoint).toHaveBeenCalledTimes(MAX_RPC_ENDPOINTS)
    expect(writeCustomRpc).toHaveBeenCalledWith('eth', urls)
    expect(wrapper.emitted('saved')).toHaveLength(1)
    wrapper.unmount()
  })

  it('rejects stale validation even if the user switches away and back to the same chain', async () => {
    const validation = deferred<{ url: string; chainId: number; checkedAt: number }>()
    vi.mocked(validateRpcEndpoint).mockReturnValue(validation.promise)
    const wrapper = mount(RpcSettings, { props: { chain: 'eth' } })
    await wrapper.get('button').trigger('click')
    await wrapper.get('textarea').setValue('https://rpc.example')
    await wrapper.get('.btn-primary').trigger('click')
    await wrapper.setProps({ chain: 'polygon' })
    await wrapper.setProps({ chain: 'eth' })
    validation.resolve({ url: 'https://rpc.example/', chainId: 1, checkedAt: 1 })
    await flushPromises()
    expect(writeCustomRpc).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Network changed while RPC validation was running')
    wrapper.unmount()
  })

  it('shows an overlong legacy endpoint and preserves it when Save rejects the new limit', async () => {
    const url = `https://legacy.example/${'x'.repeat(MAX_RPC_URL_LENGTH)}`
    vi.mocked(readCustomRpc).mockReturnValue([url])
    const wrapper = mount(RpcSettings, { props: { chain: 'eth' } })
    await wrapper.get('button').trigger('click')
    expect(wrapper.get('textarea').element.value).toBe(url)
    await wrapper.get('.btn-primary').trigger('click')
    await flushPromises()
    expect(wrapper.get('.rpc-error').text()).toContain('RPC URL must not exceed')
    expect(validateRpcEndpoint).not.toHaveBeenCalled()
    expect(writeCustomRpc).not.toHaveBeenCalled()
    expect(resetProviders).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('never saves or emits after unmount during validation', async () => {
    const validation = deferred<{ url: string; chainId: number; checkedAt: number }>()
    vi.mocked(validateRpcEndpoint).mockReturnValue(validation.promise)
    const wrapper = mount(RpcSettings, { props: { chain: 'eth' } })
    await wrapper.get('button').trigger('click')
    await wrapper.get('textarea').setValue('https://rpc.example')
    await wrapper.get('.btn-primary').trigger('click')
    wrapper.unmount()
    validation.resolve({ url: 'https://rpc.example/', chainId: 1, checkedAt: 1 })
    await flushPromises()
    expect(writeCustomRpc).not.toHaveBeenCalled()
    expect(resetProviders).not.toHaveBeenCalled()
    expect(wrapper.emitted('saved')).toBeUndefined()
  })

  it('keeps Save disabled until failed validation workers have drained', async () => {
    const gate = deferred<{ url: string; chainId: number; checkedAt: number }>()
    vi.mocked(validateRpcEndpoint).mockImplementation((url) =>
      url.includes('rpc0.') ? Promise.reject(new Error('wrong chain')) : gate.promise
    )
    const wrapper = mount(RpcSettings, { props: { chain: 'eth' } })
    await wrapper.get('button').trigger('click')
    await wrapper
      .get('textarea')
      .setValue(Array.from({ length: 16 }, (_, id) => `https://rpc${id}.example`).join('\n'))
    await wrapper.get('.btn-primary').trigger('click')
    await flushPromises()
    expect(wrapper.get('.btn-primary').attributes('disabled')).toBeDefined()
    expect(validateRpcEndpoint).toHaveBeenCalledTimes(4)
    await wrapper.get('.btn-primary').trigger('click')
    expect(validateRpcEndpoint).toHaveBeenCalledTimes(4)
    gate.resolve({ url: 'https://rpc1.example/', chainId: 1, checkedAt: 1 })
    await flushPromises()
    expect(wrapper.get('.rpc-error').text()).toBe('wrong chain')
    expect(wrapper.get('.btn-primary').attributes('disabled')).toBeUndefined()
    expect(validateRpcEndpoint).toHaveBeenCalledTimes(4)
    expect(writeCustomRpc).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
