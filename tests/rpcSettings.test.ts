// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RpcSettings from '@/components/RpcSettings.vue'
import { readCustomRpc, writeCustomRpc } from '@/config/chains'
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
  })

  it('does not save a validated Ethereum URL after the selected chain changes', async () => {
    const validation = deferred<{ url: string; chainId: number; checkedAt: number }>()
    vi.mocked(validateRpcEndpoint).mockReturnValue(validation.promise)
    const wrapper = mount(RpcSettings, { props: { chain: 'eth' } })

    await wrapper.get('button').trigger('click')
    await wrapper.get('textarea').setValue('https://rpc.example')
    await wrapper.get('.btn-primary').trigger('click')
    expect(validateRpcEndpoint).toHaveBeenCalledWith('https://rpc.example', 1)

    await wrapper.setProps({ chain: 'polygon' })
    validation.resolve({ url: 'https://rpc.example', chainId: 1, checkedAt: Date.now() })
    await flushPromises()

    expect(writeCustomRpc).not.toHaveBeenCalled()
    expect(resetProviders).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Network changed while RPC validation was running')
  })
})
