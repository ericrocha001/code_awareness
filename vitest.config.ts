import { defineConfig } from 'vitest/config'
import { nativeTestFiles } from './scripts/test-runtime-lanes.cjs'

export default defineConfig({
  test: {
    fileParallelism: false,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*',
      '**/*.e2e.test.ts',
      'scripts/*.test.cjs',
      ...nativeTestFiles
    ]
  }
})
