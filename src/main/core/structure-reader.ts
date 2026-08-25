/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Receber o conteúdo de um arquivo e sua linguagem.
2. Parsear o conteúdo via Tree-sitter (através do Language Adapter).
3. Percorrer a AST e extrair elementos estruturais padronizados.
4. Gerar identificadores estáveis determinísticos para cada elemento.
5. Gerar apenas relacionamentos contains (intra-arquivo).
6. Coletar dados brutos de herança e imports para resolução cross-file pelo Repository Model.
7. Retornar elementos, relacionamentos e dados brutos de interfaces sem análise arquitetural.

Mapa de Relacionamentos do Script

1. language-adapter.ts
   - Tipo: Dependência Direta
   - Relação: Consome getParser para obter o parser configurado.
   - Criticidade: Alta

2. repository-model.ts (Sprint 5)
   - Tipo: Dependência Inversa
   - Relação: Consumirá os elementos, relacionamentos e elementInterfaces extraídos.
   - Criticidade: Alta

3. ../../shared/types
   - Tipo: Contrato / Interface
   - Relação: Fornece CodeMapElement, CodeMapRelationship, CodeMapElementKind, etc.
   - Criticidade: Alta

Invariantes do Script

1. O Structure Reader nunca persiste dados — apenas retorna elementos e relacionamentos.
2. O Structure Reader nunca faz análise arquitetural — apenas extração estrutural.
3. Cada elemento possui ID estável determinístico (hash de repositoryId + path + kind + name + parentId).
4. Cada elemento possui localização completa (start/end com line, column, byte).
5. Elementos aninhados (métodos dentro de classes) possuem parentElementId correto.
6. Apenas relacionamentos contains são gerados — são sempre intra-arquivo e nunca quebram.
7. Relacionamentos extends, implements e imports NÃO são gerados aqui — dependem de resolução cross-file.
8. Nomes de classes base, interfaces e imports são coletados como dados brutos para o Repository Model.
9. Falhas de parse nunca interrompem o pipeline — retornam arrays e objetos vazios.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { createHash } from 'crypto'
import type {
  CodeMapElement,
  CodeMapRelationship,
  CodeMapElementKind,
  CodeMapElementVisibility,
  CodeMapRelationshipType
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
 * Gera ID estável determinístico de 16 caracteres via SHA-256.
 * INVARIANT: o algoritmo nunca deve mudar — mudanças quebram IDs entre indexações.
 */
function generateElementId(
  repositoryId: string,
  relativePath: string,
  kind: CodeMapElementKind,
  name: string,
  parentElementId: string | null
): string {
  const input = `${repositoryId}:${relativePath}:${kind}:${name}:${parentElementId ?? ''}`
  return createHash('sha256').update(input).digest('hex').substring(0, 16)
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

  /**
   * Percorre a AST recursivamente extraindo elementos estruturais.
   * @param node            - Nó atual da AST
   * @param parentElementId - ID do elemento pai (null para o nível de arquivo)
   */
  function visitNode(node: any, parentElementId: string | null): void {
    let element: CodeMapElement | null = null

    switch (node.type) {
      case 'class_declaration':
      case 'abstract_class_declaration': {
        const name = extractName(node)
        const id = generateElementId(repositoryId, relativePath, 'class', name, parentElementId)
        const baseClass = extractBaseClass(node)
        const interfaces = extractInterfaces(node)
        const modifiers = extractModifiers(node)

        element = buildElement(id, repositoryId, fileId, 'class', name, parentElementId, node, modifiers, null, extractVisibility(node), baseClass, hasJSDoc(node), 0)

        // Coleta interfaces implementadas como dados brutos — resolução cross-file é responsabilidade do Repository Model
        if (interfaces.length > 0) {
          elementInterfaces.push({ elementId: id, interfaceNames: interfaces })
        }

        // NOTA: relacionamentos extends e implements NÃO são gerados aqui.
        // O Repository Model (Sprint 5) resolverá baseClass e interfaces para IDs reais.
        break
      }

      case 'function_declaration': {
        const name = extractName(node)
        const id = generateElementId(repositoryId, relativePath, 'function', name, parentElementId)
        const modifiers = extractModifiers(node)
        const returnType = extractReturnType(node)
        const paramCount = extractParameterCount(node)

        element = buildElement(id, repositoryId, fileId, 'function', name, parentElementId, node, modifiers, returnType, null, null, hasJSDoc(node), paramCount)
        break
      }

      case 'method_definition':
      case 'method_signature': {
        const name = extractName(node)
        const id = generateElementId(repositoryId, relativePath, 'method', name, parentElementId)
        const modifiers = extractModifiers(node)
        const returnType = extractReturnType(node)
        const visibility = extractVisibility(node)
        const paramCount = extractParameterCount(node)

        element = buildElement(id, repositoryId, fileId, 'method', name, parentElementId, node, modifiers, returnType, visibility, null, hasJSDoc(node), paramCount)
        break
      }

      case 'interface_declaration': {
        const name = extractName(node)
        const id = generateElementId(repositoryId, relativePath, 'interface', name, parentElementId)
        element = buildElement(id, repositoryId, fileId, 'interface', name, parentElementId, node, [], null, null, null, hasJSDoc(node), 0)
        break
      }

      case 'enum_declaration': {
        const name = extractName(node)
        const id = generateElementId(repositoryId, relativePath, 'enum', name, parentElementId)
        const modifiers = extractModifiers(node)
        element = buildElement(id, repositoryId, fileId, 'enum', name, parentElementId, node, modifiers, null, null, null, hasJSDoc(node), 0)
        break
      }

      case 'type_alias_declaration': {
        const name = extractName(node)
        const id = generateElementId(repositoryId, relativePath, 'typeAlias', name, parentElementId)
        const modifiers = extractModifiers(node)
        element = buildElement(id, repositoryId, fileId, 'typeAlias', name, parentElementId, node, modifiers, null, null, null, hasJSDoc(node), 0)
        break
      }

      case 'lexical_declaration': {
        // Distingue const de let/var para mapear para 'constant' ou 'variable'
        const isConst = node.child(0)?.type === 'const'
        const kind: CodeMapElementKind = isConst ? 'constant' : 'variable'
        // Extrai o nome do primeiro declarator
        const declarator = findChildByType(node, 'variable_declarator')
        if (!declarator) break
        const name = extractName(declarator)
        const id = generateElementId(repositoryId, relativePath, kind, name, parentElementId)
        const modifiers = extractModifiers(node)
        element = buildElement(id, repositoryId, fileId, kind, name, parentElementId, node, modifiers, null, null, null, false, 0)
        break
      }

      case 'import_statement': {
        // Extrai o caminho do módulo importado (string_fragment ou string)
        const source = extractImportSource(node)
        const name = source ?? '(unknown-import)'
        const id = generateElementId(repositoryId, relativePath, 'import', name, parentElementId)
        element = buildElement(id, repositoryId, fileId, 'import', name, parentElementId, node, [], null, null, null, false, 0)

        // NOTA: relacionamento imports NÃO é gerado aqui.
        // O Repository Model (Sprint 5) resolverá o caminho do módulo para um fileId real.
        break
      }

      case 'export_statement': {
        // Extrai nome exportado — pode ser uma declaração embutida
        const name = extractExportName(node)
        if (name) {
          const id = generateElementId(repositoryId, relativePath, 'export', name, parentElementId)
          element = buildElement(id, repositoryId, fileId, 'export', name, parentElementId, node, [], null, null, null, false, 0)
        }
        break
      }
    }

    if (element) {
      elements.push(element)

      // Relacionamento contains: pai → filho
      if (parentElementId) {
        relationships.push(buildRelationship(repositoryId, parentElementId, element.id, 'contains'))
      }

      // Continua percorrendo filhos com o elemento atual como pai
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (child) visitNode(child, element.id)
      }
    } else {
      // Nó sem mapeamento — continua percorrendo filhos mantendo o pai atual
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (child) visitNode(child, parentElementId)
      }
    }
  }

  try {
    visitNode(tree.rootNode, null)
  } catch (err) {
    // INVARIANT: erros de percurso da AST nunca quebram o pipeline
    console.warn(`[StructureReader] Erro ao percorrer AST de "${relativePath}":`, err)
    return { elements: [], relationships: [], elementInterfaces: [] }
  }

  return { elements, relationships, elementInterfaces }
}

// ─── Construtores internos ───────────────────────────────────────────────────

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
  parameterCount: number
): CodeMapElement {
  // Tree-sitter usa 0-indexed para linhas; nosso modelo usa 1-indexed
  const startLine = node.startPosition.row + 1
  const startColumn = node.startPosition.column
  const startByte = node.startIndex
  const endLine = node.endPosition.row + 1
  const endColumn = node.endPosition.column
  const endByte = node.endIndex

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
    parameterCount
  }
}

/** Constrói um CodeMapRelationship entre dois elementos. */
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
    type
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
