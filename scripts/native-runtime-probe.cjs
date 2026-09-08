/*
-T ---
*/

function assertElectronRuntime() {
  if (!process.versions.electron) {
    throw new Error('Probe must run with Electron and ELECTRON_RUN_AS_NODE=1.')
  }
}

function runBetterSqlite3Probe() {
  const Database = require('better-sqlite3')
  const db = new Database(':memory:')
  try {
    const row = db.prepare('select 1 as value').get()
    if (!row || row.value !== 1) {
      throw new Error('SQLite minimal query returned an unexpected result.')
    }
  } finally {
    db.close()
  }
}

function runTreeSitterProbe() {
  const Parser = require('tree-sitter')
  const parser = new Parser()
  if (!parser) {
    throw new Error('Parser instance was not created.')
  }
}

function runTypeScriptProbe() {
  const Parser = require('tree-sitter')
  const TypeScript = require('tree-sitter-typescript')
  const parser = new Parser()
  parser.setLanguage(TypeScript.typescript)
  const tree = parser.parse('export const value: number = 1\n')
  if (!tree || tree.rootNode.hasError) {
    throw new Error('TypeScript grammar produced parse errors for minimal source.')
  }
}

function runJavaScriptProbe() {
  const Parser = require('tree-sitter')
  const JavaScript = require('tree-sitter-javascript')
  const parser = new Parser()
  parser.setLanguage(JavaScript)
  const tree = parser.parse('export const value = 1\n')
  if (!tree || tree.rootNode.hasError) {
    throw new Error('JavaScript grammar produced parse errors for minimal source.')
  }
}

const probes = {
  'better-sqlite3': runBetterSqlite3Probe,
  'tree-sitter': runTreeSitterProbe,
  'tree-sitter-typescript': runTypeScriptProbe,
  'tree-sitter-javascript': runJavaScriptProbe
}

function runCli() {
  const probeName = process.argv[2]
  const probe = probes[probeName]

  if (!probe) {
    console.error(`Unknown native runtime probe: ${probeName || 'absent'}`)
    process.exit(1)
  }

  try {
    assertElectronRuntime()
    probe()
    console.log(`${probeName} PASS`)
  } catch (error) {
    console.error(`${probeName} FAIL`)
    console.error(error && error.stack ? error.stack : error)
    process.exit(1)
  }
}

if (require.main === module) {
  runCli()
}

module.exports = {
  probes
}
