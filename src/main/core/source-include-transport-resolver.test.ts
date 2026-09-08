/*
-T ---
*/

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  SourceIncludeTransportResolver,
  SOURCE_MAX_COMMAND_LINE_BUDGET
} from './source-include-transport-resolver'

describe('SourceIncludeTransportResolver', () => {
  const resolver = new SourceIncludeTransportResolver()

  describe('decide — Decisão de Transporte', () => {
    it('retorna inline-include para seleções cuja estimativa fica abaixo do orçamento', () => {
      // Arquivo único curto — estimativa muito inferior ao orçamento de 6000 bytes.
      const result = resolver.decide(['src/a.ts'])
      expect(result).toBe('inline-include')
    })

    it('retorna config-file para seleções cuja estimativa excede o orçamento', () => {
      // Gerar arquivos suficientes para ultrapassar o orçamento de 6000 bytes.
      // 400 arquivos produzem estimativa ~9913 bytes (verificado).
      const manyFiles = Array.from({ length: 400 }, (_, i) => `src/module-${i}/index.ts`)
      const result = resolver.decide(manyFiles)
      expect(result).toBe('config-file')
    })

    it('estimativa exatamente igual ao orçamento permanece inline-include (condição é estritamente maior)', () => {
      // Construir seleção que produza estimativa exatamente igual ao orçamento.
      // Fórmula: byteLength('repomix.cmd') + 1 + 400 + byteLength('--include') + 1 + byteLength(joined) + 2
      // = 11 + 1 + 400 + 9 + 1 + byteLength(joined) + 2 = 424 + byteLength(joined)
      // Para estimativa = 6000: byteLength(joined) = 6000 - 424 = 5576
      const overhead = 11 + 1 + 400 + 9 + 1 + 2 // 424
      const targetJoinedBytes = SOURCE_MAX_COMMAND_LINE_BUDGET - overhead
      // Criar um arquivo único cujo nome tenha exatamente targetJoinedBytes bytes (ASCII)
      const fileName = 'a'.repeat(targetJoinedBytes)
      const estimate = resolver.estimateInlineBytes([fileName])
      expect(estimate).toBe(SOURCE_MAX_COMMAND_LINE_BUDGET)
      expect(resolver.decide([fileName])).toBe('inline-include')
    })
  })

  describe('estimateInlineBytes — Fórmula de Estimativa', () => {
    it('produz o valor esperado pela fórmula para uma seleção conhecida', () => {
      const files = ['src/a.ts', 'src/b.ts']
      const joinedBytes = Buffer.byteLength('src/a.ts,src/b.ts', 'utf8')
      const expected =
        Buffer.byteLength('repomix.cmd', 'utf8') + // 11
        1 +                                          // separador
        400 +                                        // overhead fixo
        Buffer.byteLength('--include', 'utf8') +     // 9
        1 +                                          // separador
        joinedBytes +
        2                                            // bytes finais

      expect(resolver.estimateInlineBytes(files)).toBe(expected)
    })
  })

  describe('createTempConfigFile — Criação do Config Temporário', () => {
    it('cria arquivo no diretório temporário com conteúdo JSON correto e retorna caminho existente', () => {
      const files = ['src/a.ts', 'src/b.ts']
      let configPath: string | undefined
      try {
        configPath = resolver.createTempConfigFile(files)

        expect(configPath).toBeTruthy()
        expect(configPath).toContain('code-source-cfg-')
        expect(existsSync(configPath)).toBe(true)

        const content = JSON.parse(readFileSync(configPath, 'utf8'))
        expect(content).toEqual({ include: files })
      } finally {
        if (configPath && existsSync(configPath)) {
          unlinkSync(configPath)
        }
      }
    })
  })

  describe('removeTempConfigFile — Remoção do Config Temporário', () => {
    it('remove um arquivo existente com sucesso', () => {
      const tempPath = join(tmpdir(), `test-remove-${Date.now()}.json`)
      writeFileSync(tempPath, '{}', 'utf8')
      expect(existsSync(tempPath)).toBe(true)

      resolver.removeTempConfigFile(tempPath)

      expect(existsSync(tempPath)).toBe(false)
    })

    it('não lança ao receber caminho inexistente', () => {
      const fakePath = join(tmpdir(), `nonexistent-${Date.now()}.json`)
      expect(() => resolver.removeTempConfigFile(fakePath)).not.toThrow()
    })
  })
})
