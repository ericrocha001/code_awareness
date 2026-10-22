/*
-T ---
*/

import { defineConfig } from 'vitest/config'
import { checkoutTestInclude, checkoutTestExclude } from './scripts/test-runtime-lanes.cjs'

export default defineConfig({
  test: {
    include: [...checkoutTestInclude],
    exclude: [
      ...checkoutTestExclude,
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*'
    ]
  }
})
