import type { ProofKind } from '../validation-ledger/validation-ledger-types'

export type ValidationRuntime = 'NODE' | 'GIT' | 'ELECTRON'
export type ValidationLane = 'TYPECHECK' | 'NODE' | 'GIT' | 'NATIVE' | 'CODEMAP'

export interface ValidationProfile {
  id: string
  description: string
  runtime: ValidationRuntime
  lane: ValidationLane
  acceptsTargets: boolean
  proofKind: ProofKind
  scope: string[]
  timeoutMs: number
  script: string
}

export interface ResolvedValidationCommand {
  executable: string
  args: string[]
  cwd: string
  displayCommand: string
}
