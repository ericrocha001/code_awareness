import { createHash } from 'crypto'
import type { CodeMapElement, CodeMapElementLocation } from '../../shared/types'
import type {
  ExportedConstCallBinding,
  ExportedConstNewBinding,
  ImportBinding,
  SymbolReferenceCandidate,
  SymbolReferenceKind
} from './extraction/structure-extraction-port'
import { ImportResolver } from './import-resolver'

export interface SymbolReferenceFile {
  fileId: string
  relativePath: string
  elements: readonly CodeMapElement[]
  importBindings: readonly ImportBinding[]
  exportedConstNewBindings?: readonly ExportedConstNewBinding[]
  exportedConstCallBindings?: readonly ExportedConstCallBinding[]
  symbolReferences: readonly SymbolReferenceCandidate[]
}

export interface ResolvedSymbolReference {
  sourceFileId: string
  sourceElementId: string | null
  targetElementId: string
  kind: SymbolReferenceKind
  location: CodeMapElementLocation
}

export interface PersistedSymbolReference extends ResolvedSymbolReference {
  id: string
  repositoryId: string
}

export function createSymbolReferenceId(
  repositoryId: string,
  reference: ResolvedSymbolReference
): string {
  const { start, end } = reference.location
  return createHash('sha256').update([
    repositoryId,
    reference.sourceFileId,
    start.byte,
    end.byte,
    reference.targetElementId,
    reference.kind
  ].join(':')).digest('hex').substring(0, 16)
}

const COMPATIBLE_KINDS: Record<SymbolReferenceKind, ReadonlySet<CodeMapElement['kind']>> = {
  instantiation: new Set(['class']),
  call: new Set(['function']),
  type: new Set(['class', 'interface', 'typeAlias', 'enum']),
  reference: new Set(['class', 'function', 'enum', 'variable', 'constant'])
}

const SHADOW_KINDS = new Set<CodeMapElement['kind']>([
  'parameter',
  'variable',
  'constant',
  'function',
  'class',
  'interface',
  'typeAlias',
  'enum'
])

function exactlyOne(elements: CodeMapElement[]): CodeMapElement | null {
  return elements.length === 1 ? elements[0] : null
}

function isCompatible(candidate: SymbolReferenceCandidate, element: CodeMapElement): boolean {
  return COMPATIBLE_KINDS[candidate.kind].has(element.kind)
}

function parentOf(file: SymbolReferenceFile, element: CodeMapElement): CodeMapElement | null {
  if (!element.parentElementId) return null
  return file.elements.find((candidate) => candidate.id === element.parentElementId) ?? null
}

function isTopLevelDeclaration(file: SymbolReferenceFile, element: CodeMapElement): boolean {
  if (element.parentElementId === null) return true
  const parent = parentOf(file, element)
  return parent?.kind === 'export' && parent.parentElementId === null
}

function isDirectExport(file: SymbolReferenceFile, element: CodeMapElement): boolean {
  const parent = parentOf(file, element)
  return parent?.kind === 'export' && parent.parentElementId === null && parent.name === element.name
}

function signatureParameters(element: CodeMapElement): string[] {
  const signature = element.declarationSignature
  if (!signature) return []
  const open = signature.indexOf('(')
  const close = signature.indexOf(')', open + 1)
  if (open < 0 || close < 0) return []
  return signature.slice(open + 1, close).split(',').map((name) => name.trim()).filter(Boolean)
}

function isDescendantOf(
  file: SymbolReferenceFile,
  element: CodeMapElement,
  ancestorId: string
): boolean {
  let current: CodeMapElement | null = element
  const visited = new Set<string>()
  while (current?.parentElementId && !visited.has(current.id)) {
    if (current.parentElementId === ancestorId) return true
    visited.add(current.id)
    current = parentOf(file, current)
  }
  return false
}

function containsCandidate(element: CodeMapElement, candidate: SymbolReferenceCandidate): boolean {
  return element.location.start.byte <= candidate.location.start.byte &&
    element.location.end.byte >= candidate.location.end.byte
}

