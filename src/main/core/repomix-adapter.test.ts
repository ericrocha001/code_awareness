/*
-T ---
*/

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { tmpdir } from 'os'
import { RepomixAdapter } from './repomix-adapter'
import { RepomixProcessRunner } from './repomix-process-runner'
import type { ProcessRunnerResult, ProcessRunnerOptions } from './repomix-process-runner'
import { buildRepomixRequest } from './repomix-arguments-builder'
import { resolveEffectiveProfile } from './effective-profile'
import { DEFAULT_PROFILE } from './compression-profile'
import type { RepomixRequest } from './repomix-request'
import type { OutputFormat, CompressionProfile } from '../../shared/types'

// =============================================================================
// Helpers de teste
// =============================================================================

type RunnerBehavior = 'success' | 'throw' | 'nonzero'

class RecordingRunner extends RepomixProcessRunner {
  calls: Array<{ command: string; args: string[]; cwd: string }> = []
  behavior: RunnerBehavior = 'success'
  stdout = '<documento-stub>'
  throwMessage = 'runner boom'
  nonzeroExitCode = 1
  nonzeroStderr = 'falha'
  collectConfigs = false
  configs: Array<{ configPath: string; include: string[] }> = []
  observer: ((args: string[]) => void) | undefined

  async run(
    command: string,
    args: string[],
    options: ProcessRunnerOptions
  ): Promise<ProcessRunnerResult> {
    this.calls.push({ command, args, cwd: options.cwd })

    const configIndex = args.indexOf('--config')
    if (configIndex !== -1 && this.collectConfigs) {
      const configPath = args[configIndex + 1]
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { include?: string[] }
      this.configs.push({ configPath, include: parsed.include ?? [] })
    }
    if (this.observer) this.observer(args)

    if (this.behavior === 'throw') {
      throw new Error(this.throwMessage)
    }
    if (this.behavior === 'nonzero') {
      return { stdout: this.stdout, stderr: this.nonzeroStderr, exitCode: this.nonzeroExitCode }
    }
    return { stdout: this.stdout, stderr: '', exitCode: 0 }
  }
}

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'repomix_adapter_test_'))
}

function createFile(dir: string, relativePath: string, content: string): void {
  const fullPath = join(dir, relativePath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content, 'utf-8')
}

async function cleanupDir(dir: string): Promise<void> {
  if (dir && existsSync(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // remoção transitória no Windows — ignorar
    }
  }
}

function makeRequest(
  repoPath: string,
  files: string[],
  format: OutputFormat = 'markdown',
  profileOverrides: Partial<CompressionProfile> = {}
): RepomixRequest {
  const profile = resolveEffectiveProfile({ ...DEFAULT_PROFILE, ...profileOverrides }, format)
  return buildRepomixRequest(repoPath, files, profile, format)
}

function shortFiles(): string[] {
  return ['main.ts', 'lib.ts', 'util.ts']
}

function longFiles(count = 500, segmentLen = 120): string[] {
  return Array.from({ length: count }, (_, i) => `src/module_${'x'.repeat(segmentLen)}_${i}.ts`)
}

// =============================================================================
// Suíte
// =============================================================================

