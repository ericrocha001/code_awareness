import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpWorkloadGovernor } from './mcp-workload-governor'

const ok = { content: [{ type: 'text' as const, text: '{}' }] }
const payload = (result: typeof ok) => JSON.parse(result.content[0].text)
function deferred() {
  let resolve!: (value: typeof ok) => void
  let reject!: (error: Error) => void
  const promise = new Promise<typeof ok>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
afterEach(() => vi.useRealTimers())

describe('MCP workload admission', () => {
  it.each([2, 3, 32])('admits %i overlapping same-tool and different-tool navigations', async count => {
    const governor = new McpWorkloadGovernor()
    const work = Array.from({ length: count }, deferred)
    const execute = work.map(item => vi.fn(() => item.promise))
    const calls = work.map((_, i) => governor.run(i === count - 1 ? 'inspect_files' : 'read_code', {}, String(i), undefined, execute[i]))
    await Promise.resolve()
    execute.forEach(callback => expect(callback).toHaveBeenCalledOnce())
    expect(await governor.run('get_system_health', {}, undefined, undefined, async () => ok)).toEqual(ok)
    work.forEach(item => item.resolve(ok))
    expect(await Promise.all(calls)).toEqual(work.map(() => ok))
    expect(governor.snapshot().events.some(event => event.event === 'ADMISSION_REFUSED')).toBe(false)
    expect(governor.snapshot().lanes.some(lane => lane.lane === 'NAVIGATION')).toBe(false)
  })

  it.each(['resolve', 'reject'] as const)('isolates deadlines and late %s after a timeout', async completion => {
    vi.useFakeTimers()
    const governor = new McpWorkloadGovernor(1000, 50)
    const a = deferred(), b = deferred(), c = deferred()
    const first = governor.run('read_code', {}, 'a', Date.now() + 1050, () => a.promise)
    const second = governor.run('read_code', {}, 'b', Date.now() + 1500, () => b.promise)
    await vi.advanceTimersByTimeAsync(50)
    expect(payload(await first).code).toBe('REQUEST_TIMEOUT')
    let secondFinished = false
    void second.then(() => { secondFinished = true })
    const third = governor.run('inspect_files', {}, 'c', Date.now() + 1300, () => c.promise)
    if (completion === 'resolve') a.resolve(ok)
    else a.reject(new Error('late failure'))
    await vi.advanceTimersByTimeAsync(100)
    expect(secondFinished).toBe(false)
    expect(governor.snapshot().events.some(event => ['DEGRADED', 'HALF_OPEN', 'ADMISSION_REFUSED'].includes(event.event))).toBe(false)
    c.resolve(ok)
    expect(await third).toEqual(ok)
    await vi.advanceTimersByTimeAsync(349)
    expect(secondFinished).toBe(false)
    b.resolve(ok)
    expect(await second).toEqual(ok)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not degrade navigation after a returned timeout or thrown failure', async () => {
    const governor = new McpWorkloadGovernor()
    await governor.run('read_code', {}, 'a', undefined, async () => ({ content: [{ type: 'text', text: 'REQUEST_TIMEOUT' }], isError: true }))
    await expect(governor.run('read_code', {}, 'b', undefined, async () => { throw new Error('TIMEOUT') })).rejects.toThrow('TIMEOUT')
    expect(await governor.run('read_code', {}, 'c', undefined, async () => ok)).toEqual(ok)
  })

  it.each(['commit_git_changes', 'start_validation'])('preserves single-flight and no timer for %s', async name => {
    vi.useFakeTimers()
    const governor = new McpWorkloadGovernor(100, 50)
    const work = deferred()
    const active = governor.run(name, { operationId: 'one' }, undefined, undefined, () => work.promise)
    await vi.advanceTimersByTimeAsync(1000)
    const execute = vi.fn(async () => ok)
    expect(payload(await governor.run(name, { operationId: 'two' }, undefined, undefined, execute))).toMatchObject({ code: 'BUSY', activeOperationId: 'one' })
    expect(execute).not.toHaveBeenCalled()
    expect(await governor.run('read_code', {}, 'navigation', undefined, execute)).toEqual(ok)
    work.resolve(ok)
    expect(await active).toEqual(ok)
    expect(await governor.run(name, { operationId: 'three' }, undefined, undefined, execute)).toEqual(ok)
  })
})
