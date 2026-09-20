/*
-T ---
*/

import { createHash } from 'crypto'
import type {
  CodeMapElement,
  CodeMapElementLocation,
  CodeMapRelationship,
  CodeMapElementKind,
  CodeMapElementVisibility,
  CodeMapGranularity,
  CodeMapRelationshipType,
  CodeMapRetrievalKind
} from '../../shared/types'
import { getParser, getLanguageForExtension } from './language-adapter'
import type {
  ExportedConstCallBinding,
  ExportedConstNewBinding,
  ImportBinding,
  StructureExtractionResult,
  SymbolReferenceCandidate,
  SymbolReferenceKind
} from './extraction/structure-extraction-port'

// ─── Tipos públicos ──────────────────────────────────────────────────────────

export type StructureReaderResult = StructureExtractionResult

export class StructureExtractionError extends Error {
  constructor(relativePath: string, phase: 'parse' | 'traverse', cause: unknown) {
    super(`Structure extraction failed during ${phase} for "${relativePath}"`, { cause })
    this.name = 'StructureExtractionError'
  }
}

// ─── Geração de IDs ─────────────────────────────────────────────────────────

/**
 * Gera a assinatura discriminadora por kind.
 * - function/method/constructor: texto do nó de parâmetros + texto do retorno
 * - demais kinds: '' (variable/constant usam generateDeclaratorSignature via override)
 */
function generateSignature(kind: CodeMapElementKind, node: any): string {
  switch (kind) {
    case 'function':
    case 'method':
    case 'constructor': {
      // Busca parâmetros e tipo de retorno
      let params = ''
      let returnType = ''
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (!child) continue
        if (child.type === 'formal_parameters' || child.type === 'parameters') {
          params = child.text
        } else if (child.type === 'type_annotation') {
          returnType = child.text
        }
      }
      return `(${params})${returnType}`
    }
    default:
      return ''
  }
}

/**
 * Gera ID estável determinístico de 16 caracteres via SHA-256.
 * Fórmula: sha256(repo : relativePath : kind : name : parentElementId : signature : twinIndex)[0:16]
 * INVARIANT: o algoritmo nunca deve mudar — mudanças quebram IDs entre indexações.
 */
function generateElementId(
  repositoryId: string,
  relativePath: string,
  kind: CodeMapElementKind,
  name: string,
  parentElementId: string | null,
  signature: string,
  twinIndex: number
): string {
  const input = `${repositoryId}:${relativePath}:${kind}:${name}:${parentElementId ?? ''}:${signature}:${twinIndex}`
  return createHash('sha256').update(input).digest('hex').substring(0, 16)
}

/**
 * Gera a assinatura discriminadora de um variable_declarator individual.
 *
 * FÓRMULA (Deliberação 1 da Sprint 4): texto normalizado do nó de VALOR do
 * inicializador (child imediatamente após o token '='; verificação empírica:
 * tipos variam — number, call_expression, object, etc.). Normalização:
 * whitespace colapsado para espaço único, truncado a 200 caracteres.
 * Sem inicializador → ''. O inicializador é o discriminador estrutural que
 * mantém o invariante 3 da identidade (inserção de homônimo com inicializador
 * diferente antes não desloca o twinIndex dos posteriores).
 */
function generateDeclaratorSignature(declarator: any): string {
  for (let k = 0; k < declarator.childCount; k++) {
    const child = declarator.child(k)
    if (child && child.type === '=') {
      const value = declarator.child(k + 1)
      if (!value) return ''
      return value.text.replace(/\s+/g, ' ').trim().substring(0, 200)
    }
  }
  return ''
}

/** Gera ID de relacionamento baseado nos IDs dos elementos envolvidos e no tipo. */
function generateRelationshipId(sourceId: string, targetId: string, type: CodeMapRelationshipType): string {
  const input = `${sourceId}:${targetId}:${type}`
  return createHash('sha256').update(input).digest('hex').substring(0, 16)
}

// ─── Extratores auxiliares ───────────────────────────────────────────────────

/** Conta os parâmetros formais de um nó de função ou método. */
function extractParameterCount(node: any): number {
  // Procura pelo nó formal_parameters ou parameters dentro do nó
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child && (child.type === 'formal_parameters' || child.type === 'parameters')) {
      // Conta apenas filhos que são parâmetros (exclui vírgulas e parênteses)
      let count = 0
      for (let j = 0; j < child.childCount; j++) {
        const param = child.child(j)
        if (param && param.type !== ',' && param.type !== '(' && param.type !== ')') {
          count++
        }
      }
      return count
    }
  }
  return 0
}

/** Extrai modificadores (public, private, static, async, etc.) dos nós filhos. */
function extractModifiers(node: any): string[] {
  // 'export' e 'default' são excluídos — não são modificadores de comportamento
  const MODIFIER_TYPES = new Set([
    'public', 'private', 'protected', 'static', 'async', 'abstract',
    'readonly', 'declare', 'override'
  ])
  const modifiers: string[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    const modifier = child?.type === 'accessibility_modifier' ? child.text : child?.type
    if (modifier && MODIFIER_TYPES.has(modifier)) {
      modifiers.push(modifier)
    }
  }
  return modifiers
}

/**
 * Extrai a visibilidade de um nó.
 * Retorna null quando nenhum modificador de acesso está presente (visibilidade implícita).
 */
function extractVisibility(node: any): CodeMapElementVisibility {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    const modifier = child.type === 'accessibility_modifier' ? child.text : child.type
    if (modifier === 'private') return 'private'
    if (modifier === 'protected') return 'protected'
    if (modifier === 'public') return 'public'
  }
  return null
}

/** Extrai o tipo de retorno anotado de uma função ou método. Retorna null se ausente. */
function extractReturnType(node: any): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child && (child.type === 'type_annotation' || child.type === 'return_type')) {
      // Remove os dois-pontos iniciais do nó type_annotation (ex: ": string" → "string")
      const text = child.text.replace(/^:\s*/, '').trim()
      return text || null
    }
  }
  return null
}

/**
 * Verifica se existe comentário JSDoc (/** ... *\/) imediatamente antes do nó.
 * Percorre siblings anteriores pulando nós sem texto significativo.
 */
