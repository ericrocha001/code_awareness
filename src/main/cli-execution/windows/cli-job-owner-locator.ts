import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export function locateCliJobOwner(root = process.cwd(), resources = ''): string {
  const directory = resources ? join(resources, 'cli-execution') : join(root, 'out/cli-execution/production')
  try {
    const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'))
    const executable = join(directory, 'cli-job-owner.exe')
    const bytes = readFileSync(executable)
    if (receipt.version !== 1 || receipt.inputs.test !== false || receipt.output.size !== bytes.length ||
      receipt.output.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error('INTEGRITY')
    return executable
  } catch { throw new Error('NATIVE_OWNERSHIP_UNAVAILABLE_OR_INVALID') }
}
