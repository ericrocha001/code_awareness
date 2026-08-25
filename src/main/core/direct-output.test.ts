/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Testar o comportamento do caminho Direct Output (markdown/xml) sob concorrência e verificar deduplicação via directInFlight.
2. Validar o tratamento de falhas, timeouts e respostas degeneradas (stdout vazio) no Direct Output.
3. Garantir o repasse correto de opções de transformação do CompressionProfile para a CLI.
4. Testar o comportamento do Direct Output sob diferentes volumes de arquivos selecionados (1, 10 e 50 arquivos).
5. Validar o comportamento de defesa em profundidade quando um OutputFormat inválido for fornecido em runtime.

Mapa de Relacionamentos do Script

1. compression-service.ts
   - Tipo: Dependência Direta
   - Relação: Instancia e testa o CompressionService no caminho Direct Output.
   - Criticidade: Alta

2. repomix-adapter.ts
   - Tipo: Dependência Direta
   - Relação: Fornece o mock do RepomixAdapter e os tipos de execução para os testes.
   - Criticidade: Alta

3. compression-constants.ts
   - Tipo: Dependência Direta
   - Relação: Consome COMPRESSION_TOTAL_FAILURE_MARKER para asserções de falha total.
   - Criticidade: Alta

Invariantes do Script

1. Todos os diretórios temporários criados nos testes são limpos no hook afterEach.
2. O mock do adapter não invoca a CLI real do sistema durante os testes unitários.
3. Falhas no Direct Output devem sempre retornar uma mensagem iniciando com COMPRESSION_TOTAL_FAILURE_MARKER.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { CompressionService } from './compression-service'
import { COMPRESSION_TOTAL_FAILURE_MARKER } from './compression-constants'
import { RepomixAdapter } from './repomix-adapter'
import type { RepomixRequest } from './repomix-request'
import type { CompressionProfile, OutputFormat } from '../../shared/types'
import { DEFAULT_PROFILE } from './compression-profile'

// =============================================================================
// Helpers de teste
// =============================================================================

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'direct_output_test_'))
}

function createFile(dir: string, relativePath: string, content: string): string {
  const fullPath = join(dir, relativePath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content, 'utf-8')
  return fullPath
}

async function cleanupDir(dir: string): Promise<void> {
  if (dir && existsSync(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Ignora erro de remoção transitória no Windows
    }
  }
}

// =============================================================================
// Mock do RepomixAdapter para Direct Output
// =============================================================================

class MockDirectRepomixAdapter implements RepomixAdapter {
  private _directCallCount = 0
  private _batchCallCount = 0
  private _singleCallCount = 0
  private _directResult: { content: string; failed: boolean; reason?: string } = {
    content: '# Direct Markdown Output',
    failed: false
  }
  private _throwOnDirect = false
  private _delayMs = 0
  private _capturedRequests: RepomixRequest[] = []

  get directCallCount(): number {
    return this._directCallCount
  }
  get batchCallCount(): number {
    return this._batchCallCount
  }
  get singleCallCount(): number {
    return this._singleCallCount
  }
  get capturedRequests(): RepomixRequest[] {
    return this._capturedRequests
  }

  setDirectResult(result: { content: string; failed: boolean; reason?: string }): void {
    this._directResult = result
  }

  setThrowOnDirect(shouldThrow: boolean): void {
    this._throwOnDirect = shouldThrow
  }

  setDelay(ms: number): void {
    this._delayMs = ms
  }

  async generateDirectOutput(
    request: RepomixRequest
  ): Promise<{ content: string; failed: boolean; reason?: string }> {
    this._directCallCount++
    this._capturedRequests.push(request)
    if (this._delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this._delayMs))
    }
    if (this._throwOnDirect) {
      throw new Error('Timeout simulado no Repomix Adapter (Direct Output)')
    }
    return this._directResult
  }

  async compressMultipleFiles(_request: RepomixRequest): Promise<Record<string, string>> {
    this._batchCallCount++
    return {}
  }

  async compressSingleFile(_request: RepomixRequest, _relativePath: string): Promise<string> {
    this._singleCallCount++
    return ''
  }

  async checkInstallation(): Promise<boolean> {
    return true
  }

  parseBatchOutput(_stdout: string): Record<string, string> { return {} }
  parseJsonOutput(_stdout: string): Record<string, string> { return {} }
}

// =============================================================================
// Suíte de Testes Dedicada: Direct Output
// =============================================================================

