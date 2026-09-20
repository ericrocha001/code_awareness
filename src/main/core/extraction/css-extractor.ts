/*
-T ---
*/

import { createHash } from 'crypto'
import { posix } from 'path'
import { getLanguageForExtension } from '../language-adapter'
import { classifyElement } from '../structure-reader'
import type { CodeMapElement, CodeMapElementKind, CodeMapRelationship } from '../../../shared/types'
import type {
  StructureExtractionPort,
  StructureExtractionInput,
  StructureExtractionResult
} from './structure-extraction-port'

function generateFileId(repositoryId: string, relativePath: string): string {
  return createHash('sha256').update(`${repositoryId}:${relativePath}`).digest('hex').substring(0, 16)
}

function generateRelationshipId(sourceId: string, targetId: string, type: string): string {
  return createHash('sha256').update(`${sourceId}:${targetId}:${type}`).digest('hex').substring(0, 16)
}

/** Limite contractual do nome de um cssRule (seletor). */
const SELECTOR_NAME_MAX = 120

/** Linha/coluna 1-based/0-based a partir de um índice de caractere. */
function lineColumnAt(content: string, charIndex: number): { line: number; column: number } {
  let line = 1
  let lastNl = -1
  for (let i = 0; i < charIndex; i++) {
    if (content[i] === '\n') {
      line++
      lastNl = i
    }
  }
  return { line, column: charIndex - lastNl - 1 }
}

/** Pula uma string CSS (aspas simples/duplas com escapes). Retorna índice após a aspa de fechamento. */
function skipString(clean: string, start: number): number {
  const quote = clean[start]
  let j = start + 1
  while (j < clean.length) {
    if (clean[j] === '\\') {
      j += 2
      continue
    }
    if (clean[j] === quote) return j + 1
    j++
  }
  return j
}

export class CssStructureExtractor implements StructureExtractionPort {
  supports(extension: string): boolean {
    return getLanguageForExtension(extension) === 'css'
  }

  extract(input: StructureExtractionInput): StructureExtractionResult {
    return extractCssStructure(input)
  }
}

/** Executa a tokenização estrutural e a extração de @imports de um arquivo CSS. */
function extractCssStructure(input: StructureExtractionInput): StructureExtractionResult {
  const { repositoryId, relativePath, content } = input
  const fileId = generateFileId(repositoryId, relativePath)

  // Cópia "limpa": comentários substituídos por espaços preservando comprimento e quebras de linha,
  // para que os índices de caractere permaneçam alinhados ao conteúdo original.
  const clean = content.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))

  const elements: CodeMapElement[] = []
  const relationships: CodeMapRelationship[] = []

  // Fórmula de identidade congelada — idêntica ao Structure Reader (assinatura '' para kinds CSS)
  const twinCounter = new Map<string, number>()
  const cssElementId = (kind: CodeMapElementKind, name: string, parentElementId: string | null): string => {
    const signature = ''
    const groupKey = `${parentElementId ?? ''}:${kind}:${name}:${signature}`
    const twinIndex = twinCounter.get(groupKey) ?? 0
    twinCounter.set(groupKey, twinIndex + 1)
    const hashInput = `${repositoryId}:${relativePath}:${kind}:${name}:${parentElementId ?? ''}:${signature}:${twinIndex}`
    return createHash('sha256').update(hashInput).digest('hex').substring(0, 16)
  }

  const buildCssElement = (
    kind: CodeMapElementKind,
    name: string,
    parentElementId: string | null,
    charStart: number,
    charEnd: number
  ): CodeMapElement => {
    const startByte = Buffer.byteLength(content.slice(0, charStart), 'utf-8')
    const endByte = startByte + Buffer.byteLength(content.slice(charStart, charEnd), 'utf-8')
    const startLC = lineColumnAt(content, charStart)
    const endLC = lineColumnAt(content, charEnd)
    const classification = classifyElement(kind)
    return {
      id: cssElementId(kind, name, parentElementId),
      repositoryId,
      fileId,
      kind,
      name,
      parentElementId,
      location: {
        start: { line: startLC.line, column: startLC.column, byte: startByte },
        end: { line: endLC.line, column: endLC.column, byte: endByte }
      },
      sizeLines: endLC.line - startLC.line,
      sizeBytes: endByte - startByte,
      visibility: null,
      modifiers: [],
      returnType: null,
      baseClass: null,
      hasDocumentation: false,
      parameterCount: 0,
      retrievalKind: classification.retrievable ? 'A' : null,
      granularity: classification.granularity,
      retrievable: classification.retrievable
    }
  }

  // ─── Tokenizer estrutural ──────────────────────────────────────────────────
  tokenizeCssRules(clean, elements, relationships, buildCssElement)

  return assembleCssResult({ repositoryId, relativePath, clean, elements, relationships, fileId })
}

