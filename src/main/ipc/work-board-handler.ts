import { ipcMain } from 'electron'
import type { ActiveProjectService } from '../core/active-project-service'
import type { RepositoryContinuumSession } from '../continuum/project-continuum-session'
import type { WorkBoardResult } from '../../shared/types/work-board-types'
import { readWorkBoard, workBoardRequest } from '../work-orchestration/work-board'
import { inspectWorkBoard, type WorkBoardInspectionSources } from '../work-orchestration/work-board-inspection'

export function registerWorkBoardHandler(projects: Pick<ActiveProjectService, 'getState'>,
  continuum: Pick<RepositoryContinuumSession, 'getActiveSession' | 'getActiveService'>, sources: () => WorkBoardInspectionSources): () => void {
  ipcMain.handle('work-orchestration:board', async (_event, input: unknown): Promise<WorkBoardResult> => {
    const parsed = workBoardRequest.safeParse(input)
    if (!parsed.success) return { success: false, code: 'INVALID_ARGUMENT' }
    const { context } = parsed.data
    const matchesProject = () => {
      const state = projects.getState()
      return state.project?.id === context.projectId && state.revision === context.revision && state.context?.repositoryId === context.repositoryId
    }
    if (!matchesProject()) return { success: false, code: 'PROJECT_CONTEXT_CHANGED' }
    const session = continuum.getActiveSession()
    const service = continuum.getActiveService()
    if (!service || session?.repositoryId !== context.repositoryId) return { success: false, code: 'CONTINUUM_UNAVAILABLE' }
    const current = () => matchesProject() && continuum.getActiveSession() === session
    try {
      const assertCurrent = () => { if (!current()) throw new Error('PROJECT_CONTEXT_CHANGED') }
      const request = parsed.data
      const page = readWorkBoard(service, request)
      if (request.inspect) page.inspection = await inspectWorkBoard(service, sources(), request, assertCurrent)
      else await Promise.resolve()
      return current() ? { success: true, context, page } : { success: false, code: 'PROJECT_CONTEXT_CHANGED' }
    } catch (error) {
      if (!current()) return { success: false, code: 'PROJECT_CONTEXT_CHANGED' }
      const message = error instanceof Error ? error.message : ''
      const code = message.startsWith('INVALID_ARGUMENT') ? 'INVALID_ARGUMENT'
        : ['BOARD_CHANGED', 'GRAPH_REVISION_CONFLICT'].includes(message) ? 'BOARD_CHANGED' : 'CONTINUUM_UNAVAILABLE'
      return { success: false, code }
    }
  })
  return () => ipcMain.removeHandler('work-orchestration:board')
}
