import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'

export interface CliProjectSelection {
  revision: number
  project: { id: string; path: string } | null
}
export interface CliCatalogCheckout {
  id: string
  localCheckout: { path: string; availability: string; gitState: string } | null
}
export function createCliProjectAuthority(options: {
  selection: CliProjectSelection
  getSelection: () => CliProjectSelection
  findRepository: (path: string) => CliCatalogCheckout | null
  captureGitIdentity: (path: string) => Promise<unknown>
}): () => Promise<string> {
  const selected = options.selection
  if (!selected.project) throw new Error('NO_ACTIVE_PROJECT')
  const project = selected.project
  const physicalRoot = realpathSync(project.path)
  const generation = statSync(physicalRoot)
  const catalog = options.findRepository(project.path)
  const repositoryId = catalog?.id ?? null
  const check = () => {
    const current = options.getSelection()
    const repository = options.findRepository(project.path)
    const physical = realpathSync(project.path), stat = statSync(physical)
    if (!current.project || current.revision !== selected.revision || current.project.id !== project.id ||
      realpathSync(current.project.path) !== physicalRoot || physical !== physicalRoot ||
      stat.dev !== generation.dev || stat.ino !== generation.ino || stat.birthtimeMs !== generation.birthtimeMs ||
      (repository?.id ?? null) !== repositoryId ||
      (repositoryId && (!repository?.localCheckout || repository.localCheckout.availability !== 'AVAILABLE' ||
        realpathSync(repository.localCheckout.path) !== physicalRoot || repository.localCheckout.gitState !== catalog?.localCheckout?.gitState))) {
      throw new Error('PROJECT_CONTEXT_CHANGED')
    }
  }
  return async () => {
    check()
    const git = catalog?.localCheckout?.gitState === 'GIT' ? await options.captureGitIdentity(physicalRoot) : null
    check()
    return createHash('sha256').update(JSON.stringify({ projectId: project.id, repositoryId, selectionRevision: selected.revision,
      physicalRoot, generation: { dev: generation.dev, ino: generation.ino, birthtimeMs: generation.birthtimeMs }, git })).digest('hex')
  }
}
