/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Registrar handlers IPC para operações de campanha.
2. Validar parâmetros recebidos antes de delegar ao CampaignService.
3. Capturar erros e retornar respostas estruturadas ao renderer.

Mapa de Relacionamentos do Script

1. campaign-service.ts
   - Tipo: Dependência Direta
   - Relação: Instancia e consome CampaignService.
   - Criticidade: Alta

2. ../../shared/types
   - Tipo: Contrato / Interface
   - Relação: Fornece os tipos Campaign e CampaignStatus.
   - Criticidade: Alta

Invariantes do Script

1. Handlers IPC nunca devem lançar exceções não tratadas — erros devem ser capturados e retornados como { success: false, error }.
2. Caminhos recebidos por IPC devem sempre ser validados como strings não vazias.
3. Toda resposta de handler deve conter o campo success.
4. Nenhuma lógica de negócio — apenas validação de parâmetros e delegação ao serviço.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { ipcMain } from 'electron'
import { CampaignService } from '../core/campaign-service'
import { CampaignStatus } from '../../shared/types'

const campaignService = new CampaignService()

// Valida se o valor recebido é uma string não vazia
function isValidPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function registerCampaignHandlers(): void {
  /**
   * campaign:create — Cria uma nova campanha.
   * Parâmetros: repoPath, data: { name, description? }
   * Retorna: { success, data?: Campaign, error?: string }
   */
  ipcMain.handle('campaign:create', async (_event, repoPath: string, data: { name: string; description?: string }) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }
      if (!data || typeof data !== 'object') {
        return { success: false, error: 'data é obrigatório e deve ser um objeto' }
      }
      if (!data.name || typeof data.name !== 'string' || data.name.trim().length === 0) {
        return { success: false, error: 'name é obrigatório e não pode ser vazio' }
      }

      const result = campaignService.createCampaign(repoPath, data)
      return { success: true, data: result }
    } catch (error: any) {
      console.error('[CampaignHandler] Erro ao criar campanha:', error)
      return { success: false, error: error.message || 'Erro ao criar campanha' }
    }
  })

  /**
   * campaign:list — Lista todas as campanhas de um repositório.
   * Parâmetros: repoPath
   * Retorna: { success, data?: Campaign[], error?: string }
   */
  ipcMain.handle('campaign:list', async (_event, repoPath: string) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }

      const data = campaignService.listCampaigns(repoPath)
      return { success: true, data }
    } catch (error: any) {
      console.error('[CampaignHandler] Erro ao listar campanhas:', error)
      return { success: false, error: error.message || 'Erro ao listar campanhas' }
    }
  })

  /**
   * campaign:get — Busca uma campanha por ID.
   * Parâmetros: repoPath, campaignId
   * Retorna: { success, data?: Campaign | null, error?: string }
   */
  ipcMain.handle('campaign:get', async (_event, repoPath: string, campaignId: string) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }
      if (!isValidPath(campaignId)) {
        return { success: false, error: 'campaignId é obrigatório e não pode ser vazio' }
      }

      const data = campaignService.getCampaign(repoPath, campaignId)
      return { success: true, data }
    } catch (error: any) {
      console.error('[CampaignHandler] Erro ao buscar campanha:', error)
      return { success: false, error: error.message || 'Erro ao buscar campanha' }
    }
  })

  /**
   * campaign:update — Atualiza uma campanha existente.
   * Parâmetros: repoPath, campaignId, patch: { name?, description?, status? }
   * Retorna: { success, data?: Campaign, error?: string }
   */
  ipcMain.handle('campaign:update', async (_event, repoPath: string, campaignId: string, patch: { name?: string; description?: string; status?: string }) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }
      if (!isValidPath(campaignId)) {
        return { success: false, error: 'campaignId é obrigatório e não pode ser vazio' }
      }
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return { success: false, error: 'patch é obrigatório e deve ser um objeto' }
      }

      // Valida status se presente
      if (patch.status !== undefined) {
        if (patch.status !== 'active' && patch.status !== 'completed') {
          return { success: false, error: 'status deve ser "active" ou "completed"' }
        }
      }

      const result = campaignService.updateCampaign(repoPath, campaignId, patch as { name?: string; description?: string; status?: CampaignStatus })
      return { success: true, data: result }
    } catch (error: any) {
      console.error('[CampaignHandler] Erro ao atualizar campanha:', error)
      return { success: false, error: error.message || 'Erro ao atualizar campanha' }
    }
  })
}