/**
 * Varredura linear sobre a cópia limpa do CSS empilhando blocos abertos.
 * Regras produzidas: cssRule (seletor+bloco), cssAtRule (com bloco) e cssCustomProperty.
 */
function tokenizeCssRules(
  clean: string,
  elements: CodeMapElement[],
  relationships: CodeMapRelationship[],
  buildCssElement: (kind: CodeMapElementKind, name: string, parentElementId: string | null, charStart: number, charEnd: number) => CodeMapElement
): void {
  const n = clean.length
  // Pilha de elemento-pai dos blocos abertos (rule/at-rule); vazia = nível raiz
  const stack: Array<string | null> = []
  const parentId = (): string | null => (stack.length ? stack[stack.length - 1] : null)

  const pushWithParent = (el: CodeMapElement): void => {
    elements.push(el)
    const pid = parentId()
    if (pid) {
      relationships.push({
        id: generateRelationshipId(pid, el.id, 'contains'),
        repositoryId: el.repositoryId,
        sourceId: pid,
        targetId: el.id,
        type: 'contains'
      })
    }
  }

  /** Encontra o índice da chave de fechamento correspondente à chave aberta em openIdx. */
  const findMatchingBrace = (openIdx: number): number => {
    let depth = 0
    let j = openIdx
    while (j < n) {
      const c = clean[j]
      if (c === '"' || c === "'") {
        j = skipString(clean, j)
        continue
      }
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) return j
      }
      j++
    }
    return n - 1
  }

  let i = 0
  while (i < n) {
    // Pula whitespace (comentários já estão blanked no clean)
    while (i < n && /\s/.test(clean[i])) i++
    if (i >= n) break

    const ch = clean[i]

    // Fecha bloco aberto
    if (ch === '}') {
      stack.pop()
      i++
      continue
    }

    // At-rule: '@name' seguido de bloco '{...}' (elemento) ou ';' (sem elemento)
    if (ch === '@') {
      let j = i + 1
      while (j < n && /[a-zA-Z-]/.test(clean[j])) j++
      const atName = clean.slice(i, j)

      // Procura '{' ou ';' no header do at-rule, respeitando strings e parênteses (url(...))
      let k = j
      let parenDepth = 0
      let blockOpen = -1
      let semicolon = -1
      while (k < n) {
        const c = clean[k]
        if (c === '"' || c === "'") {
          k = skipString(clean, k)
          continue
        }
        if (c === '(') parenDepth++
        else if (c === ')') parenDepth--
        else if (parenDepth === 0) {
          if (c === ';') {
            semicolon = k
            break
          }
          if (c === '{') {
            blockOpen = k
            break
          }
        }
        k++
      }

      if (blockOpen >= 0) {
        const closeIdx = findMatchingBrace(blockOpen)
        const el = buildCssElement('cssAtRule', atName, parentId(), i, closeIdx + 1)
        pushWithParent(el)
        stack.push(el.id)
        i = blockOpen + 1
      } else {
        // At-rule simples (@import, @charset) — sem elemento estrutural
        i = semicolon >= 0 ? semicolon + 1 : n
      }
      continue
    }

    // Custom property: '--name: value;' (dentro de bloco ou nível raiz)
    if (clean.startsWith('--', i)) {
      let colon = i
      while (colon < n && clean[colon] !== ':' && clean[colon] !== ';' && clean[colon] !== '}') colon++
      if (colon < n && clean[colon] === ':') {
        let end = colon
        while (end < n && clean[end] !== ';' && clean[end] !== '}') end++
        const name = clean.slice(i, colon).trim()
        if (name) {
          const el = buildCssElement('cssCustomProperty', name, parentId(), i, end)
          pushWithParent(el)
        }
        i = end < n && clean[end] === ';' ? end + 1 : end
        continue
      }
    }

    // Candidato a rule: procura '{' (rule) ou ';' (declaração solta — ignora)
    let k = i
    let blockOpen = -1
    let stopAt: number | null = null
    while (k < n) {
      const c = clean[k]
      if (c === '"' || c === "'") {
        k = skipString(clean, k)
        continue
      }
      if (c === '{') {
        blockOpen = k
        break
      }
      if (c === ';' || c === '}') {
        stopAt = k
        break
      }
      k++
    }

    if (blockOpen >= 0) {
      const closeIdx = findMatchingBrace(blockOpen)
      const rawSelector = clean.slice(i, blockOpen).trim()
      const name = rawSelector.substring(0, SELECTOR_NAME_MAX)
      if (name) {
        const el = buildCssElement('cssRule', name, parentId(), i, closeIdx + 1)
        pushWithParent(el)
        stack.push(el.id)
      }
      i = blockOpen + 1
    } else {
      // Declaração solta — consome o ';' para garantir progresso.
      // '}' NÃO é consumido aqui: é tratado no topo do loop (pop da pilha).
      if (stopAt !== null) {
        i = clean[stopAt] === ';' ? stopAt + 1 : stopAt
      } else {
        i = k + 1
      }
    }
  }
}

