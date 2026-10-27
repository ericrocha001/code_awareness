import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative, isAbsolute, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { previewProfileSchema, previewFingerprint, type PreviewProfile } from './preview-profile'
import { repositoryTrustScope, standbyPolicySchema, type StandbyPolicy } from './runtime-preview/standby-policy'

export class PreviewProfileStore {
  private defaults: Promise<unknown> = Promise.resolve()
  constructor(private readonly directory: string) {}
  provideDefault(profileId: string, resolve: (current?: PreviewProfile) => Promise<PreviewProfile>): Promise<PreviewProfile> {
    const work = this.defaults.then(async () => {
      const file = join(this.directory, 'profiles.json')
      const read = async () => { try { return await readFile(file, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '[]'; throw error } }
      const before = await read(), all = previewProfileSchema.array().max(100).parse(JSON.parse(before))
      if (new Set(all.map(p => p.profileId)).size !== all.length) throw new Error('PROFILE_ID_CONFLICT')
      const current = all.find(p => p.profileId === profileId), candidate = previewProfileSchema.parse(await resolve(current))
      if (candidate.profileId !== profileId || current && candidate.repositoryId !== current.repositoryId) throw new Error('PROFILE_ID_CONFLICT')
      if (current && previewFingerprint(candidate) === previewFingerprint(current)) return current
      const profile = { ...candidate, revision: current ? current.revision + 1 : 1 }
      const next = all.filter(p => p.profileId !== profileId); next.push(profile)
      if (next.length > 100) throw new Error('PROFILE_LIMIT_REACHED')
      await mkdir(this.directory, { recursive: true })
      const temporary = join(this.directory, `profile-${randomUUID()}.tmp`)
      await writeFile(temporary, JSON.stringify(next), { flag: 'wx' })
      try {
        if (before !== await read()) throw new Error('PROFILE_CHANGED')
        await rename(temporary, file)
      } finally { await rm(temporary, { force: true }) }
      return profile
    })
    this.defaults = work.catch(() => {})
    return work
  }
  async profiles(repositoryId: string): Promise<PreviewProfile[]> {
    let raw: string
    try { raw = await readFile(join(this.directory, 'profiles.json'), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const profiles = previewProfileSchema.array().max(100).parse(JSON.parse(raw))
    if (new Set(profiles.map(p => p.profileId)).size !== profiles.length) throw new Error('PROFILE_ID_CONFLICT')
    return profiles.filter(p => p.repositoryId === repositoryId)
  }
  async assertExternal(worktree: string) {
    const path = relative(await realpath(worktree), await realpath(this.directory))
    if (!path || !(path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path))) throw new Error('PROFILE_STORE_INSIDE_WORKTREE')
  }
  private async approvals(): Promise<Record<string, { fingerprint: string; approvedAt: string; policy?: StandbyPolicy }>> {
    try { return JSON.parse(await readFile(join(this.directory, 'approvals.json'), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
  }
  async trusted(profile: PreviewProfile) {
    const grant = (await this.approvals())['repository:' + profile.repositoryId]
    if (!grant?.policy) return undefined
    try { return grant.fingerprint === repositoryTrustScope(profile) ? standbyPolicySchema.parse(grant.policy) : undefined } catch { return undefined }
  }
  async approved(profile: PreviewProfile) { return !!await this.trusted(profile) || (await this.approvals())[profile.profileId]?.fingerprint === previewFingerprint(profile) }
  async trust(profile: PreviewProfile, policy: StandbyPolicy, confirm: (profile: PreviewProfile, policy: StandbyPolicy) => Promise<boolean>, guard: () => void) {
    policy = standbyPolicySchema.parse(policy)
    const fingerprint = repositoryTrustScope(profile)
    if (!await confirm(profile, policy)) throw new Error('REPOSITORY_TRUST_REQUIRED')
    guard()
    const current = (await this.profiles(profile.repositoryId)).find(value => value.profileId === profile.profileId)
    if (!current || repositoryTrustScope(current) !== fingerprint) throw new Error('PROFILE_CHANGED')
    const approvals = await this.approvals()
    approvals['repository:' + profile.repositoryId] = { fingerprint, policy, approvedAt: new Date().toISOString() }
    await this.saveApprovals(approvals, guard)
  }
  async revoke(repositoryId: string, guard: () => void) {
    const approvals = await this.approvals()
    delete approvals['repository:' + repositoryId]
    for (const profile of await this.profiles(repositoryId)) delete approvals[profile.profileId]
    await this.saveApprovals(approvals, guard)
  }
  private async saveApprovals(approvals: Awaited<ReturnType<PreviewProfileStore['approvals']>>, guard: () => void) {
    await mkdir(this.directory, { recursive: true })
    const temporary = join(this.directory, `approval-${randomUUID()}.tmp`)
    guard()
    await writeFile(temporary, JSON.stringify(approvals), { flag: 'wx', mode: 0o600 })
    try { guard(); await rename(temporary, join(this.directory, 'approvals.json')) }
    finally { await rm(temporary, { force: true }) }
  }
  async approve(profile: PreviewProfile, confirm: (profile: PreviewProfile) => Promise<boolean>, guard: () => void = () => {}) {
    const fingerprint = previewFingerprint(profile)
    if (!await confirm(profile)) throw new Error('PROFILE_APPROVAL_REQUIRED')
    const current = (await this.profiles(profile.repositoryId)).find(p => p.profileId === profile.profileId)
    if (!current || previewFingerprint(current) !== fingerprint) throw new Error('PROFILE_CHANGED')
    const approvals = await this.approvals()
    approvals[profile.profileId] = { fingerprint, approvedAt: new Date().toISOString() }
    await mkdir(this.directory, { recursive: true })
    const temporary = join(this.directory, `approval-${randomUUID()}.tmp`)
    guard()
    await writeFile(temporary, JSON.stringify(approvals), { flag: 'wx' })
    try { guard(); await rename(temporary, join(this.directory, 'approvals.json')) }
    finally { await rm(temporary, { force: true }) }
  }
}
