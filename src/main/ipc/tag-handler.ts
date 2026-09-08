/*
-T ---
*/

import { ipcMain } from 'electron'
import { Tag } from '../../shared/types'
import { tagService } from '../core/tag-service'

type IpcResponse<T> = {
  success: boolean
  data?: T
  error?: string
}

export function registerTagHandlers(): void {
  ipcMain.handle('tags:get', (_event, repoPath: string): IpcResponse<Tag[]> => {
    try {
      if (!repoPath || typeof repoPath !== 'string') {
        return { success: false, error: 'repoPath inválido' }
      }
      const data = tagService.getTags(repoPath)
      return { success: true, data }
    } catch (err) {
      return { success: false, error: 'Erro ao carregar tags' }
    }
  })

  ipcMain.handle('tags:upsert', (_event, repoPath: string, tag: Tag): IpcResponse<Tag> => {
    try {
      if (!repoPath || typeof repoPath !== 'string') {
        return { success: false, error: 'repoPath inválido' }
      }
      if (!tag || typeof tag !== 'object') {
        return { success: false, error: 'tag inválida' }
      }
      const data = tagService.upsertTag(repoPath, tag)
      return { success: true, data }
    } catch (err) {
      return { success: false, error: 'Erro ao salvar tag' }
    }
  })

  ipcMain.handle('tags:delete', (_event, repoPath: string, tagId: string): IpcResponse<void> => {
    try {
      if (!repoPath || typeof repoPath !== 'string') {
        return { success: false, error: 'repoPath inválido' }
      }
      if (!tagId || typeof tagId !== 'string') {
        return { success: false, error: 'tagId inválido' }
      }
      tagService.deleteTag(repoPath, tagId)
      return { success: true }
    } catch (err) {
      return { success: false, error: 'Erro ao excluir tag' }
    }
  })

  // ─── Associação Arquivo ↔ Tag ──────────────────────────────────────────

  ipcMain.handle('tag:getFileTags', (_event, repoPath: string): IpcResponse<Record<string, string[]>> => {
    try {
      if (!repoPath || typeof repoPath !== 'string') {
        return { success: false, error: 'repoPath inválido' }
      }
      const data = tagService.getFileTags(repoPath)
      return { success: true, data }
    } catch (err) {
      return { success: false, error: 'Erro ao carregar associações de tags' }
    }
  })

  ipcMain.handle('tag:setFileTag', (_event, repoPath: string, relativePath: string, tagId: string): IpcResponse<void> => {
    try {
      if (!repoPath || typeof repoPath !== 'string') {
        return { success: false, error: 'repoPath inválido' }
      }
      if (!relativePath || typeof relativePath !== 'string') {
        return { success: false, error: 'relativePath inválido' }
      }
      if (!tagId || typeof tagId !== 'string') {
        return { success: false, error: 'tagId inválido' }
      }
      tagService.setFileTag(repoPath, relativePath, tagId)
      return { success: true }
    } catch (err) {
      return { success: false, error: 'Erro ao associar tag ao arquivo' }
    }
  })

  ipcMain.handle('tag:removeFileTag', (_event, repoPath: string, relativePath: string, tagId: string): IpcResponse<void> => {
    try {
      if (!repoPath || typeof repoPath !== 'string') {
        return { success: false, error: 'repoPath inválido' }
      }
      if (!relativePath || typeof relativePath !== 'string') {
        return { success: false, error: 'relativePath inválido' }
      }
      if (!tagId || typeof tagId !== 'string') {
        return { success: false, error: 'tagId inválido' }
      }
      tagService.removeFileTag(repoPath, relativePath, tagId)
      return { success: true }
    } catch (err) {
      return { success: false, error: 'Erro ao remover tag do arquivo' }
    }
  })
}
