/*
-T ---
*/

import { ipcMain } from 'electron'
import type { DashService } from '../core/dash/dash-service'
import type { OneClickXmlService } from '../core/one-click-xml-service'
import type { DashSettings } from '../../shared/types'
import type { DashDiscoveryService } from '../core/dash/dash-discovery-service'

function isValidString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function registerDashHandlers(
  dashService: DashService,
  oneClickXmlService: OneClickXmlService,
  discoveryService?: DashDiscoveryService
): void {
  ipcMain.handle('dash:discover', async (_event, request: unknown, repoPath: string) => {
    try {
      if (!discoveryService) throw new Error('Repo Discovery is unavailable.')
      if (!isValidString(repoPath)) throw new Error('repoPath is required.')
      return { success: true, data: await discoveryService.execute(request, repoPath) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Repo Discovery failed.' }
    }
  })

  ipcMain.handle(
    'dash:parse-and-resolve',
    async (_event, input: string, repoPath: string) => {
      try {
        if (!isValidString(repoPath)) {
          return {
            success: false,
            error: 'repoPath é obrigatório e deve ser uma string não vazia.'
          }
        }
        if (!isValidString(input)) {
          return {
            success: false,
            error: 'input é obrigatório e deve ser uma string não vazia.'
          }
        }

        const result = dashService.parseAndResolve(input, repoPath)
        return result
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : 'Erro inesperado ao processar requisição Code Dash.'
        }
      }
    }
  )

  ipcMain.handle(
    'dash:generate',
    async (_event, input: string, repoPath: string, settings?: DashSettings) => {
      try {
        if (!isValidString(repoPath)) {
          return {
            success: false,
            error: 'repoPath é obrigatório e deve ser uma string não vazia.'
          }
        }
        if (!isValidString(input)) {
          return {
            success: false,
            error: 'input é obrigatório e deve ser uma string não vazia.'
          }
        }

        const result = await dashService.execute(input, repoPath, {
          repoPath,
          settings
        })
        if (result.success) {
          return {
            success: true,
            data: result
          }
        }
        return {
          success: false,
          error: result.error || 'Falha na execução do Code Dash.'
        }
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : 'Erro inesperado ao gerar contexto Code Dash.'
        }
      }
    }
  )

  ipcMain.handle(
    'dash:one-click-xml',
    async (
      _event,
      repoPath: string,
      options?: {
        removeComments?: boolean
        removeEmptyLines?: boolean
        truncateBase64?: boolean
        persistedSettings?: DashSettings
      },
      persistedSettingsFallback?: DashSettings
    ) => {
      try {
        if (!isValidString(repoPath)) {
          return {
            success: false,
            error: 'repoPath é obrigatório e deve ser uma string não vazia.'
          }
        }

        const fallback = options?.persistedSettings ?? persistedSettingsFallback
        const effectiveOptions = {
          removeComments:
            typeof options?.removeComments === 'boolean'
              ? options.removeComments
              : fallback?.removeComments,
          removeEmptyLines:
            typeof options?.removeEmptyLines === 'boolean'
              ? options.removeEmptyLines
              : fallback?.removeEmptyLines,
          truncateBase64:
            typeof options?.truncateBase64 === 'boolean'
              ? options.truncateBase64
              : fallback?.truncateBase64
        }

        const result = await oneClickXmlService.generateOneClickXml(
          repoPath,
          effectiveOptions
        )
        return result
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : 'Erro inesperado no One-Click XML.'
        }
      }
    }
  )
}
