import { ipcMain } from 'electron'
import { ArtifactStore } from '../../../src/main/continuum/artifact-store'
import { ContinuumService } from '../../../src/main/continuum/continuum-service'
import { registerContinuumBuilderHandlers } from '../../../src/main/ipc/continuum-builder-handler'
import { BundleResultHistory } from '../../../src/main/continuum/bundle-result-history'
import type { RepositoryContinuumSession } from '../../../src/main/continuum/project-continuum-session'

export function start(dbPath: string, corpus?: Array<Parameters<ArtifactStore['create']>[0]>) {
  const store = new ArtifactStore(dbPath, 'proof-repository'), service = new ContinuumService(store)
  service.mutateTags({ repositoryId: 'proof-repository', intent: 'create', tag: { slug: 'git-atlas', name: 'Git Atlas' } })
  const structured = '\n```json\n' + JSON.stringify(Array.from({ length: 80 }, (_, index) => ({ id: index, contract: 'Não alterar o contrato abc123', status: 'ACTIVE', name: 'Arquitetura de evidência repetida' })), null, 2) + '\n```\n'
  if (corpus) {
    const tags = new Set(corpus.flatMap(item => Array.isArray(item.metadata.tags) ? item.metadata.tags : []).filter((tag): tag is string => typeof tag === 'string'))
    for (const slug of tags) if (slug !== 'git-atlas') service.mutateTags({ repositoryId: 'proof-repository', intent: 'create', tag: { slug, name: slug } })
    for (const item of corpus) store.create({ artifactId: item.artifactId, metadata: { ...item.metadata, relations: [] }, rawMarkdown: item.rawMarkdown })
  } else for (let index = 0; index < 67; index++) service.publishHuman(`---\nname: Architecture ${String(index).padStart(2, '0')}\ndescription: Isolated functional acceptance\nkind: DOCUMENT\nartifactRole: ARCHITECTURE_MAP\n${index < 41 ? 'tags: [git-atlas]\n' : ''}---\n# Arquitetura ${index}\n\nNão alterar o hash abc123 nem a revisão. Ação em português 🚀.\n${index === 0 ? structured : ''}`, true)
  registerContinuumBuilderHandlers({ getActiveService: () => service, getActiveSession: () => ({ repositoryId: 'proof-repository', dbPath }), getStorageBaseDir: () => dbPath + '-profile', onChanged: () => () => {} } as unknown as RepositoryContinuumSession)
  ipcMain.handle('builder-proof:list', (_event, request) => ({ repositoryId: 'proof-repository', ...service.list({ query: request.query, cursor: request.cursor, limit: 30 }) }))
  ipcMain.handle('builder-proof:get', (_event, repositoryId, id) => { service.assertRepository(repositoryId); const artifact = service.get(id); return { repositoryId, artifact: artifact ? { ...artifact, body: artifact.rawMarkdown } : null } })
  return { service, store, close: () => store.close() }
}
export function readHistory(root: string) {
  const store = new BundleResultHistory(root)
  try { return store.list('proof-repository').map(result => ({ ...result, exact: store.get('proof-repository', result.id).data.toString('base64') })) }
  finally { store.close() }
}
