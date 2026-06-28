/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar as funções assíncronas do sistema de classificação de importância (scoreByContent, calculateRepoFingerprint) que realizam operações de I/O.
2. Garantir testes de E/S limpos usando diretório temporário dinâmico.

Mapa de Relacionamentos do Script

1. ../importance-heuristics.ts
   - Tipo: Dependência Direta
   - Relação: Módulo que contém scoreByContent.
   - Criticidade: Alta

2. ../importance-fingerprint.ts
   - Tipo: Dependência Direta
   - Relação: Módulo que contém calculateRepoFingerprint.
   - Criticidade: Alta

Invariantes do Script

1. O diretório temporário criado para os testes deve ser completamente deletado após a execução.
2. Erros e arquivos inexistentes devem ser tratados de forma resiliente conforme a implementação.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { scoreByContent } from '../importance-heuristics'
import { calculateRepoFingerprint } from '../importance-fingerprint'

describe('Camada 3: scoreByContent', () => {
  let testDir: string

  beforeEach(() => {
    // Cria um diretório temporário único para testes de E/S
    testDir = join(tmpdir(), `test-importance-${Date.now()}`)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    // Remove completamente o diretório temporário para evitar poluição
    rmSync(testDir, { recursive: true, force: true })
  })

  it('deve dar +5 para arquivos com JSDoc no topo', async () => {
    const filePath = join(testDir, 'test.ts')
    // Escreve mais de 10 linhas para evitar a penalidade de arquivo muito pequeno
    writeFileSync(
      filePath,
      `/**\n * Este é um comentário JSDoc\n */\n` + Array(15).fill('const x = 1').join('\n')
    )
    
    const score = await scoreByContent(testDir, 'test.ts')
    expect(score).toBeGreaterThanOrEqual(5)
  })

  it('deve dar -5 para arquivos muito pequenos (<10 linhas)', async () => {
    const filePath = join(testDir, 'small.ts')
    writeFileSync(filePath, 'const x = 1\n')
    
    const score = await scoreByContent(testDir, 'small.ts')
    expect(score).toBe(-5)
  })

  it('deve dar +5 para arquivos de tamanho saudável (100-500 linhas)', async () => {
    const filePath = join(testDir, 'medium.ts')
    // Preenche com 150 linhas para atender o tamanho saudável
    const content = Array(150).fill('const x = 1').join('\n')
    writeFileSync(filePath, content)
    
    const score = await scoreByContent(testDir, 'medium.ts')
    expect(score).toBeGreaterThanOrEqual(5)
  })

  it('deve dar -5 para arquivos muito grandes (>1000 linhas)', async () => {
    const filePath = join(testDir, 'large.ts')
    // Preenche com 1200 linhas para disparar a penalidade de arquivo muito grande
    const content = Array(1200).fill('const x = 1').join('\n')
    writeFileSync(filePath, content)
    
    const score = await scoreByContent(testDir, 'large.ts')
    expect(score).toBeLessThanOrEqual(-5)
  })

  it('deve retornar 0 para arquivo inexistente', async () => {
    // Se o arquivo não existir, deve tratar de forma graciosa retornando pontuação 0
    const score = await scoreByContent(testDir, 'missing.ts')
    expect(score).toBe(0)
  })
})

describe('calculateRepoFingerprint', () => {
  let testDir: string

  beforeEach(() => {
    // Cria um diretório temporário único para testes de fingerprint
    testDir = join(tmpdir(), `test-fingerprint-${Date.now()}`)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    // Limpeza após o término do teste
    rmSync(testDir, { recursive: true, force: true })
  })

  it('deve retornar hash consistente para o mesmo package.json', async () => {
    writeFileSync(join(testDir, 'package.json'), '{"name": "test", "version": "1.0.0"}')
    
    const hash1 = await calculateRepoFingerprint(testDir)
    const hash2 = await calculateRepoFingerprint(testDir)
    
    expect(hash1).toBe(hash2)
    expect(hash1).toMatch(/^[a-f0-9]{64}$/) // Padrão SHA-256 em hexadecimal
  })

  it('deve retornar hash diferente quando package.json muda', async () => {
    writeFileSync(join(testDir, 'package.json'), '{"name": "test", "version": "1.0.0"}')
    const hash1 = await calculateRepoFingerprint(testDir)
    
    writeFileSync(join(testDir, 'package.json'), '{"name": "test", "version": "2.0.0"}')
    const hash2 = await calculateRepoFingerprint(testDir)
    
    expect(hash1).not.toBe(hash2)
  })

  it('deve lançar erro para repo inexistente', async () => {
    await expect(calculateRepoFingerprint('/nonexistent/path')).rejects.toThrow()
  })

  it('deve usar fallback quando não há manifesto', async () => {
    // Repo sem manifestos listados deve cair no fallback do README.md
    writeFileSync(join(testDir, 'README.md'), '# Test')
    
    const hash = await calculateRepoFingerprint(testDir)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })
})
