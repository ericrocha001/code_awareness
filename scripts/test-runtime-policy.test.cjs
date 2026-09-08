const assert = require('assert/strict')
const { validateTestRuntimeLanes } = require('./test-runtime-policy.cjs')

function validate(nativeTestFiles, sources) {
  return validateTestRuntimeLanes({
    nativeTestFiles,
    testFiles: Object.keys(sources),
    readFile: (relativePath) => sources[relativePath]
  })
}

assert.deepEqual(validate(['native.test.ts'], {
  'native.test.ts': "import Parser from 'tree-sitter'",
  'node.test.ts': "import { describe } from 'vitest'"
}), [])

assert.match(validate(['missing.test.ts'], {
  'node.test.ts': "import { describe } from 'vitest'"
})[0], /ausente/)

assert.match(validate(['native.test.ts', 'native.test.ts'], {
  'native.test.ts': "import Database from 'better-sqlite3'"
})[0], /duplicados/)

assert.match(validate([], {
  'node.test.ts': "const Database = require('better-sqlite3')"
})[0], /importa addon nativo/)

assert.match(validate([], {
  'node.test.ts': "const Database = (await import('better-sqlite3')).default"
})[0], /importa addon nativo/)

assert.match(validate(['codemap-system-acceptance.e2e.test.ts'], {
  'codemap-system-acceptance.e2e.test.ts': 'service.synchronizeModified(repoPath)'
})[0], /sincronizacao manual/)

console.log('Test Runtime Policy tests PASS')
