/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Registrar handlers IPC para operações de checkpoint.
2. Validar parâmetros recebidos antes de delegar ao CheckpointService.
3. Capturar erros e retornar respostas estruturadas ao renderer.
4. Registrar handler IPC para geração de diff semântico entre checkpoints.
5. Registrar handler IPC para renomear checkpoints.
6. Registrar handler IPC para obter lista de arquivos alterados entre checkpoints.

Mapa de Relacionamentos do Script

1. checkpoint-service.ts
   - Tipo: Dependência Direta
   - Relação: Instancia e consome CheckpointService para todas as operações.
   - Criticidade: Alta

2. ../../shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Fornece os tipos CheckpointData, CheckpointSummary retornados pelos handlers.
   - Criticidade: Alta

3. diff (biblioteca npm)
   - Tipo: Dependência Indireta
   - Relação: Usada pelo CheckpointService para calcular hunks.
   - Criticidade: Média

Invariantes do Script

1. Handlers IPC nunca devem lançar exceções não tratadas — erros devem ser capturados e retornados como { success: false, error }.
2. Caminhos recebidos por IPC devem sempre ser validados como strings não vazias.
3. Toda resposta de handler deve conter o campo success.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { ipcMain } from 'electron'
import { CheckpointService } from '../core/checkpoint-service'

const checkpointService = new CheckpointService()

// Valida se o valor recebido é uma string não vazia
function isValidPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

// Valida se o checkpointId contém apenas caracteres alfanuméricos, underscore e hífen
// Previne path traversal: "../../../etc/passwd" seria rejeitado
function isValidCheckpointId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value)
}

