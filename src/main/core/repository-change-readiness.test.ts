import { describe, expect, it } from 'vitest'
import { RepositoryChangeReadiness } from './repository-change-readiness'

describe('repository causal readiness', () => {
  it('rejects unfinished barriers on repository close and preserves completed phases', async () => {
    const readiness = new RepositoryChangeReadiness()
    const id = readiness.accept()
    const relationships = readiness.barrier('RELATIONSHIPS')
    const symbols = readiness.barrier('SYMBOL_REFERENCES')
    void relationships.catch(() => {})
    void symbols.catch(() => {})
    readiness.advance(id, 'STRUCTURE')
    const structure = readiness.barrier('STRUCTURE')
    readiness.cancel(new Error('repository closed'))
    await expect(structure).resolves.toBeUndefined()
    await expect(relationships).rejects.toThrow('repository closed')
    await expect(symbols).rejects.toThrow('repository closed')
  })
  it('captures prior changes and releases each persisted phase independently', async () => {
    const readiness = new RepositoryChangeReadiness()
    const first = readiness.accept()
    let structure = false
    const structuralBarrier = readiness.barrier('STRUCTURE').then(() => { structure = true })
    const relationshipBarrier = readiness.barrier('RELATIONSHIPS')
    let symbols = false
    const symbolBarrier = readiness.barrier('SYMBOL_REFERENCES').then(() => { symbols = true })
    readiness.accept()
    expect(structure).toBe(false)
    readiness.advance(first, 'STRUCTURE')
    await structuralBarrier
    expect(symbols).toBe(false)
    readiness.advance(first, 'RELATIONSHIPS')
    await relationshipBarrier
    expect(symbols).toBe(false)
    readiness.advance(first, 'SYMBOL_REFERENCES')
    await symbolBarrier
  })

  it('preserves completed phases when enrichment fails', async () => {
    const readiness = new RepositoryChangeReadiness()
    const id = readiness.accept()
    readiness.advance(id, 'RELATIONSHIPS')
    readiness.fail(id, new Error('symbol persistence failed'))
    await expect(readiness.barrier('STRUCTURE')).resolves.toBeUndefined()
    await expect(readiness.barrier('RELATIONSHIPS')).resolves.toBeUndefined()
    await expect(readiness.barrier('SYMBOL_REFERENCES')).rejects.toThrow('symbol persistence failed')
  })

  it('keeps a failed captured barrier rejected after a successful retry, while future callers can recover', async () => {
    const readiness = new RepositoryChangeReadiness()
    const id = readiness.accept(0, 'a.ts')
    const captured = readiness.barrier('SYMBOL_REFERENCES')
    void captured.catch(() => {})
    readiness.advance(id, 'RELATIONSHIPS')
    readiness.fail(id, new Error('first change failed'))
    const retry = readiness.accept(0, 'a.ts')
    readiness.advance(retry, 'SYMBOL_REFERENCES')
    readiness.recover('a.ts')
    await expect(captured).rejects.toThrow('first change failed')
    await expect(readiness.barrier('SYMBOL_REFERENCES')).resolves.toBeUndefined()
  })
})
