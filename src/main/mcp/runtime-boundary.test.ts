import { readFileSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('keeps production source and the official launcher independent of Spike artifacts', () => {
  const root = resolve('.')
  const sourceRoot = resolve(root, 'src')
  const files = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.includes('.test.'))
    .map((entry) => resolve(entry.parentPath, entry.name))
  files.push(resolve(root, 'scripts/run-mcp-server.cjs'))

  for (const file of files) {
    const imports = ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles
    for (const dependency of imports) {
      expect(dependency.fileName.replaceAll('\\', '/'), relative(root, file))
        .not.toMatch(/(^|\/)spikes?\//i)
    }
  }
})
