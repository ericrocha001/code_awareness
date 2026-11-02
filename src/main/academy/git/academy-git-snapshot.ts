import type { GitService } from '../../core/git-service'
import type { AcademyGitSourceSnapshot } from '../../../shared/types/academy-git-source-types'
import type { AcademyPackage } from '../../../shared/types/academy-types'
import { AcademyError, hashAcademyPackage, normalizeAcademyPackage } from '../academy-package'
import { sha256 } from '../publication/openai-plugin-model'
import { assertNoAcademySecrets, assertSourcePath, validateGitSnapshot } from './academy-git-materializer'
export { assertSourcePath } from './academy-git-materializer'

export const ACADEMY_AUTHORED_PATHS = ['skills', 'plugin.json', 'assets']

export async function verifyStagedAcademyPackage(git: GitService, root: string, tree: string, name: string, pkg: AcademyPackage): Promise<void> {
  const expected = new Map(Object.entries({ 'SKILL.md': pkg.skillMd, ...pkg.artifacts }).map(([path, text]) => [`skills/${name}/${path}`, text]))
  const entries = (await git.readManagedTree(root, tree, [`skills/${name}`])).split('\0').filter(Boolean)
  if (entries.length !== expected.size) throw new AcademyError('GIT_DRAFT_CONTENT_CHANGED_BY_FILTER')
  for (const entry of entries) {
    const path = entry.slice(entry.indexOf('\t') + 1)
    const content = expected.get(path)
    const staged = await git.readCommitFile(root, tree, path, 8 * 1024 * 1024)
    if (content === undefined || !staged?.equals(Buffer.from(content, 'utf8'))) throw new AcademyError('GIT_DRAFT_CONTENT_CHANGED_BY_FILTER', path)
  }
}

export async function readAcademyGitSnapshot(git: GitService, root: string, identity: {
  repositoryId: string; remoteUrl: string; branch: string; sourceCommitSha: string; observedAt: string
}): Promise<AcademyGitSourceSnapshot> {
  if (!/^[a-f0-9]{40,64}$/.test(identity.sourceCommitSha) || await git.resolveCommit(root, identity.sourceCommitSha) !== identity.sourceCommitSha) throw new AcademyError('GIT_SOURCE_COMMIT_REQUIRED')
  const tree = await git.readManagedTree(root, identity.sourceCommitSha, ACADEMY_AUTHORED_PATHS)
  const files: Record<string, string> = {}
  const folded = new Set<string>()
  let totalBytes = 0
  for (const entry of tree.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(entry)
    if (!match) throw new AcademyError('GIT_SOURCE_UNSUPPORTED_ENTRY')
    const path = match[3]
    assertSourcePath(path)
    if (folded.has(path.toLowerCase())) throw new AcademyError('GIT_SOURCE_DUPLICATE_PATH', path)
    folded.add(path.toLowerCase())
    if (path.startsWith('assets/') && path !== 'assets/logo.png') throw new AcademyError('GIT_SOURCE_UNAUTHORIZED_ASSET', path)
    const bytes = await git.readCommitFile(root, identity.sourceCommitSha, path, 8 * 1024 * 1024)
    if (!bytes) throw new AcademyError('GIT_SOURCE_MISSING_FILE', path)
    totalBytes += bytes.length
    if (totalBytes > 16 * 1024 * 1024) throw new AcademyError('GIT_SOURCE_TOO_LARGE')
    if (path !== 'assets/logo.png' && (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes))) throw new AcademyError('GIT_SOURCE_INVALID_TEXT', path)
    if (path !== 'assets/logo.png') assertNoAcademySecrets(bytes.toString('utf8'), path)
    files[path] = bytes.toString('base64')
  }
  const packages = new Map<string, { skillMd: string; artifacts: Record<string, string> }>()
  for (const [path, encoded] of Object.entries(files)) {
    if (!path.startsWith('skills/')) continue
    const [, slug, ...parts] = path.split('/')
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug) || !parts.length) throw new AcademyError('GIT_SOURCE_UNSAFE_PATH', path)
    const pkg = packages.get(slug) ?? { skillMd: '', artifacts: {} }
    const relative = parts.join('/')
    const text = Buffer.from(encoded, 'base64').toString('utf8')
    if (relative === 'SKILL.md') pkg.skillMd = text
    else pkg.artifacts[relative] = text
    packages.set(slug, pkg)
  }
  const skills = [...packages].sort(([a], [b]) => a.localeCompare(b)).map(([name, input]) => {
    const pkg = normalizeAcademyPackage(input)
    return { path: `skills/${name}`, name, package: pkg, packageHash: hashAcademyPackage(pkg) }
  })
  validateGitSnapshot(skills.map(skill => ({ ...skill, skillId: skill.path, version: 0 })))
  return { schema: 1, ...identity, firstParentSha: await git.firstParent(root, identity.sourceCommitSha), managedTreeHash: sha256(tree), skills, authoredFiles: files }
}
