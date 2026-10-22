import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from '@/utils/concurrency'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('bounded concurrency', () => {
  it('stops dispatching after failure and drains in-flight work before rejecting', async () => {
    const gate = deferred<number>()
    const failure = new Error('first worker failed')
    const called: number[] = []
    let settled = false
    const work = mapWithConcurrency([0, 1, 2, 3], 2, async (id) => {
      called.push(id)
      if (id === 0) throw failure
      return gate.promise
    })
    const assertion = expect(work).rejects.toBe(failure)
    void work.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    // Cross a real macrotask boundary so an early Promise.all rejection settles.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(called).toEqual([0, 1])
    expect(settled).toBe(false)
    gate.resolve(1)
    await assertion
    expect(called).toEqual([0, 1])
  })
  it('caps active work and preserves input order', async () => {
    const gates = Array.from({ length: 5 }, () => deferred<number>())
    let active = 0
    let peak = 0
    const work = mapWithConcurrency(gates, 2, async (gate) => {
      active += 1
      peak = Math.max(peak, active)
      const result = await gate.promise
      active -= 1
      return result
    })

    await Promise.resolve()
    expect(peak).toBe(2)
    gates[1].resolve(20)
    await Promise.resolve()
    gates[2].resolve(30)
    await Promise.resolve()
    gates[0].resolve(10)
    gates[3].resolve(40)
    await Promise.resolve()
    gates[4].resolve(50)

    await expect(work).resolves.toEqual([10, 20, 30, 40, 50])
    expect(peak).toBe(2)
  })
})
