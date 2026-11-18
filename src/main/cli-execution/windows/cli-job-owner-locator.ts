import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

export const CLI_OWNER_CONTRACT_VERSION = 2
export const CLI_OWNER_PRE_CREATE_CONFIRMED_EXIT_CODE = 204
export const CLI_OWNER_CLEANUP_CONFIRMED_EXIT_CODE = 205

function validateOwnerReceipt(executable: string, requireProduction: boolean): boolean {
  try {
    const receipt = JSON.parse(readFileSync(join(dirname(executable), 'receipt.json'), 'utf8'))
    const bytes = readFileSync(executable)
    if (receipt?.version !== 1) return false
    if (requireProduction && receipt.inputs?.test !== false) return false
    if (receipt.contract?.version !== CLI_OWNER_CONTRACT_VERSION) return false
    if (receipt.contract?.preCreateConfirmedExitCode !== CLI_OWNER_PRE_CREATE_CONFIRMED_EXIT_CODE) return false
    if (receipt.contract?.cleanupConfirmedExitCode !== CLI_OWNER_CLEANUP_CONFIRMED_EXIT_CODE) return false
    if (!Array.isArray(receipt.inputs?.sources) || !receipt.inputs.sources.some((s: { name?: string }) => s?.name === 'src/main/cli-execution/windows/CliJobOwner.cs')) return false
    return receipt.output?.size === bytes.length && receipt.output?.sha256 === createHash('sha256').update(bytes).digest('hex')
  } catch {
    return false
  }
}

export function hasVerifiedOwnerCleanupContract(executable: string): boolean {
  return validateOwnerReceipt(executable, false)
}

export function locateCliJobOwner(root = process.cwd(), resources = ''): string {
  const directory = resources ? join(resources, 'cli-execution') : join(root, 'out/cli-execution/production')
  const executable = join(directory, 'cli-job-owner.exe')
  if (!validateOwnerReceipt(executable, true)) throw new Error('NATIVE_OWNERSHIP_UNAVAILABLE_OR_INVALID')
  return executable
}
