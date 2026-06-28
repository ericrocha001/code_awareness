/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar as funções puras de classificação de importância de arquivo (classifyByExtensionAndPath, scoreByNameAndPath, consolidateScore).
2. Garantir cobertura de casos limite e conformidade com as regras da especificação.

Mapa de Relacionamentos do Script

1. ../importance-heuristics.ts
   - Tipo: Dependência Direta
   - Relação: Módulo cujas funções puras estão sendo testadas.
   - Criticidade: Alta

Invariantes do Script

1. Todos os assertions devem passar e nenhuma chamada externa (E/S ou IPC) deve ser feita.
2. A suíte de testes deve refletir os limites e especificações exatos das heurísticas puras.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, it, expect } from 'vitest'
import {
  classifyByExtensionAndPath,
  scoreByNameAndPath,
  consolidateScore
} from '../importance-heuristics'

describe('Camada 1: classifyByExtensionAndPath', () => {
  it('deve retornar "low" para imagens', () => {
    // Imagens são sempre consideradas ruído arquitetural
    expect(classifyByExtensionAndPath('src/logo.png')).toBe('low')
    expect(classifyByExtensionAndPath('assets/icon.svg')).toBe('low')
    expect(classifyByExtensionAndPath('images/photo.jpg')).toBe('low')
  })

  it('deve retornar "low" para lockfiles', () => {
    // Lockfiles de dependências não carregam relevância para análise arquitetural direta
    expect(classifyByExtensionAndPath('package-lock.json')).toBe('low')
    expect(classifyByExtensionAndPath('yarn.lock')).toBe('low')
    expect(classifyByExtensionAndPath('pnpm-lock.yaml')).toBe('low')
  })

  it('deve retornar "low" para arquivos dentro de node_modules', () => {
    // Código de terceiros ou pacotes externos são sempre classificados como low
    expect(classifyByExtensionAndPath('node_modules/react/index.js')).toBe('low')
    expect(classifyByExtensionAndPath('node_modules/lodash/lodash.js')).toBe('low')
  })

  it('deve retornar "low" para arquivos de build', () => {
    // Pastas e arquivos de saída gerados de build são ruídos arquiteturais
    expect(classifyByExtensionAndPath('dist/bundle.js')).toBe('low')
    expect(classifyByExtensionAndPath('build/main.js')).toBe('low')
    expect(classifyByExtensionAndPath('out/app.exe')).toBe('low')
  })

  it('deve retornar null para arquivos de código fonte', () => {
    // Arquivos legítimos de desenvolvimento não devem ser descartados na camada 1
    expect(classifyByExtensionAndPath('src/main.ts')).toBeNull()
    expect(classifyByExtensionAndPath('src/App.tsx')).toBeNull()
    expect(classifyByExtensionAndPath('src/utils/helper.js')).toBeNull()
  })

  it('deve retornar "low" para .env.local', () => {
    // Variáveis de ambiente locais são consideradas ruído
    expect(classifyByExtensionAndPath('.env.local')).toBe('low')
    expect(classifyByExtensionAndPath('.env.production.local')).toBe('low')
  })
})

describe('Camada 2: scoreByNameAndPath', () => {
  it('deve dar +40 para entry points', () => {
    // Entry points como index, main, app recebem bônus alto
    expect(scoreByNameAndPath('main.ts')).toBe(55) // 40 + 15 (raiz)
    expect(scoreByNameAndPath('src/main.ts')).toBe(50) // 40 + 10 (1 nível)
    expect(scoreByNameAndPath('index.ts')).toBe(55)
    expect(scoreByNameAndPath('app.tsx')).toBe(55)
  })

  it('deve dar +35 para routers', () => {
    // Rotas e roteamento são classificados com prioridade
    expect(scoreByNameAndPath('router.ts')).toBe(50) // 35 + 15 (raiz)
    expect(scoreByNameAndPath('routes.ts')).toBe(50)
  })

  it('deve dar +30 para arquivos em /core/', () => {
    // Lógica core e entidades centrais acumulam pontuação de pasta
    expect(scoreByNameAndPath('src/core/auth.ts')).toBe(30) // 30 (core), 0 (depth=2)
    expect(scoreByNameAndPath('src/core/services/auth.ts')).toBe(55) // 30 (core) + 25 (services), 0 (depth=3)
  })

  it('deve dar +30 para arquivos de tipos', () => {
    // Declarações de tipos, contratos e interfaces são fundamentais para entender o sistema
    expect(scoreByNameAndPath('src/types.ts')).toBe(40) // 30 (types) + 10 (depth=1)
    expect(scoreByNameAndPath('src/interfaces.ts')).toBe(40)
    expect(scoreByNameAndPath('src/shared/types.ts')).toBe(40) // 10 (shared) + 30 (types), 0 (depth=2)
  })

  it('deve dar -10 para arquivos CSS', () => {
    // Estilos visuais são penalizados por não conter lógica arquitetural
    expect(scoreByNameAndPath('src/styles.css')).toBe(0) // 10 (depth=1) - 10 (css)
    expect(scoreByNameAndPath('src/components/Button.css')).toBe(-5) // 5 (components) + 0 (depth=2) - 10 (css)
  })

  it('deve dar -15 para arquivos de teste', () => {
    // Arquivos de testes recebem penalidade expressiva por não participarem da lógica de execução direta
    expect(scoreByNameAndPath('src/main.test.ts')).toBe(-5) // 10 (depth=1) - 15 (test)
    expect(scoreByNameAndPath('src/core/auth.spec.ts')).toBe(15) // 30 (core) - 15 (test)
  })

  it('deve dar -5 para arquivos muito aninhados (5+ níveis)', () => {
    // Arquivos em profundidade excessiva perdem levemente importância arquitetural
    expect(scoreByNameAndPath('src/a/b/c/d/e/file.ts')).toBe(-5) // 0 + 0 - 5
  })
})

describe('Camada 4: consolidateScore', () => {
  it('deve retornar "low" quando Camada 1 retorna "low"', () => {
    // O filtro de exclusão automática sempre tem precedência sobre qualquer pontuação
    expect(consolidateScore('low', 100, 100)).toBe('low')
    expect(consolidateScore('low', 0, 0)).toBe('low')
  })

  it('deve retornar "critical" para pontuação >= 50', () => {
    expect(consolidateScore(null, 40, 10)).toBe('critical')
    expect(consolidateScore(null, 30, 20)).toBe('critical')
    expect(consolidateScore(null, 50, 0)).toBe('critical')
  })

  it('deve retornar "high" para pontuação 25-49', () => {
    expect(consolidateScore(null, 20, 10)).toBe('high')
    expect(consolidateScore(null, 15, 15)).toBe('high')
    expect(consolidateScore(null, 25, 0)).toBe('high')
    expect(consolidateScore(null, 34, 15)).toBe('high') // 49
  })

  it('deve retornar "medium" para pontuação 10-24', () => {
    expect(consolidateScore(null, 10, 0)).toBe('medium')
    expect(consolidateScore(null, 5, 10)).toBe('medium')
    expect(consolidateScore(null, 14, 10)).toBe('medium') // 24
  })

  it('deve retornar "low" para pontuação < 10', () => {
    expect(consolidateScore(null, 5, 4)).toBe('low') // 9
    expect(consolidateScore(null, 0, 0)).toBe('low')
    expect(consolidateScore(null, -10, -5)).toBe('low')
  })
})
