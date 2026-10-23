import { defineConfig } from 'vitest/config'
import { checkoutGitTestInclude, checkoutTestExclude } from './scripts/test-runtime-lanes.cjs'

export default defineConfig({
  test: {
    fileParallelism: false,
    include: [...checkoutGitTestInclude],
    exclude: [
      ...checkoutTestExclude,
      '**/git-worktree-operations.git.test.ts',
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**'
    ]
  }
})
