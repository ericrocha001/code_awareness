import { describe, expect, it, vi } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import type { CodeMapElement } from '../../../shared/types'
import { readStructure } from '../structure-reader'
import { resolveSymbolReferences, type SymbolReferenceFile } from '../symbol-reference-resolver'
import type { SymbolReferenceCandidate } from '../extraction/structure-extraction-port'
import { ImportResolver } from '../import-resolver'
import { getLanguageForExtension, getParser } from '../language-adapter'
import { createRepositoryModel } from '../repository-model'
import { createFullTargetId } from './code-target'
import { ContextEngine } from './context-engine'
import { measureScenario } from './context-efficiency-harness'
import { serializeReadCode, serializeReferences, serializeSymbolDependencies } from './context-navigation-serializer'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

interface CandidateOccurrence {
  file: SymbolReferenceFile
  candidate: SymbolReferenceCandidate
}

type ConstInitializerKind = 'identifier-call' | 'member-call' | 'other-call' | 'not-call'

interface StructuralBinding {
  name: string
  kind: 'const' | 'other'
  origin: 'parameter' | 'const' | 'let' | 'var' | 'for-of-const' | 'for-of-let' | 'for-of-var' | 'for-in-const' | 'for-in-let' | 'for-in-var' | 'import-default' | 'import-named' | 'import-namespace' | 'function' | 'class' | 'catch'
  initializer: ConstInitializerKind
  initializerCategory: string
  initializerIdentifier: string | null
  initializerCallName: string | null
  initializerMemberName: string | null
  initializerMemberReceiverKind: string | null
  initializerCallStart: number | null
  declarationStart: number
  availableAfter: number
  pattern: 'identifier' | 'object' | 'array' | 'other'
  annotation: 'none' | 'simple' | 'unsupported'
  annotationSyntax: string
  callbackCallMemberByte: number | null
  iteration: 'for-of' | 'for-in' | null
  importSource: string | null
  writes: number[]
  knownType: boolean
}

interface StructuralBindingScope {
  bindings: StructuralBinding[]
}

interface UntypedReceiverMetrics {
  identifierReceiversWithoutKnownType: number
  boundToConst: number
  constInitializerIsCall: number
  identifierCallInitializer: number
  memberCallInitializer: number
  otherCallInitializer: number
}

interface UntypedReceiverObservation {
  occurrence: CandidateOccurrence
  binding: StructuralBinding | null
  unresolvedBindingReason: 'unbound' | 'ambiguous' | 'before-declaration' | null
  reassignedBeforeCall: boolean
  aliasToKnownBinding: boolean
}

function functionScope(node: any): boolean {
  return [
    'function_declaration',
    'function_expression',
    'generator_function_declaration',
    'generator_function',
    'arrow_function',
    'method_definition'
  ].includes(node.type)
}

function lexicalScope(node: any): boolean {
  return functionScope(node) || [
    'program',
    'statement_block',
    'catch_clause',
    'for_statement',
    'for_in_statement',
    'switch_case',
    'switch_default'
  ].includes(node.type)
}

function bindingNames(node: any): string[] {
  if (!node) return []
  if (['identifier', 'shorthand_property_identifier_pattern', 'shorthand_property_identifier'].includes(node.type)) {
    return [node.text]
  }
  const names: string[] = []
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index)
    if (child) names.push(...bindingNames(child))
  }
  return names
}

function callInitializerKind(declarator: any): ConstInitializerKind {
  const value = declarator.childForFieldName?.('value')
  if (value?.type !== 'call_expression') return 'not-call'
  const callee = value.childForFieldName?.('function')
  if (callee?.type === 'identifier') return 'identifier-call'
  if (callee?.type === 'member_expression') return 'member-call'
  return 'other-call'
}

function initializerCategory(declarator: any): string {
  const value = declarator.childForFieldName?.('value')
  if (!value) return 'missing'
  if (value.type === 'call_expression') return callInitializerKind(declarator)
  if (value.type === 'identifier') return 'identifier'
  if (value.type === 'member_expression') return 'member-expression'
  if (['string', 'template_string', 'number', 'true', 'false', 'null', 'regex'].includes(value.type)) return 'literal'
  if (value.type === 'object') return 'object'
  if (value.type === 'array') return 'array'
  if (value.type === 'ternary_expression') return 'conditional'
  if (value.type === 'await_expression') return 'await'
  if (value.type === 'binary_expression') return 'binary'
  if (value.type === 'unary_expression') return 'unary'
  if (value.type === 'new_expression') return 'new'
  if (['arrow_function', 'function_expression'].includes(value.type)) return 'function'
  if (value.type === 'parenthesized_expression') return 'parenthesized'
  return value.type
}

function patternKind(node: any): StructuralBinding['pattern'] {
  if (node?.type === 'identifier') return 'identifier'
  if (node?.type === 'object_pattern') return 'object'
  if (node?.type === 'array_pattern') return 'array'
  return 'other'
}

function annotationKind(node: any): StructuralBinding['annotation'] {
  const annotation = Array.from({ length: node?.childCount ?? 0 }, (_, index) => node.child(index))
    .find((child: any) => child?.type === 'type_annotation') as any
  if (!annotation) return 'none'
  const types = Array.from({ length: annotation.childCount }, (_, index) => annotation.child(index))
    .filter((child: any) => child?.isNamed) as any[]
  return types.length === 1 && types[0].type === 'type_identifier' ? 'simple' : 'unsupported'
}

function annotationSyntax(node: any): string {
  const annotation = Array.from({ length: node?.childCount ?? 0 }, (_, index) => node.child(index))
    .find((child: any) => child?.type === 'type_annotation') as any
  if (!annotation) return 'none'
  const types = Array.from({ length: annotation.childCount }, (_, index) => annotation.child(index))
    .filter((child: any) => child?.isNamed) as any[]
  return types.length === 1 ? types[0].type : 'compound'
}

function callbackCallMemberByte(node: any): number | null {
  const argumentsNode = node.parent?.type === 'arguments' ? node.parent : null
  const call = argumentsNode?.parent?.type === 'call_expression' ? argumentsNode.parent : null
  const callee = call?.childForFieldName?.('function')
  const member = callee?.type === 'member_expression' ? callee.childForFieldName?.('property') : null
  return member?.type === 'property_identifier' ? member.startIndex : null
}

function iterationKind(declaration: any): StructuralBinding['iteration'] {
  const parent = declaration.parent
  if (parent?.type !== 'for_in_statement') return null
  for (let index = 0; index < parent.childCount; index++) {
    const child = parent.child(index)
    if (child?.type === 'of') return 'for-of'
    if (child?.type === 'in') return 'for-in'
  }
  return null
}

function importSource(node: any): string | null {
  const visit = (current: any): string | null => {
    if (current?.type === 'string_fragment') return current.text
    for (let index = 0; index < (current?.childCount ?? 0); index++) {
      const found = visit(current.child(index))
      if (found) return found
    }
    return null
  }
  return visit(node)
}

function bindingBase(
  name: string,
  origin: StructuralBinding['origin'],
  declarationStart: number,
  availableAfter: number
): StructuralBinding {
  return {
    name,
    kind: origin === 'const' ? 'const' : 'other',
    origin,
    initializer: 'not-call',
    initializerCategory: 'missing',
    initializerIdentifier: null,
    initializerCallName: null,
    initializerMemberName: null,
    initializerMemberReceiverKind: null,
    initializerCallStart: null,
    declarationStart,
    availableAfter,
    pattern: 'identifier',
    annotation: 'none',
    annotationSyntax: 'none',
    callbackCallMemberByte: null,
    iteration: null,
    importSource: null,
    writes: [],
    knownType: false
  }
}

