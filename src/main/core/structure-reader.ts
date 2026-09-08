/*
-T ---
*/

import { createHash } from 'crypto'
import type {
  CodeMapElement,
  CodeMapRelationship,
  CodeMapElementKind,
  CodeMapElementVisibility,
  CodeMapGranularity,
  CodeMapRelationshipType,
  CodeMapRetrievalKind
} from '../../shared/types'
import { getParser, getLanguageForExtension } from './language-adapter'

// ─── Tipos públicos ──────────────────────────────────────────────────────────

export interface StructureReaderResult {
  elements: CodeMapElement[]
  relationships: CodeMapRelationship[]
  /**
   * Nomes de interfaces implementadas por cada elemento de classe.
   * O Repository Model (Sprint 5) resolverá esses nomes para IDs reais.
   */
  elementInterfaces: Array<{ elementId: string; interfaceNames: string[] }>
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
    if (child && MODIFIER_TYPES.has(child.type)) {
      modifiers.push(child.type)
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
    if (child.type === 'private') return 'private'
    if (child.type === 'protected') return 'protected'
    if (child.type === 'public') return 'public'
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

/** Extrai o nome de um nó, procurando pelo filho do tipo 'identifier' ou 'type_identifier'. */
function extractName(node: any): string {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child && (child.type === 'identifier' || child.type === 'type_identifier' || child.type === 'property_identifier')) {
      return child.text.trim()
    }
  }
  // Fallback estável para declarações anônimas — evita IDs instáveis baseados em conteúdo
  return '(anonymous)'
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
    return { elements: [], relationships: [], elementInterfaces: [] }
  }

  let tree: any
  try {
    const parser = getParser(language)
    tree = parser.parse(content)
  } catch (err) {
    // INVARIANT: parse failures nunca quebram o pipeline de indexação
    console.warn(`[StructureReader] Falha ao parsear "${relativePath}":`, err)
    return { elements: [], relationships: [], elementInterfaces: [] }
  }

  const elements: CodeMapElement[] = []
  const relationships: CodeMapRelationship[] = []
  const elementInterfaces: Array<{ elementId: string; interfaceNames: string[] }> = []

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

  /**
   * Percorre a AST recursivamente extraindo elementos estruturais.
   * @param node            - Nó atual da AST
   * @param parentElementId - ID do elemento pai (null para o nível de arquivo)
   * @param isTopLevel      - true se `node` é declaração de nível de módulo (direto sob program,
   *                          ou embutida em export_statement). Granularidade contextual das lexical_declaration.
   * @param parentKind      - Kind do elemento pai (null no nível de arquivo) — usado para method_signature
   */
  function visitNode(node: any, parentElementId: string | null, isTopLevel = false, parentKind: CodeMapElementKind | null = null): void {
    let element: CodeMapElement | null = null
    let skipRecursion = false
    // Override: filhos de export_statement embutido preservam o escopo top-level do módulo
    let childIsTopLevel: boolean | null = null
    // Escopo top-level só se propaga através de containers transparentes do módulo
    const childrenTopLevel = isTopLevel && (node.type === 'program' || node.type === 'export_statement')

    switch (node.type) {
      case 'class_declaration':
      case 'abstract_class_declaration': {
        const name = extractName(node)
        const id = generateIdWithTwinIndex('class', name, parentElementId, node)
        const baseClass = extractBaseClass(node)
        const interfaces = extractInterfaces(node)
        const modifiers = extractModifiers(node)

        element = buildElement(id, repositoryId, fileId, 'class', name, parentElementId, node, modifiers, null, extractVisibility(node), baseClass, hasJSDoc(node), 0, content)

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

        element = buildElement(id, repositoryId, fileId, 'function', name, parentElementId, node, modifiers, returnType, null, null, hasJSDoc(node), paramCount, content)
        break
      }

      case 'method_definition': {
        const name = extractName(node)
        const id = generateIdWithTwinIndex('method', name, parentElementId, node)
        const modifiers = extractModifiers(node)
        const returnType = extractReturnType(node)
        const visibility = extractVisibility(node)
        const paramCount = extractParameterCount(node)

        element = buildElement(id, repositoryId, fileId, 'method', name, parentElementId, node, modifiers, returnType, visibility, null, hasJSDoc(node), paramCount, content)
        break
      }

      case 'method_signature': {
        // Sob classe = structural; sob interface/type = member (granularidade contextual)
        const name = extractName(node)
        const id = generateIdWithTwinIndex('method', name, parentElementId, node)
        const modifiers = extractModifiers(node)
        const returnType = extractReturnType(node)
        const paramCount = extractParameterCount(node)

        const base = buildElement(id, repositoryId, fileId, 'method', name, parentElementId, node, modifiers, returnType, null, null, hasJSDoc(node), paramCount, content)
        // Sob interface/type = member; sob classe = structural (contrato congelado)
        element = { ...base, granularity: parentKind === 'interface' ? 'member' : 'structural' }
        break
      }

      case 'property_signature': {
        const name = extractName(node)
        if (name !== '(anonymous)') {
          const id = generateIdWithTwinIndex('property', name, parentElementId, node)
          element = buildElement(id, repositoryId, fileId, 'property', name, parentElementId, node, [], null, null, null, false, 0, content)
        }
        break
      }

      case 'public_field_definition': {
        const name = extractName(node)
        if (name !== '(anonymous)') {
          const id = generateIdWithTwinIndex('property', name, parentElementId, node)
          const modifiers = extractModifiers(node)
          const visibility = extractVisibility(node)
          element = buildElement(id, repositoryId, fileId, 'property', name, parentElementId, node, modifiers, null, visibility, null, hasJSDoc(node), 0, content)
        }
        break
      }

      case 'required_parameter':
      case 'optional_parameter': {
        const name = extractName(node)
        if (name !== '(anonymous)') {
          const id = generateIdWithTwinIndex('parameter', name, parentElementId, node)
          element = buildElement(id, repositoryId, fileId, 'parameter', name, parentElementId, node, [], null, null, null, false, 0, content)
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
            const mem = buildElement(id, repositoryId, fileId, 'enumMember', memberNameStr, parentElementId, member, [], null, null, null, false, 0, content)
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
        element = buildElement(id, repositoryId, fileId, 'interface', name, parentElementId, node, [], null, null, null, hasJSDoc(node), 0, content)
        break
      }

      case 'enum_declaration': {
        const name = extractName(node)
        const id = generateIdWithTwinIndex('enum', name, parentElementId, node)
        const modifiers = extractModifiers(node)
        element = buildElement(id, repositoryId, fileId, 'enum', name, parentElementId, node, modifiers, null, null, null, hasJSDoc(node), 0, content)
        break
      }

      case 'type_alias_declaration': {
        const name = extractName(node)
        const id = generateIdWithTwinIndex('typeAlias', name, parentElementId, node)
        const modifiers = extractModifiers(node)
        element = buildElement(id, repositoryId, fileId, 'typeAlias', name, parentElementId, node, modifiers, null, null, null, hasJSDoc(node), 0, content)
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
          const baseElem = buildElement(id, repositoryId, fileId, kind, name, parentElementId, nodeForRange, modifiers, null, null, null, false, 0, content)
          const declarationElement: CodeMapElement = { ...baseElem, granularity: isMember ? 'member' : 'structural' }
          elements.push(declarationElement)

          // Relacionamento contains: pai → filho
          if (parentElementId) {
            relationships.push(buildRelationship(repositoryId, parentElementId, id, 'contains'))
          }

          // Percorre filhos do declarator com o elemento como pai (ex.: arrow function aninhada)
          // Filhos de declarator nunca são top-level
          for (let k = 0; k < declarator.childCount; k++) {
            const dchild = declarator.child(k)
            if (dchild) visitNode(dchild, id, false, kind)
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
        element = buildElement(id, repositoryId, fileId, 'import', name, parentElementId, node, [], null, null, null, false, 0, content)

        // NOTA: relacionamento imports NÃO é gerado aqui.
        // O Repository Model (Sprint 5) resolverá o caminho do módulo para um fileId real.
        break
      }

      case 'call_expression': {
        const source = extractRequireSource(node)
        if (source) {
          const id = generateIdWithTwinIndex('import', source, parentElementId, node)
          element = buildElement(id, repositoryId, fileId, 'import', source, parentElementId, node, [], null, null, null, false, 0, content)
        }
        break
      }

      case 'assignment_expression': {
        const name = extractCommonJsExportName(node)
        if (name) {
          const id = generateIdWithTwinIndex('export', name, parentElementId, node)
          element = buildElement(id, repositoryId, fileId, 'export', name, parentElementId, node, [], null, null, null, false, 0, content)
        }
        break
      }

      case 'export_statement': {
        // Extrai nome exportado — pode ser uma declaração embutida
        const name = extractExportName(node)
        if (name) {
          const id = generateIdWithTwinIndex('export', name, parentElementId, node)
          element = buildElement(id, repositoryId, fileId, 'export', name, parentElementId, node, [], null, null, null, false, 0, content)
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

      // Continua percorrendo filhos com o elemento atual como pai.
      // Filhos de elemento nunca são top-level, exceto export_statement embutido (override).
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (child) visitNode(child, element.id, childIsTopLevel ?? false, element.kind)
      }
    } else {
      // Nó sem mapeamento — continua percorrendo filhos mantendo o pai atual
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (child) visitNode(child, parentElementId, childrenTopLevel, parentKind)
      }
    }
  }

  try {
    visitNode(tree.rootNode, null, true)
  } catch (err) {
    // INVARIANT: erros de percurso da AST nunca quebram o pipeline
    console.warn(`[StructureReader] Erro ao percorrer AST de "${relativePath}":`, err)
    return { elements: [], relationships: [], elementInterfaces: [] }
  }

  return { elements, relationships, elementInterfaces }
}

// ─── Construtores internos ───────────────────────────────────────────────────

/**
 * Classifica um elemento na taxonomia semântica.
 * Retorna granularidade e se é recuperável.
 */
export function classifyElement(kind: CodeMapElementKind): { granularity: CodeMapGranularity; retrievable: boolean } {
  switch (kind) {
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
