import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { nativeTestFiles } from '../../shared/validation/test-runtime-lanes.cjs'
import type { ResolvedValidationCommand, ValidationLane, ValidationProfile } from './validation-profile'

const nativeTargets = new Set(nativeTestFiles.map(normalize))

const profiles: ValidationProfile[] = [
  { id: 'typecheck', description: 'Run the repository TypeScript typecheck.', runtime: 'NODE', lane: 'TYPECHECK', acceptsTargets: false, proofKind: 'TYPECHECK', scope: ['repository'], timeoutMs: 120_000, script: 'typecheck' },
  { id: 'test-node', description: 'Run the complete Node test lane.', runtime: 'NODE', lane: 'NODE', acceptsTargets: false, proofKind: 'FULL_TEST_SUITE', scope: ['node-test-lane'], timeoutMs: 600_000, script: 'test:node' },
  { id: 'test-git', description: 'Run the complete Git test lane.', runtime: 'GIT', lane: 'GIT', acceptsTargets: false, proofKind: 'SUBSYSTEM_TEST', scope: ['git-test-lane'], timeoutMs: 600_000, script: 'test:git' },
  { id: 'test-native', description: 'Run the complete Native/Electron test lane.', runtime: 'ELECTRON', lane: 'NATIVE', acceptsTargets: false, proofKind: 'SUBSYSTEM_TEST', scope: ['native-test-lane'], timeoutMs: 900_000, script: 'test:native' },
  { id: 'validate-codemap', description: 'Run the established CodeMap validation lane.', runtime: 'ELECTRON', lane: 'CODEMAP', acceptsTargets: false, proofKind: 'E2E', scope: ['codemap'], timeoutMs: 1_200_000, script: 'validate:codemap' },
  { id: 'test-node-targeted', description: 'Run explicitly selected tests in the Node lane.', runtime: 'NODE', lane: 'NODE', acceptsTargets: true, proofKind: 'TARGETED_TEST', scope: ['node-test-lane'], timeoutMs: 600_000, script: 'test:node' },
  { id: 'test-git-targeted', description: 'Run explicitly selected tests in the Git lane.', runtime: 'GIT', lane: 'GIT', acceptsTargets: true, proofKind: 'TARGETED_TEST', scope: ['git-test-lane'], timeoutMs: 600_000, script: 'test:git' },
  { id: 'test-native-targeted', description: 'Run explicitly selected tests in the Native/Electron lane.', runtime: 'ELECTRON', lane: 'NATIVE', acceptsTargets: true, proofKind: 'TARGETED_TEST', scope: ['native-test-lane'], timeoutMs: 900_000, script: 'test:native' }
]

function normalize(value: string): string {
  return value.replace(/\\/g, '/')
}

function laneFor(target: string): ValidationLane | null {
  if (!/\.test\.(ts|tsx)$/.test(target)) return null
  if (nativeTargets.has(target)) return 'NATIVE'
  if (target.endsWith('.git.test.ts')) return 'GIT'
  if (target.endsWith('.e2e.test.ts')) return null
  return 'NODE'
}

export class ValidationProfileCatalog {
  list(): ValidationProfile[] {
    return profiles.map((profile) => ({ ...profile, scope: [...profile.scope] }))
  }

  get(profileId: string): ValidationProfile {
    const profile = profiles.find((entry) => entry.id === profileId)
    if (!profile) throw new Error(`UNKNOWN_VALIDATION_PROFILE: ${profileId}`)
    return { ...profile, scope: [...profile.scope] }
  }

  resolve(repoRoot: string, profileId: string, targets?: string[]): { profile: ValidationProfile; targets: string[]; command: ResolvedValidationCommand } {
    const root = realpathSync(repoRoot)
    const profile = this.get(profileId)
    const selected = targets ?? []
    if (!profile.acceptsTargets && selected.length > 0) throw new Error('TARGETS_NOT_ALLOWED')
    if (profile.acceptsTargets && selected.length === 0) throw new Error('TARGETS_REQUIRED')
    if (new Set(selected).size !== selected.length) throw new Error('INVALID_TARGET: duplicate target')

    const validated = selected.map((target) => {
      if (!target || !/^[A-Za-z0-9_./@+\-]+$/.test(normalize(target)) || isAbsolute(target) || normalize(target).split('/').includes('..')) throw new Error(`INVALID_TARGET: ${target}`)
      const absolute = realpathSync(resolve(root, target))
      const inside = normalize(relative(root, absolute))
      if (!inside || inside.startsWith('../') || isAbsolute(inside) || !statSync(absolute).isFile()) throw new Error(`INVALID_TARGET: ${target}`)
      const lane = laneFor(inside)
      if (lane !== profile.lane) throw new Error(`TARGET_LANE_MISMATCH: ${inside}`)
      return inside
    })

    const executable = process.platform === 'win32' ? (process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe') : 'npm'
    const args = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm.cmd', 'run', profile.script]
      : ['run', profile.script]
    if (validated.length > 0) args.push('--', ...validated)
    return {
      profile,
      targets: validated,
      command: { executable, args, cwd: root, displayCommand: `npm run ${profile.script}${validated.length ? ' -- <authorized targets>' : ''}` }
    }
  }
}