function addDirectBindings(node: any, bindings: StructuralBinding[]): void {
  if (node.type === 'import_statement') {
    const source = importSource(node)
    const visitImport = (current: any): void => {
      if (current.type === 'namespace_import') {
        const name = Array.from({ length: current.childCount }, (_, index) => current.child(index))
          .find((child: any) => child?.type === 'identifier') as any
        if (name) {
          bindings.push({ ...bindingBase(name.text, 'import-namespace', node.startIndex, node.startIndex), importSource: source })
        }
        return
      }
      if (current.type === 'import_specifier') {
        const alias = current.childForFieldName?.('alias')
        const name = current.childForFieldName?.('name')
        const local = alias?.type === 'identifier' ? alias : name
        if (local?.type === 'identifier') {
          bindings.push({ ...bindingBase(local.text, 'import-named', node.startIndex, node.startIndex), importSource: source })
        }
        return
      }
      if (current.type === 'import_clause') {
        for (let index = 0; index < current.childCount; index++) {
          const child = current.child(index)
          if (child?.type === 'identifier') {
            bindings.push({ ...bindingBase(child.text, 'import-default', node.startIndex, node.startIndex), importSource: source })
          } else if (child) {
            visitImport(child)
          }
        }
        return
      }
      for (let index = 0; index < current.childCount; index++) {
        const child = current.child(index)
        if (child) visitImport(child)
      }
    }
    visitImport(node)
    return
  }
  const declaration = node.type === 'export_statement'
    ? Array.from({ length: node.childCount }, (_, index) => node.child(index)).find((child: any) =>
      child && ['lexical_declaration', 'variable_declaration', 'function_declaration', 'class_declaration'].includes(child.type)
    )
    : node
  if (!declaration) return
  if (declaration.type === 'lexical_declaration' || declaration.type === 'variable_declaration') {
    const isConst = declaration.child(0)?.type === 'const'
    const origin: StructuralBinding['origin'] = isConst
      ? 'const'
      : declaration.child(0)?.type === 'let' ? 'let' : 'var'
    for (let index = 0; index < declaration.childCount; index++) {
      const declarator = declaration.child(index)
      if (declarator?.type !== 'variable_declarator') continue
      const initializer = isConst ? callInitializerKind(declarator) : 'not-call'
      const nameNode = declarator.childForFieldName?.('name')
      const value = declarator.childForFieldName?.('value')
      const category = initializerCategory(declarator)
      const callee = value?.type === 'call_expression' ? value.childForFieldName?.('function') : null
      const member = callee?.type === 'member_expression' ? callee.childForFieldName?.('property') : null
      const memberReceiver = callee?.type === 'member_expression' ? callee.childForFieldName?.('object') : null
      const constructor = value?.type === 'new_expression' ? value.childForFieldName?.('constructor') : null
      for (const name of bindingNames(nameNode)) {
        bindings.push({
          ...bindingBase(name, origin, declaration.startIndex, declaration.endIndex),
          initializer,
          initializerCategory: category,
          initializerIdentifier: value?.type === 'identifier' ? value.text : null,
          initializerCallName: callee?.type === 'identifier' ? callee.text : null,
          initializerMemberName: member?.type === 'property_identifier' ? member.text : null,
          initializerMemberReceiverKind: memberReceiver?.type ?? null,
          initializerCallStart: callee?.type === 'identifier'
            ? callee.startIndex
            : member?.type === 'property_identifier' ? member.startIndex : null,
          pattern: patternKind(nameNode),
          iteration: iterationKind(declaration),
          knownType: constructor?.type === 'identifier'
        })
      }
    }
    return
  }
  if (declaration.type === 'function_declaration' || declaration.type === 'class_declaration') {
    const name = declaration.childForFieldName?.('name')
    if (name?.type === 'identifier' || name?.type === 'type_identifier') {
      bindings.push(bindingBase(
        name.text,
        declaration.type === 'function_declaration' ? 'function' : 'class',
        declaration.startIndex,
        declaration.startIndex
      ))
    }
  }
}

function functionVarBindings(node: any): StructuralBinding[] {
  const bindings: StructuralBinding[] = []
  const visit = (current: any, root = false): void => {
    if (!root && functionScope(current)) return
    if (current.type === 'variable_declaration') {
      for (let index = 0; index < current.childCount; index++) {
        const declarator = current.child(index)
        if (declarator?.type !== 'variable_declarator') continue
        for (const name of bindingNames(declarator.childForFieldName?.('name'))) {
          bindings.push(bindingBase(name, 'var', current.startIndex, current.endIndex))
        }
      }
      return
    }
    for (let index = 0; index < current.childCount; index++) {
      const child = current.child(index)
      if (child) visit(child)
    }
  }
  visit(node, true)
  return bindings
}

function structuralScope(node: any): StructuralBindingScope {
  const bindings: StructuralBinding[] = []
  if (functionScope(node)) {
    for (let index = 0; index < node.childCount; index++) {
      const parameters = node.child(index)
      if (!parameters || !['formal_parameters', 'parameters'].includes(parameters.type)) continue
      for (let parameterIndex = 0; parameterIndex < parameters.childCount; parameterIndex++) {
        const parameter = parameters.child(parameterIndex)
        if (!parameter || !['required_parameter', 'optional_parameter', 'rest_pattern', 'rest_parameter', 'identifier'].includes(parameter.type)) continue
        for (const name of bindingNames(parameter.type === 'identifier'
          ? parameter
          : parameter.childForFieldName?.('pattern') ?? parameter)) {
          const annotation = annotationKind(parameter)
          bindings.push({
            ...bindingBase(name, 'parameter', parameter.startIndex, node.startIndex),
            annotation,
            annotationSyntax: annotationSyntax(parameter),
            callbackCallMemberByte: callbackCallMemberByte(node),
            knownType: annotation === 'simple',
            pattern: patternKind(parameter.childForFieldName?.('pattern') ?? parameter)
          })
        }
      }
    }
    if (node.type === 'arrow_function') {
      const parameter = node.childForFieldName?.('parameter')
      if (parameter?.type === 'identifier') {
        bindings.push({
          ...bindingBase(parameter.text, 'parameter', parameter.startIndex, node.startIndex),
          callbackCallMemberByte: callbackCallMemberByte(node)
        })
      }
    }
    bindings.push(...functionVarBindings(node))
  }
  if (node.type === 'catch_clause') {
    for (const name of bindingNames(node.childForFieldName?.('parameter'))) {
      bindings.push(bindingBase(name, 'catch', node.startIndex, node.startIndex))
    }
  }
  if (node.type === 'for_in_statement') {
    const left = node.childForFieldName?.('left')
    const declarationKind = Array.from({ length: node.childCount }, (_, index) => node.child(index))
      .find((child: any) => ['const', 'let', 'var'].includes(child?.type)) as any
    if (left && declarationKind) {
      const iteration = Array.from({ length: node.childCount }, (_, index) => node.child(index))
        .some((child: any) => child?.type === 'of') ? 'for-of' : 'for-in'
      const origin = `${iteration}-${declarationKind.type}` as StructuralBinding['origin']
      for (const name of bindingNames(left)) {
        bindings.push({
          ...bindingBase(name, origin, node.startIndex, left.endIndex),
          pattern: patternKind(left),
          iteration
        })
      }
    }
  }
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index)
    if (child) addDirectBindings(child, bindings)
  }
  return { bindings }
}

function structuralBinding(
  scopes: readonly StructuralBindingScope[],
  name: string,
  occurrenceStart: number
): StructuralBinding | null {
  return structuralBindingResolution(scopes, name, occurrenceStart).binding
}

function structuralBindingResolution(
  scopes: readonly StructuralBindingScope[],
  name: string,
  occurrenceStart: number
): { binding: StructuralBinding | null; reason: UntypedReceiverObservation['unresolvedBindingReason'] } {
  for (let index = scopes.length - 1; index >= 0; index--) {
    const matches = scopes[index].bindings.filter((binding) => binding.name === name)
    if (matches.length === 0) continue
    if (matches.length !== 1) return { binding: null, reason: 'ambiguous' }
    if (matches[0].availableAfter > occurrenceStart) return { binding: null, reason: 'before-declaration' }
    return { binding: matches[0], reason: null }
  }
  return { binding: null, reason: 'unbound' }
}

function measureUntypedReceivers(
  content: string,
  extension: string,
  occurrences: readonly CandidateOccurrence[],
  sourceName = extension,
  observations: UntypedReceiverObservation[] = []
): UntypedReceiverMetrics {
  const targets = new Map(occurrences.map((occurrence) => [
    `${occurrence.candidate.location.start.byte}:${occurrence.candidate.receiverName}`,
    occurrence
  ]))
  const language = getLanguageForExtension(extension)
  const parser = language ? getParser(language) : null
  if (!parser) throw new Error(`Parser unavailable for ${extension}`)
  let tree: ReturnType<typeof parser.parse>
  try {
    const bufferSize = Math.max(32 * 1024, Buffer.byteLength(content, 'utf8') + 1)
    tree = parser.parse(content, undefined, { bufferSize })
  } catch (error) {
    throw new Error(`Unable to parse ${sourceName} for structural receiver metrics`, { cause: error })
  }
  const matched = new Set<string>()
  const metrics: UntypedReceiverMetrics = {
    identifierReceiversWithoutKnownType: occurrences.length,
    boundToConst: 0,
    constInitializerIsCall: 0,
    identifierCallInitializer: 0,
    memberCallInitializer: 0,
    otherCallInitializer: 0
  }
  const byteStart = (node: any): number => Buffer.byteLength(content.slice(0, node.startIndex), 'utf8')
  const visit = (node: any, scopes: readonly StructuralBindingScope[]): void => {
    const activeScopes = lexicalScope(node) ? [...scopes, structuralScope(node)] : scopes
    if (node.type === 'assignment_expression') {
      const left = node.childForFieldName?.('left')
      if (left?.type === 'identifier') {
        structuralBinding(activeScopes, left.text, left.startIndex)?.writes.push(left.startIndex)
      }
    } else if (node.type === 'update_expression') {
      const argument = node.childForFieldName?.('argument') ?? Array.from({ length: node.childCount }, (_, index) => node.child(index))
        .find((child: any) => child?.type === 'identifier')
      if (argument?.type === 'identifier') {
        structuralBinding(activeScopes, argument.text, argument.startIndex)?.writes.push(argument.startIndex)
      }
    }
    if (node.type === 'call_expression') {
      const callee = node.childForFieldName?.('function')
      if (callee?.type === 'member_expression') {
        const receiver = callee.childForFieldName?.('object')
        const member = callee.childForFieldName?.('property')
        if (receiver?.type === 'identifier' && member?.type === 'property_identifier') {
          const key = `${byteStart(member)}:${receiver.text}`
          const occurrence = targets.get(key)
          if (occurrence) {
            matched.add(key)
            const resolution = structuralBindingResolution(activeScopes, receiver.text, receiver.startIndex)
            const binding = resolution.binding
            const alias = binding?.initializerIdentifier
              ? structuralBinding(activeScopes, binding.initializerIdentifier, binding.declarationStart)
              : null
            observations.push({
              occurrence,
              binding,
              unresolvedBindingReason: resolution.reason,
              reassignedBeforeCall: Boolean(binding?.writes.some((write) => write < receiver.startIndex)),
              aliasToKnownBinding: Boolean(alias?.knownType)
            })
            if (binding?.kind === 'const') {
              metrics.boundToConst++
              if (binding.initializer !== 'not-call') metrics.constInitializerIsCall++
              if (binding.initializer === 'identifier-call') metrics.identifierCallInitializer++
              if (binding.initializer === 'member-call') metrics.memberCallInitializer++
              if (binding.initializer === 'other-call') metrics.otherCallInitializer++
            }
          }
        }
      }
    }
    for (let index = 0; index < node.childCount; index++) {
      const child = node.child(index)
      if (child) visit(child, activeScopes)
    }
  }
  visit(tree.rootNode, [])
  if (matched.size !== targets.size) {
    throw new Error(`Structural receiver measurement matched ${matched.size}/${targets.size} occurrences`)
  }
  return metrics
}

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(join(root, 'src'), { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => SOURCE_EXTENSIONS.has(extname(path)))
    .filter((path) => !/\.(?:test|spec|benchmark)\.[cm]?[jt]sx?$/.test(path))
    .sort()
}