function hasJSDoc(node: any): boolean {
  let prev = node.previousSibling
  while (prev) {
    if (prev.type === 'comment') {
      return prev.text.startsWith('/**')
    }
    // Para em qualquer nó com conteúdo não-vazio que não seja um comentário
    if (prev.text.trim() !== '') break
    prev = prev.previousSibling
  }
  return false
}

/** Extrai o nome da classe base a partir da cláusula heritage (extends). Retorna null se ausente. */
function extractBaseClass(node: any): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child && child.type === 'class_heritage') {
      for (let j = 0; j < child.childCount; j++) {
        const part = child.child(j)
        if (part && part.type === 'extends_clause') {
          // O nome da classe base é o segundo filho (após 'extends')
          for (let k = 0; k < part.childCount; k++) {
            const name = part.child(k)
            if (name && name.type !== 'extends') {
              return name.text.trim()
            }
          }
        }
      }
    }
  }
  return null
}

/** Extrai nomes de interfaces implementadas (implements). Retorna array vazio se ausente. */
function extractInterfaces(node: any): string[] {
  const interfaces: string[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child && child.type === 'class_heritage') {
      for (let j = 0; j < child.childCount; j++) {
        const part = child.child(j)
        if (part && part.type === 'implements_clause') {
          // Extrai todos os tipos (excluindo a keyword 'implements' e vírgulas)
          for (let k = 0; k < part.childCount; k++) {
            const iface = part.child(k)
            if (iface && iface.type !== 'implements' && iface.type !== ',') {
              const name = iface.text.trim()
              if (name) interfaces.push(name)
            }
          }
        }
      }
    }
  }
  return interfaces
}

/** Extrai o nome de um membro de enum (enum_assignment, property_identifier ou string). */
function extractMemberName(node: any): string | null {
  if (node.type === 'property_identifier') return node.text.trim() || null
  if (node.type === 'string') {
    // Remove aspas do string literal
    const text = node.text.replace(/^['"]|['"]$/g, '').trim()
    return text || null
  }
  // enum_assignment: o primeiro filho com nome é o membro
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child && (child.type === 'property_identifier' || child.type === 'identifier')) {
      return child.text.trim() || null
    }
  }
  // fallback: texto do nó antes do '=' (Red = 1 → 'Red')
  const eq = node.text.indexOf('=')
  const candidate = (eq >= 0 ? node.text.slice(0, eq) : node.text).trim()
  return candidate || null
}

/** Extrai nomes dos parâmetros diretos de um nó de função/método (sem recursão em callbacks). */
function extractDirectParamNames(node: any): string[] {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child && (child.type === 'formal_parameters' || child.type === 'parameters')) {
      const names: string[] = []
      for (let j = 0; j < child.childCount; j++) {
        const param = child.child(j)
        if (!param || param.type === ',' || param.type === '(' || param.type === ')') continue
        if (param.type === 'required_parameter' || param.type === 'optional_parameter' || param.type === 'rest_pattern' || param.type === 'rest_parameter') {
          for (let k = 0; k < param.childCount; k++) {
            const nameNode = param.child(k)
            if (nameNode && (nameNode.type === 'identifier' || nameNode.type === 'shorthand_property_identifier_pattern')) {
              names.push(nameNode.text)
              break
            }
          }
        } else if (param.type === 'identifier') {
          names.push(param.text)
        }
      }
      return names
    }
  }
  return []
}

function extractDeclarationSignature(
  kind: CodeMapElementKind,
  name: string,
  node: any,
  returnType: string | null,
  baseClass: string | null
): string | null {
  if (kind === 'function' || kind === 'method') {
    const params = extractDirectParamNames(node).join(', ')
    return returnType ? `${name}(${params}): ${returnType}` : `${name}(${params})`
  }
  if (kind === 'constructor') {
    const params = extractDirectParamNames(node).join(', ')
    return `constructor(${params})`
  }
  if (kind === 'class') {
    return baseClass ? `${name} extends ${baseClass}` : null
  }
  return null
}

/** Extrai o nome de um nó, procurando pelo filho do tipo 'identifier' ou 'type_identifier'. */
function extractName(node: any): string {
  if (node.type === 'lexical_declaration') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child?.type === 'variable_declarator') {
        return extractName(child)
      }
    }
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child && (child.type === 'identifier' || child.type === 'type_identifier' || child.type === 'property_identifier')) {
      return child.text.trim()
    }
  }
  // Fallback estável para declarações anônimas — evita IDs instáveis baseados em conteúdo
  return '(anonymous)'
}

interface ReceiverBinding {
  name: string
  typeName: string | null
  kind: 'parameter' | 'const-new' | null
  availableAfter: number
}

interface BindingScope {
  bindings: ReceiverBinding[]
}

function isFunctionScope(node: any): boolean {
  return [
    'function_declaration',
    'function_expression',
    'generator_function_declaration',
    'generator_function',
    'arrow_function',
    'method_definition'
  ].includes(node.type)
}

function isBindingScope(node: any): boolean {
  return isFunctionScope(node) || [
    'program',
    'statement_block',
    'catch_clause',
    'for_statement',
    'for_in_statement',
    'switch_case',
    'switch_default'
  ].includes(node.type)
}

function directGenericTypeNames(node: any): Set<string> {
  const names = new Set<string>()
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index)
    if (child?.type !== 'type_parameters') continue
    for (let parameterIndex = 0; parameterIndex < child.childCount; parameterIndex++) {
      const parameter = child.child(parameterIndex)
      if (!parameter || !['type_parameter', 'required_type_parameter', 'optional_type_parameter'].includes(parameter.type)) continue
      for (let nameIndex = 0; nameIndex < parameter.childCount; nameIndex++) {
        const name = parameter.child(nameIndex)
        if (name?.type === 'type_identifier') {
          names.add(name.text)
          break
        }
      }
    }
  }
  return names
}

function parameterName(node: any): string | null {
  const pattern = node.childForFieldName?.('pattern')
  if (pattern?.type === 'identifier') return pattern.text
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index)
    if (child?.type === 'identifier') return child.text
  }
  return null
}

