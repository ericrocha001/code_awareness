/**
 * Lane de testes Git — executa somente arquivos *.git.test.ts.
 * Esses testes dependem de processos Git reais e repos temporários,
 * são mais lentos que a lane Node e não precisam do ambiente Electron/SQLite.
 */
import { defineConfig } from 'vitest/config'
import { checkoutGitTestInclude, checkoutTestExclude } from './scripts/test-runtime-lanes.cjs'

export default defineConfig({
  test: {
    fileParallelism: false,
    include: [...checkoutGitTestInclude],
    exclude: [
      ...checkoutTestExclude,
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**'
    ]
  }
})
