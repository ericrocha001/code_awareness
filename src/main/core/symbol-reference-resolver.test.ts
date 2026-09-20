import { describe, expect, it } from 'vitest'
import type { CodeMapElement, CodeMapElementKind, CodeMapElementLocation } from '../../shared/types'
import type {
  ExportedConstCallBinding,
  ExportedConstNewBinding,
  ImportBinding,
  SymbolReferenceCandidate,
  SymbolReferenceKind
} from './extraction/structure-extraction-port'
import {
  resolveSymbolReferences,
  type SymbolReferenceFile
} from './symbol-reference-resolver'

const location = (byte = 0): CodeMapElementLocation => ({
  start: { line: 1, column: byte, byte },
  end: { line: 1, column: byte + 1, byte: byte + 1 }
})

function element(
  id: string,
  name: string,
  kind: CodeMapElementKind,
  parentElementId: string | null = null,
  declarationSignature: string | null = null
): CodeMapElement {
  return {
    id,
    repositoryId: 'repo',
    fileId: 'file',
    kind,
    name,
    parentElementId,
    location: location(),
    sizeLines: 0,
    sizeBytes: 1,
    visibility: null,
    modifiers: [],
    returnType: null,
    baseClass: null,
    hasDocumentation: false,
    parameterCount: 0,
    declarationSignature,
    retrievalKind: kind === 'export' ? null : 'A',
    granularity: kind === 'export' ? 'syntax' : 'structural',
    retrievable: kind !== 'export'
  }
}

function exported(id: string, name: string, kind: CodeMapElementKind): CodeMapElement[] {
  const exportId = `export-${id}`
  return [element(exportId, name, 'export'), element(id, name, kind, exportId)]
}

function candidate(
  name: string,
  kind: SymbolReferenceKind,
  sourceElementId: string | null = null,
  byte = 0,
  receiver?: SymbolReferenceCandidate['receiver'],
  receiverName?: string,
  receiverTypeName?: string,
  details: Partial<Pick<SymbolReferenceCandidate,
    'receiverBindingKind' | 'receiverPropertyName' | 'receiverPropertyOrigin' | 'optional'>> = {}
): SymbolReferenceCandidate {
  return {
    name,
    kind,
    sourceElementId,
    location: location(byte),
    ...(receiver ? { receiver } : {}),
    ...(receiverName ? { receiverName } : {}),
    ...(receiverTypeName ? { receiverTypeName } : {}),
    ...details
  }
}

function binding(sourceModule: string, importedName: string, localName = importedName): ImportBinding {
  return { sourceModule, importedName, localName, location: location() }
}

function file(
  relativePath: string,
  elements: CodeMapElement[],
  symbolReferences: SymbolReferenceCandidate[] = [],
  importBindings: ImportBinding[] = [],
  exportedConstNewBindings: ExportedConstNewBinding[] = [],
  exportedConstCallBindings: ExportedConstCallBinding[] = []
): SymbolReferenceFile {
  return { fileId: `file:${relativePath}`, relativePath, elements, symbolReferences, importBindings, exportedConstNewBindings, exportedConstCallBindings }
}

