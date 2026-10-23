import { defineConfig } from 'vitest/config'
import { checkoutTestExclude } from './scripts/test-runtime-lanes.cjs'

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ['src/main/git-operations/git-worktree-operations.git.test.ts'],
    exclude: [
      ...checkoutTestExclude,
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**'
    ]
  }
})
