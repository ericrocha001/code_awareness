import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import type { SessionStore } from '../store'

export function legacyStoreFixture(path: string, repositoryId: string, temporary: string): Pick<SessionStore, 'ingest' | 'close' | 'observeWorktree'> {
  const root = process.cwd(), modulePath = join(temporary, 'legacy-store-fixture.cjs')
  const original = (file: string) => execFileSync('git', ['-c', 'core.fsmonitor=false', 'show', `a91090e81aef8bb8e207c8e8af9ac364c4bf9ebd:src/main/session-context/${file}`], { cwd: root, encoding: 'utf8', windowsHide: true })
  const typesPath = join(temporary, 'legacy-types.ts')
  writeFileSync(typesPath, original('types.ts'))
  const source = original('store.ts').replace("from './types'", `from ${JSON.stringify(typesPath.replaceAll('\\', '/'))}`)
  const compiled = buildSync({ stdin: { contents: source, resolveDir: join(root, 'src/main/session-context'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text
  writeFileSync(modulePath, `require=require('node:module').createRequire(${JSON.stringify(join(root, 'package.json'))});\n` + compiled)
  const fixture = createRequire(join(root, 'package.json'))(modulePath) as { SessionStore: new (path: string, repositoryId: string) => Pick<SessionStore, 'ingest' | 'close' | 'observeWorktree'> }
  return new fixture.SessionStore(path, repositoryId)
}
