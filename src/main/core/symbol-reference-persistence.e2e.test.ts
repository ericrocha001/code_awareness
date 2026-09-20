import { afterEach, describe, expect, it } from 'vitest'
import { unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { closeRepositoryDatabase, createRepositoryDatabase } from './repository-database'
import { createRepositoryModel, type RepositoryModel } from './repository-model'
import { cleanupTempRepo, createTempRepo } from './test-helpers'

describe('Symbol References — persistência e atualização incremental', () => {
  let repoPath = ''
  let model: RepositoryModel | null = null

  afterEach(async () => {
    if (!repoPath) return
    closeRepositoryDatabase(repoPath)
    await cleanupTempRepo(repoPath)
  })

  async function indexFixture(): Promise<{ targetId: string; sourceFileId: string; sourceElementId: string }> {
    repoPath = createTempRepo()
    writeFileSync(join(repoPath, 'target.ts'), 'export function execute() { return 1 }\n', 'utf-8')
    writeFileSync(
      join(repoPath, 'source.ts'),
      'import { execute } from "./target"\nexport function run() { return execute() }\n',
      'utf-8'
    )
    model = createRepositoryModel(repoPath)
    await model.indexRepository()
    const targetId = model.getElementsByRepository().find((element) => element.name === 'execute' && element.kind === 'function')!.id
    const sourceFileId = model.getFiles().find((file) => file.relativePath === 'source.ts')!.id
    const sourceElementId = model.getElementsByRepository().find((element) => element.name === 'run' && element.kind === 'function')!.id
    return { targetId, sourceFileId, sourceElementId }
  }

  it('persiste somente resoluções confirmadas e consulta por alvo, elemento-fonte ou arquivo-fonte em ordem estável', async () => {
    const { targetId, sourceFileId, sourceElementId } = await indexFixture()

    const bySource = model!.getSymbolReferencesBySourceFile(sourceFileId)
    const bySourceElement = model!.getSymbolReferencesBySourceElement(sourceElementId)
    const byTarget = model!.getSymbolReferencesByTargetElement(targetId)

    expect(bySource).toHaveLength(1)
    expect(bySourceElement).toEqual(bySource)
    expect(byTarget).toEqual(bySource)
    expect(bySource[0]).toMatchObject({
      repositoryId: model!.getRepositoryId(),
      sourceFileId,
      targetElementId: targetId,
      kind: 'call'
    })
    expect(bySource[0].id).toMatch(/^[0-9a-f]{16}$/)

    createRepositoryDatabase(repoPath).saveFile(model!.getFiles().find((file) => file.id === sourceFileId)!)
    expect(model!.getSymbolReferencesBySourceFile(sourceFileId)).toEqual(bySource)
    expect(model!.getSymbolReferencesBySourceElement(sourceElementId)).toEqual(bySource)

    await model!.indexRepository()
    expect(model!.getSymbolReferencesBySourceFile(sourceFileId).map((reference) => reference.id)).toEqual([bySource[0].id])
    expect(model!.getSymbolReferencesBySourceElement(sourceElementId).map((reference) => reference.id)).toEqual([bySource[0].id])
  })

  it('substitui referências do arquivo-fonte sem acumular linhas antigas', async () => {
    const { targetId, sourceFileId, sourceElementId } = await indexFixture()
    writeFileSync(
      join(repoPath, 'source.ts'),
      'import { execute } from "./target"\nexport function run() { execute(); return execute() }\n',
      'utf-8'
    )

    await model!.updateFileContent('source.ts')
    const twice = model!.getSymbolReferencesBySourceFile(sourceFileId)
    expect(twice).toHaveLength(2)
    expect(twice.map((reference) => reference.location.start.byte)).toEqual(
      [...twice].map((reference) => reference.location.start.byte).sort((left, right) => left - right)
    )
    expect(model!.getSymbolReferencesBySourceElement(sourceElementId)).toEqual(twice)
    expect(twice.every((reference) => reference.targetElementId === targetId)).toBe(true)

    writeFileSync(join(repoPath, 'source.ts'), 'export function run() { return 0 }\n', 'utf-8')
    await model!.updateFileContent('source.ts')
    expect(model!.getSymbolReferencesBySourceFile(sourceFileId)).toEqual([])
    expect(model!.getSymbolReferencesBySourceElement(sourceElementId)).toEqual([])
  })

  it('reavalia somente importadores diretos quando o alvo muda e limpa cascatas na remoção', async () => {
    const { targetId, sourceFileId } = await indexFixture()
    writeFileSync(join(repoPath, 'target.ts'), 'export function renamed() { return 1 }\n', 'utf-8')
    await model!.updateFileContent('target.ts')
    expect(model!.getSymbolReferencesBySourceFile(sourceFileId)).toEqual([])
    expect(model!.getSymbolReferencesByTargetElement(targetId)).toEqual([])

    writeFileSync(join(repoPath, 'target.ts'), 'export function execute() { return 2 }\n', 'utf-8')
    await model!.updateFileContent('target.ts')
    expect(model!.getSymbolReferencesBySourceFile(sourceFileId)).toHaveLength(1)

    unlinkSync(join(repoPath, 'target.ts'))
    await model!.updateFileContent('target.ts')
    expect(model!.getSymbolReferencesBySourceFile(sourceFileId)).toEqual([])
  })

  it('faz backfill idempotente com IDs determinísticos', async () => {
    const { sourceFileId } = await indexFixture()
    const database = createRepositoryDatabase(repoPath)
    database.replaceSymbolReferencesForFile(sourceFileId, [])

    expect(await model!.backfillSymbolReferences()).toBe(1)
    const first = model!.getSymbolReferencesBySourceFile(sourceFileId)
    expect(await model!.backfillSymbolReferences()).toBe(1)
    expect(model!.getSymbolReferencesBySourceFile(sourceFileId)).toEqual(first)
  })

  it('persiste, substitui e faz backfill idempotente de chamadas this.method', async () => {
    repoPath = createTempRepo()
    const servicePath = join(repoPath, 'service.ts')
    const withMethod = [
      'export class Service {',
      '  start() { this.execute(); this.execute() }',
      '  execute() {}',
      '}',
      ''
    ].join('\n')
    writeFileSync(servicePath, withMethod, 'utf-8')
    model = createRepositoryModel(repoPath)
    await model.indexRepository()

    const elements = model.getElementsByRepository()
    const start = elements.find((element) => element.kind === 'method' && element.name === 'start')!
    const execute = elements.find((element) => element.kind === 'method' && element.name === 'execute')!
    const sourceFileId = model.getFiles()[0].id
    const first = model.getSymbolReferencesBySourceElement(start.id)
    expect(first).toHaveLength(2)
    expect(first.every((reference) => reference.targetElementId === execute.id && reference.kind === 'call')).toBe(true)
    expect(model.getSymbolReferencesByTargetElement(execute.id)).toEqual(first)

    const database = createRepositoryDatabase(repoPath)
    database.replaceSymbolReferencesForFile(sourceFileId, [])
    expect(await model.backfillSymbolReferences()).toBe(2)
    const backfilled = model.getSymbolReferencesBySourceElement(start.id)
    expect(await model.backfillSymbolReferences()).toBe(2)
    expect(model.getSymbolReferencesBySourceElement(start.id)).toEqual(backfilled)

    writeFileSync(servicePath, 'export class Service { start() { this.execute() } }\n', 'utf-8')
    await model.updateFileContent('service.ts')
    expect(model.getSymbolReferencesBySourceFile(sourceFileId)).toEqual([])

    writeFileSync(servicePath, withMethod, 'utf-8')
    await model.updateFileContent('service.ts')
    expect(model.getSymbolReferencesBySourceFile(sourceFileId)).toHaveLength(2)
  })

  it('reavalia chamada herdada quando o método da base muda', async () => {
    repoPath = createTempRepo()
    const basePath = join(repoPath, 'base.ts')
    writeFileSync(basePath, 'export class Base { execute() {} }\n', 'utf-8')
    writeFileSync(join(repoPath, 'child.ts'), [
      "import { Base } from './base'",
      'export class Child extends Base { run() { this.execute() } }',
      ''
    ].join('\n'), 'utf-8')
    model = createRepositoryModel(repoPath)
    await model.indexRepository()

    const childFile = model.getFiles().find((file) => file.relativePath === 'child.ts')!
    expect(model.getSymbolReferencesBySourceFile(childFile.id).filter((reference) => reference.kind === 'call')).toHaveLength(1)

    writeFileSync(basePath, 'export class Base {}\n', 'utf-8')
    await model.updateFileContent('base.ts')
    expect(model.getSymbolReferencesBySourceFile(childFile.id).filter((reference) => reference.kind === 'call')).toEqual([])

    writeFileSync(basePath, 'export class Base { execute() {} }\n', 'utf-8')
    await model.updateFileContent('base.ts')
    expect(model.getSymbolReferencesBySourceFile(childFile.id).filter((reference) => reference.kind === 'call')).toHaveLength(1)
  })

  it('move e remove referências de parâmetros tipados durante reindexação incremental', async () => {
    repoPath = createTempRepo()
    const targetPath = join(repoPath, 'target.ts')
    const sourcePath = join(repoPath, 'source.ts')
    const targetSource = [
      'export class Service { execute() {} }',
      'export class OtherService { execute() {} }',
      ''
    ].join('\n')
    writeFileSync(targetPath, targetSource, 'utf-8')
    writeFileSync(sourcePath, [
      "import { Service, OtherService } from './target'",
      'export function run(service: Service) { service.execute() }',
      ''
    ].join('\n'), 'utf-8')
    model = createRepositoryModel(repoPath)
    await model.indexRepository()

    const sourceFile = model.getFiles().find((file) => file.relativePath === 'source.ts')!
    const methods = () => model!.getElementsByRepository().filter((element) => element.kind === 'method' && element.name === 'execute')
    const methodFor = (className: string) => {
      const owner = model!.getElementsByRepository().find((element) => element.kind === 'class' && element.name === className)!
      return methods().find((method) => method.parentElementId === owner.id)!
    }
    const calls = () => model!.getSymbolReferencesBySourceFile(sourceFile.id).filter((reference) => reference.kind === 'call')

    expect(calls()).toHaveLength(1)
    expect(calls()[0].targetElementId).toBe(methodFor('Service').id)

    writeFileSync(sourcePath, [
      "import { Service, OtherService } from './target'",
      'export function run(service: OtherService) { service.execute() }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('source.ts')
    expect(calls()).toHaveLength(1)
    expect(calls()[0].targetElementId).toBe(methodFor('OtherService').id)

    writeFileSync(targetPath, [
      'export class Service { execute() {} }',
      'export class OtherService {}',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('target.ts')
    expect(calls()).toEqual([])

    writeFileSync(targetPath, targetSource, 'utf-8')
    await model.updateFileContent('target.ts')
    writeFileSync(sourcePath, [
      "import { Service, OtherService } from './target'",
      'export function run(svc: OtherService) { svc.execute() }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('source.ts')
    expect(calls()).toHaveLength(1)
    expect(calls()[0].targetElementId).toBe(methodFor('OtherService').id)

    const beforeBackfill = calls()
    await model.backfillSymbolReferences()
    expect(calls()).toEqual(beforeBackfill)

    writeFileSync(sourcePath, [
      "import { OtherService } from './missing'",
      'export function run(svc: OtherService) { svc.execute() }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('source.ts')
    expect(calls()).toEqual([])
  })

  it('atualiza referências const-new quando constructor, member, método, import ou variável mudam', async () => {
    repoPath = createTempRepo()
    const targetPath = join(repoPath, 'target.ts')
    const sourcePath = join(repoPath, 'source.ts')
    const targetSource = [
      'export class A { execute() {} stop() {} }',
      'export class B { execute() {} stop() {} }',
      ''
    ].join('\n')
    writeFileSync(targetPath, targetSource, 'utf-8')
    writeFileSync(sourcePath, [
      "import { A, B } from './target'",
      'export function run() { const service = new A(); service.execute() }',
      ''
    ].join('\n'), 'utf-8')
    model = createRepositoryModel(repoPath)
    await model.indexRepository()

    const sourceFile = model.getFiles().find((file) => file.relativePath === 'source.ts')!
    const targetMethod = (className: string, methodName: string) => {
      const owner = model!.getElementsByRepository().find((element) => element.kind === 'class' && element.name === className)!
      return model!.getElementsByRepository().find((element) =>
        element.kind === 'method' && element.name === methodName && element.parentElementId === owner.id
      )!
    }
    const calls = () => model!.getSymbolReferencesBySourceFile(sourceFile.id).filter((reference) => reference.kind === 'call')

    expect(calls()).toHaveLength(1)
    expect(calls()[0].targetElementId).toBe(targetMethod('A', 'execute').id)

    writeFileSync(sourcePath, [
      "import { A, B } from './target'",
      'export function run() { const service = new B(); service.execute() }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('source.ts')
    expect(calls()[0].targetElementId).toBe(targetMethod('B', 'execute').id)

    writeFileSync(sourcePath, [
      "import { A, B } from './target'",
      'export function run() { const service = new B(); service.stop() }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('source.ts')
    expect(calls()[0].targetElementId).toBe(targetMethod('B', 'stop').id)

    writeFileSync(targetPath, [
      'export class A { execute() {} stop() {} }',
      'export class B { execute() {} }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('target.ts')
    expect(calls()).toEqual([])

    writeFileSync(targetPath, targetSource, 'utf-8')
    await model.updateFileContent('target.ts')
    writeFileSync(sourcePath, [
      "import { B } from './target'",
      'export function run() { const svc = new B(); svc.stop() }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('source.ts')
    expect(calls()).toHaveLength(1)
    expect(calls()[0].targetElementId).toBe(targetMethod('B', 'stop').id)

    const beforeBackfill = calls()
    await model.backfillSymbolReferences()
    expect(calls()).toEqual(beforeBackfill)

    writeFileSync(sourcePath, [
      "import { B } from './missing'",
      'export function run() { const svc = new B(); svc.stop() }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('source.ts')
    expect(calls()).toEqual([])
  })

  it('atualiza referências de properties tipadas quando tipo, nome, member, método ou import mudam', async () => {
    repoPath = createTempRepo()
    const targetPath = join(repoPath, 'target.ts')
    const sourcePath = join(repoPath, 'source.ts')
    const targetSource = [
      'export class A { execute() {} stop() {} }',
      'export class B { execute() {} stop() {} }',
      ''
    ].join('\n')
    writeFileSync(targetPath, targetSource, 'utf-8')
    writeFileSync(sourcePath, [
      "import { A, B } from './target'",
      'export class Controller { service: A; run() { this.service.execute() } }',
      ''
    ].join('\n'), 'utf-8')
    model = createRepositoryModel(repoPath)
    await model.indexRepository()

    const sourceFile = model.getFiles().find((file) => file.relativePath === 'source.ts')!
    const targetMethod = (className: string, methodName: string) => {
      const owner = model!.getElementsByRepository().find((element) => element.kind === 'class' && element.name === className)!
      return model!.getElementsByRepository().find((element) =>
        element.kind === 'method' && element.name === methodName && element.parentElementId === owner.id
      )!
    }
    const calls = () => model!.getSymbolReferencesBySourceFile(sourceFile.id).filter((reference) => reference.kind === 'call')

    expect(calls()).toHaveLength(1)
    expect(calls()[0].targetElementId).toBe(targetMethod('A', 'execute').id)

    writeFileSync(sourcePath, [
      "import { A, B } from './target'",
      'export class Controller { service: B; run() { this.service.execute() } }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('source.ts')
    expect(calls()[0].targetElementId).toBe(targetMethod('B', 'execute').id)

    writeFileSync(sourcePath, [
      "import { B } from './target'",
      'export class Controller { svc: B; run() { this.svc.stop() } }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('source.ts')
    expect(calls()[0].targetElementId).toBe(targetMethod('B', 'stop').id)

    writeFileSync(targetPath, [
      'export class A { execute() {} stop() {} }',
      'export class B { execute() {} }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('target.ts')
    expect(calls()).toEqual([])

    writeFileSync(targetPath, targetSource, 'utf-8')
    await model.updateFileContent('target.ts')
    await model.updateFileContent('source.ts')
    expect(calls()).toHaveLength(1)
    expect(calls()[0].targetElementId).toBe(targetMethod('B', 'stop').id)

    const beforeBackfill = calls()
    await model.backfillSymbolReferences()
    expect(calls()).toEqual(beforeBackfill)

    writeFileSync(sourcePath, [
      "import { B } from './missing'",
      'export class Controller { svc: B; run() { this.svc.stop() } }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('source.ts')
    expect(calls()).toEqual([])
  })

  it('atualiza constructor parameter properties quando tipo, modifier, nome, método ou import mudam', async () => {
    repoPath = createTempRepo()
    const targetPath = join(repoPath, 'target.ts')
    const sourcePath = join(repoPath, 'source.ts')
    const targetSource = [
      'export class A { execute() {} stop() {} }',
      'export class B { execute() {} stop() {} }',
      ''
    ].join('\n')
    writeFileSync(targetPath, targetSource, 'utf-8')
    writeFileSync(sourcePath, [
      "import { A, B } from './target'",
      'export class Controller { constructor(private service: A) {} run() { this.service.execute() } }',
      ''
    ].join('\n'), 'utf-8')
    model = createRepositoryModel(repoPath)
    await model.indexRepository()

    const sourceFile = model.getFiles().find((file) => file.relativePath === 'source.ts')!
    const targetMethod = (className: string, methodName: string) => {
      const owner = model!.getElementsByRepository().find((element) => element.kind === 'class' && element.name === className)!
      return model!.getElementsByRepository().find((element) =>
        element.kind === 'method' && element.name === methodName && element.parentElementId === owner.id
      )!
    }
    const calls = () => model!.getSymbolReferencesBySourceFile(sourceFile.id).filter((reference) => reference.kind === 'call')

    expect(calls()).toHaveLength(1)
    expect(calls()[0].targetElementId).toBe(targetMethod('A', 'execute').id)

    writeFileSync(sourcePath, [
      "import { A, B } from './target'",
      'export class Controller { constructor(private service: B) {} run() { this.service.execute() } }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('source.ts')
    expect(calls()[0].targetElementId).toBe(targetMethod('B', 'execute').id)

    writeFileSync(sourcePath, [
      "import { B } from './target'",
      'export class Controller { constructor(service: B) {} run() { this.service.execute() } }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('source.ts')
    expect(calls()).toEqual([])

    writeFileSync(sourcePath, [
      "import { B } from './target'",
      'export class Controller { constructor(protected service: B) {} run() { this.service.execute() } }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('source.ts')
    expect(calls()[0].targetElementId).toBe(targetMethod('B', 'execute').id)

    writeFileSync(sourcePath, [
      "import { B } from './target'",
      'export class Controller { constructor(public client: B) {} run() { this.client.stop() } }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('source.ts')
    expect(calls()[0].targetElementId).toBe(targetMethod('B', 'stop').id)

    writeFileSync(targetPath, [
      'export class A { execute() {} stop() {} }',
      'export class B { execute() {} }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('target.ts')
    expect(calls()).toEqual([])

    writeFileSync(targetPath, targetSource, 'utf-8')
    await model.updateFileContent('target.ts')
    await model.updateFileContent('source.ts')
    expect(calls()).toHaveLength(1)
    expect(calls()[0].targetElementId).toBe(targetMethod('B', 'stop').id)

    const beforeBackfill = calls()
    await model.backfillSymbolReferences()
    expect(calls()).toEqual(beforeBackfill)

    writeFileSync(sourcePath, [
      "import { B } from './missing'",
      'export class Controller { constructor(public client: B) {} run() { this.client.stop() } }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('source.ts')
    expect(calls()).toEqual([])
  })

  it('migra referências de contrato quando tipo, método, member ou import mudam', async () => {
    repoPath = createTempRepo()
    const targetPath = join(repoPath, 'ports.ts')
    const sourcePath = join(repoPath, 'source.ts')
    const ports = (portBMethod: string | null) => [
      'export interface PortA { execute(): void }',
      `export interface PortB { ${portBMethod ? `${portBMethod}(): void` : ''} }`,
      ''
    ].join('\n')
    writeFileSync(targetPath, ports('execute'), 'utf-8')
    writeFileSync(sourcePath, [
      "import { PortA, PortB } from './ports'",
      'export function run(service: PortA) { service.execute() }',
      ''
    ].join('\n'), 'utf-8')
    model = createRepositoryModel(repoPath)
    await model.indexRepository()

    const sourceFile = model.getFiles().find((file) => file.relativePath === 'source.ts')!
    const targetMethod = (interfaceName: string, methodName: string) => {
      const owner = model!.getElementsByRepository().find((element) =>
        element.kind === 'interface' && element.name === interfaceName
      )!
      return model!.getElementsByRepository().find((element) =>
        element.kind === 'method' && element.name === methodName && element.parentElementId === owner.id
      )!
    }
    const calls = () => model!.getSymbolReferencesBySourceFile(sourceFile.id).filter((reference) => reference.kind === 'call')

    expect(calls()).toHaveLength(1)
    expect(calls()[0].targetElementId).toBe(targetMethod('PortA', 'execute').id)

    writeFileSync(sourcePath, [
      "import { PortA, PortB } from './ports'",
      'export function run(service: PortB) { service.execute() }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('source.ts')
    expect(calls()[0].targetElementId).toBe(targetMethod('PortB', 'execute').id)

    writeFileSync(targetPath, ports(null), 'utf-8')
    await model.updateFileContent('ports.ts')
    expect(calls()).toEqual([])

    writeFileSync(targetPath, ports('execute'), 'utf-8')
    await model.updateFileContent('ports.ts')
    expect(calls()[0].targetElementId).toBe(targetMethod('PortB', 'execute').id)

    writeFileSync(targetPath, ports('stop'), 'utf-8')
    await model.updateFileContent('ports.ts')
    expect(calls()).toEqual([])
    writeFileSync(sourcePath, [
      "import { PortB } from './ports'",
      'export function run(service: PortB) { service.stop() }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('source.ts')
    expect(calls()[0].targetElementId).toBe(targetMethod('PortB', 'stop').id)

    writeFileSync(sourcePath, [
      "import { Missing as Contract } from './ports'",
      'export function run(service: Contract) { service.stop() }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('source.ts')
    expect(calls()).toEqual([])

    writeFileSync(sourcePath, [
      "import { PortB as Contract } from './ports'",
      'export function run(service: Contract) { service.stop() }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('source.ts')
    expect(calls()[0].targetElementId).toBe(targetMethod('PortB', 'stop').id)

    const beforeBackfill = calls()
    await model.backfillSymbolReferences()
    expect(calls()).toEqual(beforeBackfill)
  })

  it('mantém Tier 7 incremental e backfill idempotente para múltiplos consumidores', async () => {
    repoPath = createTempRepo()
    const servicesPath = join(repoPath, 'services.ts')
    const runtimePath = join(repoPath, 'runtime.ts')
    const firstPath = join(repoPath, 'first.ts')
    const secondPath = join(repoPath, 'second.ts')
    writeFileSync(servicesPath, [
      'export class A { execute() {} stop() {} }',
      'export class B { execute() {} stop() {} }',
      ''
    ].join('\n'), 'utf-8')
    writeFileSync(runtimePath, [
      "import { A as RuntimeA, B } from './services'",
      'export const service = new RuntimeA()',
      ''
    ].join('\n'), 'utf-8')
    writeFileSync(firstPath, [
      "import { service as svc } from './runtime'",
      'export function first() { svc.execute() }',
      ''
    ].join('\n'), 'utf-8')
    writeFileSync(secondPath, [
      "import { service } from './runtime'",
      'export function second() { service.execute() }',
      ''
    ].join('\n'), 'utf-8')
    model = createRepositoryModel(repoPath)
    await model.indexRepository()

    const sourceFiles = () => model!.getFiles().filter((file) => ['first.ts', 'second.ts'].includes(file.relativePath))
    const calls = () => sourceFiles().flatMap((file) =>
      model!.getSymbolReferencesBySourceFile(file.id).filter((reference) => reference.kind === 'call')
    )
    const targetMethod = (className: string, methodName: string) => {
      const owner = model!.getElementsByRepository().find((element) =>
        element.kind === 'class' && element.name === className
      )!
      return model!.getElementsByRepository().find((element) =>
        element.kind === 'method' && element.name === methodName && element.parentElementId === owner.id
      )!
    }

    expect(calls()).toHaveLength(2)
    expect(calls().every((reference) => reference.targetElementId === targetMethod('A', 'execute').id)).toBe(true)

    writeFileSync(runtimePath, [
      "import { A as RuntimeA, B } from './services'",
      'export const service = new B()',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('runtime.ts')
    expect(calls()).toHaveLength(2)
    expect(calls().every((reference) => reference.targetElementId === targetMethod('B', 'execute').id)).toBe(true)

    writeFileSync(firstPath, [
      "import { service as svc } from './runtime'",
      'export function first() { svc.stop() }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('first.ts')
    expect(calls().map((reference) => reference.targetElementId).sort()).toEqual([
      targetMethod('B', 'execute').id,
      targetMethod('B', 'stop').id
    ].sort())

    writeFileSync(runtimePath, [
      "import { B } from './services'",
      'export const service = createService()',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('runtime.ts')
    expect(calls()).toEqual([])

    writeFileSync(runtimePath, [
      "import { B } from './services'",
      'export const renamed = new B()',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('runtime.ts')
    expect(calls()).toEqual([])

    writeFileSync(firstPath, [
      "import { renamed as svc } from './runtime'",
      'export function first() { svc.stop() }',
      ''
    ].join('\n'), 'utf-8')
    writeFileSync(secondPath, [
      "import { renamed } from './runtime'",
      'export function second() { renamed.execute() }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('first.ts')
    await model.updateFileContent('second.ts')
    expect(calls()).toHaveLength(2)

    const beforeBackfill = calls()
    await model.backfillSymbolReferences()
    expect(calls()).toEqual(beforeBackfill)
    await model.backfillSymbolReferences()
    expect(calls()).toEqual(beforeBackfill)

    writeFileSync(firstPath, [
      "import { renamed as svc } from './missing'",
      'export function first() { svc.stop() }',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('first.ts')
    expect(calls()).toHaveLength(1)
    expect(calls()[0].targetElementId).toBe(targetMethod('B', 'execute').id)
  })

  it('reverte a substituição estrutural inteira quando uma referência viola integridade', async () => {
    const { sourceFileId } = await indexFixture()
    const database = createRepositoryDatabase(repoPath)
    const sourceFile = model!.getFiles().find((file) => file.id === sourceFileId)!
    const elements = model!.getElementsByFile(sourceFileId)
    const relationships = model!.getRelationships().filter((relationship) =>
      relationship.sourceId === sourceFileId || elements.some((element) => element.id === relationship.sourceId)
    )

    expect(() => database.replaceIndexedFileState(
      { ...sourceFile, contentHash: 'poisoned' },
      elements,
      relationships,
      [],
      [{
        id: 'invalid-target',
        repositoryId: model!.getRepositoryId(),
        sourceFileId,
        sourceElementId: null,
        targetElementId: 'missing-element',
        kind: 'call',
        location: { start: { line: 1, column: 0, byte: 0 }, end: { line: 1, column: 1, byte: 1 } }
      }]
    )).toThrow()

    expect(model!.getFiles().find((file) => file.id === sourceFileId)!.contentHash).toBe(sourceFile.contentHash)
    expect(model!.getSymbolReferencesBySourceFile(sourceFileId)).toHaveLength(1)
  })

  it('mantém Tier 8 incremental e reativo a migrações de return type e modificador static', async () => {
    repoPath = createTempRepo()
    const servicesPath = join(repoPath, 'services.ts')
    const runtimePath = join(repoPath, 'runtime.ts')
    const consumerPath = join(repoPath, 'consumer.ts')

    writeFileSync(servicesPath, [
      'export class A { execute() {} }',
      'export class B { execute() {} }',
      'export interface IService { execute(): void }',
      'export class Factory {',
      '  static getInstance(): A { return new A() }',
      '}',
      'export class Utility {',
      '  static run() {}',
      '}',
      ''
    ].join('\n'), 'utf-8')

    writeFileSync(runtimePath, [
      "import { Factory } from './services'",
      'export const service = Factory.getInstance()',
      ''
    ].join('\n'), 'utf-8')

    writeFileSync(consumerPath, [
      "import { service } from './runtime'",
      "import { Utility } from './services'",
      'export function main() {',
      '  service.execute()',
      '  Utility.run()',
      '}',
      ''
    ].join('\n'), 'utf-8')

    model = createRepositoryModel(repoPath)
    await model.indexRepository()

    const consumerFile = () => model!.getFiles().find((file) => file.relativePath === 'consumer.ts')!
    const calls = () => model!.getSymbolReferencesBySourceFile(consumerFile().id).filter((ref) => ref.kind === 'call')

    const targetMethod = (className: string, methodName: string) => {
      const owner = model!.getElementsByRepository().find((element) =>
        element.kind === 'class' && element.name === className
      )!
      return model!.getElementsByRepository().find((element) =>
        element.kind === 'method' && element.name === methodName && element.parentElementId === owner.id
      )!
    }

    expect(calls()).toHaveLength(2)
    expect(calls().map((r) => r.targetElementId).sort()).toEqual([
      targetMethod('A', 'execute').id,
      targetMethod('Utility', 'run').id
    ].sort())

    // 1. Migração de return type: getInstance(): A -> getInstance(): B
    writeFileSync(servicesPath, [
      'export class A { execute() {} }',
      'export class B { execute() {} }',
      'export interface IService { execute(): void }',
      'export class Factory {',
      '  static getInstance(): B { return new B() }',
      '}',
      'export class Utility {',
      '  static run() {}',
      '}',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('services.ts')
    expect(calls().map((r) => r.targetElementId).sort()).toEqual([
      targetMethod('B', 'execute').id,
      targetMethod('Utility', 'run').id
    ].sort())

    // 2. Return type desaparece: getInstance() sem anotação -> referência a service deve desaparecer
    writeFileSync(servicesPath, [
      'export class A { execute() {} }',
      'export class B { execute() {} }',
      'export interface IService { execute(): void }',
      'export class Factory {',
      '  static getInstance() { return new B() }',
      '}',
      'export class Utility {',
      '  static run() {}',
      '}',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('services.ts')
    expect(calls().map((r) => r.targetElementId)).toEqual([
      targetMethod('Utility', 'run').id
    ])

    // 3. Return type vira interface: getInstance(): IService -> não resolve (contrato não é classe)
    writeFileSync(servicesPath, [
      'export class A { execute() {} }',
      'export class B { execute() {} }',
      'export interface IService { execute(): void }',
      'export class Factory {',
      '  static getInstance(): IService { return new B() }',
      '}',
      'export class Utility {',
      '  static run() {}',
      '}',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('services.ts')
    expect(calls().map((r) => r.targetElementId)).toEqual([
      targetMethod('Utility', 'run').id
    ])

    // 4. Modificador static removido: run() deixa de ser static -> referência static desaparece
    writeFileSync(servicesPath, [
      'export class A { execute() {} }',
      'export class B { execute() {} }',
      'export interface IService { execute(): void }',
      'export class Factory {',
      '  static getInstance(): B { return new B() }',
      '}',
      'export class Utility {',
      '  run() {}',
      '}',
      ''
    ].join('\n'), 'utf-8')
    await model.updateFileContent('services.ts')
    expect(calls().map((r) => r.targetElementId)).toEqual([
      targetMethod('B', 'execute').id
    ])

    // 5. Backfill idempotente
    const beforeBackfill = calls()
    await model.backfillSymbolReferences()
    expect(calls()).toEqual(beforeBackfill)
  })
})
