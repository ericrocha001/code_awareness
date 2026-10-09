import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcademyService } from './academy-service'
import { AcademyLocalAdapter } from './local-adapter'
import type { AcademyMutationReceipt } from '../../shared/types/academy-types'

const context = { connected: () => true }
const pkg = (name: string, content = 'literal ç 漢字 ` ${x} $(cmd)\r\n') => ({ skillMd: `---\nname: ${name}\ndescription: Local test\n---\n${content}`, artifacts: { 'references/usage.md': content } })
describe('Academy local adapter over canonical service', () => {
  const paths: string[] = [], services: AcademyService[] = []
  const directory = () => { const path = mkdtempSync(join(tmpdir(), 'academy-local-')); paths.push(path); return path }
  const setup = () => { const service = new AcademyService(join(directory(), 'academy.db')); services.push(service); return { service, operations: new AcademyLocalAdapter(service).operations } }
  afterEach(() => { for (const service of services.splice(0)) service.close(); for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); vi.restoreAllMocks() })
  it('persists GLOBAL/PROJECT packages with LOCAL_CLI origin, managed distribution and version preconditions', async () => {
    const { service, operations } = setup()
    const root = directory(), second = directory()
    const destination = await service.registerDestination(root, 'first')
    const other = await service.registerDestination(second, 'second'); service.watcher.stop()
    const raw = pkg('local-test')
    const created = await operations.create.execute({ package: raw, scope: 'PROJECT', projectIds: [destination.id] }, context) as AcademyMutationReceipt
    expect(created).toMatchObject({ state: 'PERSISTED', version: 1, distribution: { status: 'CONVERGED' } })
    expect('package' in created).toBe(false)
    expect(service.get(created.skillId).current).toMatchObject({ origin: 'LOCAL_CLI', package: raw })
    expect(service.store.isAssigned(created.skillId, other.id)).toBe(false)
    expect(readFileSync(join(root, '.skills/local-test/SKILL.md'), 'utf8')).toBe(raw.skillMd)
    const changed = pkg('local-test', 'new content\r\n')
    const updated = await operations.update.execute({ skillId: created.skillId, expectedVersion: 1, package: changed }, context) as AcademyMutationReceipt
    expect(updated).toMatchObject({ version: 2, projectIds: [destination.id], distribution: { status: 'CONVERGED' } })
    expect(service.history(created.skillId).find(value => value.version === 1)?.package).toEqual(raw)
    await expect(operations.update.execute({ skillId: created.skillId, expectedVersion: 1, package: raw }, context)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    await expect(operations.create.execute({ package: changed, scope: 'GLOBAL' }, context)).rejects.toMatchObject({ code: 'DUPLICATE_SKILL_NAME' })
    const moved = await operations.update.execute({ skillId: created.skillId, expectedVersion: 2, package: changed, scope: 'GLOBAL' }, context) as AcademyMutationReceipt
    expect(moved).toMatchObject({ version: 3, scope: 'GLOBAL', projectIds: [], distribution: { status: 'CONVERGED' } })
    expect(service.distribution.states(created.skillId).every(state => state.status === 'CURRENT')).toBe(true)
    expect(operations.list.execute({}, context)).toEqual(service.list())
  }, 60000)
  it('rejects invalid scope/associations, hidden fields and packages before changing the Store', async () => {
    const { service, operations } = setup()
    for (const args of [{ package: pkg('invalid'), scope: 'PROJECT' }, { package: pkg('invalid'), scope: 'PROJECT', projectIds: [] }, { package: pkg('invalid'), scope: 'GLOBAL', origin: 'MCP' }, { package: pkg('invalid'), scope: 'PROJECT', projectIds: ['absent'] }]) {
      await expect(Promise.resolve().then(() => operations.create.execute(args, context))).rejects.toThrow()
    }
    await expect(Promise.resolve().then(() => operations.update.execute({ skillId: 'id', expectedVersion: 1, package: pkg('invalid'), projectIds: [] }, context))).rejects.toThrow('INVALID_ARGUMENT')
    await expect(operations.create.execute({ package: { ...pkg('invalid'), artifacts: { '../outside': 'bad' } }, scope: 'GLOBAL' }, context)).rejects.toMatchObject({ code: 'INVALID_ARTIFACT_PATH' })
    await expect(Promise.resolve().then(() => operations.create.execute({ package: pkg('disconnected'), scope: 'GLOBAL' }, { connected: () => false }))).rejects.toThrow('IPC_CLOSED')
    expect(service.list()).toEqual([])
  })
  it('reports persistence separately when reconciliation fails after commit, without lying about rollback', async () => {
    const { service, operations } = setup()
    const notified = vi.fn(); service.onCanonicalChange(notified)
    vi.spyOn(service, 'reconcileAll').mockRejectedValueOnce(new Error('transport failed'))
    const created = await operations.create.execute({ package: pkg('committed'), scope: 'GLOBAL' }, context) as AcademyMutationReceipt
    expect(created).toMatchObject({ state: 'PERSISTED', version: 1, distribution: { status: 'ERROR', errorCode: 'RECONCILIATION_FAILED' } })
    expect(service.get(created.skillId).current.packageHash).toBe(created.packageHash)
    expect(notified).toHaveBeenCalledOnce()
    const updated = await operations.update.execute({ skillId: created.skillId, expectedVersion: 1, package: pkg('committed', 'fixed') }, context) as AcademyMutationReceipt
    expect(updated).toMatchObject({ version: 2, distribution: { status: 'NOT_APPLICABLE' } })
    expect(service.history(created.skillId).every(version => version.origin === 'LOCAL_CLI')).toBe(true)
  })
})
