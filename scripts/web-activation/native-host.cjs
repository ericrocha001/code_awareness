#!/usr/bin/env node
const { existsSync } = require('node:fs')
const { join, resolve } = require('node:path')

const siblingBundle = join(__dirname, 'native-host.bundle.cjs')
const distBundle = resolve(__dirname, '..', '..', 'dist', 'web-activation', 'native-host.cjs')
const target = existsSync(siblingBundle) ? siblingBundle : distBundle

if (!existsSync(target)) {
  process.stderr.write(`Code Awareness native host bundle not found at ${target}. Run "npm run web-activation:build" first.\n`)
  process.exit(1)
}

const entry = require(target)
if (entry && typeof entry.runWebActivationNativeHost === 'function') {
  entry.runWebActivationNativeHost(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    process.exitCode = 1
  })
}
