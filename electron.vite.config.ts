/*
-T ---
*/

import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { createRequire } from 'node:module'
const requirePreview = createRequire(import.meta.url)
const { vitePreviewPlugin } = requirePreview('./scripts/runtime-preview/cooperation.cjs')
const { buildIdentity } = requirePreview('./scripts/runtime-preview/build-identity.cjs')

export default defineConfig({
  main: {
    build: { rollupOptions: { input: { main: resolve('src/main/bootstrap.ts') }, output: { chunkFileNames: '[name]-[hash].js' } } },
    define: {
      __CODE_AWARENESS_RELAY_ENDPOINT__: JSON.stringify(process.env.CODE_AWARENESS_RELAY_ENDPOINT?.trim() ?? '')
    },
    plugins: [externalizeDepsPlugin({ exclude: ['mdast-util-from-markdown', 'micromark-extension-gfm', 'mdast-util-gfm', 'mdast-util-to-string'] }), buildIdentity('ELECTRON_MAIN')],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin(), buildIdentity('ELECTRON_PRELOAD')],
    build: {
      rollupOptions: {
        input: resolve('src/main/preload.ts')
      }
    }
  },
  renderer: {
    plugins: [vitePreviewPlugin(), react()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer/src')
      }
    }
  }
})