function hasReceiverShadow(
  file: SymbolReferenceFile,
  receiverName: string,
  sourceElementId: string | null
): boolean {
  const source = sourceElementId
    ? file.elements.find((element) => element.id === sourceElementId) ?? null
    : null

  if (source && signatureParameters(source).includes(receiverName)) return true

  return file.elements.some((element) => {
    if (element.name !== receiverName || !SHADOW_KINDS.has(element.kind)) return false
    if (source) {
      return element.id === source.id ||
        isDescendantOf(file, element, source.id) ||
        isTopLevelDeclaration(file, element)
    }
    return isTopLevelDeclaration(file, element)
  })
}

function hasPlausibleShadow(
  file: SymbolReferenceFile,
  candidate: SymbolReferenceCandidate,
  ignoredElementId: string | null = null
): boolean {
  const source = candidate.sourceElementId
    ? file.elements.find((element) => element.id === candidate.sourceElementId) ?? null
    : null

  if (source && signatureParameters(source).includes(candidate.name)) return true
  if ((source?.kind === 'variable' || source?.kind === 'constant') && candidate.kind !== 'type') return true
  if (source && candidate.kind !== 'type' && file.elements.some((element) =>
    (element.kind === 'variable' || element.kind === 'constant') &&
    isDescendantOf(file, element, source.id) &&
    containsCandidate(element, candidate)
  )) return true

  return file.elements.some((element) => {
    if (element.id === ignoredElementId) return false
    if (element.name !== candidate.name || !SHADOW_KINDS.has(element.kind)) return false
    if (source) {
      return element.id === source.id ||
        isDescendantOf(file, element, source.id) ||
        isTopLevelDeclaration(file, element)
    }
    return isTopLevelDeclaration(file, element)
  })
}

function localTarget(file: SymbolReferenceFile, candidate: SymbolReferenceCandidate): CodeMapElement | null {
  const target = exactlyOne(file.elements.filter((element) =>
    element.name === candidate.name &&
    isTopLevelDeclaration(file, element) &&
    isCompatible(candidate, element)
  ))
  if (!target || hasPlausibleShadow(file, candidate, target.id)) return null
  return target
}

function importedTarget(
  file: SymbolReferenceFile,
  targetFile: SymbolReferenceFile,
  binding: ImportBinding,
  candidate: SymbolReferenceCandidate
): CodeMapElement | null {
  if (hasPlausibleShadow(file, candidate)) return null
  return exactlyOne(targetFile.elements.filter((element) =>
    element.name === binding.importedName &&
    isDirectExport(targetFile, element) &&
    isCompatible(candidate, element)
  ))
}

function owningClass(file: SymbolReferenceFile, sourceElementId: string | null): CodeMapElement | null {
  if (!sourceElementId) return null
  let current = file.elements.find((element) => element.id === sourceElementId) ?? null
  const visited = new Set<string>()
  while (current && !visited.has(current.id)) {
    if (current.kind === 'class') return current
    visited.add(current.id)
    current = parentOf(file, current)
  }
  return null
}

function instanceOwnerByName(
  file: SymbolReferenceFile,
  filesByPath: ReadonlyMap<string, SymbolReferenceFile>,
  importResolver: ImportResolver,
  name: string
): { file: SymbolReferenceFile; element: CodeMapElement } | null {
  const bindings = file.importBindings.filter((binding) => binding.localName === name)
  if (bindings.length > 1) return null
  if (bindings.length === 1) {
    const binding = bindings[0]
    const resolution = importResolver.resolve(binding.sourceModule, file.relativePath)
    if (resolution.status !== 'internal') return null
    const targetFile = filesByPath.get(resolution.targetRelativePath)
    if (!targetFile) return null
    const target = exactlyOne(targetFile.elements.filter((element) =>
      (element.kind === 'class' || element.kind === 'interface') &&
      element.name === binding.importedName &&
      isDirectExport(targetFile, element)
    ))
    return target ? { file: targetFile, element: target } : null
  }
  const target = exactlyOne(file.elements.filter((element) =>
    (element.kind === 'class' || element.kind === 'interface') &&
    element.name === name &&
    isTopLevelDeclaration(file, element)
  ))
  return target ? { file, element: target } : null
}

