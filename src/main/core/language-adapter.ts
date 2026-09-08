/*
-T ---
*/

import Parser from 'tree-sitter'
// @ts-ignore — tree-sitter-typescript não possui types declarados no pacote
import TSLanguages from 'tree-sitter-typescript'
// @ts-ignore — tree-sitter-javascript não possui types declarados no pacote
import JSLanguage from 'tree-sitter-javascript'

// Linguagens suportadas
export type SupportedLanguage = 'typescript' | 'typescript-react' | 'javascript' | 'javascript-react' | 'css'

const SUPPORTED_LANGUAGES = new Set<SupportedLanguage>([
  'typescript',
  'typescript-react',
  'javascript',
  'javascript-react',
  'css'
])

// Mapeamento de extensão de arquivo para linguagem suportada
const EXTENSION_TO_LANGUAGE: Record<string, SupportedLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'typescript-react',
  '.js': 'javascript',
  '.jsx': 'javascript-react',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.css': 'css'
}

// Cache de parsers por linguagem — evita recriar instâncias a cada chamada
const parserCache = new Map<SupportedLanguage, Parser>()

/**
 * Retorna um parser Tree-sitter configurado para a linguagem especificada.
 * Cacheado por linguagem para evitar reloads repetidos.
 * Retorna null para linguagens que não utilizam Tree-sitter (ex: 'css').
 * Lança erro para linguagens desconhecidas ou quando a gramática não puder ser carregada.
 */
export function getParser(language: string): Parser | null {
  if (!isLanguageSupported(language)) {
    throw new Error(`Language Adapter: linguagem não suportada: "${language}". Suportadas: ${getSupportedLanguages().join(', ')}`)
  }

  const lang = language as SupportedLanguage

  // CSS não usa parser Tree-sitter — retorna null
  if (lang === 'css') {
    return null
  }

  const cached = parserCache.get(lang)
  if (cached) return cached

  let grammar: any
  if (lang === 'typescript') {
    grammar = TSLanguages.typescript
  } else if (lang === 'typescript-react') {
    grammar = TSLanguages.tsx
  } else if (lang === 'javascript' || lang === 'javascript-react') {
    grammar = JSLanguage
  }

  if (!grammar) {
    throw new Error(`Language Adapter: gramática Tree-sitter indisponível para "${language}"`)
  }

  const parser = new Parser()
  parser.setLanguage(grammar)

  parserCache.set(lang, parser)
  return parser
}

/** Retorna true se a linguagem possui suporte neste adapter. */
export function isLanguageSupported(language: string): boolean {
  return SUPPORTED_LANGUAGES.has(language as SupportedLanguage)
}

/** Retorna a lista de linguagens suportadas. */
export function getSupportedLanguages(): string[] {
  return Array.from(SUPPORTED_LANGUAGES)
}

/**
 * Retorna a linguagem suportada para uma extensão de arquivo.
 * Retorna null se a extensão não possuir mapeamento.
 */
export function getLanguageForExtension(extension: string): SupportedLanguage | null {
  const normalized = extension.toLowerCase()
  return EXTENSION_TO_LANGUAGE[normalized] ?? null
}