describe('RepomixAdapter — Transporte Seguro e Orçamento da Linha de Comando', () => {
  let repoDir = ''

  afterEach(async () => {
    await cleanupDir(repoDir)
    repoDir = ''
  })

  // 1. Seleção pequena usa --include
  it('seleção pequena usa --include e não --config', async () => {
    repoDir = createTempDir()
    const runner = new RecordingRunner()
    const adapter = new RepomixAdapter(runner)

    const result = await adapter.generateDirectOutput(makeRequest(repoDir, shortFiles(), 'markdown'))

    expect(runner.calls.length).toBe(1)
    expect(runner.calls[0].args).toContain('--include')
    expect(runner.calls[0].args).not.toContain('--config')
    expect(runner.calls[0].cwd).toBe(resolve(repoDir))
    expect(result.failed).toBe(false)
  })

  // 2. Seleção grande usa --config
  it('seleção grande usa --config com {"include": [...]} exato', async () => {
    repoDir = createTempDir()
    const selected = longFiles(500, 120)
    const runner = new RecordingRunner()
    runner.collectConfigs = true
    const adapter = new RepomixAdapter(runner)

    const result = await adapter.generateDirectOutput(makeRequest(repoDir, selected, 'markdown'))

    expect(runner.calls.length).toBe(1)
    expect(runner.calls[0].args).toContain('--config')
    expect(runner.calls[0].args).not.toContain('--include')
    expect(runner.configs.length).toBe(1)
    expect(runner.configs[0].include).toEqual(selected)
    expect(result.failed).toBe(false)
    expect(result.content).toBe('<documento-stub>')
  })

  // 3. Arquivo temporário existe durante a execução e some após
  it('arquivo temporário existe no momento do run e some após gerar', async () => {
    repoDir = createTempDir()
    const selected = longFiles(500, 120)
    const runner = new RecordingRunner()
    let pathDuringRun = ''
    let existedDuringRun = false
    runner.observer = (args) => {
      if (args.indexOf('--config') !== -1) {
        pathDuringRun = args[args.indexOf('--config') + 1]
        existedDuringRun = existsSync(pathDuringRun)
      }
    }
    const adapter = new RepomixAdapter(runner)

    await adapter.generateDirectOutput(makeRequest(repoDir, selected, 'markdown'))

    // Existe no momento da execução do processo (o config foi gravado antes do run)
    // e some após o retorno (finally removeu o arquivo temporário).
    expect(pathDuringRun).toBeTruthy()
    expect(existedDuringRun).toBe(true)
    expect(existsSync(pathDuringRun)).toBe(false)
  })

  // 4. Arquivo temporário é removido mesmo com erro
  it('arquivo temporário é removido mesmo quando o runner lança erro', async () => {
    repoDir = createTempDir()
    const selected = longFiles(500, 120)
    const runner = new RecordingRunner()
    runner.behavior = 'throw'
    runner.collectConfigs = true
    const adapter = new RepomixAdapter(runner)

    await expect(adapter.generateDirectOutput(makeRequest(repoDir, selected, 'markdown'))).rejects.toThrow(
      runner.throwMessage
    )

    expect(runner.configs.length).toBe(1)
    const pathDuringRun = runner.configs[0].configPath
    expect(existsSync(pathDuringRun)).toBe(false)
  })

  // 5. Arquivo temporário é removido mesmo com exitCode != 0
  it('arquivo temporário é removido mesmo que exitCode != 0', async () => {
    repoDir = createTempDir()
    const selected = longFiles(500, 120)
    const runner = new RecordingRunner()
    runner.behavior = 'nonzero'
    runner.collectConfigs = true
    const adapter = new RepomixAdapter(runner)

    const result = await adapter.generateDirectOutput(makeRequest(repoDir, selected, 'markdown'))

    expect(result.failed).toBe(true)
    expect(runner.configs.length).toBe(1)
    const pathDuringRun = runner.configs[0].configPath
    expect(existsSync(pathDuringRun)).toBe(false)
  })

  // 6. Caminho absoluto fora do repoPath
  it('caminho do arquivo de configuração é absoluto e fora do repoPath', async () => {
    repoDir = createTempDir()
    const selected = longFiles(500, 120)
    const runner = new RecordingRunner()
    runner.collectConfigs = true
    const adapter = new RepomixAdapter(runner)

    await adapter.generateDirectOutput(makeRequest(repoDir, selected, 'markdown'))

    expect(runner.configs.length).toBe(1)
    const configPath = runner.configs[0].configPath
    const repoResolved = resolve(repoDir)
    // Deve morar no temp do SO, nunca dentro do repositório do usuário.
    expect(configPath.startsWith(repoResolved)).toBe(false)
    expect(configPath.startsWith(tmpdir())).toBe(true)
    expect(Buffer.byteLength(configPath, 'utf8')).toBeGreaterThan(0)
  })

  // 7. Batch orientado à linha inteira
  it('compressMultipleFiles divide em múltiplos batches, cada um dentro do orçamento', async () => {
    repoDir = createTempDir()
    const selected = longFiles(400, 160)
    const runner = new RecordingRunner()
    const adapter = new RepomixAdapter(runner)

    await adapter.compressMultipleFiles(makeRequest(repoDir, selected, 'plain'))

    // Cada chamada do runner corresponde a um batch (compression core sempre inline).
    const batches = runner.calls.map((c) => {
      const i = c.args.indexOf('--include')
      return c.args[i + 1].split(',')
    })

    expect(batches.length).toBeGreaterThan(1)
    for (const batch of batches) {
      expect(batch.length).toBeGreaterThan(0)
      expect(batch.length).toBeLessThanOrEqual(20) // limite defensivo MAX_FILES_PER_BATCH
      const includeBytes = Buffer.byteLength(batch.join(','), 'utf8')
      expect(includeBytes).toBeLessThanOrEqual(6000) // orçamento da linha inteira
    }
    const total = batches.reduce((sum, b) => sum + b.length, 0)
    expect(total).toBe(selected.length)
  })

  // 8. Alteração de perfil produz argumentos diferentes
  it('alteração de perfil produz argumentos diferentes', async () => {
    repoDir = createTempDir()
    const files = shortFiles()
    const runner = new RecordingRunner()
    const adapter = new RepomixAdapter(runner)

    await adapter.generateDirectOutput(makeRequest(repoDir, files, 'markdown', { removeComments: true }))
    await adapter.generateDirectOutput(makeRequest(repoDir, files, 'markdown', { removeComments: false }))

    expect(runner.calls.length).toBe(2)
    const first = runner.calls[0].args
    const second = runner.calls[1].args
    expect(first).toContain('--remove-comments')
    expect(second).not.toContain('--remove-comments')
    expect(first).not.toEqual(second)
  })

  // 9. Paridade de saída entre transportes
  it('inline e config produzem a mesma saída (mesmo content e failed)', async () => {
    repoDir = createTempDir()
    const inlineRunner = new RecordingRunner()
    const configRunner = new RecordingRunner()
    const inlineAdapter = new RepomixAdapter(inlineRunner)
    const configAdapter = new RepomixAdapter(configRunner)

    const inlineRes = await inlineAdapter.generateDirectOutput(makeRequest(repoDir, shortFiles(), 'markdown'))
    const configRes = await configAdapter.generateDirectOutput(makeRequest(repoDir, longFiles(500, 120), 'markdown'))

    expect(inlineRunner.calls[0].args).toContain('--include')
    expect(configRunner.calls[0].args).toContain('--config')

    expect(configRes.content).toBe(inlineRes.content)
    expect(configRes.failed).toBe(inlineRes.failed)
  })
})