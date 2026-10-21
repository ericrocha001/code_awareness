import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { GitOperationsService } from '../git-operations/git-operations-service'
import type { PreviewPreflight, PreviewSelection, MissingSecurityRequirement } from '../../shared/types/runtime-preview-types'
import { PreviewProfileStore } from './preview-profile-store'
import { bytesFingerprint, previewFingerprint } from './preview-profile'
import { PreviewNpmDependencies } from './preview-npm-dependencies'

export async function previewPath(root: string, path: string): Promise<string> {
  const physicalRoot = await realpath(root), physical = await realpath(resolve(root, path))
  const scope = relative(physicalRoot, physical)
  if (scope === '..' || scope.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(scope)) throw new Error('PATH_OUTSIDE_WORKTREE')
  return physical
}
export class PreviewPreflightService {
  private readonly dependencies = new PreviewNpmDependencies()
  constructor(private readonly profiles: PreviewProfileStore) {}
  async list(repositoryId: string) {
    return Promise.all((await this.profiles.profiles(repositoryId)).map(async p => ({ profileId: p.profileId, revision: p.revision,
      runtime: p.runtime, fingerprint: previewFingerprint(p), approved: await this.profiles.approved(p) })))
  }
  async check(git: Pick<GitOperationsService, 'getCoordinationIdentity' | 'getCoordinationSnapshot'>, selection: PreviewSelection): Promise<PreviewPreflight> {
    const profile = (await this.profiles.profiles(selection.repositoryId)).find(p => p.profileId === selection.profileId)
    if (!profile || previewFingerprint(profile) !== selection.fingerprint) throw new Error('PROFILE_CHANGED')
    const identity = await git.getCoordinationIdentity(selection.worktreeId)
    if (identity.repositoryId !== selection.repositoryId) throw new Error('REPOSITORY_MISMATCH')
    if (identity.record.generation !== selection.generation) throw new Error('WORKTREE_STALE')
    const initial = await git.getCoordinationSnapshot(selection.worktreeId)
    if (initial.record.generation !== selection.generation) throw new Error('WORKTREE_STALE')
    const result: PreviewPreflight = { selection, profileRevision: profile.revision, status: 'SUPPORTED', diagnostics: [], readiness: 'NOT_OBSERVED', process: 'NOT_IMPLEMENTED',
      snapshot: { ...initial.snapshot, dirty: initial.stagedCount + initial.unstagedCount + initial.untrackedCount > 0 } }
    const problem = (reasonCode: string, message: string, status: PreviewPreflight['status'] = 'INCOMPATIBLE') => {
      result.diagnostics.push({ reasonCode, message })
      const priority = { SUPPORTED: 0, UNKNOWN: 1, MISSING: 2, INCOMPATIBLE: 3 }
      if (priority[status] > priority[result.status]) result.status = status
    }
    await this.profiles.assertExternal(initial.record.path)
    if (!await this.profiles.approved(profile)) problem('PROFILE_APPROVAL_REQUIRED', 'O perfil atual exige aprovação independente do operador.')
    if (initial.reference || initial.record.locked || initial.record.detached || initial.conflictCount || initial.snapshot.operation) problem('TARGET_UNAVAILABLE', 'Selecione uma Worktree de branch isolada, disponível e sem operação Git ou conflitos.')
    const missingRequirements: MissingSecurityRequirement[] = profile.security.requirements.map(requirement => ({ ...requirement,
      availableMechanism: { kind: 'NONE', name: 'Nenhum mecanismo de contenção disponível para esta capacidade', basis: 'U1 oferece contrato declarativo de isolamento operacional, sem enforcement de filesystem, rede, credenciais ou privilégios. Declaração do perfil não constitui proteção aplicada.' },
      resolutions: [{ action: 'INDEPENDENT_POLICY_REVIEW', description: 'Reavaliar risco e política em aprovação material independente; esta pré-checagem não modifica requisitos nem autoriza downgrade.', requiresIndependentApproval: true }]
    }))
    if (missingRequirements.length || profile.security.mode !== 'profile_only') {
      problem('SECURITY_ISOLATION_UNAVAILABLE', 'As garantias de contenção solicitadas não podem ser aplicadas pelo host atual.')
      result.diagnostics[result.diagnostics.length - 1].missingRequirements = missingRequirements.length ? missingRequirements : [{ capability: 'SYSTEM_RESOURCE_RESTRICTION', guarantee: profile.security.mode,
        availableMechanism: { kind: 'NONE', name: 'Nenhum executor de container/VM integrado', basis: 'Containers e VMs estão fora do MVP.' }, resolutions: [] }]
    }
    if (profile.network.destinations.some(d => !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/.test(d)) && !profile.network.openNetworkConsent) problem('NETWORK_APPROVAL_REQUIRED', 'Destinos externos exigem consentimento informado no perfil aprovado.')
    try {
      await previewPath(initial.record.path, profile.command.cwd)
      if (!(await stat(await realpath(profile.command.executable))).isFile()) throw new Error('EXECUTABLE_UNAVAILABLE')
      if (bytesFingerprint(await readFile(profile.command.executable)) !== profile.command.executableHash) problem('EXECUTABLE_CHANGED', 'Executável difere da aprovação.')
      for (const input of profile.command.inputs) {
        if (bytesFingerprint(await readFile(await previewPath(initial.record.path, input.path))) !== input.fingerprint) problem('COMMAND_INPUT_CHANGED', 'Script/comando difere da aprovação; exige revisão material.')
      }
      const cooperation = await readFile(await previewPath(initial.record.path, profile.cooperation.manifest))
      if (bytesFingerprint(cooperation) !== profile.cooperation.fingerprint) problem('COOPERATION_CHANGED', 'Contrato cooperante ausente ou alterado; não modificar checkout legado automaticamente.')
    } catch (error) { problem('COOPERATION_UNAVAILABLE', error instanceof Error ? error.message : 'Contrato de checkout indisponível.') }
    try {
      const root = initial.record.path
      const manifestBytes = await readFile(await previewPath(root, profile.dependencies.manifest))
      const lockBytes = await readFile(await previewPath(root, profile.dependencies.lockfile))
      if (bytesFingerprint(manifestBytes) !== profile.dependencies.manifestHash || bytesFingerprint(lockBytes) !== profile.dependencies.lockfileHash) problem('DEPENDENCY_INPUT_CHANGED', 'Manifest/scripts ou lockfile diferem do perfil aprovado.')
      const dependencies = await this.dependencies.inspect(root, profile, selection.generation, manifestBytes, lockBytes)
      result.dependencyBasis = dependencies.basis
      for (const diagnostic of dependencies.diagnostics) problem(diagnostic.reasonCode, diagnostic.message, diagnostic.status)
      try {
        const materialization = JSON.parse(await readFile(await previewPath(root, profile.dependencies.materialization), 'utf8'))
        if (!materialization || !['lockfileHash', 'runtimeVersion', 'abi', 'packageManagerVersion'].every(key => typeof materialization[key] === 'string' && materialization[key])) problem('DEPENDENCY_MATERIALIZATION_UNVERIFIABLE', 'Registro de materialização incompleto; instalação e ABI não atestadas.', 'UNKNOWN')
        else if (materialization.lockfileHash !== profile.dependencies.lockfileHash || materialization.runtimeVersion !== profile.runtimeVersion || materialization.abi !== profile.dependencies.abi || materialization.packageManagerVersion !== profile.dependencies.packageManagerVersion) problem('DEPENDENCY_MISMATCH', 'Materialização incompatível com runtime/ABI/package manager aprovados.')
        else problem('RUNTIME_COMPATIBILITY_UNVERIFIED', 'Recibo declarativo do checkout não atesta runtime/ABI instalado. Qualificação real será produzida pela unidade de integração da stack.', 'UNKNOWN')
      } catch (error) {
        if (error instanceof Error && error.message === 'PATH_OUTSIDE_WORKTREE') problem('DEPENDENCY_MISMATCH', error.message)
        else problem('DEPENDENCY_MATERIALIZATION_UNVERIFIABLE', 'Registro de materialização ausente ou ilegível; isso não comprova ausência da instalação.', 'UNKNOWN')
      }
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      problem(missing ? 'DEPENDENCIES_MISSING' : 'DEPENDENCY_MISMATCH', error instanceof Error ? error.message : 'Instalação indisponível.', missing ? 'MISSING' : 'INCOMPATIBLE')
    }
    const final = await git.getCoordinationSnapshot(selection.worktreeId)
    if (previewFingerprint(final.snapshot) !== previewFingerprint(initial.snapshot) || final.record.generation !== selection.generation) throw new Error('GIT_STATE_CHANGED')
    const current = (await this.profiles.profiles(selection.repositoryId)).find(p => p.profileId === selection.profileId)
    if (!current || previewFingerprint(current) !== selection.fingerprint) throw new Error('PROFILE_CHANGED')
    return result
  }
}
