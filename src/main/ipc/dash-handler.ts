/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Registrar os manipuladores IPC para o protocolo Code Dash: parsing, validação, resolução e geração de contexto XML.
2. Validar defensivamente os parâmetros de entrada dos canais IPC antes de delegar aos serviços de domínio.
3. Implementar a funcionalidade One-Click XML (dash:one-click-xml) delegando ao OneClickXmlService.

Mapa de Relacionamentos do Script

1. src/main/core/dash/dash-service.ts
   - Tipo: Dependência Direta
   - Relação: Delega a execução das operações Code Dash seletivas ao DashService.
   - Criticidade: Alta

2. src/main/core/one-click-xml-service.ts
   - Tipo: Dependência Direta
   - Relação: Delega a geração do One-Click XML ao OneClickXmlService.
   - Criticidade: Alta

3. src/main/preload.ts
   - Tipo: Dependência Inversa
   - Relação: Expõe os canais IPC declarados neste handler para o processo renderer.
   - Criticidade: Alta

Invariantes do Script

1. Handlers IPC nunca devem lançar exceções não capturadas para o renderer; todas as falhas devem ser retornadas em formato estruturado { success, data, error }.
2. Nenhum processamento é iniciado se repoPath ou input forem inválidos ou vazios.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { ipcMain } from 'electron'
import type { DashService } from '../core/dash/dash-service'
import type { OneClickXmlService } from '../core/one-click-xml-service'

function isValidString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function registerDashHandlers(
  dashService: DashService,
  oneClickXmlService: OneClickXmlService
): void {
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

        const result = await dashService.execute(input, repoPath)
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
      }
    ) => {
      try {
        if (!isValidString(repoPath)) {
          return {
            success: false,
            error: 'repoPath é obrigatório e deve ser uma string não vazia.'
          }
        }

        const result = await oneClickXmlService.generateOneClickXml(repoPath, options)
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