function instanceMethodTarget(
  ownerFile: SymbolReferenceFile,
  owner: CodeMapElement,
  methodName: string,
  filesByPath: ReadonlyMap<string, SymbolReferenceFile>,
  importResolver: ImportResolver
): CodeMapElement | null {
  if (owner.kind === 'interface') {
    return exactlyOne(ownerFile.elements.filter((element) =>
      element.parentElementId === owner.id && element.kind === 'method' && element.name === methodName
    ))
  }
  let current = { file: ownerFile, element: owner }
  const visited = new Set<string>()
  let inherited = false

  while (!visited.has(current.element.id)) {
    visited.add(current.element.id)
    const named = current.file.elements.filter((element) =>
      element.parentElementId === current.element.id && element.kind === 'method' && element.name === methodName
    )
    if (named.length > 0) {
      if (named.length !== 1) return null
      const method = named[0]
      if (method.modifiers.includes('static')) return null
      if (inherited && method.visibility === 'private') return null
      return method
    }
    if (!current.element.baseClass) return null
    const base = instanceOwnerByName(current.file, filesByPath, importResolver, current.element.baseClass)
    if (!base || base.element.kind !== 'class') return null
    current = base
    inherited = true
  }
  return null
}

function staticMethodTarget(
  ownerFile: SymbolReferenceFile,
  owner: CodeMapElement,
  methodName: string,
  filesByPath: ReadonlyMap<string, SymbolReferenceFile>,
  importResolver: ImportResolver
): CodeMapElement | null {
  if (owner.kind !== 'class') return null
  let current = { file: ownerFile, element: owner }
  const visited = new Set<string>()
  let inherited = false

  while (!visited.has(current.element.id)) {
    visited.add(current.element.id)
    const named = current.file.elements.filter((element) =>
      element.parentElementId === current.element.id && element.kind === 'method' && element.name === methodName
    )
    if (named.length > 0) {
      if (named.length !== 1) return null
      const method = named[0]
      if (!method.modifiers.includes('static')) return null
      if (inherited && method.visibility === 'private') return null
      return method
    }
    if (!current.element.baseClass) return null
    const base = instanceOwnerByName(current.file, filesByPath, importResolver, current.element.baseClass)
    if (!base || base.element.kind !== 'class') return null
    current = base
    inherited = true
  }
  return null
}

function functionByName(
  file: SymbolReferenceFile,
  filesByPath: ReadonlyMap<string, SymbolReferenceFile>,
  importResolver: ImportResolver,
  name: string
): { file: SymbolReferenceFile; element: CodeMapElement } | null {
  const bindings = file.importBindings.filter((binding) => binding.localName === name)
  if (bindings.length > 1) return null
  if (bindings.length === 1) {
    const binding = bindings[0]
    const resolution = importResolver.resolve(binding.sourceModule, file.relativePath)
    if (resolution.status !== 'internal') return null
    const targetFile = filesByPath.get(resolution.targetRelativePath)
    if (!targetFile) return null
    const target = exactlyOne(targetFile.elements.filter((element) =>
      element.kind === 'function' &&
      element.name === binding.importedName &&
      isDirectExport(targetFile, element)
    ))
    return target ? { file: targetFile, element: target } : null
  }
  const target = exactlyOne(file.elements.filter((element) =>
    element.kind === 'function' &&
    element.name === name &&
    isTopLevelDeclaration(file, element)
  ))
  return target ? { file, element: target } : null
}

interface InstancePropertyBinding {
  element: CodeMapElement
  origin: 'class-property' | 'constructor-parameter-property'
}

function instancePropertyBindings(
  file: SymbolReferenceFile,
  owner: CodeMapElement,
  name: string
): InstancePropertyBinding[] {
  const regular = file.elements
    .filter((element) => element.parentElementId === owner.id && element.kind === 'property' && element.name === name)
    .map((element) => ({ element, origin: 'class-property' as const }))
  const constructors = file.elements.filter((element) =>
    element.parentElementId === owner.id && element.kind === 'method' && element.name === 'constructor'
  )
  const parameterProperties = file.elements
    .filter((element) =>
      element.kind === 'parameter' &&
      element.name === name &&
      constructors.some((constructor) => constructor.id === element.parentElementId) &&
      element.modifiers.some((modifier) => ['private', 'protected', 'public', 'readonly'].includes(modifier))
    )
    .map((element) => ({ element, origin: 'constructor-parameter-property' as const }))
  return [...regular, ...parameterProperties]
}

