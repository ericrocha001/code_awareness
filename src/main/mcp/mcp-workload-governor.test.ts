import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpWorkloadGovernor } from './mcp-workload-governor'

const ok = { content: [{ type: 'text' as const, text: '{}' }] }
const payload = (result: typeof ok) => JSON.parse(result.content[0].text)
afterEach(() => vi.useRealTimers())

describe('MCP workload admission', () => {
  it('refuses overlapping navigation while keeping diagnostics independent', async () => {
    const governor = new McpWorkloadGovernor()
    let finish!: (value: typeof ok) => void
    const active = governor.run('read_code', {}, 'one', undefined, () => new Promise((resolve) => { finish = resolve }))
    await Promise.resolve()
    const execute = vi.fn(async () => ok)
    expect(payload(await governor.run('inspect_files', {}, 'two', undefined, execute))).toMatchObject({ code: 'BUSY', activeOperationId: 'one' })
    expect(execute).not.toHaveBeenCalled()
    for (const name of ['get_git_state', 'get_runtime_identity', 'get_system_health', 'get_validation_run', 'get_validation_proofs', 'manage_git_shelf']) {
      expect(await governor.run(name, { action: 'LIST' }, undefined, undefined, execute)).toEqual(ok)
    }
    finish(ok); await active
    expect(governor.snapshot().events.map((event) => event.event)).toContain('ADMISSION_REFUSED')
  })

  it('keeps timed out work occupied, then permits exactly one recovery attempt', async () => {
    vi.useFakeTimers()
    const governor = new McpWorkloadGovernor(100, 50)
    let finish!: (value: typeof ok) => void
    const active = governor.run('read_code', {}, 'one', undefined, () => new Promise((resolve) => { finish = resolve }))
    await vi.advanceTimersByTimeAsync(100)
    expect(payload(await active).code).toBe('REQUEST_TIMEOUT')
    const execute = vi.fn(async () => ok)
    expect(payload(await governor.run('read_code', {}, 'two', undefined, execute)).code).toBe('CHANNEL_DEGRADED')
    await vi.advanceTimersByTimeAsync(50)
    expect(payload(await governor.run('read_code', {}, 'three', undefined, execute)).code).toBe('CHANNEL_DEGRADED')
    expect(execute).not.toHaveBeenCalled()
    expect(await governor.run('get_git_state', {}, undefined, undefined, execute)).toEqual(ok)
    finish(ok); await vi.advanceTimersByTimeAsync(0)
    expect(await governor.run('read_code', {}, 'recovery', undefined, execute)).toEqual(ok)
    expect(governor.snapshot().lanes[0].state).toBe('HEALTHY')
    expect(governor.snapshot().events.map((event) => event.event)).toEqual(expect.arrayContaining(['DEGRADED', 'HALF_OPEN', 'RECOVERED']))
  })

  it('never times out or reexecutes an admitted mutation', async () => {
    vi.useFakeTimers()
    const governor = new McpWorkloadGovernor(100, 50)
    let finish!: (value: typeof ok) => void
    const active = governor.run('commit_git_changes', { operationId: 'git-one' }, undefined, undefined, () => new Promise((resolve) => { finish = resolve }))
    await vi.advanceTimersByTimeAsync(1000)
    const rejected = await governor.run('commit_git_changes', { operationId: 'git-two' }, undefined, undefined, async () => { throw new Error('must not execute') })
    expect(payload(rejected)).toMatchObject({ code: 'BUSY', retryability: 'SAME_OPERATION_ID', activeOperationId: 'git-one' })
    finish(ok); expect(await active).toEqual(ok)
    await governor.run('read_code', {}, 'failed', undefined, async () => ({ ...ok, isError: true }))
    expect(governor.snapshot().events.map((event) => event.event)).toContain('EXECUTION_FAILED')
  })
})