export function registerCheckpointHandlers(): void {
  /**
   * checkpoint:create — Cria um novo checkpoint do repositório.
   * Parâmetros: repoPath, name, strategy ('all' | 'critical-high')
   * Retorna: { success, data?: CheckpointData, error?: string }
   */
  ipcMain.handle('checkpoint:create', async (_event, repoPath: string, name: string, strategy: 'all' | 'critical-high') => {
    try {
      // Valida parâmetros obrigatórios
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }
      if (!isValidPath(name)) {
        return { success: false, error: 'name é obrigatório e não pode ser vazio' }
      }
      if (strategy !== 'all' && strategy !== 'critical-high') {
        return { success: false, error: 'strategy deve ser "all" ou "critical-high"' }
      }

      const data = await checkpointService.createCheckpoint(repoPath, name, strategy)
      return { success: true, data }
    } catch (error: any) {
      console.error('[CheckpointHandler] Erro ao criar checkpoint:', error)
      return { success: false, error: error.message || 'Erro ao criar checkpoint' }
    }
  })

  /**
   * checkpoint:list — Lista todos os checkpoints do repositório.
   * Parâmetros: repoPath
   * Retorna: { success, data?: CheckpointSummary[], error?: string }
   */
  ipcMain.handle('checkpoint:list', async (_event, repoPath: string) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }

      const data = await checkpointService.listCheckpoints(repoPath)
      return { success: true, data }
    } catch (error: any) {
      console.error('[CheckpointHandler] Erro ao listar checkpoints:', error)
      return { success: false, error: error.message || 'Erro ao listar checkpoints' }
    }
  })

  /**
   * checkpoint:load — Carrega um checkpoint específico pelo ID.
   * Parâmetros: repoPath, checkpointId
   * Retorna: { success, data?: CheckpointData | null, error?: string }
   */
  ipcMain.handle('checkpoint:load', async (_event, repoPath: string, checkpointId: string) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }
      if (!isValidCheckpointId(checkpointId)) {
        return { success: false, error: 'checkpointId contém caracteres inválidos' }
      }

      const data = await checkpointService.loadCheckpoint(repoPath, checkpointId)
      return { success: true, data }
    } catch (error: any) {
      console.error('[CheckpointHandler] Erro ao carregar checkpoint:', error)
      return { success: false, error: error.message || 'Erro ao carregar checkpoint' }
    }
  })

  /**
   * checkpoint:delete — Deleta um checkpoint específico.
   * Parâmetros: repoPath, checkpointId
   * Retorna: { success: boolean }
   */
  ipcMain.handle('checkpoint:delete', async (_event, repoPath: string, checkpointId: string) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }
      if (!isValidCheckpointId(checkpointId)) {
        return { success: false, error: 'checkpointId contém caracteres inválidos' }
      }

      const deleted = await checkpointService.deleteCheckpoint(repoPath, checkpointId)
      return { success: deleted }
    } catch (error: any) {
      console.error('[CheckpointHandler] Erro ao deletar checkpoint:', error)
      return { success: false, error: error.message || 'Erro ao deletar checkpoint' }
    }
  })

  /**
   * checkpoint:restore — Restaura arquivos do repositório para o estado de um checkpoint.
   * Parâmetros: repoPath, checkpointId
   * Retorna: { success: boolean, data?: { restored: number, failed: number, errors: string[] }, error?: string }
   */
  ipcMain.handle('checkpoint:restore', async (_event, repoPath: string, checkpointId: string) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }
      if (!isValidCheckpointId(checkpointId)) {
        return { success: false, error: 'checkpointId contém caracteres inválidos' }
      }

      const result = await checkpointService.restoreCheckpoint(repoPath, checkpointId)

      if (result.errors.length > 0 && result.restored === 0) {
        return { success: false, error: result.errors[0], data: result }
      }

      return { success: true, data: result }
    } catch (error: any) {
      console.error('[CheckpointHandler] Erro ao restaurar checkpoint:', error)
      return { success: false, error: error.message || 'Erro ao restaurar checkpoint' }
    }
  })

  /**
   * checkpoint:generate-diff — Gera diff semântico entre checkpoints ou entre checkpoint e disco.
   * Parâmetros: repoPath, fromCheckpointId, toCheckpointId (opcional)
   * Retorna: { success: boolean, data?: string, error?: string }
   *   - data contém o Markdown formatado com as diferenças.
   */
  ipcMain.handle('checkpoint:generate-diff', async (_event, repoPath: string, fromCheckpointId: string, toCheckpointId?: string) => {
    try {
      // Valida parâmetros obrigatórios
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }
      if (!isValidCheckpointId(fromCheckpointId)) {
        return { success: false, error: 'fromCheckpointId contém caracteres inválidos' }
      }
      // toCheckpointId é opcional, mas se fornecido, deve ser válido
      if (toCheckpointId !== undefined && toCheckpointId !== null && !isValidCheckpointId(toCheckpointId)) {
        return { success: false, error: 'toCheckpointId contém caracteres inválidos' }
      }

      const markdown = await checkpointService.generateDiffBetween(
        repoPath,
        fromCheckpointId,
        toCheckpointId || undefined
      )
      return { success: true, data: markdown }
    } catch (error: any) {
      console.error('[CheckpointHandler] Erro ao gerar diff:', error)
      return { success: false, error: error.message || 'Erro ao gerar diff entre checkpoints' }
    }
  })

  /**
   * checkpoint:get-changed-files — Retorna lista de arquivos alterados entre checkpoints.
   * Parâmetros: repoPath, fromCheckpointId, toCheckpointId (opcional)
   * Retorna: { success: boolean, data?: CheckpointDiffFile[], error?: string }
   *   - data contém array de arquivos com relativePath, changeType, importance e mtime.
   */
  ipcMain.handle('checkpoint:get-changed-files', async (_event, repoPath: string, fromCheckpointId: string, toCheckpointId?: string) => {
    try {
      // Valida parâmetros obrigatórios
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }
      if (!isValidCheckpointId(fromCheckpointId)) {
        return { success: false, error: 'fromCheckpointId contém caracteres inválidos' }
      }
      // toCheckpointId é opcional, mas se fornecido, deve ser válido
      if (toCheckpointId !== undefined && toCheckpointId !== null && !isValidCheckpointId(toCheckpointId)) {
        return { success: false, error: 'toCheckpointId contém caracteres inválidos' }
      }

      const changedFiles = await checkpointService.getChangedFiles(
        repoPath,
        fromCheckpointId,
        toCheckpointId || undefined
      )
      return { success: true, data: changedFiles }
    } catch (error: any) {
      console.error('[CheckpointHandler] Erro ao obter changed files:', error)
      return { success: false, error: error.message || 'Erro ao obter arquivos alterados' }
    }
  })

  /**
   * checkpoint:initialize-commit-detection — Inicializa a detecção de commits para um repositório.
   * Chamado quando o usuário abre a aba Code Checkpoints.
   * Salva o HEAD atual como referência inicial.
   *
   * Parâmetros: repoPath
   * Retorna: { success: boolean, error?: string }
   */
  ipcMain.handle('checkpoint:initialize-commit-detection', async (_event, repoPath: string) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }

      // Obtém o HEAD atual
      const currentHead = await checkpointService.getCurrentHead(repoPath)

      if (!currentHead) {
        return { success: false, error: 'Não foi possível obter o HEAD atual do repositório' }
      }

      // Verifica se já existe metadados
      const metadata = await checkpointService.getMetadata(repoPath)

      // Se não existe, salva o HEAD atual como referência inicial
      if (!metadata) {
        await checkpointService.setMetadata(repoPath, {
          lastHead: currentHead,
          lastChecked: new Date().toISOString()
        })
        console.log(`[CheckpointHandler] Detecção de commits inicializada para ${repoPath}`)
      }

      return { success: true }
    } catch (error: any) {
      console.error('[CheckpointHandler] Erro ao inicializar detecção de commits:', error)
      return { success: false, error: error.message || 'Erro ao inicializar detecção de commits' }
    }
  })

  /**
   * checkpoint:rename — Renomeia um checkpoint existente.
   * Parâmetros: repoPath, checkpointId, newName
   * Retorna: { success: boolean, error?: string }
   */
  ipcMain.handle('checkpoint:rename', async (_event, repoPath: string, checkpointId: string, newName: string) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }
      if (!isValidCheckpointId(checkpointId)) {
        return { success: false, error: 'checkpointId contém caracteres inválidos' }
      }
      if (!newName || newName.trim().length === 0) {
        return { success: false, error: 'O novo nome não pode estar vazio' }
      }

      const success = await checkpointService.renameCheckpoint(repoPath, checkpointId, newName)

      if (success) {
        return { success: true }
      } else {
        return { success: false, error: 'Checkpoint não encontrado' }
      }
    } catch (error: any) {
      console.error('[CheckpointHandler] Erro ao renomear checkpoint:', error)
      return { success: false, error: error.message || 'Erro ao renomear checkpoint' }
    }
  })

  /**
   * checkpoint:delete-all — Deleta todos os checkpoints do repositório.
   * Parâmetros: repoPath
   * Retorna: { success: boolean, deletedCount: number }
   */
  ipcMain.handle('checkpoint:delete-all', async (_event, repoPath: string) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, deletedCount: 0, error: 'repoPath é obrigatório e não pode ser vazio' }
      }

      const deletedCount = await checkpointService.deleteAllCheckpoints(repoPath)
      return { success: true, deletedCount }
    } catch (error: any) {
      console.error('[CheckpointHandler] Erro ao deletar todos os checkpoints:', error)
      return { success: false, deletedCount: 0, error: error.message || 'Erro ao deletar todos os checkpoints' }
    }
  })
}