function simpleAnnotatedType(node: any, genericTypeNames: ReadonlySet<string>): string | null {
  for (let index = 0; index < node.childCount; index++) {
    const annotation = node.child(index)
    if (annotation?.type !== 'type_annotation') continue
    const types: any[] = []
    for (let typeIndex = 0; typeIndex < annotation.childCount; typeIndex++) {
      const type = annotation.child(typeIndex)
      if (type?.isNamed) types.push(type)
    }
    if (types.length !== 1 || types[0].type !== 'type_identifier') return null
    const typeName = types[0].text
    return genericTypeNames.has(typeName) ? null : typeName
  }
  return null
}

interface InstancePropertyBinding {
  name: string
  explicitType: string | null
  origin: 'class-property' | 'constructor-parameter-property'
}

function isConstructorDefinition(node: any): boolean {
  if (node?.type !== 'method_definition') return false
  const name = node.childForFieldName?.('name')
  return name?.type === 'property_identifier' && name.text === 'constructor'
}

function isConstructorParameterProperty(node: any): boolean {
  if (!['required_parameter', 'optional_parameter'].includes(node?.type)) return false
  if (!isConstructorDefinition(node.parent?.parent)) return false
  return extractModifiers(node).some((modifier) =>
    ['private', 'protected', 'public', 'readonly'].includes(modifier)
  )
}

function directClassPropertyBindings(
  node: any,
  genericTypeNames: ReadonlySet<string>
): ReadonlyMap<string, InstancePropertyBinding | null> {
  const properties = new Map<string, InstancePropertyBinding | null>()
  const body = Array.from({ length: node.childCount }, (_, index) => node.child(index))
    .find((child: any) => child?.type === 'class_body')
  if (!body) return properties
  const add = (binding: InstancePropertyBinding): void => {
    properties.set(binding.name, properties.has(binding.name) ? null : binding)
  }
  for (let index = 0; index < body.childCount; index++) {
    const member = body.child(index)
    if (member?.type === 'public_field_definition') {
      const name = member.childForFieldName?.('name')
      if (name?.type === 'property_identifier') {
        add({ name: name.text, explicitType: simpleAnnotatedType(member, genericTypeNames), origin: 'class-property' })
      }
      continue
    }
    if (!isConstructorDefinition(member)) continue
    const parameters = Array.from({ length: member.childCount }, (_, childIndex) => member.child(childIndex))
      .find((child: any) => child?.type === 'formal_parameters')
    if (!parameters) continue
    for (let parameterIndex = 0; parameterIndex < parameters.childCount; parameterIndex++) {
      const parameter = parameters.child(parameterIndex)
      if (!isConstructorParameterProperty(parameter)) continue
      const name = parameterName(parameter)
      if (!name) continue
      add({
        name,
        explicitType: parameter.type === 'required_parameter'
          ? simpleAnnotatedType(parameter, genericTypeNames)
          : null,
        origin: 'constructor-parameter-property'
      })
    }
  }
  return properties
}

function patternNames(node: any): string[] {
  if (!node) return []
  if (['identifier', 'shorthand_property_identifier_pattern', 'shorthand_property_identifier'].includes(node.type)) {
    return [node.text]
  }
  const names: string[] = []
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index)
    if (child) names.push(...patternNames(child))
  }
  return names
}

function directConstNewType(declarator: any): string | null {
  const name = declarator.childForFieldName?.('name')
  const value = declarator.childForFieldName?.('value')
  if (name?.type !== 'identifier' || value?.type !== 'new_expression') return null
  const constructor = value.childForFieldName?.('constructor')
  return constructor?.type === 'identifier' ? constructor.text : null
}

