import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ['src/main/core/context/repo-discovery-real.benchmark.ts']
  }
})
