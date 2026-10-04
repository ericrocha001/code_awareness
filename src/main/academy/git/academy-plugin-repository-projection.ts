import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync, lstatSync } from 'node:fs'
import { join, relative } from 'node:path'
import type {
  AcademyOpenAiPluginProfile,
  AcademyOpenAiSnapshotEntry,
  AcademyPluginPackageRevision
} from '../../../shared/types/academy-types'
import { AcademyError } from '../academy-package'
import {
  buildOpenAiManifest,
  canonicalJson
} from '../publication/openai-plugin-model'
import { validateOpenAiPluginPackage } from '../publication/openai-plugin-validator'
import type { ZipEntry } from '../publication/deterministic-zip'

export interface PluginProjectionResult {
  version: string
  manifestHash: string
}

async function getFilesRecursively(dir: string): Promise<string[]> {
  const dirents = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const dirent of dirents) {
    const full = join(dir, dirent.name)
    if (dirent.isDirectory()) {
      files.push(...(await getFilesRecursively(full)))
    } else if (dirent.isFile()) {
      files.push(full)
    }
  }
  return files
}

export class AcademyPluginRepositoryProjection {
  async project(
    repoRoot: string,
    profile: AcademyOpenAiPluginProfile,
    snapshot: AcademyOpenAiSnapshotEntry[],
    revision: AcademyPluginPackageRevision
  ): Promise<PluginProjectionResult> {
    const version = revision.version
    const manifest = buildOpenAiManifest(profile, version)
    const manifestJson = `${canonicalJson(manifest)}\n`

    await writeFile(join(repoRoot, 'plugin.json'), manifestJson, 'utf8')

    if (profile.logoPath) {
      if (!existsSync(profile.logoPath)) {
        throw new AcademyError('OPENAI_PLUGIN_LOGO_INVALID', `OPENAI_PLUGIN_LOGO_INVALID: Logo not found at ${profile.logoPath}`)
      }
      const stat = lstatSync(profile.logoPath)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new AcademyError('OPENAI_PLUGIN_LOGO_INVALID', `OPENAI_PLUGIN_LOGO_INVALID: Logo path must be a regular file: ${profile.logoPath}`)
      }
      const assetsDir = join(repoRoot, 'assets')
      if (!existsSync(assetsDir)) await mkdir(assetsDir, { recursive: true })
      await copyFile(profile.logoPath, join(assetsDir, 'logo.png'))
    }

    return { version, manifestHash: canonicalJson(manifest) }
  }

  async validate(
    repoRoot: string,
    profile: AcademyOpenAiPluginProfile,
    snapshot: AcademyOpenAiSnapshotEntry[]
  ): Promise<void> {
    const entries = await this.collectValidationEntries(repoRoot, profile, snapshot)
    validateOpenAiPluginPackage(entries, profile, snapshot)
  }

  private async collectValidationEntries(
    repoRoot: string,
    profile: AcademyOpenAiPluginProfile,
    snapshot: AcademyOpenAiSnapshotEntry[]
  ): Promise<ZipEntry[]> {
    const prefix = profile.name
    const entries: ZipEntry[] = []

    const manifestPath = join(repoRoot, 'plugin.json')
    if (!existsSync(manifestPath)) throw new AcademyError('PLUGIN_JSON_MISSING')
    entries.push({ path: `${prefix}/plugin.json`, data: await readFile(manifestPath) })

    const logoPath = join(repoRoot, 'assets', 'logo.png')
    if (existsSync(logoPath)) {
      entries.push({ path: `${prefix}/assets/logo.png`, data: await readFile(logoPath) })
    }

    for (const item of snapshot) {
      const skillDir = join(repoRoot, 'skills', item.name)
      if (!existsSync(skillDir)) continue
      const files = await getFilesRecursively(skillDir)
      for (const file of files) {
        const rel = relative(skillDir, file).replaceAll('\\', '/')
        const data = await readFile(file)
        entries.push({ path: `${prefix}/skills/${item.name}/${rel}`, data })
      }
    }

    return entries
  }
}
