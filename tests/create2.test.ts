import { describe, expect, it } from 'vitest'
import {
  computeProxyAddress,
  computeProxyAddressRange,
  proxyInitCodeHash,
  minimalProxyInitCode,
  minimalProxyRuntimeCode
} from '../src/core/create2'

// Production contract addresses.
const FACTORY = '0xfEF2359e77Df8B769760D62cbB5eE676FE78f6C2'
const VMU_TEMPLATE = '0x1D65d25b1D90Ef6Dd9F64b10d6B079a015085855'
const WALLET = '0xD3216C59691C5d27aa68F9023A1A435897149D35'

// Golden values produced by the project's OWN production derivation
// (contract/contract-xen-miner/utils/contract.util.ts :: getCreate2Address).
// Our implementation must stay byte-identical to it.
const GOLDEN_INIT_CODE_HASH =
  '0x02a272a8b9ecaac2626a4e479d8ab27503a779f78636bdf04fe99ba77b3c5e71'

const GOLDEN: Record<number, string> = {
  1: '0x7a599246badb63e074524776d1b0eedd74673c25',
  2: '0x65558d87da63ffb1dac2d767cb3e986416b5dee7',
  231: '0x7ab7ab8d204fee5f9046d61f1bf08a63db8094cf',
  1000: '0xa2e91c95b3d1236d4ad5eb447aaac49dd115645e'
}

describe('CREATE2 proxy derivation', () => {
  it('produces the canonical EIP-1167 minimal proxy init code', () => {
    const initCode = minimalProxyInitCode(VMU_TEMPLATE).toLowerCase()
    expect(initCode.startsWith('0x3d602d80600a3d3981f3363d3d373d3d3d363d73')).toBe(true)
    expect(initCode.endsWith('5af43d82803e903d91602b57fd5bf3')).toBe(true)
    expect(initCode).toContain(VMU_TEMPLATE.slice(2).toLowerCase())
  })

  it('produces the exact EIP-1167 runtime code expected at a deployed VMU address', () => {
    const runtimeCode = minimalProxyRuntimeCode(VMU_TEMPLATE).toLowerCase()
    expect(runtimeCode).toBe(
      `0x363d3d373d3d3d363d73${VMU_TEMPLATE.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`
    )
    expect(minimalProxyInitCode(VMU_TEMPLATE).toLowerCase().endsWith(runtimeCode.slice(2))).toBe(true)
  })

  it('matches the production init code hash', () => {
    expect(proxyInitCodeHash(VMU_TEMPLATE)).toBe(GOLDEN_INIT_CODE_HASH)
  })

  it('derives proxy addresses identical to the production reference', () => {
    for (const [id, expected] of Object.entries(GOLDEN)) {
      const got = computeProxyAddress({
        factory: FACTORY,
        vmuTemplate: VMU_TEMPLATE,
        wallet: WALLET,
        vmuId: Number(id)
      })
      expect(got.toLowerCase()).toBe(expected)
    }
  })

  it('range derivation agrees with single derivation', () => {
    const range = computeProxyAddressRange({
      factory: FACTORY,
      vmuTemplate: VMU_TEMPLATE,
      wallet: WALLET,
      fromId: 1,
      toId: 2
    })
    expect(range[0].address.toLowerCase()).toBe(GOLDEN[1])
    expect(range[1].address.toLowerCase()).toBe(GOLDEN[2])
  })
})
