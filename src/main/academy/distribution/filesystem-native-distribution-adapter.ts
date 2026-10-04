import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { hashAcademyPackage } from '../academy-package'
import { readSkillDirectory } from '../academy-filesystem'
import type { AcademyStore } from '../academy-store'
import type { AcademyDistributionAdapter, AcademyDistributionAdapterResult, AcademyDistributionContext } from './distribution-adapter'

export class FilesystemNativeDistributionAdapter implements AcademyDistributionAdapter {
  readonly target = 'FILESYSTEM_NATIVE' as const

  constructor(private readonly store: AcademyStore) {}

  inspect(context: AcademyDistributionContext): Promise<AcademyDistributionAdapterResult> { return this.evaluate(context) }
  reconcile(context: AcademyDistributionContext): Promise<AcademyDistributionAdapterResult> { return this.evaluate(context) }
  async remove(): Promise<null> { return null }

  private async evaluate({ destination, skill }: AcademyDistributionContext): Promise<AcademyDistributionAdapterResult> {
    const projection = this.store.getProjection(skill.id, destination.id)
    const directory = join(destination.path, '.skills', skill.name)
    if (!projection) return result('MISSING', null, null, 'PROJECTION_MISSING', 'The managed .skills projection is not registered.', skill.name)
    try {
      if ((await lstat(directory)).isSymbolicLink()) return result('ERROR', projection.version, null, 'PROJECTION_LINK_UNEXPECTED', 'The .skills projection must be a physical Academy-managed directory.', skill.name)
      const distributedHash = hashAcademyPackage(await readSkillDirectory(directory))
      if (distributedHash !== skill.current.packageHash || projection.version !== skill.currentVersion) {
        return result('DRIFTED', projection.version, distributedHash, 'PROJECTION_DRIFTED', 'The .skills package differs from the canonical Academy version.', skill.name)
      }
      return result('CURRENT', projection.version, distributedHash, null, null, skill.name)
    } catch (error: any) {
      if (error?.code === 'ENOENT') return result('MISSING', projection.version, null, 'PROJECTION_MISSING', 'The .skills directory is missing.', skill.name)
      return result('ERROR', projection.version, null, error?.code ?? 'PROJECTION_ERROR', error instanceof Error ? error.message : String(error), skill.name)
    }
  }
}

function result(status: AcademyDistributionAdapterResult['status'], distributedVersion: number | null, distributedHash: string | null, errorCode: string | null, errorMessage: string | null, exposureName: string): AcademyDistributionAdapterResult {
  return { status, distributedVersion, distributedHash, errorCode, errorMessage, exposureName, linkMechanism: null }
}
