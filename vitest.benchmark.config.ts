import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    fileParallelism: false,
    include: [
      'src/main/core/context/progressive-navigation-real.benchmark.ts',
      'src/main/core/context/member-resolution-real.benchmark.ts'
    ]
  }
})
