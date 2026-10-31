import { beforeAll } from 'vitest'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(join(process.cwd(), 'package.json'))
const { ensureProduction } = require('./scripts/cli-execution/build.cjs')

beforeAll(() => {
  ensureProduction(process.cwd())
}, 70000)
