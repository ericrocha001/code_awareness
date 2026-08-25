/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Configurar o test runner Vitest para o projeto Code Awareness.
2. Excluir explicitamente arquivos *.e2e.test.ts da descoberta padrão de testes para impedir a execução de testes que dependam de runtime nativo (Electron/SQLite) no ambiente Node do Vitest.

Mapa de Relacionamentos do Script

1. package.json
   - Tipo: Contrato / Interface
   - Relação: Define os scripts npm test, npm run test:run e npm run test:domain consumidos pelo desenvolvedor e CI.
   - Criticidade: Alta

2. src/main/core/better-sqlite3-database-adapter.e2e.test.ts
   - Tipo: Contrato / Interface
   - Relação: Arquivo de teste de infraestrutura excluído da execução padrão do Vitest.
   - Criticidade: Alta

Invariantes do Script

1. vitest e vitest run sem argumentos explícitos de arquivo nunca descobrem arquivos *.e2e.test.ts.
2. Preservar o isolamento arquitetural entre testes de domínio (Node) e testes de infraestrutura nativa (Electron).

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*',
      '**/*.e2e.test.ts'
    ]
  }
})
