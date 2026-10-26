import { describe, expect, it } from 'vitest'
import { prepareTogether } from './preparation'

describe('supervised preparation barrier', () => {
  it('overlaps independent preparation and exposes neither result before both complete', async () => {
    let release!: () => void, started = false, completed = false
    const result = prepareTogether(async () => { await new Promise<void>(resolve => { release = resolve }); return 'private-context' }, async () => { started = true; return 'safe-build' }).then(value => { completed = true; return value })
    await Promise.resolve()
    expect(started).toBe(true); expect(completed).toBe(false)
    release(); expect(await result).toEqual(['private-context', 'safe-build'])
  })
  it.each([0, 1])('aborts siblings and joins late work before propagating failure in path %s', async failed => {
    let release!: () => void, aborted = false, lateWrite = false, rejected = false
    const workers = [async () => { throw new Error('PREPARATION_FAILED') }, async (signal: AbortSignal) => {
      signal.addEventListener('abort', () => { aborted = true }, { once: true })
      await new Promise<void>(resolve => { release = resolve }); lateWrite = true
    }]
    if (failed) workers.reverse()
    const result = prepareTogether(workers[0], workers[1]).catch(error => { rejected = true; return error })
    await Promise.resolve(); await Promise.resolve()
    expect(aborted).toBe(true); expect(rejected).toBe(false)
    release(); expect(await result).toEqual(new Error('PREPARATION_FAILED'))
    expect(lateWrite).toBe(true); expect(rejected).toBe(true)
  })
})