function memberTarget(
  sourceFile: SymbolReferenceFile,
  candidate: SymbolReferenceCandidate,
  filesByPath: ReadonlyMap<string, SymbolReferenceFile>,
  importResolver: ImportResolver
): CodeMapElement | null {
  if (candidate.receiver === 'this-property') {
    const owner = owningClass(sourceFile, candidate.sourceElementId)
    if (!owner || !candidate.receiverPropertyName || !candidate.receiverTypeName) return null
    const source = candidate.sourceElementId
      ? sourceFile.elements.find((element) => element.id === candidate.sourceElementId)
      : null
    if (source?.modifiers.includes('static')) return null
    const properties = instancePropertyBindings(sourceFile, owner, candidate.receiverPropertyName)
    if (properties.length !== 1) return null
    if (candidate.receiverPropertyOrigin && properties[0].origin !== candidate.receiverPropertyOrigin) return null
    if (properties[0].element.modifiers.includes('static')) return null
    if (properties[0].element.declarationSignature !== `${candidate.receiverPropertyName}: ${candidate.receiverTypeName}`) return null
    const propertyType = instanceOwnerByName(sourceFile, filesByPath, importResolver, candidate.receiverTypeName)
    if (propertyType?.element.kind === 'interface' && (candidate.optional || !candidate.receiverPropertyOrigin)) return null
    return propertyType
      ? instanceMethodTarget(propertyType.file, propertyType.element, candidate.name, filesByPath, importResolver)
      : null
  }
  if (candidate.receiver === 'this') {
    const owner = owningClass(sourceFile, candidate.sourceElementId)
    return owner
      ? instanceMethodTarget(sourceFile, owner, candidate.name, filesByPath, importResolver)
      : null
  }
  if (candidate.receiver === 'identifier' && candidate.receiverTypeName) {
    const owner = instanceOwnerByName(sourceFile, filesByPath, importResolver, candidate.receiverTypeName)
    if (owner?.element.kind === 'interface' && (candidate.optional || candidate.receiverBindingKind !== 'parameter')) return null
    return owner
      ? instanceMethodTarget(owner.file, owner.element, candidate.name, filesByPath, importResolver)
      : null
  }
  if (candidate.receiver === 'identifier' && candidate.receiverName) {
    if (hasReceiverShadow(sourceFile, candidate.receiverName, candidate.sourceElementId)) return null
    const bindings = sourceFile.importBindings.filter((binding) => binding.localName === candidate.receiverName)
    if (bindings.length !== 1) return null
    const binding = bindings[0]
    const resolution = importResolver.resolve(binding.sourceModule, sourceFile.relativePath)
    if (resolution.status !== 'internal') return null
    const exporterFile = filesByPath.get(resolution.targetRelativePath)
    if (!exporterFile) return null
    const instanceBindings = (exporterFile.exportedConstNewBindings ?? []).filter((instanceBinding) =>
      instanceBinding.exportedName === binding.importedName
    )
    if (instanceBindings.length === 1) {
      const instanceBinding = instanceBindings[0]
      const declaration = exporterFile.elements.find((element) =>
        element.id === instanceBinding.declarationElementId &&
        element.kind === 'constant' &&
        element.name === binding.importedName &&
        isDirectExport(exporterFile, element)
      )
      if (declaration) {
        const owner = instanceOwnerByName(
          exporterFile,
          filesByPath,
          importResolver,
          instanceBinding.constructorName
        )
        if (owner?.element.kind === 'class') {
          return instanceMethodTarget(owner.file, owner.element, candidate.name, filesByPath, importResolver)
        }
      }
    }

    const callBindings = (exporterFile.exportedConstCallBindings ?? []).filter((callBinding) =>
      callBinding.exportedName === binding.importedName
    )
    if (callBindings.length === 1) {
      const callBinding = callBindings[0]
      const declaration = exporterFile.elements.find((element) =>
        element.id === callBinding.declarationElementId &&
        element.kind === 'constant' &&
        element.name === binding.importedName &&
        isDirectExport(exporterFile, element)
      )
      if (declaration) {
        let returnType: string | null = null
        let calleeFile = exporterFile
        if (callBinding.calleeKind === 'member' && callBinding.calleeReceiverName) {
          const calleeOwner = instanceOwnerByName(
            exporterFile,
            filesByPath,
            importResolver,
            callBinding.calleeReceiverName
          )
          if (calleeOwner?.element.kind === 'class') {
            calleeFile = calleeOwner.file
            const calleeMethod = staticMethodTarget(
              calleeOwner.file,
              calleeOwner.element,
              callBinding.calleeName,
              filesByPath,
              importResolver
            )
            returnType = calleeMethod?.returnType ?? null
          }
        } else if (callBinding.calleeKind === 'identifier') {
          const calleeFn = functionByName(
            exporterFile,
            filesByPath,
            importResolver,
            callBinding.calleeName
          )
          if (calleeFn) {
            calleeFile = calleeFn.file
            returnType = calleeFn.element.returnType ?? null
          }
        }
        if (returnType && /^[A-Za-z_$][\w$]*$/.test(returnType)) {
          const owner = instanceOwnerByName(
            calleeFile,
            filesByPath,
            importResolver,
            returnType
          ) ?? instanceOwnerByName(
            exporterFile,
            filesByPath,
            importResolver,
            returnType
          )
          if (owner?.element.kind === 'class') {
            return instanceMethodTarget(owner.file, owner.element, candidate.name, filesByPath, importResolver)
          }
        }
      }
    }

    const targetClass = exactlyOne(exporterFile.elements.filter((element) =>
      element.kind === 'class' &&
      element.name === binding.importedName &&
      isDirectExport(exporterFile, element)
    ))
    if (targetClass) {
      return staticMethodTarget(exporterFile, targetClass, candidate.name, filesByPath, importResolver)
    }
    return null
  }
  return null
}