function directExport(file: SymbolReferenceFile, element: CodeMapElement): boolean {
  const parent = file.elements.find((candidate) => candidate.id === element.parentElementId)
  return parent?.kind === 'export' && parent.parentElementId === null && parent.name === element.name
}

function constructedClass(
  occurrence: CandidateOccurrence,
  filesByPath: ReadonlyMap<string, SymbolReferenceFile>,
  importResolver: ImportResolver
): CodeMapElement | null {
  const typeName = occurrence.candidate.receiverTypeName
  if (!typeName) return null
  const bindings = occurrence.file.importBindings.filter((binding) => binding.localName === typeName)
  if (bindings.length === 0) {
    const local = occurrence.file.elements.filter((element) =>
      element.kind === 'class' && element.name === typeName && element.parentElementId === null
    )
    return local.length === 1 ? local[0] : null
  }
  if (bindings.length !== 1) return null
  const resolution = importResolver.resolve(bindings[0].sourceModule, occurrence.file.relativePath)
  if (resolution.status !== 'internal') return null
  const targetFile = filesByPath.get(resolution.targetRelativePath)
  if (!targetFile) return null
  const imported = targetFile.elements.filter((element) =>
    element.kind === 'class' && element.name === bindings[0].importedName && directExport(targetFile, element)
  )
  return imported.length === 1 ? imported[0] : null
}

interface ImportedConstNewReceiver {
  exporterFile: SymbolReferenceFile
  ownerFile: SymbolReferenceFile
  owner: CodeMapElement
}

function classByName(
  file: SymbolReferenceFile,
  name: string,
  filesByPath: ReadonlyMap<string, SymbolReferenceFile>,
  importResolver: ImportResolver
): { file: SymbolReferenceFile; element: CodeMapElement } | null {
  const bindings = file.importBindings.filter((binding) => binding.localName === name)
  if (bindings.length === 1) {
    const resolution = importResolver.resolve(bindings[0].sourceModule, file.relativePath)
    const targetFile = resolution.status === 'internal' ? filesByPath.get(resolution.targetRelativePath) : null
    const matches = targetFile?.elements.filter((element) =>
      element.kind === 'class' && element.name === bindings[0].importedName && directExport(targetFile, element)
    ) ?? []
    return targetFile && matches.length === 1 ? { file: targetFile, element: matches[0] } : null
  }
  if (bindings.length > 1) return null
  const matches = file.elements.filter((element) =>
    element.kind === 'class' && element.name === name &&
    (element.parentElementId === null || directExport(file, element))
  )
  return matches.length === 1 ? { file, element: matches[0] } : null
}

function importedConstNewReceiver(
  occurrence: CandidateOccurrence,
  filesByPath: ReadonlyMap<string, SymbolReferenceFile>,
  importResolver: ImportResolver
): ImportedConstNewReceiver | null {
  const receiverName = occurrence.candidate.receiverName
  if (occurrence.candidate.receiver !== 'identifier' || occurrence.candidate.receiverTypeName || !receiverName) return null
  const imports = occurrence.file.importBindings.filter((binding) => binding.localName === receiverName)
  if (imports.length !== 1) return null
  const resolution = importResolver.resolve(imports[0].sourceModule, occurrence.file.relativePath)
  if (resolution.status !== 'internal') return null
  const exporterFile = filesByPath.get(resolution.targetRelativePath)
  if (!exporterFile) return null
  const bindings = (exporterFile.exportedConstNewBindings ?? []).filter((binding) =>
    binding.exportedName === imports[0].importedName
  )
  if (bindings.length !== 1) return null
  const binding = bindings[0]
  const declaration = exporterFile.elements.find((element) =>
    element.id === binding.declarationElementId &&
    element.kind === 'constant' &&
    element.name === imports[0].importedName &&
    directExport(exporterFile, element)
  )
  if (!declaration) return null
  const owner = classByName(exporterFile, binding.constructorName, filesByPath, importResolver)
  return owner ? { exporterFile, ownerFile: owner.file, owner: owner.element } : null
}

function methodOwnerIsReachable(
  receiver: ImportedConstNewReceiver,
  method: CodeMapElement,
  filesByPath: ReadonlyMap<string, SymbolReferenceFile>,
  importResolver: ImportResolver
): boolean {
  let current = { file: receiver.ownerFile, element: receiver.owner }
  const visited = new Set<string>()
  while (!visited.has(current.element.id)) {
    visited.add(current.element.id)
    if (method.parentElementId === current.element.id) return true
    if (!current.element.baseClass) return false
    const base = classByName(current.file, current.element.baseClass, filesByPath, importResolver)
    if (!base) return false
    current = base
  }
  return false
}

interface ImportedExplicitReturnBinding {
  exporterFile: SymbolReferenceFile
  ownerFile: SymbolReferenceFile
  owner: CodeMapElement
}

function importedExplicitReturnBinding(
  occurrence: CandidateOccurrence,
  filesByPath: ReadonlyMap<string, SymbolReferenceFile>,
  importResolver: ImportResolver
): ImportedExplicitReturnBinding | null {
  const receiverName = occurrence.candidate.receiverName
  if (occurrence.candidate.receiver !== 'identifier' || occurrence.candidate.receiverTypeName || !receiverName) return null
  const imports = occurrence.file.importBindings.filter((binding) => binding.localName === receiverName)
  if (imports.length !== 1) return null
  const resolution = importResolver.resolve(imports[0].sourceModule, occurrence.file.relativePath)
  if (resolution.status !== 'internal') return null
  const exporterFile = filesByPath.get(resolution.targetRelativePath)
  if (!exporterFile) return null
  const bindings = (exporterFile.exportedConstCallBindings ?? []).filter((binding) =>
    binding.exportedName === imports[0].importedName
  )
  if (bindings.length !== 1) return null
  const binding = bindings[0]
  const declaration = exporterFile.elements.find((element) =>
    element.id === binding.declarationElementId &&
    element.kind === 'constant' &&
    element.name === imports[0].importedName &&
    directExport(exporterFile, element)
  )
  if (!declaration) return null
  let returnType: string | null = null
  let calleeFile = exporterFile
  if (binding.calleeKind === 'member' && binding.calleeReceiverName) {
    const calleeOwner = classByName(exporterFile, binding.calleeReceiverName, filesByPath, importResolver)
    if (calleeOwner?.element.kind === 'class') {
      calleeFile = calleeOwner.file
      const calleeMethod = calleeOwner.file.elements.find((element) =>
        element.parentElementId === calleeOwner.element.id &&
        element.kind === 'method' &&
        element.name === binding.calleeName &&
        element.modifiers.includes('static')
      )
      returnType = calleeMethod?.returnType ?? null
    }
  } else if (binding.calleeKind === 'identifier') {
    const calleeFn = exporterFile.elements.find((element) =>
      element.kind === 'function' &&
      element.name === binding.calleeName &&
      directExport(exporterFile, element)
    )
    returnType = calleeFn?.returnType ?? null
  }
  if (!returnType || !/^[A-Za-z_$][\w$]*$/.test(returnType)) return null
  const owner = classByName(calleeFile, returnType, filesByPath, importResolver) ??
    classByName(exporterFile, returnType, filesByPath, importResolver)
  return owner ? { exporterFile, ownerFile: owner.file, owner: owner.element } : null
}

interface ImportedStaticClassCall {
  exporterFile: SymbolReferenceFile
  targetClass: CodeMapElement
}

