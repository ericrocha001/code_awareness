import { describe, expect, it, vi } from 'vitest'
import { PreviewStackAdapter } from './adapters'

const state = vi.hoisted(() => ({ controlId: '', reads: 0, mode: 'partial', abort: new AbortController() }))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(),
  writeFile: vi.fn(async (_path: unknown, raw: string) => { state.controlId = JSON.parse(raw).controlId }),
  readFile: vi.fn(async () => {
    state.reads++
    if (state.mode === 'schema') return Buffer.from('{}')
    if (state.reads === 1) return Buffer.from('{')
    if (state.mode === 'nonce') state.abort.abort(new Error('TEST_CANCELLED'))
    return Buffer.from(JSON.stringify({ sessionId: 'e1c8a999-6d73-4f56-83a3-fbcd78c9c19d', pid: 123, runtime: '32', abi: '128',
      builds: [], rendererPid: 124, rendererFailure: null, sandboxObserved: true, rendererModules: [],
      window: { visible: true, rendererInitialized: true, createdNs: '1', loadedNs: '2', presentedNs: '3', focused: true,
        quiescent: false, controlId: state.mode === 'nonce' ? 'wrong' : state.controlId, showNs: '3', functionalNs: '4', focusedNs: '4' },
      resourcesIsolated: true, channelDisabled: true, protocolDisabled: true, processes: [] }))
  })
}))
function fixture(mode: string) {
  state.mode = mode; state.reads = 0; state.abort = new AbortController()
  return Object.assign(Object.create(PreviewStackAdapter.prototype), { directory: 'controlled', sessionId: 'selected', token: 'private' }) as PreviewStackAdapter
}
describe('prepared window control evidence', () => {
  it('retries a partial JSON write and requires the current command acknowledgement', async () => {
    await expect(fixture('partial').control('SHOW')).resolves.toMatchObject({ functionalNs: '4', focusedNs: '4' })
    expect(state.reads).toBe(2)
  })
  it('rejects a valid JSON object with an invalid schema', async () => {
    await expect(fixture('schema').control('SHOW')).rejects.toThrow()
    expect(state.reads).toBe(1)
  })
  it('does not accept a different control nonce and remains cancellable', async () => {
    const adapter = fixture('nonce')
    await expect(adapter.control('SHOW', state.abort.signal)).rejects.toThrow('TEST_CANCELLED')
  })
})