describe('SymbolReferenceResolver', () => {
  it('resolve declarações locais top-level apenas para kinds compatíveis e inequívocos', () => {
    const source = file('src/local.ts', [
      element('run-id', 'run', 'function'),
      element('service-id', 'Service', 'class'),
      element('config-id', 'Config', 'interface'),
      element('value-id', 'value', 'constant')
    ], [
      candidate('run', 'call', null, 1),
      candidate('Service', 'instantiation', null, 2),
      candidate('Config', 'type', null, 3),
      candidate('value', 'reference', null, 4),
      candidate('Service', 'call', null, 5)
    ])

    expect(resolveSymbolReferences('.', [source]).map((reference) => reference.targetElementId)).toEqual([
      'run-id', 'service-id', 'config-id', 'value-id'
    ])
  })

  it('resolve named imports, aliases, funções, tipos e referências para exports diretos', () => {
    const service = file('src/service.ts', [
      ...exported('service-id', 'Service', 'class'),
      ...exported('execute-id', 'execute', 'function'),
      ...exported('token-id', 'token', 'constant')
    ])
    const types = file('src/types.ts', [
      ...exported('config-id', 'Config', 'interface'),
      ...exported('alias-id', 'Identifier', 'typeAlias')
    ])
    const app = file('src/app.ts', [], [
      candidate('Service', 'instantiation', null, 1),
      candidate('DataService', 'instantiation', null, 2),
      candidate('execute', 'call', null, 3),
      candidate('Config', 'type', null, 4),
      candidate('Identifier', 'type', null, 5),
      candidate('token', 'reference', null, 6)
    ], [
      binding('./service', 'Service'),
      binding('./service', 'Service', 'DataService'),
      binding('./service', 'execute'),
      binding('./types', 'Config'),
      binding('./types', 'Identifier'),
      binding('./service', 'token')
    ])

    const resolved = resolveSymbolReferences('.', [service, types, app])
    expect(resolved.map((reference) => reference.targetElementId)).toEqual([
      'service-id', 'service-id', 'execute-id', 'config-id', 'alias-id', 'token-id'
    ])
    expect(resolveSymbolReferences('.', [app, types, service])).toEqual(resolved)
  })

  it('mantém unresolved destinos não exportados, incompatíveis, externos, ambíguos e overloads', () => {
    const hidden = file('src/hidden.ts', [element('hidden-id', 'Hidden', 'class')])
    const overloaded = file('src/overloaded.ts', [
      ...exported('format-1', 'format', 'function'),
      ...exported('format-2', 'format', 'function')
    ])
    const app = file('src/app.ts', [], [
      candidate('Hidden', 'instantiation', null, 1),
      candidate('format', 'call', null, 2),
      candidate('format', 'instantiation', null, 3),
      candidate('external', 'call', null, 4)
    ], [
      binding('./hidden', 'Hidden'),
      binding('./overloaded', 'format'),
      binding('external-package', 'external')
    ])

    expect(resolveSymbolReferences('.', [hidden, overloaded, app])).toEqual([])
  })

  it('bloqueia import sombreado por parâmetro ou declaração local', () => {
    const target = file('src/foo.ts', exported('foo-id', 'Foo', 'function'))
    const scope = element('scope-id', 'invoke', 'function', null, 'invoke(Foo)')
    const parameter = element('parameter-id', 'Foo', 'parameter', scope.id)
    const app = file('src/app.ts', [scope, parameter], [
      candidate('Foo', 'call', scope.id, 1)
    ], [binding('./foo', 'Foo')])

    expect(resolveSymbolReferences('.', [target, app])).toEqual([])
  })

  it('não fabrica resolução para método dinâmico ausente dos candidates', () => {
    const target = file('src/service.ts', exported('execute-id', 'execute', 'function'))
    const app = file('src/app.ts', [], [candidate('service', 'reference')])

    expect(resolveSymbolReferences('.', [target, app])).toEqual([])
  })

  it('resolve corpus conservador de this.method com zero falsas resoluções', () => {
    const service = element('service', 'Service', 'class')
    const start = element('start', 'start', 'method', service.id)
    const execute = element('execute', 'execute', 'method', service.id)
    const overloadedA = element('overload-a', 'overloaded', 'method', service.id)
    const overloadedB = element('overload-b', 'overloaded', 'method', service.id)
    const staticMethod = { ...element('static', 'staticOnly', 'method', service.id), modifiers: ['static'] }
    const source = file('src/service.ts', [service, start, execute, overloadedA, overloadedB, staticMethod], [
      candidate('execute', 'call', start.id, 1, 'this'),
      candidate('execute', 'call', start.id, 2, 'this'),
      candidate('overloaded', 'call', start.id, 3, 'this'),
      candidate('missing', 'call', start.id, 4, 'this'),
      candidate('staticOnly', 'call', start.id, 5, 'this')
    ])

    const resolved = resolveSymbolReferences('.', [source])
    expect(resolved).toHaveLength(2)
    expect(resolved.every((reference) => reference.sourceElementId === start.id)).toBe(true)
    expect(resolved.every((reference) => reference.targetElementId === execute.id && reference.kind === 'call')).toBe(true)
    expect(new Set(resolved.map((reference) => reference.location.start.byte))).toEqual(new Set([1, 2]))
    expect({ candidates: 5, resolved: resolved.length, intentionallyUnresolved: 3, falseResolutions: 0 }).toEqual({
      candidates: 5,
      resolved: 2,
      intentionallyUnresolved: 3,
      falseResolutions: 0
    })
  })

  it('prefere override local e resolve cadeia herdada inequívoca', () => {
    const baseExport = element('base-export', 'Base', 'export')
    const base = { ...element('base', 'Base', 'class', baseExport.id), baseClass: null }
    const baseExecute = element('base-execute', 'execute', 'method', base.id)
    const baseFile = file('src/base.ts', [baseExport, base, baseExecute])

    const parentExport = element('parent-export', 'Parent', 'export')
    const parent = { ...element('parent', 'Parent', 'class', parentExport.id), baseClass: 'Base' }
    const parentFile = file('src/parent.ts', [parentExport, parent], [], [binding('./base', 'Base')])

    const child = { ...element('child', 'Child', 'class'), baseClass: 'Parent' }
    const run = element('run', 'run', 'method', child.id)
    const childFile = file('src/child.ts', [child, run], [candidate('execute', 'call', run.id, 1, 'this')], [binding('./parent', 'Parent')])
    expect(resolveSymbolReferences('.', [childFile, parentFile, baseFile])).toMatchObject([
      { sourceElementId: run.id, targetElementId: baseExecute.id, kind: 'call' }
    ])

    const override = element('child-execute', 'execute', 'method', child.id)
    const childWithOverride = file('src/child.ts', [child, run, override], [candidate('execute', 'call', run.id, 1, 'this')], [binding('./parent', 'Parent')])
    expect(resolveSymbolReferences('.', [childWithOverride, parentFile, baseFile])).toMatchObject([
      { sourceElementId: run.id, targetElementId: override.id, kind: 'call' }
    ])
  })

  it('rejeita hierarquia cíclica ou ambígua e membro private herdado', () => {
    const left = { ...element('left', 'Left', 'class'), baseClass: 'Right' }
    const right = { ...element('right', 'Right', 'class'), baseClass: 'Left' }
    const run = element('left-run', 'run', 'method', left.id)
    const cycle = file('src/cycle.ts', [left, right, run], [candidate('missing', 'call', run.id, 1, 'this')])
    expect(resolveSymbolReferences('.', [cycle])).toEqual([])

    const baseExport = element('private-base-export', 'PrivateBase', 'export')
    const base = element('private-base', 'PrivateBase', 'class', baseExport.id)
    const hidden = { ...element('hidden', 'execute', 'method', base.id), visibility: 'private' as const }
    const baseFile = file('src/private-base.ts', [baseExport, base, hidden])
    const child = { ...element('private-child', 'Child', 'class'), baseClass: 'PrivateBase' }
    const childRun = element('private-run', 'run', 'method', child.id)
    const childFile = file('src/private-child.ts', [child, childRun], [candidate('execute', 'call', childRun.id, 2, 'this')], [
      binding('./private-base', 'PrivateBase'),
      binding('./other-base', 'PrivateBase')
    ])
    expect(resolveSymbolReferences('.', [childFile, baseFile])).toEqual([])

    const unambiguousChild = file('src/private-child.ts', [child, childRun], [candidate('execute', 'call', childRun.id, 2, 'this')], [binding('./private-base', 'PrivateBase')])
    expect(resolveSymbolReferences('.', [unambiguousChild, baseFile])).toEqual([])
  })

  it('resolve parâmetros tipados locais, importados e aliases para classes', () => {
    const localService = element('local-service', 'LocalService', 'class')
    const localExecute = element('local-execute', 'execute', 'method', localService.id)
    const localRun = element('local-run', 'run', 'function')
    const localFile = file('src/local-parameter.ts', [localService, localExecute, localRun], [
      candidate('execute', 'call', localRun.id, 1, 'identifier', 'service', 'LocalService')
    ])

    const serviceExport = element('service-export', 'Service', 'export')
    const service = element('service-class', 'Service', 'class', serviceExport.id)
    const execute = element('service-execute', 'execute', 'method', service.id)
    const serviceFile = file('src/service.ts', [serviceExport, service, execute])
    const importedRun = element('imported-run', 'run', 'function')
    const importedFile = file('src/imported-parameter.ts', [importedRun], [
      candidate('execute', 'call', importedRun.id, 2, 'identifier', 'service', 'Service'),
      candidate('execute', 'call', importedRun.id, 3, 'identifier', 'alias', 'DataService')
    ], [
      binding('./service', 'Service'),
      binding('./service', 'Service', 'DataService')
    ])

    expect(resolveSymbolReferences('.', [localFile, serviceFile, importedFile])).toMatchObject([
      { sourceElementId: importedRun.id, targetElementId: execute.id, kind: 'call' },
      { sourceElementId: importedRun.id, targetElementId: execute.id, kind: 'call' },
      { sourceElementId: localRun.id, targetElementId: localExecute.id, kind: 'call' }
    ])
  })

  it('reutiliza override e herança para parâmetros tipados', () => {
    const baseExport = element('typed-base-export', 'Base', 'export')
    const base = element('typed-base', 'Base', 'class', baseExport.id)
    const baseExecute = element('typed-base-execute', 'execute', 'method', base.id)
    const baseFile = file('src/typed-base.ts', [baseExport, base, baseExecute])
    const child = { ...element('typed-child', 'Child', 'class'), baseClass: 'Base' }
    const run = element('typed-run', 'run', 'function')
    const inherited = file('src/typed-child.ts', [child, run], [
      candidate('execute', 'call', run.id, 1, 'identifier', 'service', 'Child')
    ], [binding('./typed-base', 'Base')])
    expect(resolveSymbolReferences('.', [inherited, baseFile])).toMatchObject([
      { sourceElementId: run.id, targetElementId: baseExecute.id }
    ])

    const override = element('typed-child-execute', 'execute', 'method', child.id)
    const overridden = file('src/typed-child.ts', [child, override, run], [
      candidate('execute', 'call', run.id, 1, 'identifier', 'service', 'Child')
    ], [binding('./typed-base', 'Base')])
    expect(resolveSymbolReferences('.', [overridden, baseFile])).toMatchObject([
      { sourceElementId: run.id, targetElementId: override.id }
    ])
  })

  it('resolve parâmetros tipados para métodos diretos de interfaces locais, exportadas, importadas e aliases', () => {
    const localPort = element('local-port', 'LocalPort', 'interface')
    const localExecute = element('local-execute', 'execute', 'method', localPort.id)
    const exportedPort = element('exported-port', 'ExportedPort', 'interface', 'exported-port-export')
    const exportedExecute = element('exported-execute', 'execute', 'method', exportedPort.id)
    const localRun = element('local-run', 'runLocal', 'function')
    const localFile = file('src/local-contract.ts', [
      localPort,
      localExecute,
      element('exported-port-export', 'ExportedPort', 'export'),
      exportedPort,
      exportedExecute,
      localRun
    ], [
      candidate('execute', 'call', localRun.id, 1, 'identifier', 'local', 'LocalPort', { receiverBindingKind: 'parameter' }),
      candidate('execute', 'call', localRun.id, 2, 'identifier', 'exported', 'ExportedPort', { receiverBindingKind: 'parameter' })
    ])

    const portExport = element('port-export', 'ServicePort', 'export')
    const port = element('port', 'ServicePort', 'interface', portExport.id)
    const portExecute = element('port-execute', 'execute', 'method', port.id)
    const implementationA = element('implementation-a', 'ServiceA', 'class')
    const implementationB = element('implementation-b', 'ServiceB', 'class')
    const contracts = file('src/contracts.ts', [
      portExport,
      port,
      portExecute,
      implementationA,
      element('implementation-a-execute', 'execute', 'method', implementationA.id),
      implementationB,
      element('implementation-b-execute', 'execute', 'method', implementationB.id)
    ])
    const importedRun = element('imported-run', 'runImported', 'function')
    const imported = file('src/imported-contract.ts', [importedRun], [
      candidate('execute', 'call', importedRun.id, 3, 'identifier', 'service', 'ServicePort', { receiverBindingKind: 'parameter' }),
      candidate('execute', 'call', importedRun.id, 4, 'identifier', 'aliased', 'Port', { receiverBindingKind: 'parameter' })
    ], [
      binding('./contracts', 'ServicePort'),
      binding('./contracts', 'ServicePort', 'Port')
    ])

    const resolved = resolveSymbolReferences('.', [localFile, contracts, imported])
    expect(resolved.map((reference) => reference.targetElementId)).toEqual([
      portExecute.id,
      portExecute.id,
      localExecute.id,
      exportedExecute.id
    ])
    expect(resolved.every((reference) => reference.kind === 'call')).toBe(true)
    expect(resolved.some((reference) => [
      'implementation-a-execute',
      'implementation-b-execute'
    ].includes(reference.targetElementId))).toBe(false)
  })

  it('resolve properties e constructor parameter properties para o método da interface', () => {
    const portExport = element('property-port-export', 'ServicePort', 'export')
    const port = element('property-port', 'ServicePort', 'interface', portExport.id)
    const execute = element('property-port-execute', 'execute', 'method', port.id)
    const contracts = file('src/property-contract.ts', [portExport, port, execute])

    const controller = element('controller', 'Controller', 'class')
    const run = element('controller-run', 'run', 'method', controller.id)
    const property = element('controller-property', 'service', 'property', controller.id, 'service: ServicePort')
    const constructor = element('controller-constructor', 'constructor', 'method', controller.id)
    const parameterProperty = {
      ...element('controller-client', 'client', 'parameter', constructor.id, 'client: ServicePort'),
      modifiers: ['private']
    }
    const source = file('src/controller.ts', [controller, run, property, constructor, parameterProperty], [
      candidate('execute', 'call', run.id, 1, 'this-property', undefined, 'ServicePort', {
        receiverPropertyName: 'service',
        receiverPropertyOrigin: 'class-property'
      }),
      candidate('execute', 'call', run.id, 2, 'this-property', undefined, 'ServicePort', {
        receiverPropertyName: 'client',
        receiverPropertyOrigin: 'constructor-parameter-property'
      })
    ], [binding('./property-contract', 'ServicePort')])

    expect(resolveSymbolReferences('.', [contracts, source])).toMatchObject([
      { sourceElementId: run.id, targetElementId: execute.id, kind: 'call' },
      { sourceElementId: run.id, targetElementId: execute.id, kind: 'call' }
    ])
  })

  it('mantém interfaces herdadas, overloads, optional calls e origens fora do Tier 6 unresolved', () => {
    const base = element('interface-base', 'BasePort', 'interface')
    const baseExecute = element('interface-base-execute', 'execute', 'method', base.id)
    const child = element('interface-child', 'ChildPort', 'interface')
    const overloaded = element('interface-overloaded', 'OverloadedPort', 'interface')
    const overloadA = element('interface-overload-a', 'execute', 'method', overloaded.id)
    const overloadB = element('interface-overload-b', 'execute', 'method', overloaded.id)
    const direct = element('interface-direct', 'DirectPort', 'interface')
    const directExecute = element('interface-direct-execute', 'execute', 'method', direct.id)
    const run = element('interface-negative-run', 'run', 'function')
    const source = file('src/interface-negatives.ts', [
      base,
      baseExecute,
      child,
      overloaded,
      overloadA,
      overloadB,
      direct,
      directExecute,
      run
    ], [
      candidate('execute', 'call', run.id, 1, 'identifier', 'child', 'ChildPort', { receiverBindingKind: 'parameter' }),
      candidate('execute', 'call', run.id, 2, 'identifier', 'overloaded', 'OverloadedPort', { receiverBindingKind: 'parameter' }),
      candidate('execute', 'call', run.id, 3, 'identifier', 'optional', 'DirectPort', { receiverBindingKind: 'parameter', optional: true }),
      candidate('execute', 'call', run.id, 4, 'identifier', 'constructed', 'DirectPort', { receiverBindingKind: 'const-new' })
    ])

    expect(resolveSymbolReferences('.', [source])).toEqual([])
  })

  it('mantém unresolved receivers sem tipo, interface sem origem comprovada, tipos ambíguos e overloads', () => {
    const service = element('negative-service', 'Service', 'class')
    const overloadA = element('negative-overload-a', 'execute', 'method', service.id)
    const overloadB = element('negative-overload-b', 'execute', 'method', service.id)
    const contract = element('negative-contract', 'ServicePort', 'interface')
    const contractMethod = element('negative-contract-method', 'execute', 'method', contract.id)
    const run = element('negative-run', 'run', 'function')
    const source = file('src/negative-parameter.ts', [service, overloadA, overloadB, contract, contractMethod, run], [
      candidate('execute', 'call', run.id, 1, 'identifier', 'untyped'),
      candidate('execute', 'call', run.id, 2, 'identifier', 'shadowed'),
      candidate('execute', 'call', run.id, 3, 'identifier', 'port', 'ServicePort'),
      candidate('execute', 'call', run.id, 4, 'identifier', 'union'),
      candidate('execute', 'call', run.id, 5, 'identifier', 'generic'),
      candidate('execute', 'call', run.id, 6, 'identifier', 'service', 'Service')
    ])

    const resolved = resolveSymbolReferences('.', [source])
    expect(resolved).toEqual([])
    expect({ occurrences: 6, resolved: resolved.length, intentionallyUnresolved: 6, falseResolutions: 0 }).toEqual({
      occurrences: 6,
      resolved: 0,
      intentionallyUnresolved: 6,
      falseResolutions: 0
    })
  })

  it('resolve instâncias importadas criadas com new estrutural, aliases, herança e override sem falsos positivos', () => {
    const services = file('src/services.ts', [
      ...exported('service', 'Service', 'class'),
      element('service-execute', 'execute', 'method', 'service'),
      ...exported('base', 'Base', 'class'),
      element('base-execute', 'execute', 'method', 'base'),
      ...exported('child', 'Child', 'class'),
      ...exported('overridden', 'Overridden', 'class'),
      element('overridden-execute', 'execute', 'method', 'overridden')
    ])
    services.elements.find((e) => e.id === 'child')!.baseClass = 'Base'
    services.elements.find((e) => e.id === 'overridden')!.baseClass = 'Base'

    const localService = element('local-service', 'LocalService', 'class')
    const localExecute = element('local-execute', 'execute', 'method', localService.id)
    const localExport = element('export-local', 'local', 'export')
    const localConst = element('const-local', 'local', 'constant', localExport.id)

    const importedExport = element('export-imported', 'imported', 'export')
    const importedConst = element('const-imported', 'imported', 'constant', importedExport.id)

    const inheritedExport = element('export-inherited', 'inherited', 'export')
    const inheritedConst = element('const-inherited', 'inherited', 'constant', inheritedExport.id)

    const overriddenExport = element('export-overridden', 'overridden', 'export')
    const overriddenConst = element('const-overridden', 'overridden', 'constant', overriddenExport.id)

    const runtime = file('src/runtime.ts', [
      localService,
      localExecute,
      localExport,
      localConst,
      importedExport,
      importedConst,
      inheritedExport,
      inheritedConst,
      overriddenExport,
      overriddenConst
    ], [], [
      binding('./services', 'Service', 'InternalService'),
      binding('./services', 'Child'),
      binding('./services', 'Overridden')
    ], [
      { declarationElementId: localConst.id, exportedName: 'local', constructorName: 'LocalService' },
      { declarationElementId: importedConst.id, exportedName: 'imported', constructorName: 'InternalService' },
      { declarationElementId: inheritedConst.id, exportedName: 'inherited', constructorName: 'Child' },
      { declarationElementId: overriddenConst.id, exportedName: 'overridden', constructorName: 'Overridden' }
    ])

    const run = element('run-fn', 'run', 'function')
    const consumer = file('src/consumer.ts', [run], [
      candidate('execute', 'call', run.id, 1, 'identifier', 'local'),
      candidate('execute', 'call', run.id, 2, 'identifier', 'service'),
      candidate('execute', 'call', run.id, 3, 'identifier', 'inherited'),
      candidate('execute', 'call', run.id, 4, 'identifier', 'overridden'),
      candidate('execute', 'call', run.id, 5, 'identifier', 'factory'),
      candidate('execute', 'call', run.id, 6, 'identifier', 'singleton'),
      candidate('execute', 'call', run.id, 7, 'identifier', 'external')
    ], [
      binding('./runtime', 'local'),
      binding('./runtime', 'imported', 'service'),
      binding('./runtime', 'inherited'),
      binding('./runtime', 'overridden'),
      binding('./runtime', 'factory'),
      binding('./runtime', 'singleton'),
      binding('external-pkg', 'external')
    ])

    const resolved = resolveSymbolReferences('.', [services, runtime, consumer])
    expect(resolved).toMatchObject([
      { sourceElementId: run.id, targetElementId: localExecute.id, kind: 'call' },
      { sourceElementId: run.id, targetElementId: 'service-execute', kind: 'call' },
      { sourceElementId: run.id, targetElementId: 'base-execute', kind: 'call' },
      { sourceElementId: run.id, targetElementId: 'overridden-execute', kind: 'call' }
    ])
    expect(resolved).toHaveLength(4)
  })

  it('resolve Tier 8 Parte A: export const via call com return type explícito simples', () => {
    const serviceExport = element('service-export', 'SettingsService', 'export')
    const serviceClass = element('service-class', 'SettingsService', 'class', serviceExport.id)
    const getInstance = {
      ...element('get-instance', 'getInstance', 'method', serviceClass.id),
      modifiers: ['static'],
      returnType: 'SettingsService'
    }
    const save = element('save-method', 'save', 'method', serviceClass.id)

    const interfaceExport = element('iface-export', 'StoragePort', 'export')
    const storageInterface = element('storage-iface', 'StoragePort', 'interface', interfaceExport.id)
    const getStorage = {
      ...element('get-storage', 'getStorage', 'function'),
      returnType: 'StoragePort'
    }

    const getExternal = {
      ...element('get-external', 'getExternal', 'function'),
      returnType: 'ExternalType'
    }

    const getNoType = {
      ...element('get-notype', 'getNoType', 'function'),
      returnType: null
    }

    const getComplex = {
      ...element('get-complex', 'getComplex', 'function'),
      returnType: 'Promise<SettingsService>'
    }

    const settingsExport = element('settings-export', 'settingsService', 'export')
    const settingsConst = element('settings-const', 'settingsService', 'constant', settingsExport.id)
    const storageExport = element('storage-export', 'storage', 'export')
    const storageConst = element('storage-const', 'storage', 'constant', storageExport.id)
    const externalExport = element('ext-export', 'externalService', 'export')
    const externalConst = element('ext-const', 'externalService', 'constant', externalExport.id)
    const noTypeExport = element('notype-export', 'noTypeService', 'export')
    const noTypeConst = element('notype-const', 'noTypeService', 'constant', noTypeExport.id)
    const complexExport = element('complex-export', 'complexService', 'export')
    const complexConst = element('complex-const', 'complexService', 'constant', complexExport.id)

    const runtime = file('src/runtime.ts', [
      serviceExport,
      serviceClass,
      getInstance,
      save,
      interfaceExport,
      storageInterface,
      getStorage,
      getExternal,
      getNoType,
      getComplex,
      settingsExport,
      settingsConst,
      storageExport,
      storageConst,
      externalExport,
      externalConst,
      noTypeExport,
      noTypeConst,
      complexExport,
      complexConst
    ], [], [], [], [
      { declarationElementId: settingsConst.id, exportedName: 'settingsService', calleeKind: 'member', calleeName: 'getInstance', calleeReceiverName: 'SettingsService' },
      { declarationElementId: storageConst.id, exportedName: 'storage', calleeKind: 'identifier', calleeName: 'getStorage' },
      { declarationElementId: externalConst.id, exportedName: 'externalService', calleeKind: 'identifier', calleeName: 'getExternal' },
      { declarationElementId: noTypeConst.id, exportedName: 'noTypeService', calleeKind: 'identifier', calleeName: 'getNoType' },
      { declarationElementId: complexConst.id, exportedName: 'complexService', calleeKind: 'identifier', calleeName: 'getComplex' }
    ])

    const run = element('run-fn', 'run', 'function')
    const consumer = file('src/consumer.ts', [run], [
      candidate('save', 'call', run.id, 1, 'identifier', 'settingsService'),
      candidate('save', 'call', run.id, 2, 'identifier', 'storage'),
      candidate('save', 'call', run.id, 3, 'identifier', 'externalService'),
      candidate('save', 'call', run.id, 4, 'identifier', 'noTypeService'),
      candidate('save', 'call', run.id, 5, 'identifier', 'complexService')
    ], [
      binding('./runtime', 'settingsService'),
      binding('./runtime', 'storage'),
      binding('./runtime', 'externalService'),
      binding('./runtime', 'noTypeService'),
      binding('./runtime', 'complexService')
    ])

    const resolved = resolveSymbolReferences('.', [runtime, consumer])
    expect(resolved).toMatchObject([
      { sourceElementId: run.id, targetElementId: save.id, kind: 'call' }
    ])
    expect(resolved).toHaveLength(1)
  })

  it('resolve Tier 8 Parte B: método static através de classe importada sem confundir com instance', () => {
    const devToolsExport = element('devtools-export', 'DevToolsManager', 'export')
    const devToolsClass = element('devtools-class', 'DevToolsManager', 'class', devToolsExport.id)
    const toggle = {
      ...element('toggle-method', 'toggle', 'method', devToolsClass.id),
      modifiers: ['static']
    }
    const instanceAction = {
      ...element('instance-action', 'action', 'method', devToolsClass.id),
      modifiers: []
    }

    const devtoolsFile = file('src/devtools.ts', [
      devToolsExport,
      devToolsClass,
      toggle,
      instanceAction
    ])

    const run = element('run-fn', 'run', 'function')
    const consumer = file('src/consumer.ts', [run], [
      candidate('toggle', 'call', run.id, 1, 'identifier', 'DevToolsManager'),
      candidate('action', 'call', run.id, 2, 'identifier', 'DevToolsManager'),
      candidate('nonExistent', 'call', run.id, 3, 'identifier', 'DevToolsManager')
    ], [
      binding('./devtools', 'DevToolsManager')
    ])

    const resolved = resolveSymbolReferences('.', [devtoolsFile, consumer])
    expect(resolved).toMatchObject([
      { sourceElementId: run.id, targetElementId: toggle.id, kind: 'call' }
    ])
    expect(resolved).toHaveLength(1)
  })
})
