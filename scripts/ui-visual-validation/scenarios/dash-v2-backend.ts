import { createRepositoryModel } from '../../../src/main/core/repository-model'
import type { DashMapPort } from '../../../src/main/core/dash/dash-map-port'
import { DashService } from '../../../src/main/core/dash/dash-service'
import { registerDashHandlers } from '../../../src/main/ipc/dash-handler'

export async function start(repo: string) {
  const model = createRepositoryModel(repo)
  const map: DashMapPort = {
    awaitReadiness: async (_repo, capability) => {
      if (capability !== 'FILE_INVENTORY') await model.readiness.barrier(capability)
    },
    getFiles: () => model.getFiles(),
    getElements: () => model.getElementsByRepository(),
    getRelationships: () => model.getRelationships(),
    getSymbolReferencesBySourceElement: (_repo, id) => model.getSymbolReferencesBySourceElement(id),
    getSymbolReferencesByTargetElement: (_repo, id) => model.getSymbolReferencesByTargetElement(id),
    getElementExactSources: (_repo, ids) => model.getElementExactSources(ids),
    getFileContent: (_repo, path) => model.getFileContent(path)
  }
  registerDashHandlers(new DashService(map))
  return () => {
    model.close()
  }
}