function collectFunctionVarBindings(node: any): ReceiverBinding[] {
  const bindings: ReceiverBinding[] = []
  const visit = (current: any, root = false): void => {
    if (!root && isFunctionScope(current)) return
    if (current.type === 'variable_declaration') {
      for (let index = 0; index < current.childCount; index++) {
        const declarator = current.child(index)
        if (declarator?.type !== 'variable_declarator') continue
        const name = declarator.childForFieldName?.('name')
        for (const bindingName of patternNames(name)) {
          bindings.push({ name: bindingName, typeName: null, kind: null, availableAfter: current.endIndex })
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

function addDeclarationBindings(node: any, bindings: ReceiverBinding[]): void {
  const declaration = node.type === 'export_statement'
    ? Array.from({ length: node.childCount }, (_, index) => node.child(index)).find((child: any) =>
      child && ['lexical_declaration', 'variable_declaration', 'function_declaration', 'class_declaration'].includes(child.type)
    )
    : node
  if (!declaration) return
  if (declaration.type === 'lexical_declaration' || declaration.type === 'variable_declaration') {
    const isConst = declaration.child(0)?.type === 'const'
    for (let index = 0; index < declaration.childCount; index++) {
      const declarator = declaration.child(index)
      if (declarator?.type !== 'variable_declarator') continue
      const name = declarator.childForFieldName?.('name')
      const names = patternNames(name)
      const typeName = isConst ? directConstNewType(declarator) : null
      for (const bindingName of names) {
        bindings.push({
          name: bindingName,
          typeName: names.length === 1 ? typeName : null,
          kind: names.length === 1 && typeName ? 'const-new' : null,
          availableAfter: declaration.endIndex
        })
      }
    }
    return
  }
  if (declaration.type === 'function_declaration' || declaration.type === 'class_declaration') {
    const name = declaration.childForFieldName?.('name')
    if (name?.type === 'identifier' || name?.type === 'type_identifier') {
      bindings.push({ name: name.text, typeName: null, kind: null, availableAfter: declaration.startIndex })
    }
  }
}

function bindingScope(node: any, genericTypeNames: ReadonlySet<string>): BindingScope {
  const bindings: ReceiverBinding[] = []
  if (isFunctionScope(node)) {
    for (let index = 0; index < node.childCount; index++) {
      const parameters = node.child(index)
      if (!parameters || !['formal_parameters', 'parameters'].includes(parameters.type)) continue
      for (let parameterIndex = 0; parameterIndex < parameters.childCount; parameterIndex++) {
        const parameter = parameters.child(parameterIndex)
        if (!parameter || !['required_parameter', 'optional_parameter', 'rest_pattern', 'rest_parameter', 'identifier'].includes(parameter.type)) continue
        const name = parameter.type === 'identifier' ? parameter.text : parameterName(parameter)
        if (!name) continue
        bindings.push({
          name,
          typeName: parameter.type === 'identifier' ? null : simpleAnnotatedType(parameter, genericTypeNames),
          kind: 'parameter',
          availableAfter: node.startIndex
        })
      }
    }
    if (node.type === 'arrow_function') {
      const parameter = node.childForFieldName?.('parameter')
      if (parameter?.type === 'identifier') {
        bindings.push({ name: parameter.text, typeName: null, kind: 'parameter', availableAfter: node.startIndex })
      }
    }
    bindings.push(...collectFunctionVarBindings(node))
  }
  if (node.type === 'catch_clause') {
    const parameter = node.childForFieldName?.('parameter')
    for (const name of patternNames(parameter)) {
      bindings.push({ name, typeName: null, kind: null, availableAfter: node.startIndex })
    }
  }
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index)
    if (child) addDeclarationBindings(child, bindings)
  }
  return { bindings }
}

function receiverBinding(scopes: readonly BindingScope[], name: string, occurrenceStart: number): ReceiverBinding | null {
  for (let index = scopes.length - 1; index >= 0; index--) {
    const scope = scopes[index]
    const matches = scope.bindings.filter((binding) => binding.name === name)
    if (matches.length === 0) continue
    if (matches.length !== 1 || matches[0].availableAfter > occurrenceStart) return null
    return matches[0]
  }
  return null
}

function locationOf(node: any, content: string): CodeMapElementLocation {
  return {
    start: {
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
      byte: Buffer.byteLength(content.slice(0, node.startIndex), 'utf-8')
    },
    end: {
      line: node.endPosition.row + 1,
      column: node.endPosition.column,
      byte: Buffer.byteLength(content.slice(0, node.endIndex), 'utf-8')
    }
  }
}

function isSameNode(left: any, right: any): boolean {
  return Boolean(left && right && left.type === right.type && left.startIndex === right.startIndex && left.endIndex === right.endIndex)
}

function isField(node: any, fieldName: string): boolean {
  return isSameNode(node.parent?.childForFieldName?.(fieldName), node)
}

function isTypeReferenceNode(node: any): boolean {
  if (node.type === 'identifier' && node.parent?.type === 'extends_clause' && isField(node, 'value')) return true
  if (node.type !== 'type_identifier') return false
  if (node.parent?.type === 'nested_type_identifier') return false
  if (isField(node, 'name') && [
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
    'type_alias_declaration',
    'enum_declaration',
    'type_parameter'
  ].includes(node.parent?.type)) return false
  return true
}

function isValueReferenceNode(node: any): boolean {
  if (node.type !== 'identifier') return false
  const parentType = node.parent?.type
  if (!parentType) return false
  if ([
    'import_specifier',
    'import_clause',
    'namespace_import',
    'export_specifier',
    'nested_type_identifier'
  ].includes(parentType)) return false
  if (parentType.endsWith('_pattern')) return false
  if (parentType === 'formal_parameters') return false
  if (parentType === 'arrow_function' && isField(node, 'parameter')) return false
  if (['required_parameter', 'optional_parameter'].includes(parentType) && isField(node, 'pattern')) return false
  if (parentType === 'catch_clause' && isField(node, 'parameter')) return false
  if (isField(node, 'name') && [
    'function_declaration',
    'function_signature',
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
    'type_alias_declaration',
    'enum_declaration',
    'variable_declarator'
  ].includes(parentType)) return false
  if (isField(node, 'key') && parentType === 'pair') return false
  if (isField(node, 'label')) return false
  return true
}

function extractNamedImportBindings(node: any, sourceModule: string, content: string): ImportBinding[] {
  const bindings: ImportBinding[] = []
  const visit = (current: any): void => {
    if (current.type === 'import_specifier') {
      const imported = current.childForFieldName?.('name')
      const alias = current.childForFieldName?.('alias')
      if (imported?.type === 'identifier' && (!alias || alias.type === 'identifier')) {
        const local = alias ?? imported
        bindings.push({
          sourceModule,
          importedName: imported.text,
          localName: local.text,
          location: locationOf(local, content)
        })
      }
      return
    }
    for (let index = 0; index < current.childCount; index++) {
      const child = current.child(index)
      if (child) visit(child)
    }
  }
  visit(node)
  return bindings
}

// ─── Lógica principal ────────────────────────────────────────────────────────

/**
 * Extrai elementos estruturais e relacionamentos de um arquivo via Tree-sitter.
 * Função pura: recebe conteúdo, retorna estrutura. Nunca lança exceção.
 *
 * @param repositoryId - ID do repositório (para geração de IDs estáveis)
 * @param relativePath - Caminho relativo do arquivo no repositório
 * @param extension    - Extensão do arquivo (ex.: '.ts', '.tsx')
 * @param content      - Conteúdo textual completo do arquivo
 */
export function readStructure(
  repositoryId: string,
  relativePath: string,
  extension: string,
  content: string
): StructureReaderResult {
  // Verifica suporte da linguagem via extensão
  const language = getLanguageForExtension(extension)
  if (!language) {
    return {
      elements: [],
      relationships: [],
      elementInterfaces: [],
      importBindings: [],
      symbolReferences: []
    }
  }

  let tree: any
  try {
    const parser = getParser(language)
    const bufferSize = Math.max(32 * 1024, Buffer.byteLength(content, 'utf8') + 1)
    tree = parser.parse(content, undefined, { bufferSize })
  } catch (err) {
    throw new StructureExtractionError(relativePath, 'parse', err)
  }

  const elements: CodeMapElement[] = []
  const relationships: CodeMapRelationship[] = []
  const elementInterfaces: Array<{ elementId: string; interfaceNames: string[] }> = []
  const importBindings: ImportBinding[] = []
  const exportedConstNewBindings: ExportedConstNewBinding[] = []
  const exportedConstCallBindings: ExportedConstCallBinding[] = []
  const symbolReferences: SymbolReferenceCandidate[] = []
  const seenSymbolOccurrences = new Set<string>()

  // Usa relativePath como fileId placeholder — será substituído pelo Repository Model (Sprint 5)
  const fileId = relativePath

  // Contador de gêmeos: chave = "parentElementId:kind:name:signature", valor = próximo índice
  const twinCounter = new Map<string, number>()

  /**
   * Gera o ID do elemento com base na fórmula congelada.
   * Gerencia automaticamente o twinIndex para elementos com mesma assinatura.
   */
  function generateIdWithTwinIndex(
    kind: CodeMapElementKind,
    name: string,
    parentElementId: string | null,
    node: any,
    signatureOverride?: string
  ): string {
    const signature = signatureOverride ?? generateSignature(kind, node)
    const groupKey = `${parentElementId ?? ''}:${kind}:${name}:${signature}`
    const twinIndex = twinCounter.get(groupKey) ?? 0
    twinCounter.set(groupKey, twinIndex + 1)
    return generateElementId(repositoryId, relativePath, kind, name, parentElementId, signature, twinIndex)
  }

  function addSymbolReference(
    node: any,
    kind: SymbolReferenceKind,
    sourceElementId: string | null,
    details: Pick<SymbolReferenceCandidate,
      'receiver' | 'receiverName' | 'receiverTypeName' | 'receiverBindingKind' |
      'receiverPropertyName' | 'receiverPropertyOrigin' | 'optional'> = {}
  ): void {
    const key = `${node.startIndex}:${node.endIndex}`
    if (seenSymbolOccurrences.has(key)) return
    seenSymbolOccurrences.add(key)
    symbolReferences.push({
      name: node.text,
      kind,
      location: locationOf(node, content),
      sourceElementId,
      ...details
    })
  }

  /**
   * Percorre a AST recursivamente extraindo elementos estruturais.
   * @param node            - Nó atual da AST
   * @param parentElementId - ID do elemento pai (null para o nível de arquivo)
   * @param isTopLevel      - true se `node` é declaração de nível de módulo (direto sob program,
   *                          ou embutida em export_statement). Granularidade contextual das lexical_declaration.
   * @param parentKind      - Kind do elemento pai (null no nível de arquivo) — usado para method_signature
   */
  function visitNode(
    node: any,
    parentElementId: string | null,
    isTopLevel = false,
    parentKind: CodeMapElementKind | null = null,
    sourceElementId: string | null = null,
    bindingScopes: readonly BindingScope[] = [],
    genericTypeNames: ReadonlySet<string> = new Set(),
    thisPropertyBindings: ReadonlyMap<string, InstancePropertyBinding | null> | null = null
  ): void {
    let element: CodeMapElement | null = null
    let skipRecursion = false
    // Override: filhos de export_statement embutido preservam o escopo top-level do módulo
    let childIsTopLevel: boolean | null = null
    // Escopo top-level só se propaga através de containers transparentes do módulo
    const childrenTopLevel = isTopLevel && (node.type === 'program' || node.type === 'export_statement')
    const nodeGenericTypeNames = directGenericTypeNames(node)
    const activeGenericTypeNames = nodeGenericTypeNames.size === 0
      ? genericTypeNames
      : new Set([...genericTypeNames, ...nodeGenericTypeNames])
    const activeBindingScopes = isBindingScope(node)
      ? [...bindingScopes, bindingScope(node, activeGenericTypeNames)]
      : bindingScopes
    const activeThisPropertyBindings = ['class_declaration', 'abstract_class_declaration'].includes(node.type)
      ? directClassPropertyBindings(node, activeGenericTypeNames)
      : thisPropertyBindings

    if (node.type === 'new_expression') {
      const constructor = node.childForFieldName?.('constructor')
      if (constructor?.type === 'identifier') addSymbolReference(constructor, 'instantiation', sourceElementId)
    } else if (node.type === 'call_expression') {
      const callee = node.childForFieldName?.('function')
      const argumentsNode = Array.from({ length: node.childCount }, (_, index) => node.child(index))
        .find((child: any) => child?.type === 'arguments') as any
      const optional = Boolean(callee && (
        callee.text.includes('?.') ||
        (argumentsNode && content.slice(callee.endIndex, argumentsNode.startIndex).includes('?.'))
      ))
      if (callee?.type === 'identifier') addSymbolReference(callee, 'call', sourceElementId)
      else if (callee?.type === 'member_expression') {
        const receiver = callee.childForFieldName?.('object')
        const member = callee.childForFieldName?.('property')
        if (receiver?.type === 'this' && member?.type === 'property_identifier') {
          addSymbolReference(member, 'call', sourceElementId, { receiver: 'this', ...(optional ? { optional: true } : {}) })
        } else if (receiver?.type === 'member_expression' && member?.type === 'property_identifier') {
          const root = receiver.childForFieldName?.('object')
          const property = receiver.childForFieldName?.('property')
          if (root?.type === 'this' && property?.type === 'property_identifier') {
            const binding = activeThisPropertyBindings?.get(property.text)
            addSymbolReference(member, 'call', sourceElementId, {
              receiver: 'this-property',
              receiverPropertyName: property.text,
              ...(binding?.explicitType ? { receiverTypeName: binding.explicitType } : {}),
              ...(binding?.origin ? { receiverPropertyOrigin: binding.origin } : {}),
              ...(optional ? { optional: true } : {})
            })
          }
        } else if (receiver?.type === 'identifier' && member?.type === 'property_identifier') {
          const binding = receiverBinding(activeBindingScopes, receiver.text, receiver.startIndex)
          addSymbolReference(member, 'call', sourceElementId, {
            receiver: 'identifier',
            receiverName: receiver.text,
            ...(binding?.typeName ? { receiverTypeName: binding.typeName } : {}),
            ...(binding?.kind ? { receiverBindingKind: binding.kind } : {}),
            ...(optional ? { optional: true } : {})
          })
        }
      }
    } else if (isTypeReferenceNode(node)) {
      addSymbolReference(node, 'type', sourceElementId)
    } else if (isValueReferenceNode(node)) {
      addSymbolReference(node, 'reference', sourceElementId)
    }

    switch (node.type) {
      case 'class_declaration':
      case 'abstract_class_declaration': {
        const name = extractName(node)
        const id = generateIdWithTwinIndex('class', name, parentElementId, node)
        const baseClass = extractBaseClass(node)
        const interfaces = extractInterfaces(node)
        const modifiers = extractModifiers(node)

        element = buildElement(id, repositoryId, fileId, 'class', name, parentElementId, node, modifiers, null, extractVisibility(node), baseClass, hasJSDoc(node), 0, extractDeclarationSignature('class', name, node, null, baseClass), content)

        // Coleta interfaces implementadas como dados brutos — resolução cross-file é responsabilidade do Repository Model
        if (interfaces.length > 0) {
          elementInterfaces.push({ elementId: id, interfaceNames: interfaces })
        }

        // NOTA: relacionamentos extends e implements NÃO são gerados aqui.
        // O Repository Model (Sprint 5) resolverá baseClass e interfaces para IDs reais.
        break
      }

      case 'function_declaration':
      case 'function_signature': {
        const name = extractName(node)
        const id = generateIdWithTwinIndex('function', name, parentElementId, node)
        const modifiers = extractModifiers(node)
        const returnType = extractReturnType(node)
        const paramCount = extractParameterCount(node)

        element = buildElement(id, repositoryId, fileId, 'function', name, parentElementId, node, modifiers, returnType, null, null, hasJSDoc(node), paramCount, extractDeclarationSignature('function', name, node, returnType, null), content)
        break
      }

      case 'method_definition': {
        const name = extractName(node)
        const id = generateIdWithTwinIndex('method', name, parentElementId, node)
        const modifiers = extractModifiers(node)
        const returnType = extractReturnType(node)
        const visibility = extractVisibility(node)
        const paramCount = extractParameterCount(node)

        element = buildElement(id, repositoryId, fileId, 'method', name, parentElementId, node, modifiers, returnType, visibility, null, hasJSDoc(node), paramCount, extractDeclarationSignature(name === 'constructor' ? 'constructor' : 'method', name, node, returnType, null), content)
        break
      }

      case 'method_signature': {
        // Sob classe = structural; sob interface/type = member (granularidade contextual)
        const name = extractName(node)
        const id = generateIdWithTwinIndex('method', name, parentElementId, node)
        const modifiers = extractModifiers(node)
        const returnType = extractReturnType(node)
        const paramCount = extractParameterCount(node)

        const base = buildElement(id, repositoryId, fileId, 'method', name, parentElementId, node, modifiers, returnType, null, null, hasJSDoc(node), paramCount, extractDeclarationSignature('method', name, node, returnType, null), content)
        // Sob interface/type = member; sob classe = structural (contrato congelado)
        element = { ...base, granularity: parentKind === 'interface' ? 'member' : 'structural' }
        break
      }

      case 'property_signature': {
        const name = extractName(node)
        if (name !== '(anonymous)') {
          const id = generateIdWithTwinIndex('property', name, parentElementId, node)
          element = buildElement(id, repositoryId, fileId, 'property', name, parentElementId, node, [], null, null, null, false, 0, null, content)
        }
        break
      }

      case 'public_field_definition': {
        const name = extractName(node)
        if (name !== '(anonymous)') {
          const id = generateIdWithTwinIndex('property', name, parentElementId, node)
          const modifiers = extractModifiers(node)
          const visibility = extractVisibility(node)
          const typeName = simpleAnnotatedType(node, activeGenericTypeNames)
          element = buildElement(id, repositoryId, fileId, 'property', name, parentElementId, node, modifiers, null, visibility, null, hasJSDoc(node), 0, typeName ? `${name}: ${typeName}` : null, content)
        }
        break
      }

      case 'required_parameter':
      case 'optional_parameter': {
        const name = extractName(node)
        if (name !== '(anonymous)') {
          const id = generateIdWithTwinIndex('parameter', name, parentElementId, node)
          const parameterProperty = isConstructorParameterProperty(node)
          const modifiers = parameterProperty ? extractModifiers(node) : []
          const typeName = parameterProperty && node.type === 'required_parameter'
            ? simpleAnnotatedType(node, activeGenericTypeNames)
            : null
          element = buildElement(
            id,
            repositoryId,
            fileId,
            'parameter',
            name,
            parentElementId,
            node,
            modifiers,
            null,
            parameterProperty ? extractVisibility(node) : null,
            null,
            false,
            0,
            typeName ? `${name}: ${typeName}` : null,
            content
          )
        }
        break
      }

      case 'enum_body': {
        // Membros de enum são elementos do tipo 'enumMember' sob o elemento enum pai.
        // A identidade vem do próprio nó membro (enum_assignment, property_identifier, string).
        for (let i = 0; i < node.childCount; i++) {
          const member = node.child(i)
          if (!member) continue
          const memberType = member.type
          if (memberType === 'enum_assignment' || memberType === 'property_identifier' || memberType === 'string') {
            // nome específico por nó
            const memberNameStr = extractMemberName(member)
            if (!memberNameStr) continue
            const id = generateIdWithTwinIndex('enumMember', memberNameStr, parentElementId, member)
            const mem = buildElement(id, repositoryId, fileId, 'enumMember', memberNameStr, parentElementId, member, [], null, null, null, false, 0, null, content)
            elements.push(mem)
            if (parentElementId) {
              relationships.push(buildRelationship(repositoryId, parentElementId, id, 'contains'))
            }
          }
        }
        // Não desce nos membros — já tratados aqui (evita property_identifier/enum_assignment virarem membros duplicados)
        element = null
        skipRecursion = true
        break
      }

      case 'interface_declaration': {
        const name = extractName(node)
        const id = generateIdWithTwinIndex('interface', name, parentElementId, node)
        element = buildElement(id, repositoryId, fileId, 'interface', name, parentElementId, node, [], null, null, null, hasJSDoc(node), 0, null, content)
        break
      }

      case 'enum_declaration': {
        const name = extractName(node)
        const id = generateIdWithTwinIndex('enum', name, parentElementId, node)
        const modifiers = extractModifiers(node)
        element = buildElement(id, repositoryId, fileId, 'enum', name, parentElementId, node, modifiers, null, null, null, hasJSDoc(node), 0, null, content)
        break
      }

      case 'type_alias_declaration': {
        const name = extractName(node)
        const id = generateIdWithTwinIndex('typeAlias', name, parentElementId, node)
        const modifiers = extractModifiers(node)
        element = buildElement(id, repositoryId, fileId, 'typeAlias', name, parentElementId, node, modifiers, null, null, null, hasJSDoc(node), 0, null, content)
        break
      }

      case 'lexical_declaration': {
        // Distingue const de let/var para mapear para 'constant' ou 'variable'
        const isConst = node.child(0)?.type === 'const'
        const kind: CodeMapElementKind = isConst ? 'constant' : 'variable'
        const modifiers = extractModifiers(node)
        // Granularidade contextual por ancestralidade: structural somente em escopo de módulo
        const isMember = !isTopLevel

        // Regra do primeiro declarator: N declarators → N elementos.
        // O elemento 0 estende o início ao keyword (const/let); os demais iniciam no próprio declarator.
        // Isso preserva exatamente os ranges single-declarator existentes (Cenário 8 é o guardião).
        let declaratorIndex = 0
        for (let i = 0; i < node.childCount; i++) {
          const declarator = node.child(i)
          if (!declarator || declarator.type !== 'variable_declarator') continue

          const name = extractName(declarator)
          const signature = generateDeclaratorSignature(declarator)
          const id = generateIdWithTwinIndex(kind, name, parentElementId, node, signature)

          const nodeForRange = declaratorIndex === 0 ? node : declarator
          const baseElem = buildElement(id, repositoryId, fileId, kind, name, parentElementId, nodeForRange, modifiers, null, null, null, false, 0, null, content)
          const declarationElement: CodeMapElement = { ...baseElem, granularity: isMember ? 'member' : 'structural' }
          elements.push(declarationElement)

          const initializer = declarator.childForFieldName?.('value')
          const constructor = initializer?.type === 'new_expression'
            ? initializer.childForFieldName?.('constructor')
            : null
          const exportElement = parentKind === 'export' && parentElementId
            ? elements.find((candidate) => candidate.id === parentElementId)
            : null
          if (
            isConst &&
            isTopLevel &&
            exportElement?.name === name
          ) {
            if (constructor?.type === 'identifier') {
              exportedConstNewBindings.push({
                declarationElementId: id,
                exportedName: name,
                constructorName: constructor.text
              })
            } else if (initializer?.type === 'call_expression') {
              const callee = initializer.childForFieldName?.('function')
              if (callee?.type === 'member_expression') {
                const receiver = callee.childForFieldName?.('object')
                const member = callee.childForFieldName?.('property')
                if (receiver?.type === 'identifier' && member?.type === 'property_identifier') {
                  exportedConstCallBindings.push({
                    declarationElementId: id,
                    exportedName: name,
                    calleeKind: 'member',
                    calleeName: member.text,
                    calleeReceiverName: receiver.text
                  })
                }
              } else if (callee?.type === 'identifier') {
                exportedConstCallBindings.push({
                  declarationElementId: id,
                  exportedName: name,
                  calleeKind: 'identifier',
                  calleeName: callee.text
                })
              }
            }
          }

          // Relacionamento contains: pai → filho
          if (parentElementId) {
            relationships.push(buildRelationship(repositoryId, parentElementId, id, 'contains'))
          }

          // Percorre filhos do declarator com o elemento como pai (ex.: arrow function aninhada)
          // Filhos de declarator nunca são top-level
          for (let k = 0; k < declarator.childCount; k++) {
            const dchild = declarator.child(k)
            if (dchild) {
              const declarationSourceId = declarationElement.granularity === 'structural' ? id : sourceElementId
              visitNode(dchild, id, false, kind, declarationSourceId, activeBindingScopes, activeGenericTypeNames, activeThisPropertyBindings)
            }
          }
          declaratorIndex++
        }
        // Elementos já empurrados manualmente — não usar a via genérica (element = null)
        element = null
        skipRecursion = true
        break
      }

      case 'import_statement': {
        // Extrai o caminho do módulo importado (string_fragment ou string)
        const source = extractImportSource(node)
        const name = source ?? '(unknown-import)'
        const id = generateIdWithTwinIndex('import', name, parentElementId, node)
        element = buildElement(id, repositoryId, fileId, 'import', name, parentElementId, node, [], null, null, null, false, 0, null, content)

        if (source) importBindings.push(...extractNamedImportBindings(node, source, content))

        // NOTA: relacionamento imports NÃO é gerado aqui.
        // O Repository Model (Sprint 5) resolverá o caminho do módulo para um fileId real.
        break
      }

      case 'call_expression': {
        const source = extractRequireSource(node)
        if (source) {
          const id = generateIdWithTwinIndex('import', source, parentElementId, node)
          element = buildElement(id, repositoryId, fileId, 'import', source, parentElementId, node, [], null, null, null, false, 0, null, content)
        }
        break
      }

      case 'assignment_expression': {
        const name = extractCommonJsExportName(node)
        if (name) {
          const id = generateIdWithTwinIndex('export', name, parentElementId, node)
          element = buildElement(id, repositoryId, fileId, 'export', name, parentElementId, node, [], null, null, null, false, 0, null, content)
        }
        break
      }

      case 'export_statement': {
        // Extrai nome exportado — pode ser uma declaração embutida
        const name = extractExportName(node)
        if (name) {
          const id = generateIdWithTwinIndex('export', name, parentElementId, node)
          element = buildElement(id, repositoryId, fileId, 'export', name, parentElementId, node, [], null, null, null, false, 0, null, content)
          // Declaração embutida (`export const x = 1`) continua sendo top-level
          childIsTopLevel = isTopLevel
        }
        break
      }
    }

    if (skipRecursion) {
      // Casos que tratam os filhos manualmente (lexical_declaration, enum_body)
      return
    }

    if (element) {
      elements.push(element)

      // Relacionamento contains: pai → filho
      if (parentElementId) {
        relationships.push(buildRelationship(repositoryId, parentElementId, element.id, 'contains'))
      }

      const childSourceElementId = element.granularity === 'structural' ? element.id : sourceElementId

      // Continua percorrendo filhos com o elemento atual como pai.
      // Filhos de elemento nunca são top-level, exceto export_statement embutido (override).
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (child) visitNode(child, element.id, childIsTopLevel ?? false, element.kind, childSourceElementId, activeBindingScopes, activeGenericTypeNames, activeThisPropertyBindings)
      }
    } else {
      // Nó sem mapeamento — continua percorrendo filhos mantendo o pai atual
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (child) visitNode(child, parentElementId, childrenTopLevel, parentKind, sourceElementId, activeBindingScopes, activeGenericTypeNames, activeThisPropertyBindings)
      }
    }
  }

  try {
    visitNode(tree.rootNode, null, true)
  } catch (err) {
    throw new StructureExtractionError(relativePath, 'traverse', err)
  }

  return { elements, relationships, elementInterfaces, importBindings, exportedConstNewBindings, exportedConstCallBindings, symbolReferences }
}

// ─── Construtores internos ───────────────────────────────────────────────────

/**
 * Classifica um elemento na taxonomia semântica.
 * Retorna granularidade e se é recuperável.
 */
export function classifyElement(kind: CodeMapElementKind): { granularity: CodeMapGranularity; retrievable: boolean } {
  switch (kind) {
    case 'document':
    case 'section':
    case 'class':
    case 'function':
    case 'method':
    case 'interface':
    case 'typeAlias':
    case 'enum':
    case 'variable':
    case 'constant':
    case 'cssAtRule':
      return { granularity: 'structural', retrievable: true }
    case 'property':
    case 'parameter':
    case 'enumMember':
    case 'cssRule':
    case 'cssCustomProperty':
      return { granularity: 'member', retrievable: true }
    case 'import':
    case 'export':
      return { granularity: 'syntax', retrievable: false }
    default:
      return { granularity: 'structural', retrievable: false }
  }
}

/** @deprecated Use 'classifyElement' em vez desta função */
export function classifyRetrievalKind(kind: CodeMapElementKind): CodeMapRetrievalKind {
  const { retrievable } = classifyElement(kind)
  return retrievable ? 'A' : null
}

/** Constrói um CodeMapElement a partir dos dados extraídos do nó. */
function buildElement(
  id: string,
  repositoryId: string,
  fileId: string,
  kind: CodeMapElementKind,
  name: string,
  parentElementId: string | null,
  node: any,
  modifiers: string[],
  returnType: string | null,
  visibility: CodeMapElementVisibility,
  baseClass: string | null,
  hasDocumentation: boolean,
  parameterCount: number,
  declarationSignature: string | null,
  content: string
): CodeMapElement {
  // Tree-sitter usa 0-indexed para linhas; nosso modelo usa 1-indexed
  const startLine = node.startPosition.row + 1
  const startColumn = node.startPosition.column
  // Converte índices de caracteres do Tree-sitter em offsets reais de bytes UTF-8
  const startByte = Buffer.byteLength(content.slice(0, node.startIndex), 'utf-8')
  const endLine = node.endPosition.row + 1
  const endColumn = node.endPosition.column
  const endByte = Buffer.byteLength(content.slice(0, node.endIndex), 'utf-8')

  const classification = classifyElement(kind)

  return {
    id,
    repositoryId,
    fileId,
    kind,
    name,
    parentElementId,
    location: {
      start: { line: startLine, column: startColumn, byte: startByte },
      end: { line: endLine, column: endColumn, byte: endByte }
    },
    sizeLines: endLine - startLine,
    sizeBytes: endByte - startByte,
    visibility,
    modifiers,
    returnType,
    baseClass,
    hasDocumentation,
    parameterCount,
    declarationSignature,
    retrievalKind: classification.retrievable ? 'A' : null,
    granularity: classification.granularity,
    retrievable: classification.retrievable
  }
}

/** Constrói um CodeMapRelationship entre dois elementos (element → element). */
function buildRelationship(
  repositoryId: string,
  sourceId: string,
  targetId: string,
  type: CodeMapRelationshipType
): CodeMapRelationship {
  return {
    id: generateRelationshipId(sourceId, targetId, type),
    repositoryId,
    sourceId,
    targetId,
    type,
    sourceKind: 'element',
    targetKind: 'element'
  }
}

// ─── Utilitários de nó ───────────────────────────────────────────────────────

/** Retorna o primeiro filho com o tipo especificado, ou null se não encontrado. */
function findChildByType(node: any, type: string): any | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child && child.type === type) return child
  }
  return null
}

