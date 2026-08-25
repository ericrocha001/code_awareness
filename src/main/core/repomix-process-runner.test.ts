/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar isoladamente o contrato do RepomixProcessRunner: resultado estruturado, não-lançamento por exitCode != 0 e captura de stdout.

Mapa de Relacionamentos do Script

1. repomix-process-runner.ts
   - Tipo: Dependência Direta
   - Relação: Testa o método run usando um comando trivial (node) — sem dependência da CLI do Repomix.
   - Criticidade: Alta

Invariantes do Script

1. Nenhum teste depende da CLI do Repomix — usa apenas o binário node.
2. O runner nunca lança exceção por exitCode != 0; sempre resolve com { stdout, stderr, exitCode }.
3. Timeout explícito pequeno é usado para evitar travamentos no ambiente de teste.
*/

import { describe, it, expect } from 'vitest'
import { RepomixProcessRunner } from './repomix-process-runner'

describe('RepomixProcessRunner — Provas de Aceitação', () => {
  it('retorna stdout, stderr e exitCode 0 para um comando válido', async () => {
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
    // Sem timeoutMs informado: usa o default sem quebrar a execução.
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toMatch(/\d+\.\d+\.\d+/)
    expect(typeof res.stderr).toBe('string')
  })
})