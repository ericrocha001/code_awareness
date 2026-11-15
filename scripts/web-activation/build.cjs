const esbuild = require('esbuild')
const { copyFileSync, mkdirSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')

const rootDir = resolve(__dirname, '..', '..')
const extSrcDir = join(rootDir, 'src', 'web-extension')
const extOutDir = join(rootDir, 'dist', 'web-extension')
const hostOutDir = join(rootDir, 'dist', 'web-activation')

async function buildWebActivationArtifacts() {
  rmSync(extOutDir, { recursive: true, force: true })
  rmSync(hostOutDir, { recursive: true, force: true })
  mkdirSync(extOutDir, { recursive: true })
  mkdirSync(hostOutDir, { recursive: true })

  await Promise.all([
    esbuild.build({
      entryPoints: [join(extSrcDir, 'background.ts')],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: ['chrome120'],
      outfile: join(extOutDir, 'background.js'),
      sourcemap: false
    }),
    esbuild.build({
      entryPoints: [join(extSrcDir, 'content-script.ts')],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: ['chrome120'],
      outfile: join(extOutDir, 'content-script.js'),
      sourcemap: false
    }),
    esbuild.build({
      entryPoints: [join(extSrcDir, 'popup.ts')],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: ['chrome120'],
      outfile: join(extOutDir, 'popup.js'),
      sourcemap: false
    }),
    esbuild.build({
      entryPoints: [join(rootDir, 'src', 'main', 'web-activation', 'native-host-cli.ts')],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: ['node20'],
      outfile: join(hostOutDir, 'native-host.cjs'),
      sourcemap: false
    })
  ])

  copyFileSync(join(extSrcDir, 'manifest.json'), join(extOutDir, 'manifest.json'))
  copyFileSync(join(extSrcDir, 'popup.html'), join(extOutDir, 'popup.html'))
  console.log('[web-activation:build] Built extension -> dist/web-extension and host -> dist/web-activation')
}

buildWebActivationArtifacts().catch((err) => {
  console.error('[web-activation:build] Failed:', err)
  process.exit(1)
})
