import { ipcMain } from 'electron'
import { GitService } from '../../../src/main/core/git-service'
import { GitOperationsService } from '../../../src/main/git-operations/git-operations-service'
import { GitHubGitTransport } from '../../../src/main/github/github-git-transport'
import {
  GitManagementController,
  registerGitManagementHandlers
} from '../../../src/main/ipc/git-management-handler'
import { ActiveProjectService } from '../../../src/main/core/active-project-service'
import { RuntimeIdentityProvider } from '../../../src/main/runtime-identity/runtime-identity-provider'

export async function setup(
  root: string,
  secondRoot: string,
  nonGitRoot: string,
  sourceRoot: string
) {
  const runtime = new RuntimeIdentityProvider({
    rootDir: sourceRoot,
    mode: 'production'
  })
  await runtime.sourceOriginReady
  const projects = new ActiveProjectService({
    getOpenProjects: () => [
      { id: 'proof-a', name: 'Git Management Proof', path: root },
      { id: 'proof-b', name: 'Second Repository', path: secondRoot },
      { id: 'proof-non-git', name: 'Non Git Folder', path: nonGitRoot }
    ],
    closeRepository: () => {}
  })
  const git = new GitService()
  const controller = new GitManagementController(projects)
  projects.onBeforeChange(() => controller.deactivate())
  projects.onChanged((state) => {
    controller.bind(
      state.project
        ? new GitOperationsService(
            state.project.path,
            git,
            new GitHubGitTransport(null, git),
            {
              repositoryId: state.project.id,
              isActive: () => projects.getState().revision === state.revision &&
                projects.getState().project?.id === state.project?.id
            }
          )
        : null
    )
  })
  registerGitManagementHandlers(controller)
  ipcMain.handle('project:get-active', () => projects.getState())
  ipcMain.handle('repositories:list', () => [])
  ipcMain.handle('project:activate', async (_event, id) => ({
    success: true,
    data: await projects.activate(id)
  }))
  await projects.activate('proof-a')
  return { controller, projects, runtime }
}
