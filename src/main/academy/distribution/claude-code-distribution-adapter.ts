import { lstat, mkdir, readlink, realpath, rm, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AcademyDistributionAdapter, AcademyDistributionAdapterResult, AcademyDistributionContext } from './distribution-adapter'

export class ClaudeCodeDistributionAdapter implements AcademyDistributionAdapter {
  readonly target = 'CLAUDE_CODE' as const

  async inspect(context: AcademyDistributionContext): Promise<AcademyDistributionAdapterResult> {
    return this.inspectName(context, context.skill.name)
  }

  async reconcile(context: AcademyDistributionContext): Promise<AcademyDistributionAdapterResult> {
    const previousName = context.previous?.exposureName
    if (previousName && previousName !== context.skill.name) {
      const removed = await this.removeName(context, previousName, true)
      if (removed) return removed
    }

    const inspected = await this.inspect(context)
    if (inspected.status === 'CURRENT') return inspected
    if (inspected.status === 'ERROR' || inspected.errorCode === 'LINK_TARGET_INCORRECT') return inspected
    if (inspected.errorCode === 'LINK_BROKEN' && context.previous?.exposureName !== context.skill.name) return inspected
    if (inspected.errorCode === 'LINK_BROKEN') await rm(this.bridgePath(context, context.skill.name), { force: true })

    const source = await this.resolveSource(context)
    if ('status' in source) return source
    const bridge = this.bridgePath(context, context.skill.name)
    await mkdir(dirname(bridge), { recursive: true })
    let mechanism: 'SYMLINK' | 'JUNCTION' = 'SYMLINK'
    try {
      await symlink(relative(dirname(bridge), source.real), bridge, 'dir')
    } catch (error: any) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) return linkError(error)
      try {
        await symlink(source.real, bridge, 'junction')
        mechanism = 'JUNCTION'
      } catch (junctionError) { return linkError(junctionError) }
    }
    const verified = await this.inspect(context)
    return verified.status === 'CURRENT' ? { ...verified, linkMechanism: mechanism } : verified
  }

  async remove(context: AcademyDistributionContext): Promise<AcademyDistributionAdapterResult | null> {
    const name = context.previous?.exposureName
    if (!name) return null
    return this.removeName(context, name, true)
  }

  private async inspectName(context: AcademyDistributionContext, name: string): Promise<AcademyDistributionAdapterResult> {
    const source = await this.resolveSource(context)
    if ('status' in source) return source
    const bridge = this.bridgePath(context, name)
    let stats
    try { stats = await lstat(bridge) } catch (error: any) {
      if (error?.code === 'ENOENT') return result('MISSING', null, null, 'LINK_MISSING', 'Claude Code bridge is missing.', name, null)
      return linkError(error, name)
    }
    if (!stats.isSymbolicLink()) {
      const code = stats.isDirectory() ? 'DIRECTORY_CONFLICT' : 'ENTRY_CONFLICT'
      return result('ERROR', null, null, code, 'A non-managed filesystem entry conflicts with the Claude Code bridge.', name, null)
    }
    let target: string
    try { target = await realpath(bridge) } catch {
      return result('MISSING', null, null, 'LINK_BROKEN', 'Claude Code bridge target is missing.', name, await this.mechanism(bridge))
    }
    if (!samePath(target, source.real) || !isWithin(context.destination.path, target)) {
      return result('ERROR', null, null, 'LINK_TARGET_INCORRECT', 'Claude Code bridge points outside the expected .skills package.', name, await this.mechanism(bridge))
    }
    return result('CURRENT', context.skill.currentVersion, context.skill.current.packageHash, null, null, name, await this.mechanism(bridge))
  }

  private async removeName(context: AcademyDistributionContext, name: string, managed: boolean): Promise<AcademyDistributionAdapterResult | null> {
    const bridge = this.bridgePath(context, name)
    try {
      const stats = await lstat(bridge)
      if (!stats.isSymbolicLink()) return result('ERROR', null, null, stats.isDirectory() ? 'DIRECTORY_CONFLICT' : 'ENTRY_CONFLICT', 'Refusing to remove non-managed Claude Code content.', name, null)
      if (!managed) return result('ERROR', null, null, 'OWNERSHIP_UNKNOWN', 'Refusing to remove a bridge without Academy ownership.', name, await this.mechanism(bridge))
      await rm(bridge, { force: true })
      return null
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null
      return linkError(error, name)
    }
  }

  private async resolveSource(context: AcademyDistributionContext): Promise<{ real: string } | AcademyDistributionAdapterResult> {
    const projectRoot = resolve(context.destination.path)
    const skillsRoot = resolve(projectRoot, '.skills')
    const expected = resolve(skillsRoot, context.skill.name)
    if (!isWithin(projectRoot, skillsRoot) || !isWithin(skillsRoot, expected)) return result('ERROR', null, null, 'PATH_ESCAPE', 'Distribution target escaped the project.', context.skill.name, null)
    try {
      const [rootReal, sourceReal] = await Promise.all([realpath(skillsRoot), realpath(expected)])
      if (!isWithin(projectRoot, rootReal) || !isWithin(rootReal, sourceReal) || !samePath(sourceReal, expected)) {
        return result('ERROR', null, null, 'TARGET_OUTSIDE_PROJECT', 'The .skills package resolves outside the project.', context.skill.name, null)
      }
      return { real: sourceReal }
    } catch (error: any) {
      return result('MISSING', null, null, 'PROJECTION_MISSING', error instanceof Error ? error.message : 'The .skills projection is missing.', context.skill.name, null)
    }
  }

  private bridgePath(context: AcademyDistributionContext, name: string): string {
    const root = resolve(context.destination.path, '.claude', 'skills')
    const bridge = resolve(root, name)
    if (!isWithin(root, bridge)) throw new Error('PATH_ESCAPE')
    return bridge
  }

  private async mechanism(path: string): Promise<'SYMLINK' | 'JUNCTION'> {
    const target = await readlink(path)
    return isAbsolute(target) && process.platform === 'win32' ? 'JUNCTION' : 'SYMLINK'
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
  return normalize(left) === normalize(right)
}
function result(status: AcademyDistributionAdapterResult['status'], distributedVersion: number | null, distributedHash: string | null, errorCode: string | null, errorMessage: string | null, exposureName: string, linkMechanism: 'SYMLINK' | 'JUNCTION' | null): AcademyDistributionAdapterResult {
  return { status, distributedVersion, distributedHash, errorCode, errorMessage, exposureName, linkMechanism }
}
function linkError(error: unknown, exposureName: string | null = null): AcademyDistributionAdapterResult {
  const value = error as NodeJS.ErrnoException
  const permission = value?.code === 'EPERM' || value?.code === 'EACCES'
  return result('ERROR', null, null, permission ? 'PERMISSION_DENIED' : value?.code ?? 'LINK_ERROR', error instanceof Error ? error.message : String(error), exposureName ?? '', null)
}