function importedStaticClassCall(
  occurrence: CandidateOccurrence,
  filesByPath: ReadonlyMap<string, SymbolReferenceFile>,
  importResolver: ImportResolver
): ImportedStaticClassCall | null {
  const receiverName = occurrence.candidate.receiverName
  if (occurrence.candidate.receiver !== 'identifier' || occurrence.candidate.receiverTypeName || !receiverName) return null
  const imports = occurrence.file.importBindings.filter((binding) => binding.localName === receiverName)
  if (imports.length !== 1) return null
  const resolution = importResolver.resolve(imports[0].sourceModule, occurrence.file.relativePath)
  if (resolution.status !== 'internal') return null
  const exporterFile = filesByPath.get(resolution.targetRelativePath)
  if (!exporterFile) return null
  const targetClass = exporterFile.elements.find((element) =>
    element.kind === 'class' &&
    element.name === imports[0].importedName &&
    directExport(exporterFile, element)
  )
  if (!targetClass) return null
  const staticMethod = exporterFile.elements.find((element) =>
    element.parentElementId === targetClass.id &&
    element.kind === 'method' &&
    element.name === occurrence.candidate.name &&
    element.modifiers.includes('static')
  )
  return staticMethod ? { exporterFile, targetClass } : null
}

describe('Member Resolution real repository coverage', () => {
  it('measures const receiver bindings through lexical AST facts', () => {
    const content = [
      'service.run()',
      'const service = createService()',
      'service.run()',
      '{',
      '  service.run()',
      '  const service = repository.getService()',
      '  service.run()',
      '}',
      'service.run()',
      '[1].forEach((service) => service.run())',
      '[1].forEach(() => service.run())',
      'const items = repository.getItems()',
      'items.map()',
      'const indirect = (createService)()',
      'indirect.run()',
      'const plain = service',
      'plain.run()'
    ].join('\n')
    const result = readStructure('receiver-metrics', 'fixture.ts', '.ts', content)
    const file: SymbolReferenceFile = {
      fileId: 'fixture.ts',
      relativePath: 'fixture.ts',
      elements: result.elements,
      importBindings: result.importBindings,
      exportedConstNewBindings: result.exportedConstNewBindings,
      exportedConstCallBindings: result.exportedConstCallBindings,
      symbolReferences: result.symbolReferences
    }
    const occurrences = file.symbolReferences
      .filter((candidate) => candidate.receiver === 'identifier' && !candidate.receiverTypeName)
      .map((candidate) => ({ file, candidate }))

    expect(measureUntypedReceivers(content, '.ts', occurrences, 'fixture.ts')).toEqual({
      identifierReceiversWithoutKnownType: 12,
      boundToConst: 7,
      constInitializerIsCall: 6,
      identifierCallInitializer: 3,
      memberCallInitializer: 2,
      otherCallInitializer: 1
    })
  })

  it('classifies parameters, reassignment, iteration, catch and imports structurally', () => {
    const content = [
      "import api from 'external-package'",
      'function run(typed: Box<string>, plain) {',
      '  typed.execute()',
      '  plain.execute()',
      '  let current = plain',
      '  current.execute()',
      '  current = typed',
      '  current.execute()',
      '  for (const item of plain) item.execute()',
      '  try {} catch (error) { error.toString() }',
      '  api.execute()',
      '}'
    ].join('\n')
    const result = readStructure('receiver-taxonomy', 'taxonomy.ts', '.ts', content)
    const file: SymbolReferenceFile = {
      fileId: 'taxonomy.ts',
      relativePath: 'taxonomy.ts',
      elements: result.elements,
      importBindings: result.importBindings,
      exportedConstNewBindings: result.exportedConstNewBindings,
      exportedConstCallBindings: result.exportedConstCallBindings,
      symbolReferences: result.symbolReferences
    }
    const occurrences = file.symbolReferences
      .filter((candidate) => candidate.receiver === 'identifier' && !candidate.receiverTypeName)
      .map((candidate) => ({ file, candidate }))
    const observations: UntypedReceiverObservation[] = []
    measureUntypedReceivers(content, '.ts', occurrences, 'taxonomy.ts', observations)

    expect(observations.map((observation) => observation.binding?.origin)).toEqual([
      'parameter', 'parameter', 'let', 'let', 'for-of-const', 'catch', 'import-default'
    ])
    expect(observations.filter((observation) => observation.binding?.origin === 'let')
      .map((observation) => observation.reassignedBeforeCall)).toEqual([false, true])
    expect(observations.filter((observation) => observation.binding?.origin === 'parameter')
      .map((observation) => observation.binding?.annotationSyntax)).toEqual(['generic_type', 'none'])
  })

  it('measures Tiers 1-8, conservative misses and navigation token gains', async () => {
    const telemetry = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const repoPath = process.cwd()
    const extracted: SymbolReferenceFile[] = []
    const sourceContents = new Map<string, string>()
    for (const path of await sourceFiles(repoPath)) {
      const relativePath = relative(repoPath, path).replace(/\\/g, '/')
      const content = await readFile(path, 'utf8')
      sourceContents.set(relativePath, content)
      const result = readStructure('member-resolution-real', relativePath, extname(path), content)
      extracted.push({
        fileId: relativePath,
        relativePath,
        elements: result.elements,
        importBindings: result.importBindings,
        exportedConstNewBindings: result.exportedConstNewBindings,
        exportedConstCallBindings: result.exportedConstCallBindings,
        symbolReferences: result.symbolReferences
      })
    }

    const resolved = resolveSymbolReferences(repoPath, extracted)
    const resolvedByOccurrence = new Map(resolved.map((reference) => [
      `${reference.sourceFileId}:${reference.location.start.byte}:${reference.location.end.byte}`,
      reference
    ]))
    const occurrences = extracted.flatMap((file) => file.symbolReferences.map((candidate) => ({ file, candidate })))
    const filesByPath = new Map(extracted.map((file) => [file.relativePath, file]))
    const importResolver = new ImportResolver(repoPath)
    importResolver.setFiles(extracted.map((file) => file.relativePath))
    const elements = extracted.flatMap((file) => file.elements)
    const elementById = new Map(elements.map((element) => [element.id, element]))
    const declaredType = (occurrence: CandidateOccurrence): CodeMapElement | null => {
      const typeName = occurrence.candidate.receiverTypeName
      if (!typeName) return null
      const bindings = occurrence.file.importBindings.filter((entry) => entry.localName === typeName)
      if (bindings.length === 1) {
        const binding = bindings[0]
        const resolution = importResolver.resolve(binding.sourceModule, occurrence.file.relativePath)
        const targetFile = resolution.status === 'internal' ? filesByPath.get(resolution.targetRelativePath) : null
        const matches = targetFile?.elements.filter((element) =>
          element.name === binding.importedName &&
          ['class', 'interface'].includes(element.kind) &&
          directExport(targetFile, element)
        ) ?? []
        return matches.length === 1 ? matches[0] : null
      }
      if (bindings.length > 1) return null
      const matches = occurrence.file.elements.filter((element) => {
        if (element.name !== typeName || !['class', 'interface'].includes(element.kind)) return false
        if (element.parentElementId === null) return true
        const parent = occurrence.file.elements.find((candidate) => candidate.id === element.parentElementId)
        return parent?.kind === 'export' && parent.parentElementId === null && parent.name === element.name
      })
      return matches.length === 1 ? matches[0] : null
    }
    const identifierMemberCalls = occurrences.filter(({ candidate }) => candidate.receiver === 'identifier')
    const tier1 = occurrences.filter(({ candidate }) => candidate.receiver === 'this')
    const tier2 = occurrences.filter(({ candidate }) => candidate.receiverBindingKind === 'parameter' && candidate.receiverTypeName)
    const tier3 = occurrences.filter(({ candidate }) => candidate.receiverBindingKind === 'const-new' && candidate.receiverTypeName)
    const tier4 = occurrences.filter(({ candidate }) =>
      candidate.receiver === 'this-property' && candidate.receiverPropertyOrigin !== 'constructor-parameter-property'
    )
    const tier5 = occurrences.filter(({ candidate }) =>
      candidate.receiver === 'this-property' && candidate.receiverPropertyOrigin === 'constructor-parameter-property'
    )
    const tier6Universe = occurrences.filter((occurrence) => {
      const { candidate } = occurrence
      const supportedOrigin = candidate.receiverBindingKind === 'parameter' ||
        (candidate.receiver === 'this-property' && Boolean(candidate.receiverPropertyOrigin))
      return supportedOrigin && declaredType(occurrence)?.kind === 'interface'
    })
    const tier6 = tier6Universe.filter(({ candidate }) => !candidate.optional)
    const tier7 = occurrences.filter((occurrence) =>
      importedConstNewReceiver(occurrence, filesByPath, importResolver) !== null
    )
    const tier8A = occurrences.filter((occurrence) =>
      importedExplicitReturnBinding(occurrence, filesByPath, importResolver) !== null
    )
    const tier8B = occurrences.filter((occurrence) =>
      importedStaticClassCall(occurrence, filesByPath, importResolver) !== null
    )
    const resolvedFor = (items: CandidateOccurrence[]) => items.filter(({ file, candidate }) => resolvedByOccurrence.has(
      `${file.fileId}:${candidate.location.start.byte}:${candidate.location.end.byte}`
    ))
    const tier1Resolved = resolvedFor(tier1)
    const ownerKindFor = (occurrence: CandidateOccurrence): CodeMapElement['kind'] | null => {
      const key = `${occurrence.file.fileId}:${occurrence.candidate.location.start.byte}:${occurrence.candidate.location.end.byte}`
      const target = elementById.get(resolvedByOccurrence.get(key)?.targetElementId ?? '')
      return elementById.get(target?.parentElementId ?? '')?.kind ?? null
    }
    const tier2Resolved = resolvedFor(tier2).filter((occurrence) => ownerKindFor(occurrence) === 'class')
    const tier3Resolved = resolvedFor(tier3)
    const tier4Resolved = resolvedFor(tier4).filter((occurrence) => ownerKindFor(occurrence) === 'class')
    const tier5Resolved = resolvedFor(tier5).filter((occurrence) => ownerKindFor(occurrence) === 'class')
    const tier6Resolved = resolvedFor(tier6).filter((occurrence) => ownerKindFor(occurrence) === 'interface')
    const tier7Resolved = resolvedFor(tier7).filter((occurrence) => ownerKindFor(occurrence) === 'class')
    const tier8AResolved = resolvedFor(tier8A).filter((occurrence) => ownerKindFor(occurrence) === 'class')
    const tier8BResolved = resolvedFor(tier8B).filter((occurrence) => ownerKindFor(occurrence) === 'class')
    const tier3Breakdown = { local: 0, imported: 0, aliases: 0, inheritance: 0, override: 0 }
    const tier4Breakdown = { local: 0, imported: 0, aliases: 0, inheritance: 0, override: 0 }
    const tier5Breakdown = { local: 0, imported: 0, aliases: 0, inheritance: 0, override: 0 }
    let tier3FalseResolutions = 0
    let tier4FalseResolutions = 0
    let tier5FalseResolutions = 0
    let tier6FalseResolutions = 0
    let tier7FalseResolutions = 0
    let tier8AFalseResolutions = 0
    let tier8BFalseResolutions = 0

    for (const occurrence of tier3Resolved) {
      const key = `${occurrence.file.fileId}:${occurrence.candidate.location.start.byte}:${occurrence.candidate.location.end.byte}`
      const reference = resolvedByOccurrence.get(key)!
      const target = elementById.get(reference.targetElementId)
      const owner = constructedClass(occurrence, filesByPath, importResolver)
      const binding = occurrence.file.importBindings.find((entry) => entry.localName === occurrence.candidate.receiverTypeName)
      if (binding) {
        tier3Breakdown.imported++
        if (binding.importedName !== binding.localName) tier3Breakdown.aliases++
      } else {
        tier3Breakdown.local++
      }
      if (owner && target?.parentElementId !== owner.id) tier3Breakdown.inheritance++
      if (owner?.baseClass && target?.parentElementId === owner.id) tier3Breakdown.override++
      if (!owner || target?.kind !== 'method' || target.name !== occurrence.candidate.name) tier3FalseResolutions++
    }

    for (const occurrence of tier4Resolved) {
      const key = `${occurrence.file.fileId}:${occurrence.candidate.location.start.byte}:${occurrence.candidate.location.end.byte}`
      const reference = resolvedByOccurrence.get(key)!
      const target = elementById.get(reference.targetElementId)
      const owner = constructedClass(occurrence, filesByPath, importResolver)
      const binding = occurrence.file.importBindings.find((entry) => entry.localName === occurrence.candidate.receiverTypeName)
      if (binding) {
        tier4Breakdown.imported++
        if (binding.importedName !== binding.localName) tier4Breakdown.aliases++
      } else {
        tier4Breakdown.local++
      }
      if (owner && target?.parentElementId !== owner.id) tier4Breakdown.inheritance++
      if (owner?.baseClass && target?.parentElementId === owner.id) tier4Breakdown.override++
      if (!owner || target?.kind !== 'method' || target.name !== occurrence.candidate.name) tier4FalseResolutions++
    }

    for (const occurrence of tier5Resolved) {
      const key = `${occurrence.file.fileId}:${occurrence.candidate.location.start.byte}:${occurrence.candidate.location.end.byte}`
      const reference = resolvedByOccurrence.get(key)!
      const target = elementById.get(reference.targetElementId)
      const owner = constructedClass(occurrence, filesByPath, importResolver)
      const binding = occurrence.file.importBindings.find((entry) => entry.localName === occurrence.candidate.receiverTypeName)
      if (binding) {
        tier5Breakdown.imported++
        if (binding.importedName !== binding.localName) tier5Breakdown.aliases++
      } else {
        tier5Breakdown.local++
      }
      if (owner && target?.parentElementId !== owner.id) tier5Breakdown.inheritance++
      if (owner?.baseClass && target?.parentElementId === owner.id) tier5Breakdown.override++
      if (!owner || target?.kind !== 'method' || target.name !== occurrence.candidate.name) tier5FalseResolutions++
    }

    for (const occurrence of tier6Resolved) {
      const key = `${occurrence.file.fileId}:${occurrence.candidate.location.start.byte}:${occurrence.candidate.location.end.byte}`
      const target = elementById.get(resolvedByOccurrence.get(key)!.targetElementId)
      const owner = declaredType(occurrence)
      const ownerFile = owner ? extracted.find((file) => file.elements.some((element) => element.id === owner.id)) : null
      const named = ownerFile?.elements.filter((element) =>
        element.parentElementId === owner!.id && element.kind === 'method' && element.name === occurrence.candidate.name
      ) ?? []
      if (!owner || !target || target.parentElementId !== owner.id || named.length !== 1 || named[0].id !== target.id) {
        tier6FalseResolutions++
      }
    }

    for (const occurrence of tier7Resolved) {
      const key = `${occurrence.file.fileId}:${occurrence.candidate.location.start.byte}:${occurrence.candidate.location.end.byte}`
      const target = elementById.get(resolvedByOccurrence.get(key)!.targetElementId)
      const receiver = importedConstNewReceiver(occurrence, filesByPath, importResolver)
      if (
        !receiver ||
        !target ||
        target.kind !== 'method' ||
        target.name !== occurrence.candidate.name ||
        !methodOwnerIsReachable(receiver, target, filesByPath, importResolver)
      ) {
        tier7FalseResolutions++
      }
    }

    for (const occurrence of tier8AResolved) {
      const key = `${occurrence.file.fileId}:${occurrence.candidate.location.start.byte}:${occurrence.candidate.location.end.byte}`
      const target = elementById.get(resolvedByOccurrence.get(key)!.targetElementId)
      const receiver = importedExplicitReturnBinding(occurrence, filesByPath, importResolver)
      if (
        !receiver ||
        !target ||
        target.kind !== 'method' ||
        target.name !== occurrence.candidate.name ||
        !methodOwnerIsReachable(receiver, target, filesByPath, importResolver)
      ) {
        tier8AFalseResolutions++
      }
    }

    for (const occurrence of tier8BResolved) {
      const key = `${occurrence.file.fileId}:${occurrence.candidate.location.start.byte}:${occurrence.candidate.location.end.byte}`
      const target = elementById.get(resolvedByOccurrence.get(key)!.targetElementId)
      const call = importedStaticClassCall(occurrence, filesByPath, importResolver)
      if (
        !call ||
        !target ||
        target.kind !== 'method' ||
        target.name !== occurrence.candidate.name ||
        target.parentElementId !== call.targetClass.id ||
        !target.modifiers.includes('static')
      ) {
        tier8BFalseResolutions++
      }
    }

    expect(tier1Resolved.length).toBeGreaterThan(0)
    expect(tier2Resolved.length).toBeGreaterThan(0)
    expect(tier3Resolved.length).toBeGreaterThan(0)
    expect(tier4Resolved.length).toBeGreaterThan(0)
    expect(tier3FalseResolutions).toBe(0)
    expect(tier4FalseResolutions).toBe(0)
    expect(tier5FalseResolutions).toBe(0)
    expect(tier6Universe.length).toBe(222)
    expect(tier6.length).toBe(220)
    expect(tier6Resolved.length).toBe(212)
    expect(new Set(tier6Resolved.map((occurrence) => {
      const key = `${occurrence.file.fileId}:${occurrence.candidate.location.start.byte}:${occurrence.candidate.location.end.byte}`
      return resolvedByOccurrence.get(key)!.targetElementId
    })).size).toBe(99)
    expect(tier6FalseResolutions).toBe(0)
    expect(tier7.length).toBe(104)
    expect(tier7Resolved.length).toBe(101)
    expect(tier7FalseResolutions).toBe(0)
    expect(tier8A.length).toBe(12)
    expect(tier8AResolved.length).toBe(12)
    expect(tier8AFalseResolutions).toBe(0)
    expect(tier8B.length).toBe(3)
    expect(tier8BResolved.length).toBe(3)
    expect(tier8BFalseResolutions).toBe(0)
    const tiers1To6Resolved = tier1Resolved.length + tier2Resolved.length + tier3Resolved.length +
      tier4Resolved.length + tier5Resolved.length + tier6Resolved.length
    const tiers1To7Resolved = tiers1To6Resolved + tier7Resolved.length

    expect(tiers1To6Resolved).toBe(832)
    expect(tiers1To7Resolved).toBe(933)
    expect(tiers1To7Resolved + tier8AResolved.length + tier8BResolved.length).toBe(948)

    const unresolvedOccurrences = occurrences.filter(({ file, candidate }) => !resolvedByOccurrence.has(
      `${file.fileId}:${candidate.location.start.byte}:${candidate.location.end.byte}`
    ))
    const untypedIdentifierOccurrences = occurrences.filter(({ candidate }) =>
      candidate.receiver === 'identifier' && !candidate.receiverTypeName
    )
    const untypedReceiverMetrics: UntypedReceiverMetrics = {
      identifierReceiversWithoutKnownType: 0,
      boundToConst: 0,
      constInitializerIsCall: 0,
      identifierCallInitializer: 0,
      memberCallInitializer: 0,
      otherCallInitializer: 0
    }
    const untypedReceiverObservations: UntypedReceiverObservation[] = []
    for (const file of extracted) {
      const fileOccurrences = untypedIdentifierOccurrences.filter((occurrence) => occurrence.file === file)
      if (fileOccurrences.length === 0) continue
      const measured = measureUntypedReceivers(
        sourceContents.get(file.relativePath)!,
        extname(file.relativePath),
        fileOccurrences,
        file.relativePath,
        untypedReceiverObservations
      )
      for (const key of Object.keys(untypedReceiverMetrics) as Array<keyof UntypedReceiverMetrics>) {
        untypedReceiverMetrics[key] += measured[key]
      }
    }
    expect(untypedReceiverMetrics).toEqual({
      identifierReceiversWithoutKnownType: 2933,
      boundToConst: 1214,
      constInitializerIsCall: 514,
      identifierCallInitializer: 213,
      memberCallInitializer: 301,
      otherCallInitializer: 0
    })
    expect(
      untypedReceiverMetrics.identifierCallInitializer +
      untypedReceiverMetrics.memberCallInitializer +
      untypedReceiverMetrics.otherCallInitializer
    ).toBe(untypedReceiverMetrics.constInitializerIsCall)
    const countBy = <T>(items: readonly T[], keyFor: (item: T) => string): Record<string, number> => {
      const counts: Record<string, number> = {}
      for (const item of items) {
        const key = keyFor(item)
        counts[key] = (counts[key] ?? 0) + 1
      }
      return Object.fromEntries(Object.entries(counts).sort((left, right) =>
        right[1] - left[1] || left[0].localeCompare(right[0])
      ))
    }
    const occurrenceKey = (occurrence: CandidateOccurrence): string =>
      `${occurrence.file.fileId}:${occurrence.candidate.location.start.byte}:${occurrence.candidate.location.end.byte}`
    const observationByStart = new Map(untypedReceiverObservations.map((observation) => [
      `${observation.occurrence.file.fileId}:${observation.occurrence.candidate.location.start.byte}`,
      observation
    ]))
    const byteAt = (observation: UntypedReceiverObservation, index: number): number =>
      Buffer.byteLength(sourceContents.get(observation.occurrence.file.relativePath)!.slice(0, index), 'utf8')
    const callCandidateAt = (observation: UntypedReceiverObservation, index: number): CandidateOccurrence | null => {
      const start = byteAt(observation, index)
      const candidate = observation.occurrence.file.symbolReferences.find((entry) =>
        entry.kind === 'call' && entry.location.start.byte === start
      )
      return candidate ? { file: observation.occurrence.file, candidate } : null
    }
    const resolutionClass = (observation: UntypedReceiverObservation, call: CandidateOccurrence | null): string => {
      if (!call) return 'call-candidate-missing'
      if (resolvedByOccurrence.has(occurrenceKey(call))) return 'internal-indexed'
      const sourceObservation = observationByStart.get(`${call.file.fileId}:${call.candidate.location.start.byte}`)
      const sourceBinding = sourceObservation?.binding
      if (sourceBinding?.origin.startsWith('import-')) {
        const resolution = sourceBinding.importSource
          ? importResolver.resolve(sourceBinding.importSource, call.file.relativePath)
          : null
        return resolution?.status === 'internal' ? 'internal-import-unresolved' : 'external-import'
      }
      if (!sourceBinding) return 'unbound-or-global'
      return 'local-binding-unresolved'
    }
    const origins = countBy(untypedReceiverObservations, (observation) =>
      observation.binding?.origin ?? observation.unresolvedBindingReason ?? 'unknown'
    )
    const parameters = untypedReceiverObservations.filter((observation) => observation.binding?.origin === 'parameter')
    const constants = untypedReceiverObservations.filter((observation) => observation.binding?.origin === 'const')
    const lets = untypedReceiverObservations.filter((observation) => observation.binding?.origin === 'let')
    const imports = untypedReceiverObservations.filter((observation) => observation.binding?.origin.startsWith('import-'))
    const callbacks = parameters.filter((observation) => observation.binding?.callbackCallMemberByte !== null)
    const identifierCallConstants = constants.filter((observation) =>
      observation.binding?.initializer === 'identifier-call'
    )
    const memberCallConstants = constants.filter((observation) =>
      observation.binding?.initializer === 'member-call'
    )
    const identifierCallOrigins = countBy(identifierCallConstants, (observation) => {
      const binding = observation.binding!
      const call = binding.initializerCallStart === null ? null : callCandidateAt(observation, binding.initializerCallStart)
      if (!call) return 'call-candidate-missing'
      const reference = resolvedByOccurrence.get(occurrenceKey(call))
      if (!reference) {
        const imported = call.file.importBindings.find((entry) => entry.localName === binding.initializerCallName)
        if (!imported) return 'external-or-unresolved'
        return importResolver.resolve(imported.sourceModule, call.file.relativePath).status === 'internal'
          ? 'internal-import-unresolved'
          : 'external-import'
      }
      const imported = call.file.importBindings.find((entry) => entry.localName === binding.initializerCallName)
      return imported ? 'named-import-internal' : 'local-function'
    })
    const classifyReturnType = (target: CodeMapElement | null): string => {
      const returnType = target?.returnType?.trim()
      if (!target) return 'callee-unresolved'
      if (!returnType) return 'without-return-type'
      if (/[<>{}\[\]|&]/.test(returnType)) return 'generic-or-container'
      const targetFile = extracted.find((file) => file.elements.some((element) => element.id === target.id))
      const matches = targetFile?.elements.filter((element) =>
        element.name === returnType && ['class', 'interface'].includes(element.kind)
      ) ?? []
      if (matches.length === 1) return matches[0].kind === 'class' ? 'return-class' : 'return-interface'
      const importedType = targetFile?.importBindings.find((entry) => entry.localName === returnType)
      if (!importedType || !targetFile) return 'return-external-or-unresolved'
      const typeResolution = importResolver.resolve(importedType.sourceModule, targetFile.relativePath)
      if (typeResolution.status !== 'internal') return 'return-external-or-unresolved'
      const typeFile = filesByPath.get(typeResolution.targetRelativePath)
      const typeMatches = typeFile?.elements.filter((element) =>
        element.name === importedType.importedName && ['class', 'interface'].includes(element.kind)
      ) ?? []
      if (typeMatches.length !== 1) return 'return-external-or-unresolved'
      return typeMatches[0].kind === 'class' ? 'return-class' : 'return-interface'
    }
    const identifierCallReturnTypes = countBy(identifierCallConstants, (observation) => {
      const binding = observation.binding!
      const call = binding.initializerCallStart === null ? null : callCandidateAt(observation, binding.initializerCallStart)
      const reference = call ? resolvedByOccurrence.get(occurrenceKey(call)) : null
      return classifyReturnType(reference ? elementById.get(reference.targetElementId) ?? null : null)
    })
    const memberCallClasses = countBy(memberCallConstants, (observation) => {
      const binding = observation.binding!
      const call = binding.initializerCallStart === null ? null : callCandidateAt(observation, binding.initializerCallStart)
      return call
        ? resolutionClass(observation, call)
        : `unsupported-receiver-shape:${binding.initializerMemberReceiverKind ?? 'unknown'}`
    })
    const memberCallReturnTypes = countBy(memberCallConstants, (observation) => {
      const binding = observation.binding!
      const call = binding.initializerCallStart === null ? null : callCandidateAt(observation, binding.initializerCallStart)
      const reference = call ? resolvedByOccurrence.get(occurrenceKey(call)) : null
      return classifyReturnType(reference ? elementById.get(reference.targetElementId) ?? null : null)
    })
    const callbackSources = countBy(callbacks, (observation) => {
      const index = observation.binding!.callbackCallMemberByte
      return resolutionClass(observation, index === null ? null : callCandidateAt(observation, index))
    })
    const importKinds = countBy(imports, (observation) => {
      const binding = observation.binding!
      const resolution = binding.importSource
        ? importResolver.resolve(binding.importSource, observation.occurrence.file.relativePath)
        : null
      return `${binding.origin}:${resolution?.status === 'internal' ? 'internal' : 'external'}`
    })
    const importTargetKinds = countBy(
      imports.filter((observation) => observation.binding?.origin === 'import-named'),
      (observation) => {
        const binding = observation.binding!
        const importBinding = observation.occurrence.file.importBindings.find((entry) => entry.localName === binding.name)
        if (!importBinding) return 'binding-not-materialized'
        const resolution = importResolver.resolve(importBinding.sourceModule, observation.occurrence.file.relativePath)
        if (resolution.status !== 'internal') return 'external'
        const targetFile = filesByPath.get(resolution.targetRelativePath)
        const matches = targetFile?.elements.filter((element) =>
          element.name === importBinding.importedName && directExport(targetFile, element)
        ) ?? []
        return matches.length === 1 ? `internal-${matches[0].kind}` : 'internal-export-unresolved'
      }
    )
    const internalImports = imports.filter((observation) => {
      const binding = observation.binding!
      return Boolean(binding.importSource &&
        importResolver.resolve(binding.importSource, observation.occurrence.file.relativePath).status === 'internal')
    })
    const exportedValueOriginCache = new Map<string, string>()
    const exportedValueOrigin = (observation: UntypedReceiverObservation): string => {
      const binding = observation.binding!
      const importBinding = observation.occurrence.file.importBindings.find((entry) => entry.localName === binding.name)
      if (!importBinding) return 'binding-not-materialized'
      const resolution = importResolver.resolve(importBinding.sourceModule, observation.occurrence.file.relativePath)
      if (resolution.status !== 'internal') return 'external'
      const cacheKey = `${resolution.targetRelativePath}:${importBinding.importedName}`
      const cached = exportedValueOriginCache.get(cacheKey)
      if (cached) return cached
      const content = sourceContents.get(resolution.targetRelativePath)
      const language = getLanguageForExtension(extname(resolution.targetRelativePath))
      const parser = language ? getParser(language) : null
      if (!content || !parser) return 'source-unavailable'
      const tree = parser.parse(content, undefined, {
        bufferSize: Math.max(32 * 1024, Buffer.byteLength(content, 'utf8') + 1)
      })
      let origin = 'export-unresolved'
      const visit = (node: any): void => {
        if (origin !== 'export-unresolved') return
        if (node.type === 'variable_declarator') {
          const name = node.childForFieldName?.('name')
          const value = node.childForFieldName?.('value')
          const exported = node.parent?.parent?.type === 'export_statement'
          if (exported && name?.type === 'identifier' && name.text === importBinding.importedName) {
            if (value?.type === 'new_expression') {
              const constructor = value.childForFieldName?.('constructor')
              origin = constructor?.type === 'identifier' ? `const-new:${constructor.text}` : 'const-new:complex'
            } else if (value?.type === 'call_expression') {
              const callee = value.childForFieldName?.('function')
              const member = callee?.type === 'member_expression' ? callee.childForFieldName?.('property') : null
              origin = callee?.type === 'identifier'
                ? `const-identifier-call:${callee.text}`
                : member?.type === 'property_identifier'
                  ? `const-member-call:${member.text}`
                  : 'const-call:complex'
            } else {
              origin = `const-${value?.type ?? 'missing'}`
            }
            return
          }
        }
        if (node.type === 'class_declaration') {
          const name = node.childForFieldName?.('name')
          if (node.parent?.type === 'export_statement' && name?.text === importBinding.importedName) {
            origin = 'class'
            return
          }
        }
        for (let index = 0; index < node.childCount; index++) {
          const child = node.child(index)
          if (child) visit(child)
        }
      }
      visit(tree.rootNode)
      exportedValueOriginCache.set(cacheKey, origin)
      return origin
    }
    const taxonomy = {
      universe: untypedReceiverObservations.length,
      origins,
      parameterAnnotations: countBy(parameters, (observation) => observation.binding!.annotation),
      parameterAnnotationSyntax: countBy(parameters, (observation) => observation.binding!.annotationSyntax),
      constInitializers: countBy(constants, (observation) => observation.binding!.initializerCategory),
      letBindings: {
        total: lets.length,
        noObservedReassignment: lets.filter((observation) => !observation.reassignedBeforeCall).length,
        reassignedBeforeCall: lets.filter((observation) => observation.reassignedBeforeCall).length
      },
      varBindings: origins.var ?? 0,
      aliasesToKnownBindings: constants.filter((observation) => observation.aliasToKnownBinding).length,
      imports: {
        origins: importKinds,
        targetKinds: importTargetKinds,
        internalValueOrigins: countBy(internalImports, exportedValueOrigin),
        internalReceiverNames: countBy(internalImports, (observation) => observation.binding!.name),
        internalMemberNames: countBy(internalImports, (observation) => observation.occurrence.candidate.name)
      },
      destructuring: countBy(
        untypedReceiverObservations.filter((observation) => observation.binding && observation.binding.pattern !== 'identifier'),
        (observation) => `${observation.binding!.origin}:${observation.binding!.pattern}`
      ),
      callbacks: { total: callbacks.length, sources: callbackSources },
      iterations: countBy(
        untypedReceiverObservations.filter((observation) => observation.binding?.iteration),
        (observation) => `${observation.binding!.origin}:${observation.binding!.iteration}`
      ),
      catchBindings: origins.catch ?? 0,
      unboundReceiverNames: countBy(
        untypedReceiverObservations.filter((observation) => !observation.binding),
        (observation) => observation.occurrence.candidate.receiverName ?? 'unknown'
      ),
      identifierCallInitializers: {
        total: identifierCallConstants.length,
        origins: identifierCallOrigins,
        returnTypes: identifierCallReturnTypes
      },
      memberCallInitializers: {
        total: memberCallConstants.length,
        classes: memberCallClasses,
        returnTypes: memberCallReturnTypes,
        methodNames: countBy(memberCallConstants, (observation) => observation.binding!.initializerMemberName ?? 'unknown')
      }
    }
    expect(Object.values(origins).reduce((sum, count) => sum + count, 0)).toBe(untypedReceiverMetrics.identifierReceiversWithoutKnownType)
    expect(taxonomy.universe).toBe(untypedReceiverMetrics.identifierReceiversWithoutKnownType)
    expect(taxonomy).toMatchObject({
      origins: {
        const: 1214,
        unbound: 779,
        parameter: 422,
        'import-named': 357,
        let: 74,
        'for-of-const': 58,
        'import-default': 27,
        class: 1,
        'import-namespace': 1
      },
      parameterAnnotations: { unsupported: 272, none: 145, simple: 5 },
      constInitializers: {
        array: 494,
        'member-call': 301,
        'identifier-call': 213,
        binary: 45,
        await: 37,
        'member-expression': 33,
        subscript_expression: 32,
        conditional: 19,
        as_expression: 18,
        identifier: 18,
        literal: 4
      },
      letBindings: { total: 74, noObservedReassignment: 13, reassignedBeforeCall: 61 },
      varBindings: 0,
      aliasesToKnownBindings: 5,
      imports: {
        origins: {
          'import-named:external': 231,
          'import-named:internal': 126,
          'import-default:external': 27,
          'import-namespace:external': 1
        },
        targetKinds: { external: 231, 'internal-class': 3 },
        internalValueOrigins: {
          'const-new:TelemetryService': 81,
          'const-new:RepositoryEventBus': 17,
          'const-member-call:getInstance': 12,
          'const-array': 6,
          'const-new:TagService': 6,
          class: 3,
          'const-new:Set': 1
        }
      },
      callbacks: { total: 56 },
      iterations: { 'for-of-const:for-of': 58 },
      catchBindings: 0,
      identifierCallInitializers: {
        total: 213,
        origins: { 'external-import': 179, 'internal-import-unresolved': 22, 'external-or-unresolved': 12 },
        returnTypes: { 'callee-unresolved': 213 }
      },
      memberCallInitializers: {
        total: 301,
        returnTypes: { 'callee-unresolved': 228, 'generic-or-container': 46, 'return-external-or-unresolved': 27 }
      }
    })
    const nextFrontier = {
      ...untypedReceiverMetrics,
      remainingIdentifierReceiversWithoutKnownType: unresolvedOccurrences.filter(({ candidate }) =>
        candidate.receiver === 'identifier' && !candidate.receiverTypeName
      ).length,
      interfaceTypedReceivers: unresolvedOccurrences.filter((occurrence) => declaredType(occurrence)?.kind === 'interface').length,
      inheritedProperties: unresolvedOccurrences.filter(({ file, candidate }) => {
        if (candidate.receiver !== 'this-property' || candidate.receiverPropertyOrigin) return false
        let source = candidate.sourceElementId
          ? file.elements.find((element) => element.id === candidate.sourceElementId) ?? null
          : null
        while (source?.parentElementId && source.kind !== 'class') {
          source = file.elements.find((element) => element.id === source!.parentElementId) ?? null
        }
        return source?.kind === 'class' && Boolean(source.baseClass)
      }).length,
      memberChains: [...sourceContents.values()].reduce((total, content) =>
        total + (content.match(/\bthis\.[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/g)?.length ?? 0), 0
      ),
      defaultImportTypedReceivers: unresolvedOccurrences.filter((occurrence) => {
        const typeName = occurrence.candidate.receiverTypeName
        const content = sourceContents.get(occurrence.file.relativePath)
        return Boolean(typeName && content && new RegExp(`^import\\s+${typeName}\\s+from\\s+['\"][^'\"]+['\"]`, 'm').test(content))
      }).length,
      namespaceImportsInCorpus: [...sourceContents.values()].reduce((total, content) =>
        total + (content.match(/^import\s+\*\s+as\s+[A-Za-z_$][\w$]*\s+from\s+['"][^'"]+['"]/gm)?.length ?? 0), 0
      )
    }

    const model = createRepositoryModel(repoPath)
    try {
      await model.indexRepository()
      const modelElements = model.getElementsByRepository()
      const modelFiles = model.getFiles()
      const engine = new ContextEngine({
        awaitSnapshot: async () => {},
        getFiles: () => modelFiles,
        getElements: () => modelElements,
        getRelationships: () => model.getRelationships(),
        getSymbolReferencesByTargetElement: (_repo, target) => model.getSymbolReferencesByTargetElement(target),
        getSymbolReferencesBySourceElement: (_repo, source) => model.getSymbolReferencesBySourceElement(source),
        getElementExactSources: (_repo, ids) => model.getElementExactSources(ids)
      })
      const examples = []
      const targetIdentity = (occurrence: CandidateOccurrence): { owner: string; method: string } => {
        const key = `${occurrence.file.fileId}:${occurrence.candidate.location.start.byte}:${occurrence.candidate.location.end.byte}`
        const target = elementById.get(resolvedByOccurrence.get(key)!.targetElementId)
        return { owner: elementById.get(target?.parentElementId ?? '')?.name ?? '', method: target?.name ?? '' }
      }
      const prioritized = [
        ...['TelemetryService', 'RepositoryEventBus', 'TagService'].map((ownerName) =>
          tier7Resolved.find((occurrence) => targetIdentity(occurrence).owner === ownerName)
        ),
        tier6Resolved.find((occurrence) => {
          const target = targetIdentity(occurrence)
          return target.owner === 'ActionLogPort' && target.method === 'insertAction'
        }),
        tier6Resolved.find((occurrence) => {
          const target = targetIdentity(occurrence)
          const source = occurrence.file.elements.find((element) => element.id === occurrence.candidate.sourceElementId)
          return target.owner === 'RepositoryRepository' &&
            target.method === 'getFilesByRepository' &&
            source?.name === 'discoverIntegrityIssues'
        })
      ].filter((occurrence): occurrence is CandidateOccurrence => occurrence !== undefined)
      const preferredOccurrences = [
        ...prioritized,
        ...tier7Resolved.filter((occurrence) => !prioritized.includes(occurrence)),
        ...tier6Resolved.filter((occurrence) => !prioritized.includes(occurrence))
      ]
      const seenExamples = new Set<string>()
      for (const occurrence of preferredOccurrences) {
        if (examples.length === 3 || !occurrence.candidate.sourceElementId) break
        const extractedSource = occurrence.file.elements.find((element) => element.id === occurrence.candidate.sourceElementId)
        const sourceFile = modelFiles.find((file) => file.relativePath === occurrence.file.relativePath)
        const source = extractedSource && sourceFile
          ? modelElements.find((element) =>
              element.fileId === sourceFile.id &&
              element.kind === extractedSource.kind &&
              element.name === extractedSource.name &&
              element.location.start.byte === extractedSource.location.start.byte &&
              element.retrievable
            )
          : null
        const key = `${occurrence.file.fileId}:${occurrence.candidate.location.start.byte}:${occurrence.candidate.location.end.byte}`
        const reference = resolvedByOccurrence.get(key)!
        const extractedTarget = elementById.get(reference.targetElementId)
        const extractedTargetFile = extracted.find((file) => file.elements.some((element) => element.id === reference.targetElementId))
        const targetFile = modelFiles.find((file) => file.relativePath === extractedTargetFile?.relativePath)
        const target = extractedTarget && targetFile
          ? modelElements.find((element) =>
              element.fileId === targetFile.id &&
              element.kind === extractedTarget.kind &&
              element.name === extractedTarget.name &&
              element.location.start.byte === extractedTarget.location.start.byte &&
              element.retrievable
            )
          : null
        if (!source || !target) continue
        const exampleKey = `${source.id}:${target.id}`
        if (seenExamples.has(exampleKey)) continue
        seenExamples.add(exampleKey)
        const sourceTarget = createFullTargetId(source.id)
        const methodTarget = createFullTargetId(target.id)
        const [read] = await engine.readCode(repoPath, [sourceTarget])
        const dependencies = await engine.getSymbolDependencies(repoPath, [sourceTarget])
        const references = await engine.getReferences(repoPath, [methodTarget])
        const example = {
          source: `${occurrence.file.relativePath}:${source.name}`,
          target: `${target.name}`,
          sourceTokens: measureScenario('member_source', serializeReadCode(read)).tokens,
          dependencyTokens: measureScenario('member_dependencies', serializeSymbolDependencies(dependencies)).tokens,
          referenceTokens: measureScenario('member_references', serializeReferences(references)).tokens
        }
        if (example.dependencyTokens < example.sourceTokens && example.referenceTokens < example.sourceTokens) {
          examples.push(example)
        }
      }
      console.log('MEMBER_RESOLUTION_REAL_BENCHMARK ' + JSON.stringify({
        files: extracted.length,
        surface: { identifierMemberCalls: identifierMemberCalls.length },
        tier1: { occurrences: tier1.length, resolved: tier1Resolved.length, intentionallyUnresolved: tier1.length - tier1Resolved.length },
        tier2: { occurrences: tier2.length, resolved: tier2Resolved.length, intentionallyUnresolved: tier2.length - tier2Resolved.length },
        tier3: {
          totalMatchingOccurrences: tier3.length,
          candidateOccurrences: tier3.length,
          resolved: tier3Resolved.length,
          intentionallyUnresolved: tier3.length - tier3Resolved.length,
          falseResolutions: tier3FalseResolutions,
          breakdown: tier3Breakdown
        },
        tier4: {
          occurrences: tier4.length,
          candidates: tier4.filter(({ candidate }) => candidate.receiverTypeName).length,
          resolved: tier4Resolved.length,
          intentionallyUnresolved: tier4.length - tier4Resolved.length,
          falseResolutions: tier4FalseResolutions,
          breakdown: tier4Breakdown
        },
        tier5: {
          occurrences: tier5.length,
          candidates: tier5.filter(({ candidate }) => candidate.receiverTypeName).length,
          resolved: tier5Resolved.length,
          intentionallyUnresolved: tier5.length - tier5Resolved.length,
          falseResolutions: tier5FalseResolutions,
          breakdown: tier5Breakdown
        },
        tier6: {
          occurrences: tier6Universe.length,
          candidates: tier6.length,
          resolved: tier6Resolved.length,
          intentionallyUnresolved: tier6Universe.length - tier6Resolved.length,
          optionalChaining: tier6Universe.filter(({ candidate }) => candidate.optional).length,
          distinctMethods: new Set(tier6Resolved.map((occurrence) => {
            const key = `${occurrence.file.fileId}:${occurrence.candidate.location.start.byte}:${occurrence.candidate.location.end.byte}`
            return resolvedByOccurrence.get(key)!.targetElementId
          })).size,
          falseResolutions: tier6FalseResolutions
        },
        tier7: {
          category: 'importedConstNewReceiver',
          occurrences: tier7.length,
          candidates: tier7.length,
          resolved: tier7Resolved.length,
          intentionallyUnresolved: tier7.length - tier7Resolved.length,
          falseResolutions: tier7FalseResolutions
        },
        tier8A: {
          category: 'importedExplicitReturnBinding',
          occurrences: tier8A.length,
          candidates: tier8A.length,
          resolved: tier8AResolved.length,
          intentionallyUnresolved: tier8A.length - tier8AResolved.length,
          falseResolutions: tier8AFalseResolutions
        },
        tier8B: {
          category: 'importedStaticClassCall',
          occurrences: tier8B.length,
          candidates: tier8B.length,
          resolved: tier8BResolved.length,
          intentionallyUnresolved: tier8B.length - tier8BResolved.length,
          falseResolutions: tier8BFalseResolutions
        },
        implementedSurface: {
          occurrences: tier1.length + tier2.length + tier3.length + tier4.length + tier5.length + tier6.length + tier7.length + tier8A.length + tier8B.length,
          resolved: tiers1To7Resolved + tier8AResolved.length + tier8BResolved.length
        },
        globalInformativeSurface: {
          capturedMemberCalls: occurrences.filter(({ candidate }) => candidate.receiver).length,
          resolved: resolved.filter((reference) => reference.kind === 'call').length
        },
        cumulativeResolved: tiers1To7Resolved + tier8AResolved.length + tier8BResolved.length,
        nextFrontier,
        taxonomy,
        originalOpportunityBaseline: { occurrences: 3526, methodology: 'Tier 2 checkout; informational because checkout changed' },
        examples
      }))
    } finally {
      model.close()
      telemetry.mockRestore()
    }
  }, 180_000)
})