describe('Direct Output — Suíte Dedicada de Robustez e Concorrência', () => {
  let tempDir: string = ''

  afterEach(async () => {
    if (tempDir) {
      await cleanupDir(tempDir)
      tempDir = ''
    }
  })

  // 1. Concorrência de chamadas idênticas (deduplicação via directInFlight)
  describe('Deduplicação de chamadas concorrentes (directInFlight)', () => {
    it('duas chamadas idênticas simultâneas em markdown compartilham a Promise e executam o adapter apenas uma vez', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'file1.ts', 'const a = 1')
      createFile(tempDir, 'file2.ts', 'const b = 2')

      const mock = new MockDirectRepomixAdapter()
      mock.setDelay(50) // Adiciona delay para garantir concorrência
      mock.setDirectResult({ content: '# Shared Markdown', failed: false })

      const service = new CompressionService(mock)

      const [res1, res2] = await Promise.all([
        service.generateCompressionMarkdown(tempDir, ['file1.ts', 'file2.ts'], undefined, 'markdown'),
        service.generateCompressionMarkdown(tempDir, ['file1.ts', 'file2.ts'], undefined, 'markdown')
      ])

      expect(mock.directCallCount).toBe(1)
      expect(mock.batchCallCount).toBe(0)
      expect(res1).toBe(res2)
      expect(res1).toContain('# Shared Markdown')
    })

    it('duas chamadas simultâneas com formatos diferentes NÃO compartilham a mesma Promise', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'file1.ts', 'const a = 1')

      const mock = new MockDirectRepomixAdapter()
      mock.setDelay(30)
      mock.setDirectResult({ content: 'Documento gerado', failed: false })

      const service = new CompressionService(mock)

      const [resMd, resXml] = await Promise.all([
        service.generateCompressionMarkdown(tempDir, ['file1.ts'], undefined, 'markdown'),
        service.generateCompressionMarkdown(tempDir, ['file1.ts'], undefined, 'xml')
      ])

      expect(mock.directCallCount).toBe(2)
      expect(resMd).toContain('Documento gerado')
      expect(resXml).toContain('Documento gerado')
    })
  })

  // 2. Falhas e cenários adversos do Adapter
  describe('Tratamento de Falhas e Erros de Processo', () => {
    it('quando o adapter lança erro (ex: timeout simulado), retorna COMPRESSION_TOTAL_FAILURE_MARKER com a mensagem', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'file1.ts', 'const a = 1')

      const mock = new MockDirectRepomixAdapter()
      mock.setThrowOnDirect(true)

      const service = new CompressionService(mock)
      const result = await service.generateCompressionMarkdown(tempDir, ['file1.ts'], undefined, 'markdown')

      expect(result.startsWith(COMPRESSION_TOTAL_FAILURE_MARKER)).toBe(true)
      expect(result).toContain('Timeout simulado no Repomix Adapter')
    })

    it('quando o adapter retorna failed: true, retorna COMPRESSION_TOTAL_FAILURE_MARKER com a razão', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'file1.ts', 'const a = 1')

      const mock = new MockDirectRepomixAdapter()
      mock.setDirectResult({ content: '', failed: true, reason: 'Repomix falhou com exitCode 1' })

      const service = new CompressionService(mock)
      const result = await service.generateCompressionMarkdown(tempDir, ['file1.ts'], undefined, 'xml')

      expect(result.startsWith(COMPRESSION_TOTAL_FAILURE_MARKER)).toBe(true)
      expect(result).toContain('Repomix falhou com exitCode 1')
    })

    it('quando o adapter retorna stdout vazio com exit code 0 (caso degenerado), trata como falha total', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'file1.ts', 'const a = 1')

      const mock = new MockDirectRepomixAdapter()
      mock.setDirectResult({ content: '', failed: false })

      const service = new CompressionService(mock)
      const result = await service.generateCompressionMarkdown(tempDir, ['file1.ts'], undefined, 'markdown')

      expect(result.startsWith(COMPRESSION_TOTAL_FAILURE_MARKER)).toBe(true)
      expect(result).toContain('Falha ao gerar Direct Output')
    })
  })

  // 3. Propagação de Profile e Flags de Transformação
  describe('Propagação de Configurações do CompressionProfile', () => {
    it('repassa flags como removeComments e removeEmptyLines no RepomixRequest para o Direct Output', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'main.ts', 'const m = 1')

      const mock = new MockDirectRepomixAdapter()
      mock.setDirectResult({ content: '# Clean Markdown', failed: false })

      const service = new CompressionService(mock)
      const customProfile: CompressionProfile = {
        ...DEFAULT_PROFILE,
        removeComments: true,
        removeEmptyLines: true,
        truncateBase64: true
      }

      await service.generateCompressionMarkdown(tempDir, ['main.ts'], customProfile, 'markdown')

      expect(mock.capturedRequests.length).toBe(1)
      const captured = mock.capturedRequests[0]
      expect(captured.profile.removeComments).toBe(true)
      expect(captured.profile.removeEmptyLines).toBe(true)
      expect(captured.profile.truncateBase64).toBe(true)
      expect(captured.outputFormat).toBe('markdown')
      expect(captured.selectedFiles).toEqual(['main.ts'])
    })
  })

  // 4. Variação na quantidade de arquivos selecionados
  describe('Volume de Arquivos Selecionados', () => {
    it('processa corretamente seleção de 1 arquivo', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'single.ts', 'export const s = 1')

      const mock = new MockDirectRepomixAdapter()
      mock.setDirectResult({ content: '# Single File Output', failed: false })

      const service = new CompressionService(mock)
      const result = await service.generateCompressionMarkdown(tempDir, ['single.ts'], undefined, 'markdown')

      expect(mock.directCallCount).toBe(1)
      expect(result).toContain('# Single File Output')
    })

    it('processa corretamente seleção de 10 arquivos', async () => {
      tempDir = createTempDir()
      const files: string[] = []
      for (let i = 0; i < 10; i++) {
        const name = `file_${i}.ts`
        createFile(tempDir, name, `const v${i} = ${i}`)
        files.push(name)
      }

      const mock = new MockDirectRepomixAdapter()
      mock.setDirectResult({ content: '# 10 Files Output', failed: false })

      const service = new CompressionService(mock)
      const result = await service.generateCompressionMarkdown(tempDir, files, undefined, 'xml')

      expect(mock.directCallCount).toBe(1)
      expect(mock.capturedRequests[0].selectedFiles.length).toBe(10)
      expect(result).toContain('# 10 Files Output')
    })

    it('processa corretamente seleção de 50 arquivos em uma única chamada de Direct Output', async () => {
      tempDir = createTempDir()
      const files: string[] = []
      for (let i = 0; i < 50; i++) {
        const name = `batch_${i}.ts`
        createFile(tempDir, name, `const b${i} = ${i}`)
        files.push(name)
      }

      const mock = new MockDirectRepomixAdapter()
      mock.setDirectResult({ content: '# 50 Files Direct Output', failed: false })

      const service = new CompressionService(mock)
      const result = await service.generateCompressionMarkdown(tempDir, files, undefined, 'markdown')

      expect(mock.directCallCount).toBe(1)
      expect(mock.batchCallCount).toBe(0) // Direct Output não fragmenta em batches do Core
      expect(mock.capturedRequests[0].selectedFiles.length).toBe(50)
      expect(result).toContain('# 50 Files Direct Output')
    })
  })

  // 5. Defesa em profundidade para formato inválido
  describe('Defesa em Profundidade para OutputFormat', () => {
    it('formato inválido em runtime é sanitizado para plain (cai no Compression Core com segurança)', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'safe.ts', 'const s = 10')

      const mock = new MockDirectRepomixAdapter()
      const service = new CompressionService(mock)

      // Passa formato inválido forçado via cast
      await service.generateCompressionMarkdown(
        tempDir,
        ['safe.ts'],
        undefined,
        'invalid-format' as unknown as OutputFormat
      )

      // Não deve chamar o Direct Output; cai no Compression Core
      expect(mock.directCallCount).toBe(0)
      expect(mock.batchCallCount).toBe(1)
    })
  })

  // 6. Contrato de formato no Direct Output
  describe('Contrato de Formato no Direct Output', () => {
    it('markdown mantém o envelope completo (cabeçalho, blockquote e enrichment)', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', 'const a = 1')

      const mock = new MockDirectRepomixAdapter()
      mock.setDirectResult({ content: '# Corpo do documento', failed: false })
      const service = new CompressionService(mock)

      const result = await service.generateCompressionMarkdown(
        tempDir, ['a.ts'], undefined, 'markdown',
        { headerText: 'HEADER-ENRICHMENT' }
      )

      expect(result).toContain('# Code Compression —')
      expect(result).toContain('> Este documento contém o esqueleto estrutural (Code Compression) dos arquivos solicitados.')
      expect(result).toContain('## 📋 Contexto Adicional')
      expect(result).toContain('HEADER-ENRICHMENT')
      expect(result).toContain('# Corpo do documento')
    })

    it('xml não recebe envelope — passthrough puro do conteúdo do Repomix', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', 'const a = 1')

      const mock = new MockDirectRepomixAdapter()
      mock.setDirectResult({ content: '<repository><files>conteúdo xml</files></repository>', failed: false })
      const service = new CompressionService(mock)

      const result = await service.generateCompressionMarkdown(
        tempDir, ['a.ts'], undefined, 'xml',
        { headerText: 'NAO-DEVE-APARECER' }
      )

      expect(result).toBe('<repository><files>conteúdo xml</files></repository>')
      expect(result).not.toContain('# Code Compression —')
      expect(result).not.toContain('> Este documento contém')
      expect(result).not.toContain('## 📋 Contexto Adicional')
    })

    it('enrichment é ignorado quando o formato é xml', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', 'const a = 1')

      const mock = new MockDirectRepomixAdapter()
      mock.setDirectResult({ content: '<repository/>', failed: false })
      const service = new CompressionService(mock)

      const result = await service.generateCompressionMarkdown(
        tempDir, ['a.ts'], undefined, 'xml',
        { headerText: 'HEADER-XML-INVÁLIDO' }
      )

      // Nenhuma seção de enrichment (Markdown) pode vazar para dentro do XML.
      expect(result).not.toContain('HEADER-XML-INVÁLIDO')
      expect(result).not.toContain('## 📋 Contexto Adicional')
      expect(result).not.toContain('## 📖 Instruções')
      expect(result).not.toContain('## 🔀 Alterações Recentes')
    })

    it('sentinela de falha total é universal, inclusive no xml', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', 'const a = 1')

      const mock = new MockDirectRepomixAdapter()
      mock.setDirectResult({ content: '', failed: true, reason: 'Repomix falhou (código 1)' })
      const service = new CompressionService(mock)

      const result = await service.generateCompressionMarkdown(tempDir, ['a.ts'], undefined, 'xml')

      expect(result.startsWith(COMPRESSION_TOTAL_FAILURE_MARKER)).toBe(true)
      expect(result).toContain('Repomix falhou (código 1)')
    })

    it('json não recebe envelope — passthrough puro do documento JSON do Repomix', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', 'const a = 1')

      const mock = new MockDirectRepomixAdapter()
      mock.setDirectResult({ content: '{"files":[{"path":"a.ts"}]}', failed: false })
      const service = new CompressionService(mock)

      const result = await service.generateCompressionMarkdown(
        tempDir, ['a.ts'], undefined, 'json',
        { headerText: 'NAO-DEVE-APARECER' }
      )

      // Passthrough puro: JSON real sem envelope Markdown, sem enrichment.
      expect(result).toBe('{"files":[{"path":"a.ts"}]}')
      expect(result).not.toContain('# Code Compression —')
      expect(result).not.toContain('> Este documento contém')
      expect(result).not.toContain('## 📋 Contexto Adicional')
    })

    it('enrichment é ignorado quando o formato é json', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', 'const a = 1')

      const mock = new MockDirectRepomixAdapter()
      mock.setDirectResult({ content: '{"ok":true}', failed: false })
      const service = new CompressionService(mock)

      const result = await service.generateCompressionMarkdown(
        tempDir, ['a.ts'], undefined, 'json',
        { headerText: 'HEADER-JSON-INVÁLIDO' }
      )

      // Nenhuna seção de enrichment (Markdown) pode vazar para dentro do JSON.
      expect(result).not.toContain('HEADER-JSON-INVÁLIDO')
      expect(result).not.toContain('## 📋 Contexto Adicional')
      expect(result).not.toContain('## 📖 Instruções')
    })

    it('sentinela de falha total é universal, inclusive no json', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', 'const a = 1')

      const mock = new MockDirectRepomixAdapter()
      mock.setDirectResult({ content: '', failed: true, reason: 'Repomix falhou (código 1)' })
      const service = new CompressionService(mock)

      const result = await service.generateCompressionMarkdown(tempDir, ['a.ts'], undefined, 'json')

      expect(result.startsWith(COMPRESSION_TOTAL_FAILURE_MARKER)).toBe(true)
      expect(result).toContain('Repomix falhou (código 1)')
    })

    it('paridade de transporte: mesma seleção/perfil/formato geram o mesmo envelope e conteúdo', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', 'const a = 1')
      createFile(tempDir, 'b.ts', 'const b = 2')

      const mock = new MockDirectRepomixAdapter()
      mock.setDirectResult({ content: '# Repomix markdown idêntico', failed: false })
      const service = new CompressionService(mock)

      const res1 = await service.generateCompressionMarkdown(tempDir, ['a.ts', 'b.ts'], undefined, 'markdown')
      const res2 = await service.generateCompressionMarkdown(tempDir, ['a.ts', 'b.ts'], undefined, 'markdown')

      expect(mock.directCallCount).toBe(2)
      // Normaliza a linha de data/timestamp antes de comparar, pois as duas chamadas
      // podem atravessar um limite de segundo (new Date().toLocaleString).
      const stripDate = (s: string): string => s.replace(/^# Code Compression — \[.*\] \(.*\)/m, '# HEADER')
      expect(stripDate(res1)).toBe(stripDate(res2))
      expect(res1).toContain('# Code Compression —')
      expect(res1).toContain('# Repomix markdown idêntico')
    })
  })
})
