import { configDefaults, defineConfig } from 'vitest/config'
import { checkoutTestExclude } from './scripts/test-runtime-lanes.cjs'

export default defineConfig({
  test: {
    fileParallelism: false,
    exclude: [...configDefaults.exclude, ...checkoutTestExclude],
    include: [
      'src/main/core/context/progressive-navigation-real.benchmark.ts',
      'src/main/core/context/member-resolution-real.benchmark.ts'
    ]
  }
})
