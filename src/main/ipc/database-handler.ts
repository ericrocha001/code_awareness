/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Registrar handlers IPC para operações de log de ações e inicialização de banco de dados.
2. Validar parâmetros recebidos do renderer.
3. Delegar chamadas à porta ActionLogPort e retornar resultados estruturados.

Mapa de Relacionamentos do Script

1. ../core/database-ports.ts
   - Tipo: Contrato / Interface
   - Relação: Consome ActionLogPort via injeção de dependência para operações de log de ações.
   - Criticidade: Alta

2. ../../shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Fornece o tipo ActionLog para tipagem das respostas.
   - Criticidade: Alta

3. preload.ts
   - Tipo: Dependência Inversa
   - Relação: Os métodos expostos no preload invocam estes handlers via ipcRenderer.invoke.
   - Criticidade: Alta

Invariantes do Script

1. Handlers IPC nunca devem lançar exceções não tratadas — erros devem ser capturados e retornados como { success: false, error }.
2. Toda resposta de handler deve conter o campo success.
3. repoPath deve ser validado como string não vazia antes de processar qualquer operação.
4. Nenhuma lógica de negócio deve ser implementada aqui — apenas delegação à porta ActionLogPort.
5. Não instancia dependências internamente — recebe ActionLogPort pronta no registro.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { ipcMain } from 'electron'
import type { ActionLogPort } from '../core/database-ports'
import { ActionLog } from '../../shared/types'

// Valida se o valor recebido é uma string não vazia
function isValidPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function registerDatabaseHandlers(actionLogPort: ActionLogPort): void {
  /**
   * database:initialize — Inicializa o banco de dados para um repositório (no-op transparente com adapter sob demanda).
   * Parâmetros: repoPath
   * Retorna: { success, error? }
   */
  ipcMain.handle('database:initialize', async (_event, repoPath: string) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }

      return { success: true }
    } catch (error: any) {
      console.error('[DatabaseHandler] Erro ao inicializar banco:', error)
      return { success: false, error: error.message || 'Erro ao inicializar banco de dados' }
    }
  })

  /**
   * database:insert-action — Insere uma ação no banco.
   * Parâmetros: action (Omit<ActionLog, 'id'>)
   * Retorna: { success, error? }
   */
  ipcMain.handle('database:insert-action', async (_event, action: Omit<ActionLog, 'id'>) => {
    try {
      if (!action || typeof action !== 'object') {
        return { success: false, error: 'action é obrigatório e deve ser um objeto' }
      }
      if (!isValidPath(action.repoPath)) {
        return { success: false, error: 'action.repoPath é obrigatório e não pode ser vazio' }
      }
      if (!action.actionType) {
        return { success: false, error: 'action.actionType é obrigatório' }
      }

      actionLogPort.insertAction(action)
      return { success: true }
    } catch (error: any) {
      console.error('[DatabaseHandler] Erro ao inserir ação:', error)
      return { success: false, error: error.message || 'Erro ao inserir ação' }
    }
  })

  /**
   * database:get-actions — Consulta ações de um repositório.
   * Parâmetros: repoPath, limit? (opcional)
   * Retorna: { success, data?: ActionLog[], error? }
   */
  ipcMain.handle('database:get-actions', async (_event, repoPath: string, limit?: number) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }

      const data = actionLogPort.getActions(repoPath, limit)
      return { success: true, data }
    } catch (error: any) {
      console.error('[DatabaseHandler] Erro ao consultar ações:', error)
      return { success: false, error: error.message || 'Erro ao consultar ações' }
    }
  })

  /**
   * database:get-actions-by-date-range — Consulta ações por intervalo de datas.
   * Parâmetros: repoPath, startDate, endDate
   * Retorna: { success, data?: ActionLog[], error? }
   */
  ipcMain.handle('database:get-actions-by-date-range', async (_event, repoPath: string, startDate: number, endDate: number) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }
      if (typeof startDate !== 'number' || typeof endDate !== 'number') {
        return { success: false, error: 'startDate e endDate devem ser números' }
      }

      const data = actionLogPort.getActionsByDateRange(repoPath, startDate, endDate)
      return { success: true, data }
    } catch (error: any) {
      console.error('[DatabaseHandler] Erro ao consultar ações por data:', error)
      return { success: false, error: error.message || 'Erro ao consultar ações por data' }
    }
  })
}