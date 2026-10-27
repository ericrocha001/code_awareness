import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { GitOperationsService } from '../git-operations/git-operations-service'
import type { PreviewPreflight, PreviewSelection, MissingSecurityRequirement } from '../../shared/types/runtime-preview-types'
import { PreviewProfileStore } from './preview-profile-store'
import { bytesFingerprint, previewFingerprint } from './preview-profile'
import { PreviewNpmDependencies } from './preview-npm-dependencies'
import type { PreviewStartClock } from './runtime-preview/start-timing'

export async function previewPath(root: string, path: string): Promise<string> {
  const physicalRoot = await realpath(root), physical = await realpath(resolve(root, path))
  const scope = relative(physicalRoot, physical)
  if (scope === '..' || scope.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(scope)) throw new Error('PATH_OUTSIDE_WORKTREE')
  return physical
}
export class PreviewPreflightService {
  private readonly dependencies = new PreviewNpmDependencies()
  private readonly evidence = new WeakMap<PreviewPreflight, { git: object; fingerprint: string; profile: import('./preview-profile').PreviewProfile; root: string; materialization: string | null }>()
  constructor(private readonly profiles: PreviewProfileStore) {}
  async list(repositoryId: string) {
    return Promise.all((await this.profiles.profiles(repositoryId)).map(async p => ({ profileId: p.profileId, revision: p.revision,
      runtime: p.runtime, fingerprint: previewFingerprint(p), approved: await this.profiles.approved(p) })))
  }
  async check(git: Pick<GitOperationsService, 'getCoordinationIdentity' | 'getCoordinationSnapshot'>, selection: PreviewSelection, timing?: PreviewStartClock): Promise<PreviewPreflight> {
    const read = (file: string) => timing ? timing.read(file) : readFile(file)
    let materializationFingerprint: string | null = null
    const profile = (await this.profiles.profiles(selection.repositoryId)).find(p => p.profileId === selection.profileId)
    if (!profile || previewFingerprint(profile) !== selection.fingerprint) throw new Error('PROFILE_CHANGED')
    const identity = await (timing ? timing.measure('git', () => git.getCoordinationIdentity(selection.worktreeId)) : git.getCoordinationIdentity(selection.worktreeId))
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
    if (profile.bootstrap && (profile.runtime !== 'ELECTRON_DEV' || profile.adapter?.kind !== 'ELECTRON')) problem('PREVIEW_CONTEXT_PROFILE_INVALID', 'Bootstrap contextual exige o adaptador Electron cooperante.')
    if (profile.bootstrap && !profile.env.PATH) problem('PREVIEW_GIT_PATH_REQUIRED', 'Declare no ambiente aprovado do perfil um PATH contendo o Git necessário à identidade e ao contexto do preview.', 'MISSING')
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
      if (bytesFingerprint(await read(profile.command.executable)) !== profile.command.executableHash) problem('EXECUTABLE_CHANGED', 'Executável difere da aprovação.')
      for (const input of profile.command.inputs) {
        if (bytesFingerprint(await read(await previewPath(initial.record.path, input.path))) !== input.fingerprint) problem('COMMAND_INPUT_CHANGED', 'Script/comando difere da aprovação; exige revisão material.')
      }
      const cooperation = await read(await previewPath(initial.record.path, profile.cooperation.manifest))
      if (bytesFingerprint(cooperation) !== profile.cooperation.fingerprint) problem('COOPERATION_CHANGED', 'Contrato cooperante ausente ou alterado; não modificar checkout legado automaticamente.')
    } catch (error) { problem('COOPERATION_UNAVAILABLE', error instanceof Error ? error.message : 'Contrato de checkout indisponível.') }
    try {
      const root = initial.record.path
      const manifestBytes = await read(await previewPath(root, profile.dependencies.manifest))
      const lockBytes = await read(await previewPath(root, profile.dependencies.lockfile))
      if (bytesFingerprint(manifestBytes) !== profile.dependencies.manifestHash || bytesFingerprint(lockBytes) !== profile.dependencies.lockfileHash) problem('DEPENDENCY_INPUT_CHANGED', 'Manifest/scripts ou lockfile diferem do perfil aprovado.')
      const inspect = () => this.dependencies.inspect(root, profile, selection.generation, manifestBytes, lockBytes, timing)
      const dependencies = await (timing ? timing.measure('dependencies', inspect) : inspect())
      result.dependencyBasis = dependencies.basis
      for (const diagnostic of dependencies.diagnostics) problem(diagnostic.reasonCode, diagnostic.message, diagnostic.status)
      try {
        const raw = await read(await previewPath(root, profile.dependencies.materialization))
        materializationFingerprint = bytesFingerprint(raw)
        const materialization = JSON.parse(raw.toString())
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
    this.evidence.set(result, { git, fingerprint: previewFingerprint(result), profile: structuredClone(profile), root: initial.record.path, materialization: materializationFingerprint })
    return result
  }
  canReuse(git: object, selection: PreviewSelection, result: PreviewPreflight) {
    const evidence = this.evidence.get(result)
    return !!evidence && evidence.git === git && evidence.fingerprint === previewFingerprint(result) && previewFingerprint(result.selection) === previewFingerprint(selection) &&
      (result.status === 'SUPPORTED' || result.status === 'UNKNOWN' && result.diagnostics.length > 0 && result.diagnostics.every(d => ['ABI_UNVERIFIED', 'RUNTIME_COMPATIBILITY_UNVERIFIED', 'DEPENDENCY_MATERIALIZATION_UNVERIFIABLE'].includes(d.reasonCode)))
  }
  async revalidate(git: Pick<GitOperationsService, 'getCoordinationIdentity' | 'getCoordinationSnapshot'>, selection: PreviewSelection, result: PreviewPreflight, timing?: PreviewStartClock) {
    if (!this.canReuse(git, selection, result)) return this.check(git, selection, timing)
    const evidence = this.evidence.get(result)!, profile = evidence.profile
    const measure = <T>(stage: 'profile_guard' | 'inputs' | 'materialization' | 'source_guard', work: () => Promise<T>) => timing ? timing.measure(stage, work) : work()
    const read = (file: string) => timing ? timing.read(file) : readFile(file)
    await measure('profile_guard', async () => {
      const current = (await this.profiles.profiles(selection.repositoryId)).find(p => p.profileId === selection.profileId)
      if (!current || previewFingerprint(current) !== selection.fingerprint || !await this.profiles.approved(current)) throw new Error('PROFILE_CHANGED')
      await this.profiles.assertExternal(evidence.root)
    })
    await measure('inputs', async () => {
      await previewPath(evidence.root, profile.command.cwd)
      if (!(await stat(await realpath(profile.command.executable))).isFile() || bytesFingerprint(await read(profile.command.executable)) !== profile.command.executableHash) throw new Error('EXECUTABLE_CHANGED')
      for (const input of profile.command.inputs) if (bytesFingerprint(await read(await previewPath(evidence.root, input.path))) !== input.fingerprint) throw new Error('COMMAND_INPUT_CHANGED')
      if (bytesFingerprint(await read(await previewPath(evidence.root, profile.cooperation.manifest))) !== profile.cooperation.fingerprint) throw new Error('COOPERATION_CHANGED')
    })
    await measure('materialization', async () => {
      const manifest = await read(await previewPath(evidence.root, profile.dependencies.manifest)), lock = await read(await previewPath(evidence.root, profile.dependencies.lockfile))
      if (bytesFingerprint(manifest) !== profile.dependencies.manifestHash || bytesFingerprint(lock) !== profile.dependencies.lockfileHash) throw new Error('DEPENDENCY_INPUT_CHANGED')
      const current = await this.dependencies.inspect(evidence.root, profile, selection.generation, manifest, lock, timing)
      if (current.basis !== result.dependencyBasis) throw new Error('DEPENDENCY_INSTALLATION_CHANGED')
      let materialization: string | null = null
      try { materialization = bytesFingerprint(await read(await previewPath(evidence.root, profile.dependencies.materialization))) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (materialization !== evidence.materialization) throw new Error('DEPENDENCY_INSTALLATION_CHANGED')
    })
    await measure('source_guard', async () => {
      const current = await git.getCoordinationSnapshot(selection.worktreeId)
      if (current.record.generation !== selection.generation || current.record.path !== evidence.root || current.reference || current.record.locked || current.record.detached || current.conflictCount || current.snapshot.operation ||
        previewFingerprint({ ...current.snapshot, dirty: current.stagedCount + current.unstagedCount + current.untrackedCount > 0 }) !== previewFingerprint(result.snapshot)) throw new Error('LAUNCH_EVIDENCE_CHANGED')
    })
    return result
  }
}
