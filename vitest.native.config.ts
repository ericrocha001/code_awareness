import { defineConfig } from 'vitest/config'
import { nativeTestFiles } from './scripts/test-runtime-lanes.cjs'

export default defineConfig({
  test: {
    fileParallelism: false,
    include: nativeTestFiles
  }
})
