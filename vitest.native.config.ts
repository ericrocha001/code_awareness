import { configDefaults, defineConfig } from 'vitest/config'
import { nativeTestFiles, checkoutTestExclude } from './scripts/test-runtime-lanes.cjs'

export default defineConfig({
  test: {
    fileParallelism: false,
    include: nativeTestFiles,
    exclude: [...configDefaults.exclude, ...checkoutTestExclude]
  }
})