export function resolveSymbolReferences(
  repoPath: string,
  files: readonly SymbolReferenceFile[],
  affectedSourceFileIds?: ReadonlySet<string>
): ResolvedSymbolReference[] {
  const orderedFiles = [...files].sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  )
  const importResolver = new ImportResolver(repoPath)
  importResolver.setFiles(orderedFiles.map((file) => file.relativePath))
  const filesByPath = new Map(orderedFiles.map((file) => [file.relativePath, file]))
  const resolved: ResolvedSymbolReference[] = []

  for (const file of orderedFiles) {
    if (affectedSourceFileIds && !affectedSourceFileIds.has(file.fileId)) continue
    const candidates = [...file.symbolReferences].sort((left, right) =>
      left.location.start.byte - right.location.start.byte ||
      left.location.end.byte - right.location.end.byte
    )
    for (const candidate of candidates) {
      if (candidate.receiver) {
        const target = memberTarget(file, candidate, filesByPath, importResolver)
        if (target) {
          resolved.push({
            sourceFileId: file.fileId,
            sourceElementId: candidate.sourceElementId,
            targetElementId: target.id,
            kind: candidate.kind,
            location: candidate.location
          })
        }
        continue
      }
      const bindings = file.importBindings.filter((binding) => binding.localName === candidate.name)
      let target: CodeMapElement | null = null

      if (bindings.length === 1) {
        const binding = bindings[0]
        const resolution = importResolver.resolve(binding.sourceModule, file.relativePath)
        if (resolution.status === 'internal') {
          const targetFile = filesByPath.get(resolution.targetRelativePath)
          if (targetFile) target = importedTarget(file, targetFile, binding, candidate)
        }
      } else if (bindings.length === 0) {
        target = localTarget(file, candidate)
      }

      if (!target) continue
      resolved.push({
        sourceFileId: file.fileId,
        sourceElementId: candidate.sourceElementId,
        targetElementId: target.id,
        kind: candidate.kind,
        location: candidate.location
      })
    }
  }

  return resolved
}
