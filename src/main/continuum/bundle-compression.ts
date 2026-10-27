import { compressMixed, decompressMixed, extractBlocks } from '@sriinnu/pakt'
import type { BundleCompressionProfile, BundleCompressionReport } from '../../shared/types/continuum-builder-types'
import { countCanonicalTokens } from '../core/tokenizer'

const legend = '> Conteúdo transformado: PAKT 0.10.0 reversível L1–L3. Fontes e revisões continuam históricas.\n> Notação: `@from` indica formato; `[N]{coluna|coluna}` define linhas tabulares separadas por `|`; `@dict` define aliases `$`; `~` repete o valor anterior (delta). Marcadores PAKT guardam o wrapper original. Para recuperação literal, aplique `decompressMixed` de @sriinnu/pakt 0.10.0 ao texto abaixo desta nota. `utf8Bytes` e hashes nas fronteiras referem-se ao original. Nenhuma transformação atravessa fronteiras de fontes.\n\n'

export function compressBundleOutput(original: string, profile: BundleCompressionProfile): { markdown: string; report: BundleCompressionReport } {
  if (!['off', 'light', 'balanced', 'strong'].includes(profile)) throw new Error('INVALID_COMPRESSION_PROFILE')
  const originalTokens = countCanonicalTokens(original).tokenCount
  const fallback = (reason: string) => ({ markdown: original, report: { profile, applied: false, originalTokens, outputTokens: originalTokens, savedTokens: 0, savedPercent: 0, transformedBlocks: 0, reason } })
  if (profile === 'off') return fallback('Compressão desativada')
  if (Buffer.byteLength(original) > 8 * 1024 * 1024) return fallback('Entrada excede o limite operacional de 8 MiB; original preservado')
  // Domain-generated boundaries contain a nonce absent from every source.
  const boundaries = [...original.matchAll(/<!-- BEGIN ([a-f0-9-]+) (\d+) artifact=.*? -->\n([\s\S]*?)\n<!-- END \1 \2 -->/g)]
  const replacements: Array<{ start: number; end: number; text: string }> = []
  const started = Date.now()
  let rejected = 0
  try {
    for (const boundary of boundaries) {
      const body = boundary[3], bodyStart = boundary.index! + boundary[0].indexOf('\n') + 1
      if (body.includes('<!-- PAKT:') || body.includes('<!-- /PAKT -->')) { rejected++; continue }
      for (const block of extractBlocks(body)) {
        if (Date.now() - started > 5000) return fallback('Tempo de compressão excedido; original preservado')
        if (block.startOffset < 0 || block.endOffset > body.length || block.endOffset <= block.startOffset) return fallback('Offsets de bloco inválidos; original preservado')
        const literal = body.slice(block.startOffset, block.endOffset)
        const result = compressMixed(literal, { targetModel: 'gpt-4', maxInputBytes: 8 * 1024 * 1024, layers: { structural: true, dictionary: profile !== 'light', tokenizerAware: profile === 'strong', semantic: false, contentAware: false }, semanticBudget: 0, piiMode: 'off' })
        if (Date.now() - started > 5000) return fallback('Tempo de compressão excedido; original preservado')
        if (result.compressed === literal) continue
        if (!result.reversible || result.compressed.includes('@warning lossy') || !Buffer.from(decompressMixed(result.compressed)).equals(Buffer.from(literal))) { rejected++; continue }
        replacements.push({ start: bodyStart + block.startOffset, end: bodyStart + block.endOffset, text: result.compressed })
      }
    }
    if (!replacements.length) return fallback(rejected ? 'Nenhum trecho com round-trip byte a byte aprovado; original preservado' : 'Nenhum trecho elegível com ganho; original preservado')
    let transformed = original
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) transformed = transformed.slice(0, replacement.start) + replacement.text + transformed.slice(replacement.end)
    if (!Buffer.from(decompressMixed(transformed)).equals(Buffer.from(original))) return fallback('Round-trip integral não comprovado; original preservado')
    if (Date.now() - started > 5000) return fallback('Tempo de compressão excedido; original preservado')
    const markdown = legend + transformed, outputTokens = countCanonicalTokens(markdown).tokenCount
    if (outputTokens >= originalTokens || Buffer.byteLength(markdown) > 8 * 1024 * 1024) return fallback('Sem economia positiva após incluir notação e proveniência; original preservado')
    return { markdown, report: { profile, applied: true, originalTokens, outputTokens, savedTokens: originalTokens - outputTokens, savedPercent: (originalTokens - outputTokens) / originalTokens * 100, transformedBlocks: replacements.length, reason: `${replacements.length} blocos com reconstrução byte a byte comprovada${rejected ? `; ${rejected} trechos preservados sem transformação` : ''}` } }
  } catch { return fallback('Falha de parse ou reconstrução PAKT; original preservado') }
}