/** Monta o resultado final: elementos + contains + relacionamentos @import (FILE -> FILE). */
function assembleCssResult(ctx: {
  repositoryId: string
  relativePath: string
  clean: string
  elements: CodeMapElement[]
  relationships: CodeMapRelationship[]
  fileId: string
}): StructureExtractionResult {
  const { repositoryId, relativePath, clean, elements, relationships, fileId } = ctx

  // Regex para capturar declarações @import:
  // Suporta: @import "path", @import 'path', @import url("path"), @import url('path'), @import url(path)
  const IMPORT_REGEX = /@import\s+(?:url\(\s*)?(?:['"]([^'"]+)['"]|([^'")\s;]+))\s*\)?/g

  let match: RegExpExecArray | null
  const sourceId = fileId

  // Diretório do arquivo CSS relativo à raiz do repositório
  const importerDir = posix.dirname(relativePath.replace(/\\/g, '/'))

  while ((match = IMPORT_REGEX.exec(clean)) !== null) {
    const rawSpecifier = (match[1] || match[2] || '').trim()
    if (!rawSpecifier) continue

    // Ignora URLs externas ou esquemas de dados
    if (
      rawSpecifier.startsWith('http://') ||
      rawSpecifier.startsWith('https://') ||
      rawSpecifier.startsWith('//') ||
      rawSpecifier.startsWith('data:')
    ) {
      continue
    }

    // Remove query string (?...) e hash (#...) se presentes
    const cleanPath = rawSpecifier.split('?')[0].split('#')[0].trim()
    if (!cleanPath) continue

    // Resolve o caminho em relação ao diretório do arquivo CSS atual
    let targetRelativePath: string
    if (cleanPath.startsWith('/')) {
      targetRelativePath = posix.normalize(cleanPath.replace(/^\/+/, ''))
    } else {
      targetRelativePath = posix.normalize(
        importerDir === '.' ? cleanPath : posix.join(importerDir, cleanPath)
      )
    }

    // Evita caminhos que escapam da raiz do repositório (ex: ../../fora)
    if (targetRelativePath.startsWith('..')) {
      continue
    }

    const targetId = generateFileId(repositoryId, targetRelativePath)
    const relationshipId = generateRelationshipId(sourceId, targetId, 'imports')

    relationships.push({
      id: relationshipId,
      repositoryId,
      sourceId,
      targetId,
      type: 'imports',
      sourceKind: 'file',
      targetKind: 'file'
    })
  }

  return {
    elements,
    relationships,
    elementInterfaces: [],
    importBindings: [],
    exportedConstNewBindings: [],
    exportedConstCallBindings: [],
    symbolReferences: []
  }
}
