/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar unitariamente a resolução de arquivos de requisições Code Dash em diretórios temporários controlados.
2. Garantir que caminhos exatos, fallbacks por basename, ambiguidades e tentativas de path traversal sejam tratados corretamente.

Mapa de Relacionamentos do Script

1. src/main/core/dash/dash-file-resolver.ts
   - Tipo: Dependência Direta
   - Relação: Instancia e testa os métodos da classe DashFileResolver.
   - Criticidade: Alta

Invariantes do Script

1. Todos os testes devem criar sua própria sandbox temporária e removê-la completamente ao final da execução.
2. Cobrir todos os casos obrigatórios da Sprint 2 para resolução de caminhos.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DashItem } from '../../../shared/types/dash-types'
import { DashFileResolver } from './dash-file-resolver'

describe('DashFileResolver', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-resolver-test-'))

    // Cria estrutura de diretórios e arquivos para teste
    fs.mkdirSync(path.join(tempDir, 'src', 'core'), { recursive: true })
    fs.mkdirSync(path.join(tempDir, 'src', 'utils'), { recursive: true })
    fs.mkdirSync(path.join(tempDir, 'packages', 'pkg-a'), { recursive: true })
    fs.mkdirSync(path.join(tempDir, 'packages', 'pkg-b'), { recursive: true })

    fs.writeFileSync(path.join(tempDir, 'src', 'index.ts'), 'export * from "./core/main"')
    fs.writeFileSync(path.join(tempDir, 'src', 'core', 'main.ts'), 'console.log("main")')
    fs.writeFileSync(path.join(tempDir, 'src', 'utils', 'helper.ts'), 'export const helper = 1')
    fs.writeFileSync(path.join(tempDir, 'packages', 'pkg-a', 'config.json'), '{"pkg": "a"}')
    fs.writeFileSync(path.join(tempDir, 'packages', 'pkg-b', 'config.json'), '{"pkg": "b"}')
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignora erro de limpeza temporária
    }
  })

  it('deve resolver caminho relativo exato existente', () => {
    const resolver = new DashFileResolver(tempDir)
    const items: DashItem[] = [
      { path: 'src/index.ts', representation: 'source' },
      { path: 'src/core/main.ts', representation: 'compression' }
    ]

    const report = resolver.resolve(items)

    expect(report.valid).toBe(true)
    expect(report.failures).toHaveLength(0)
    expect(report.request).not.toBeNull()
    expect(report.request?.items).toEqual([
      { path: 'src/index.ts', representation: 'source' },
      { path: 'src/core/main.ts', representation: 'compression' }
    ])
  })

  it('deve resolver via fallback por basename quando único no repositório', () => {
    const resolver = new DashFileResolver(tempDir)
    // helper.ts está em src/utils/helper.ts, mas o pedido veio como helper.ts ou outro caminho
    const items: DashItem[] = [
      { path: 'helper.ts', representation: 'source' },
      { path: 'wrong/dir/main.ts', representation: 'compression' }
    ]

    const report = resolver.resolve(items)

    expect(report.valid).toBe(true)
    expect(report.failures).toHaveLength(0)
    expect(report.request?.items).toEqual([
      { path: 'src/utils/helper.ts', representation: 'source' },
      { path: 'src/core/main.ts', representation: 'compression' }
    ])
  })

  it('deve marcar como "ambiguous" quando o basename existir em múltiplos locais', () => {
    const resolver = new DashFileResolver(tempDir)
    // config.json existe em packages/pkg-a/config.json e packages/pkg-b/config.json
    const items: DashItem[] = [
      { path: 'config.json', representation: 'source' }
    ]

    const report = resolver.resolve(items)

    expect(report.valid).toBe(false)
    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]).toEqual({
      index: 0,
      path: 'config.json',
      reason: 'ambiguous'
    })
  })

  it('deve marcar como "not_found" quando o arquivo não existir no repositório', () => {
    const resolver = new DashFileResolver(tempDir)
    const items: DashItem[] = [
      { path: 'non-existent-file.ts', representation: 'source' }
    ]

    const report = resolver.resolve(items)

    expect(report.valid).toBe(false)
    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]).toEqual({
      index: 0,
      path: 'non-existent-file.ts',
      reason: 'not_found'
    })
  })

  it('deve bloquear path traversal que tenta escapar do repositório', () => {
    const resolver = new DashFileResolver(tempDir)
    const items: DashItem[] = [
      { path: '../../etc/passwd', representation: 'source' },
      { path: '../outside.txt', representation: 'compression' }
    ]

    const report = resolver.resolve(items)

    expect(report.valid).toBe(false)
    expect(report.failures).toHaveLength(2)
    expect(report.failures[0].reason).toBe('path_traversal')
    expect(report.failures[1].reason).toBe('path_traversal')
  })

  it('deve processar mix de itens resolvidos e não resolvidos preservando posições', () => {
    const resolver = new DashFileResolver(tempDir)
    const items: DashItem[] = [
      { path: 'src/index.ts', representation: 'source' },       // 0: resolvido exato
      { path: 'config.json', representation: 'source' },        // 1: ambíguo
      { path: 'helper.ts', representation: 'compression' },     // 2: resolvido fallback
      { path: 'unknown.ts', representation: 'source' }          // 3: not_found
    ]

    const report = resolver.resolve(items)

    expect(report.valid).toBe(false)
    expect(report.failures).toHaveLength(2)
    expect(report.failures).toEqual([
      { index: 1, path: 'config.json', reason: 'ambiguous' },
      { index: 3, path: 'unknown.ts', reason: 'not_found' }
    ])

    expect(report.request).not.toBeNull()
    expect(report.request?.items).toEqual([
      { path: 'src/index.ts', representation: 'source' },
      { path: 'src/utils/helper.ts', representation: 'compression' }
    ])
  })
})