/** Extrai o caminho do módulo de um import_statement (ex.: './utils'). */
function extractImportSource(node: any): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child && child.type === 'string') {
      // Remove as aspas do string literal
      return child.text.replace(/^['"]|['"]$/g, '').trim()
    }
  }
  return null
}

function extractRequireSource(node: any): string | null {
  const match = node.text.match(/^require\s*\(\s*(['"])([^'"]+)\1\s*\)$/)
  return match?.[2]?.trim() || null
}

function extractCommonJsExportName(node: any): string | null {
  const left = node.childForFieldName?.('left')?.text ?? node.child(0)?.text ?? ''
  if (left === 'module.exports') return 'default'
  const match = left.match(/^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/)
  return match?.[1] ?? null
}

/** Extrai o nome principal de um export_statement. */
function extractExportName(node: any): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    // export default expression
    if (child.type === 'default') return 'default'
    // export { ... } — retorna o texto da cláusula
    if (child.type === 'export_clause') return child.text.substring(0, 60).trim()
    // export type, const, let, function, class, interface, enum embutidos
    if (['class_declaration', 'function_declaration', 'lexical_declaration',
         'interface_declaration', 'enum_declaration', 'type_alias_declaration',
         'abstract_class_declaration'].includes(child.type)) {
      return extractName(child) || null
    }
  }
  return null
}
