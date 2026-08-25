/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Carregar e configurar o parser Tree-sitter para cada linguagem suportada.
2. Retornar uma instância do parser pronta para uso pelo Structure Reader.
3. Isolar o Tree-sitter do resto do sistema — o núcleo nunca importa tree-sitter diretamente.

Mapa de Relacionamentos do Script

1. structure-reader.ts
   - Tipo: Dependência Inversa
   - Relação: Consome o parser configurado para parsear arquivos.
   - Criticidade: Alta

2. tree-sitter (npm)
   - Tipo: Dependência Direta
   - Relação: Runtime principal do parser.
   - Criticidade: Alta

3. tree-sitter-typescript (npm)
   - Tipo: Dependência Direta
   - Relação: Gramática TypeScript/TSX.
   - Criticidade: Alta

Invariantes do Script

1. O Language Adapter nunca parseia código — apenas retorna o parser configurado.
2. Cada linguagem tem sua própria gramática carregada sob demanda.
3. O parser é cacheado por linguagem para evitar reloads repetidos.
4. Linguagens não suportadas lançam erro claro, não retornam null.
5. O Structure Reader nunca importa tree-sitter — sempre via Language Adapter.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import Parser from 'tree-sitter'
// @ts-ignore — tree-sitter-typescript não possui types declarados no pacote
import TSLanguages from 'tree-sitter-typescript'

// Linguagens suportadas no MVP
export type SupportedLanguage = 'typescript' | 'typescript-react'

const SUPPORTED_LANGUAGES = new Set<SupportedLanguage>(['typescript', 'typescript-react'])

// Mapeamento de extensão de arquivo para linguagem suportada
const EXTENSION_TO_LANGUAGE: Record<string, SupportedLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'typescript-react'
}

// Cache de parsers por linguagem — evita recriar instâncias a cada chamada
const parserCache = new Map<SupportedLanguage, Parser>()

/**
 * Retorna um parser Tree-sitter configurado para a linguagem especificada.
 * Cacheado por linguagem para evitar reloads repetidos.
 * Lança erro para linguagens não suportadas.
 */
export function getParser(language: string): Parser {
  if (!isLanguageSupported(language)) {
    throw new Error(`Language Adapter: linguagem não suportada: "${language}". Suportadas: ${getSupportedLanguages().join(', ')}`)
  }

  const lang = language as SupportedLanguage

  const cached = parserCache.get(lang)
  if (cached) return cached

  // Carrega a gramática correta: typescript para .ts, tsx para .tsx
  // INVARIANT: usar a gramática errada pode causar falhas de parse silenciosas
  const grammar = lang === 'typescript-react' ? TSLanguages.tsx : TSLanguages.typescript

  const parser = new Parser()
  parser.setLanguage(grammar)

  parserCache.set(lang, parser)
  return parser
}

/** Retorna true se a linguagem possui suporte nativo neste adapter. */
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
