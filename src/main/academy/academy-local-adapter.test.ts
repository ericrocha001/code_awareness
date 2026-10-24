import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcademyService } from './academy-service'
import { AcademyLocalAdapter } from './local-adapter'
import { registerApplicationShutdown } from '../application-shutdown'
import { executeAcademyTool } from './academy-mcp'
import type { AcademyMutationReceipt, AcademySkillDeliveryStatus } from '../../shared/types/academy-types'

const context = { connected: () => true }
const pkg = (name: string, content = 'literal ç 漢字 ` ${x} $(cmd)\r\n') => ({ skillMd: `---\nname: ${name}\ndescription: Local test\n---\n${content}`, artifacts: { 'references/usage.md': content } })

describe('Academy local adapter over canonical service', () => {
  const paths: string[] = [], services: AcademyService[] = []
  const directory = () => { const path = mkdtempSync(join(tmpdir(), 'academy-local-')); paths.push(path); return path }
  const setup = () => { const service = new AcademyService(join(directory(), 'academy.db')); services.push(service); return { service, operations: new AcademyLocalAdapter(service).operations } }
  afterEach(async () => {
    for (const service of services.splice(0)) await service.close()
    for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('delegates all history modes and selector protection identically to MCP without writing', async () => {
    const { service, operations } = setup()
    const skill = service.store.create({ package: pkg('historical'), scope: 'GLOBAL', origin: 'IMPORT' })
    service.store.update({ skillId: skill.id, expectedVersion: 1, package: pkg('historical', 'new'), origin: 'UI' })
    const before = service.snapshot(), history = service.history(skill.id)
    for (const options of [{}, { metadataOnly: true }, { metadataOnly: false }, { version: 1 }]) {
      const args = { skillId: skill.id, ...options }
      const remote = await executeAcademyTool(service, 'get_academy_skill_history', args)
      expect(remote.isError).toBeUndefined()
      expect(operations.history.execute(args, context)).toEqual(JSON.parse(remote.content[0].text))
    }
    for (const options of [{ version: 0 }, { version: 1.2 }, { version: '1' }, { version: Number.MAX_SAFE_INTEGER + 1 }, { version: 1, metadataOnly: false }, { version: 1, metadataOnly: true }, { metadataOnly: 'true' }, { hidden: true }]) {
      const args = { skillId: skill.id, ...options }
      expect(() => operations.history.execute(args, context)).toThrow('INVALID_ARGUMENT')
      expect(JSON.parse((await executeAcademyTool(service, 'get_academy_skill_history', args)).content[0].text).error).toBe('INVALID_ARGUMENT')
    }
    expect(() => operations.history.execute({ skillId: skill.id, version: 3 }, context)).toThrow('VERSION_NOT_FOUND')
    expect(() => operations.history.execute({ skillId: 'absent', version: 1 }, context)).toThrow('SKILL_NOT_FOUND')
    expect(service.snapshot()).toEqual(before); expect(service.history(skill.id)).toEqual(history)
  })

  it('persists GLOBAL/PROJECT packages with LOCAL_CLI origin, managed distribution and version preconditions', async () => {
    const { service, operations } = setup()
    const root = directory(), second = directory()
    const destination = await service.registerDestination(root, 'first')
    const other = await service.registerDestination(second, 'second'); service.watcher.stop()
    const raw = pkg('local-test')
    const created = await operations.create.execute({ package: raw, scope: 'PROJECT', projectIds: [destination.id] }, context) as AcademyMutationReceipt
    expect(created).toMatchObject({ state: 'PERSISTED', version: 1, distribution: { status: 'PENDING' } })
    expect('package' in created).toBe(false)
    expect(service.get(created.skillId).current).toMatchObject({ origin: 'LOCAL_CLI', package: raw })
    expect(service.store.isAssigned(created.skillId, other.id)).toBe(false)
    await service.waitForReconciliation()
    const initialDelivery = await operations.delivery_status.execute({ skillId: created.skillId }, context) as AcademySkillDeliveryStatus
    expect(initialDelivery.status).toBe('CONVERGED')
    expect(readFileSync(join(root, '.skills/local-test/SKILL.md'), 'utf8')).toBe(raw.skillMd)
    const changed = pkg('local-test', 'new content\r\n')
    const updated = await operations.update.execute({ skillId: created.skillId, expectedVersion: 1, package: changed }, context) as AcademyMutationReceipt
    expect(updated).toMatchObject({ version: 2, projectIds: [destination.id], distribution: { status: 'PENDING' } })
    expect(service.history(created.skillId).find(value => value.version === 1)?.package).toEqual(raw)
    await service.waitForReconciliation()
    await expect(operations.update.execute({ skillId: created.skillId, expectedVersion: 1, package: raw }, context)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    await expect(operations.create.execute({ package: changed, scope: 'GLOBAL' }, context)).rejects.toMatchObject({ code: 'DUPLICATE_SKILL_NAME' })
    const moved = await operations.update.execute({ skillId: created.skillId, expectedVersion: 2, package: changed, scope: 'GLOBAL' }, context) as AcademyMutationReceipt
    expect(moved).toMatchObject({ version: 3, scope: 'GLOBAL', projectIds: [], distribution: { status: 'PENDING' } })
    await service.waitForReconciliation()
    expect(service.distribution.states(created.skillId).every(state => state.status === 'CURRENT')).toBe(true)
    const delivery = await operations.delivery_status.execute({ skillId: created.skillId }, context) as AcademySkillDeliveryStatus
    expect(delivery.status).toBe('CONVERGED')
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

  it('reports persistence immediately and marks reconciliation failure as ERROR, converging on retry without new version (B2)', async () => {
    const { service, operations } = setup()
    const notified = vi.fn(); service.onCanonicalChange(notified)
    const root = directory()
    await service.registerDestination(root, 'dest')
    const spy = vi.spyOn(service.projections, 'reconcileDestination').mockRejectedValueOnce(new Error('filesystem disk full'))
    const created = await operations.create.execute({ package: pkg('committed'), scope: 'GLOBAL' }, context) as AcademyMutationReceipt
    expect(created).toMatchObject({ state: 'PERSISTED', version: 1, distribution: { status: 'PENDING' } })
    expect(service.get(created.skillId).current.packageHash).toBe(created.packageHash)
    expect(notified).toHaveBeenCalledOnce()
    await service.waitForReconciliation()

    // Conclusão com falha observável como ERROR (não PENDING eterno)
    const delivery = await operations.delivery_status.execute({ skillId: created.skillId }, context) as AcademySkillDeliveryStatus
    expect(delivery.status).toBe('ERROR')
    expect(delivery.destinations.some(d => d.status === 'ERROR' && d.errorMessage?.includes('filesystem disk full'))).toBe(true)

    // Retry sem alterar versão converge para CONVERGED
    spy.mockRestore()
    await service.reconcileAll()
    const retried = await operations.delivery_status.execute({ skillId: created.skillId }, context) as AcademySkillDeliveryStatus
    expect(retried.status).toBe('CONVERGED')
    expect(service.get(created.skillId).currentVersion).toBe(1)

    const noDestService = setup()
    const unassigned = await noDestService.operations.create.execute({ package: pkg('no-dest'), scope: 'GLOBAL' }, context) as AcademyMutationReceipt
    expect(unassigned).toMatchObject({ state: 'PERSISTED', version: 1, distribution: { status: 'NOT_APPLICABLE' } })
  })

  it('safe shutdown handles operations exceeding timeout without closed DB access and recovers on restart (B1)', async () => {
    const dir = directory()
    const dbPath = join(dir, 'academy.db')
    const repo = directory()
    // Timeout curto de encerramento para forçar o fechamento do Store enquanto o reconciliador ainda está bloqueado
    const service = new AcademyService(dbPath, undefined, 50)
    services.push(service)
    await service.registerDestination(repo, 'repo')

    const unhandledErrors: any[] = []
    const unhandledHandler = (reason: any) => { unhandledErrors.push(reason) }
    process.on('unhandledRejection', unhandledHandler)

    let unblockAdapter!: () => void
    const slowReconcilePromise = new Promise<void>(resolve => { unblockAdapter = resolve })
    const origReconcile = service.projections.reconcileDestination.bind(service.projections)
    vi.spyOn(service.projections, 'reconcileDestination').mockImplementation(async (destId) => {
      await slowReconcilePromise
      return origReconcile(destId)
    })

    const created = await service.create({ package: pkg('in-flight-timeout-test'), scope: 'GLOBAL', origin: 'UI' })
    expect(created.currentVersion).toBe(1)

    // Acionar close() que aguarda 50ms e fecha o SQLite mesmo com o reconciliador ainda bloqueado
    await service.close()
    expect(service.store.isClosed).toBe(true)

    // Liberar o reconciliador SOMENTE DEPOIS que o store já foi fechado
    unblockAdapter()
    // Pequeno intervalo para dar chance de qualquer continuação rodar
    await new Promise(res => setTimeout(res, 50))

    process.off('unhandledRejection', unhandledHandler)
    expect(unhandledErrors).toEqual([])

    // Reabertura e recuperação comprovada
    const reopened = new AcademyService(dbPath)
    services.push(reopened)
    expect(reopened.get(created.id).currentVersion).toBe(1)
    reopened.start() // Dispara recoverPendingReconciliations automaticamente
    await reopened.waitForReconciliation()
    const delivery = reopened.getDeliveryStatus(created.id)
    expect(delivery.status).toBe('CONVERGED')
  })

  it('integrates with registerApplicationShutdown ensuring awaited disposal before app.quit (B1)', async () => {
    const dir = directory()
    const dbPath = join(dir, 'academy.db')
    const service = new AcademyService(dbPath)
    services.push(service)

    let beforeQuitHandler: ((event: { preventDefault: () => void }) => void) | undefined
    const mockApp = {
      on: vi.fn((event: string, handler: any) => {
        if (event === 'before-quit') beforeQuitHandler = handler
      }),
      quit: vi.fn()
    }

    let shutdownOrder: string[] = []
    registerApplicationShutdown(mockApp as any, async () => {
      shutdownOrder.push('closing_academy')
      await service.close()
      shutdownOrder.push('academy_closed')
    })

    expect(beforeQuitHandler).toBeDefined()
    const fakeEvent = { preventDefault: vi.fn() }
    beforeQuitHandler!(fakeEvent)

    expect(fakeEvent.preventDefault).toHaveBeenCalled()
    expect(mockApp.quit).not.toHaveBeenCalled()

    await vi.waitFor(() => expect(mockApp.quit).toHaveBeenCalled())
    expect(shutdownOrder).toEqual(['closing_academy', 'academy_closed'])
    expect(service.store.isClosed).toBe(true)
  })

  it('tracks archive and restore delivery lifecycle deterministically without premature convergence (B3)', async () => {
    const { service, operations } = setup()
    const root = directory()
    await service.registerDestination(root, 'dest')
    const skill = await service.create({ package: pkg('lifecycle'), scope: 'GLOBAL', origin: 'UI' })
    await service.waitForReconciliation()

    const activeDelivery = await operations.delivery_status.execute({ skillId: skill.id }, context) as AcademySkillDeliveryStatus
    expect(activeDelivery.status).toBe('CONVERGED')
    expect(existsSync(join(root, '.skills/lifecycle/SKILL.md'))).toBe(true)

    // Arquivar: pausar para verificar que imediatamente fica PENDING
    let releaseArchive!: () => void
    const archiveGate = new Promise<void>(res => { releaseArchive = res })
    const origReconcile = service.distribution.reconcileDestination.bind(service.distribution)
    vi.spyOn(service.distribution, 'reconcileDestination').mockImplementation(async (destId) => {
      await archiveGate
      return origReconcile(destId)
    })

    await service.archive(skill.id, 1)
    // Antes da limpeza concluir: PENDING (nunca CONVERGED prematuro)
    const pendingArchiveDelivery = await operations.delivery_status.execute({ skillId: skill.id }, context) as AcademySkillDeliveryStatus
    expect(pendingArchiveDelivery.status).toBe('PENDING')

    // Liberar reconciliação e aguardar limpeza
    releaseArchive()
    await service.waitForReconciliation()

    // Limpeza concluída: ausência confirmada como CONVERGED
    const archivedDelivery = await operations.delivery_status.execute({ skillId: skill.id }, context) as AcademySkillDeliveryStatus
    expect(archivedDelivery.status).toBe('CONVERGED')
    expect(existsSync(join(root, '.skills/lifecycle'))).toBe(false)

    // Restaurar: imediatamente PENDING e depois CONVERGED
    vi.restoreAllMocks()
    let releaseRestore!: () => void
    const restoreGate = new Promise<void>(res => { releaseRestore = res })
    vi.spyOn(service.distribution, 'reconcileDestination').mockImplementation(async (destId) => {
      await restoreGate
      return origReconcile(destId)
    })

    await service.restore(skill.id, 1)
    const pendingRestoreDelivery = await operations.delivery_status.execute({ skillId: skill.id }, context) as AcademySkillDeliveryStatus
    expect(pendingRestoreDelivery.status).toBe('PENDING')

    releaseRestore()
    await service.waitForReconciliation()

    const restoredDelivery = await operations.delivery_status.execute({ skillId: skill.id }, context) as AcademySkillDeliveryStatus
    expect(restoredDelivery.status).toBe('CONVERGED')
    expect(existsSync(join(root, '.skills/lifecycle/SKILL.md'))).toBe(true)
  })

  it('rejects nonexistent or invalid versions and accurately reports superseded versions (B4)', async () => {
    const { service, operations } = setup()
    const root = directory()
    await service.registerDestination(root, 'dest')
    const skill = await service.create({ package: pkg('versioned'), scope: 'GLOBAL', origin: 'UI' })
    await service.waitForReconciliation()

    // Versão futura inexistente deve ser rejeitada com VERSION_NOT_FOUND
    await expect(Promise.resolve().then(() => operations.delivery_status.execute({ skillId: skill.id, expectedVersion: 999 }, context))).rejects.toThrow('VERSION_NOT_FOUND')
    // Versão negativa ou zero deve ser rejeitada
    await expect(Promise.resolve().then(() => operations.delivery_status.execute({ skillId: skill.id, expectedVersion: 0 }, context))).rejects.toThrow('INVALID_ARGUMENT')
    await expect(Promise.resolve().then(() => operations.delivery_status.execute({ skillId: skill.id, expectedVersion: -1 }, context))).rejects.toThrow('INVALID_ARGUMENT')
    expect(() => service.getDeliveryStatus(skill.id, 0)).toThrow('VERSION_NOT_FOUND')

    // Atualizar para versão 2
    await service.update({ skillId: skill.id, expectedVersion: 1, package: pkg('versioned', 'v2'), origin: 'UI' })
    await service.waitForReconciliation()

    // Consulta de versão superseded histórica existente
    const supersededDelivery = await operations.delivery_status.execute({ skillId: skill.id, expectedVersion: 1 }, context) as AcademySkillDeliveryStatus
    expect(supersededDelivery.status).toBe('DEGRADED')
    expect(supersededDelivery.version).toBe(1)

    // Consulta da versão corrente
    const currentDelivery = await operations.delivery_status.execute({ skillId: skill.id, expectedVersion: 2 }, context) as AcademySkillDeliveryStatus
    expect(currentDelivery.status).toBe('CONVERGED')
    expect(currentDelivery.version).toBe(2)
  })
})
