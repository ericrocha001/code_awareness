import { expect, it, vi } from 'vitest'
import { decompressMixed } from '@sriinnu/pakt'
import { compressBundleOutput } from './bundle-compression'
import type { BundleCompressionProfile } from '../../shared/types/continuum-builder-types'
const boundary = '01234567-abcd-1234-eeee-012345678901'
const wrap = (body: string) => `# Context Bundle\nHistorical source, hash abc123 revision 7\n<!-- BEGIN ${boundary} 1 artifact="source" revision=7 utf8Bytes=${Buffer.byteLength(body)} -->\n${body}\n<!-- END ${boundary} 1 -->\n`
const rows = Array.from({ length: 80 }, (_, index) => ({ id: index, name: 'Não alterar contrato, revisão e hash abc123 🚀', status: 'ACTIVE', type: 'Arquivo arquitetural português', enabled: false }))
const structured = '```json\n' + JSON.stringify(rows, null, 2) + '\n```\n'
const architecture = '---\nname: Arquitetura\nkind: DOCUMENT\nstatus: PENDING\n---\n# Contrato\n\nNão remover negações nem alterar IDs. Unicode ç 日本語 🚀.\n\n| Coluna | Valor |\n| --- | --- |\n| hash | abc123 |\n\n```diff\n- const enabled = true\n+ const enabled = false\n```\n\n```ts\nconst hash = "abc123"\n```\n'
it.each(['light', 'balanced', 'strong'] as BundleCompressionProfile[])('round-trips every modified byte with %s and leaves provenance, prose, YAML, diffs and visual references literal', profile => {
  const original = wrap(architecture + structured + '\nWebP original: media/source.webp\n')
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('NETWORK_FORBIDDEN') })
  try {
    const result = compressBundleOutput(original, profile)
    expect(result.report.applied).toBe(true)
    expect(result.report.savedTokens).toBeGreaterThan(0)
    const transformed = result.markdown.slice(result.markdown.indexOf('# Context Bundle'))
    expect(Buffer.from(decompressMixed(transformed))).toEqual(Buffer.from(original))
    expect(result.markdown).toContain(architecture)
    expect(result.markdown).toContain('WebP original: media/source.webp')
    expect(result.markdown).not.toContain('@warning lossy')
    expect(fetch).not.toHaveBeenCalled()
    expect(compressBundleOutput(original, profile)).toEqual(result)
  } finally { fetch.mockRestore() }
})
it('keeps exact originals for disabled, noneligible, no gain, malformed and non-byte-stable inputs', () => {
  for (const body of ['Prosa curta. Não alterar. ç 🚀', '```json\n{bad JSON}\n```', '```json\n'+JSON.stringify(rows)+'\n```', '```yaml\na: 1\nb: 2\n```']) {
    const original = wrap(body), result = compressBundleOutput(original, 'strong')
    expect(result.markdown).toBe(original); expect(result.report.applied).toBe(false)
    expect(result.report.savedTokens).toBe(0)
  }
  expect(compressBundleOutput(wrap(structured), 'off').markdown).toBe(wrap(structured))
  expect(compressBundleOutput(structured, 'strong').markdown).toBe(structured)
  expect(() => compressBundleOutput(wrap(structured), 'semantic' as BundleCompressionProfile)).toThrow('INVALID_COMPRESSION_PROFILE')
})
