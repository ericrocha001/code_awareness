/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar isoladamente o contrato do RepomixProcessRunner: resultado estruturado, não-lançamento por exitCode != 0, captura de stdout, timeout obrigatório e cancelamento via AbortSignal.
2. Validar a distinção entre erro de timeout e GenerationCancelledError.
3. Validar a função utilitária isGenerationCancelledError em diversos cenários de erro.

Mapa de Relacionamentos do Script

1. repomix-process-runner.ts
   - Tipo: Dependência Direta
   - Relação: Testa o método run usando um comando trivial (node) — sem dependência da CLI do Repomix.
   - Criticidade: Alta

2. generation-errors.ts
   - Tipo: Dependência Direta
   - Relação: Valida o lançamento e reconhecimento de GenerationCancelledError.
   - Criticidade: Alta

Invariantes do Script

1. Nenhum teste depende da CLI do Repomix — usa apenas o binário node.
2. O runner nunca lança exceção por exitCode != 0; sempre resolve com { stdout, stderr, exitCode }.
3. Timeout e cancelamento produzem tipos e mensagens de erro distintos.
4. O signal abortado antes da execução impede a criação do processo filho.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, it, expect } from 'vitest'
import { RepomixProcessRunner } from './repomix-process-runner'
import { GenerationCancelledError, isGenerationCancelledError } from './generation-errors'

describe('RepomixProcessRunner — Provas de Aceitação', () => {
  it('retorna stdout, stderr e exitCode 0 para um comando válido (sem signal)', async () => {
    const runner = new RepomixProcessRunner()
    const res = await runner.run('node', ['--version'], { cwd: process.cwd(), timeoutMs: 10000 })
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toMatch(/\d+\.\d+\.\d+/)
    expect(typeof res.stderr).toBe('string')
  })

  it('não lança exceção quando o processo retorna exitCode diferente de 0', async () => {
    const runner = new RepomixProcessRunner()
    const res = await runner.run('node', ['-e', 'process.exit(3)'], { cwd: process.cwd(), timeoutMs: 10000 })
    expect(res.exitCode).toBe(3)
    expect(typeof res.stdout).toBe('string')
    expect(typeof res.stderr).toBe('string')
  })

  it('aplica o timeout default (120000ms) quando timeoutMs é omitido, retornando resultado estruturado', async () => {
    const runner = new RepomixProcessRunner()
    const res = await runner.run('node', ['--version'], { cwd: process.cwd() })
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toMatch(/\d+\.\d+\.\d+/)
    expect(typeof res.stderr).toBe('string')
  })

  it('dispara timeout quando o processo excede timeoutMs e rejeita com erro de timeout (não cancelamento)', async () => {
    const runner = new RepomixProcessRunner()
    let error: Error | undefined

    try {
      await runner.run('node', ['-e', 'setTimeout(function(){}, 10000)'], {
        cwd: process.cwd(),
        timeoutMs: 50
      })
    } catch (err: any) {
      error = err
    }

    expect(error).toBeDefined()
    expect(error?.message).toContain('excedeu o timeout')
    expect(isGenerationCancelledError(error)).toBe(false)
  })

  it('executa normalmente e resolve quando fornecido AbortSignal não abortado', async () => {
    const runner = new RepomixProcessRunner()
    const controller = new AbortController()

    const res = await runner.run('node', ['--version'], {
      cwd: process.cwd(),
      timeoutMs: 10000,
      signal: controller.signal
    })

    expect(res.exitCode).toBe(0)
    expect(res.stdout).toMatch(/\d+\.\d+\.\d+/)
  })

  it('rejeita imediatamente com GenerationCancelledError quando o signal já está abortado antes da chamada', async () => {
    const runner = new RepomixProcessRunner()
    const controller = new AbortController()
    controller.abort()

    let error: Error | undefined
    try {
      await runner.run('node', ['--version'], {
        cwd: process.cwd(),
        signal: controller.signal
      })
    } catch (err: any) {
      error = err
    }

    expect(error).toBeDefined()
    expect(isGenerationCancelledError(error)).toBe(true)
    expect(error).toBeInstanceOf(GenerationCancelledError)
  })

  it('rejeita com GenerationCancelledError quando o signal é abortado durante a execução', async () => {
    const runner = new RepomixProcessRunner()
    const controller = new AbortController()

    const promise = runner.run('node', ['-e', 'setTimeout(function(){}, 10000)'], {
      cwd: process.cwd(),
      timeoutMs: 10000,
      signal: controller.signal
    })

    setTimeout(() => {
      controller.abort()
    }, 50)

    let error: Error | undefined
    try {
      await promise
    } catch (err: any) {
      error = err
    }

    expect(error).toBeDefined()
    expect(isGenerationCancelledError(error)).toBe(true)
    expect(error).toBeInstanceOf(GenerationCancelledError)
  })
})

describe('isGenerationCancelledError — Contrato Utilitário', () => {
  it('reconhece instâncias de GenerationCancelledError', () => {
    expect(isGenerationCancelledError(new GenerationCancelledError())).toBe(true)
    expect(isGenerationCancelledError(new GenerationCancelledError('Cancelado'))).toBe(true)
  })

  it('reconhece objetos com name GenerationCancelledError (resiliência entre contextos)', () => {
    expect(isGenerationCancelledError({ name: 'GenerationCancelledError', message: 'teste' })).toBe(true)
  })

  it('retorna false para outros erros e tipos', () => {
    expect(isGenerationCancelledError(new Error('Erro comum'))).toBe(false)
    expect(isGenerationCancelledError(new TypeError('Tipo inválido'))).toBe(false)
    expect(isGenerationCancelledError(null)).toBe(false)
    expect(isGenerationCancelledError(undefined)).toBe(false)
    expect(isGenerationCancelledError('string')).toBe(false)
    expect(isGenerationCancelledError({})).toBe(false)
  })
})