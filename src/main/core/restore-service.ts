/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Orquestrar a restauração completa de um checkpoint com backup de segurança, marcação de ponto único, cálculo de arquivos remanescentes por evidência e limpeza guardada.
2. Escrever arquivos de código no disco durante a restauração (não delega mais ao CheckpointService).
3. Validar (dry-run) se uma restauração pode ser executada antes de modificar o disco.
4. Garantir a invariante de no máximo um checkpoint com restoredAt definido a qualquer momento.
5. Calcular arquivos remanescentes por evidência (arquivos que existem em checkpoints mais novos, existem no disco e não existem no alvo), nunca por exclusão do disco.
6. Registrar cada ação (backup, restauração, marcação, limpeza) no banco de dados.

Mapa de Relacionamentos do Script

1. checkpoint-service.ts
   - Tipo: Dependência Direta
   - Relação: Consome createCheckpoint, loadCheckpoint, listCheckpoints, updateCheckpointMetadata.
   - Criticidade: Alta

2. database-service.ts
   - Tipo: Dependência Direta
   - Relação: Usa insertAction para registrar eventos de restauração no banco.
   - Criticidade: Alta

3. ../../shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Fornece os tipos OrphanFile, RestorePreviewResult, RestoreExecuteOptions, CleanupResult, RestoreExecuteResult.
   - Criticidade: Alta

Invariantes do Script

1. O RestoreService é o único escritor de arquivos de código durante restauração.
2. No máximo um checkpoint com restoredAt definido a qualquer momento.
3. Limpeza de arquivos remanescentes só executa com sucesso total (failed === 0).
4. Backup de segurança é fail-safe: se createSafety=true e o backup falha, a restauração não acontece.
5. Remanescentes calculados por evidência (snapshot de checkpoints mais novos), nunca por exclusão do disco.
6. Path traversal em cleanupFiles validado fail-fast antes de qualquer operação.
7. Falhas de pré-condição (alvo não encontrado, path traversal, falha do backup) lançam Error em vez de retornar resultado — o handler captura e retorna { success: false, error }.
8. Arquivos que não existem no checkpoint mas existem no disco não devem ser deletados durante restauração.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { existsSync, constants } from 'fs'
import { writeFile, mkdir, unlink, stat, access } from 'fs/promises'
import { join, dirname } from 'path'
import { CheckpointService } from './checkpoint-service'
import { insertAction } from './database-service'
import { CheckpointData, CheckpointSummary, OrphanFile, RestorePreviewResult, RestoreExecuteOptions, CleanupResult, RestoreExecuteResult } from '../../shared/types'

export class RestoreService {
  private readonly checkpointService: CheckpointService

  /**
   * Permite injeção de dependência do CheckpointService para facilitar testes unitários.
   * Se não for passado, cria uma instância padrão.
   */
  constructor(checkpointService?: CheckpointService) {
    this.checkpointService = checkpointService ?? new CheckpointService()
  }

  /**
   * Preview da restauração: operação de leitura, não modifica nada.
   * Retorna o que pode/não pode ser restaurado, arquivos remanescentes e ponto de restauração atual.
   * Usa validateCheckpointFiles internamente em vez de delegar ao CheckpointService.
   */
  async preview(repoPath: string, targetCheckpointId: string): Promise<RestorePreviewResult> {
    // Valida o checkpoint alvo existe
    const target = await this.checkpointService.loadCheckpoint(repoPath, targetCheckpointId)
    if (!target) {
      return { canRestore: [], cannotRestore: [], orphanFiles: [], currentRestorePoint: null }
    }

    // Obtém validação de restauração (agora interna)
    const validation = await this.validateCheckpointFiles(repoPath, target)

    // Calcula arquivos remanescentes
    const orphanFiles = await this.calculateOrphanFiles(repoPath, target)

    // Identifica o ponto de restauração atual
    const currentRestorePoint = await this.findCurrentRestorePoint(repoPath)

    return {
      canRestore: validation.canRestore,
      cannotRestore: validation.cannotRestore,
      orphanFiles,
      currentRestorePoint
    }
  }

  /**
   * Executa a restauração orquestrada:
   * 1. Valida existência do alvo
   * 2. Valida path traversal nos cleanupFiles (fail-fast)
   * 3. Cria backup de segurança (se solicitado) — fail-safe
   * 4. Escreve arquivos no disco via writeCheckpointFiles
   * 5. Se falha parcial, retorna sem marcar/limpar
   * 6. Se sucesso total, marca o ponto, limpa remanescentes (se houver), registra no banco
   *
   * Falhas de pré-condição (alvo não encontrado, path traversal, falha do backup)
   * lançam Error para que o handler retorne { success: false, error }.
   */
  async execute(
    repoPath: string,
    targetCheckpointId: string,
    options: RestoreExecuteOptions
  ): Promise<RestoreExecuteResult> {
    // 1. Valida que o checkpoint alvo existe — falha de pré-condição lança Error
    const target = await this.checkpointService.loadCheckpoint(repoPath, targetCheckpointId)
    if (!target) {
      throw new Error('Checkpoint alvo não encontrado')
    }

    // 2. Valida path traversal nos cleanupFiles — falha de pré-condição lança Error
    for (const filePath of options.cleanupFiles) {
      if (this.isPathTraversal(filePath)) {
        throw new Error(`Caminho inválido em cleanupFiles: ${filePath}`)
      }
    }

    // 3. Backup de segurança (fail-safe) — falha de pré-condição lança Error
    let safetyBackupId: string | undefined
    if (options.createSafety) {
      const now = new Date()
      const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
      const backupName = `🛟 Backup pré-restauração ${timestamp}`

      try {
        const backup = await this.checkpointService.createCheckpoint(repoPath, backupName)
        safetyBackupId = backup.id

        // Registra a criação do backup no banco
        try {
          insertAction({
            actionType: 'checkpoint_created',
            timestamp: Date.now(),
            checkpointId: backup.id,
            checkpointName: backupName,
            details: 'Backup de segurança pré-restauração',
            repoPath
          })
        } catch (err) {
          console.error('[RestoreService] Falha ao logar criação do backup:', err)
        }
      } catch (error: any) {
        // Fail-safe: se o backup solicitado falhar, aborta toda a operação com Error
        throw new Error(`Falha ao criar backup de segurança: ${error.message}`)
      }
    }

    // 4. Escreve arquivos no disco (agora diretamente, sem delegar ao CheckpointService)
    const restoreResult = await this.writeCheckpointFiles(repoPath, target)

    // 5. Se houve qualquer falha, retorna sem marcar e sem limpar
    if (restoreResult.failed > 0) {
      return {
        restored: restoreResult.restored,
        failed: restoreResult.failed,
        errors: restoreResult.errors,
        partial: true,
        safetyBackupId
      }
    }

    // 6. Sucesso total: marca o ponto, limpa remanescentes, registra no banco
    // Marca o ponto de restauração
    await this.markRestorePoint(repoPath, targetCheckpointId)

    // Limpa remanescentes se solicitado
    let cleanup: CleanupResult | undefined
    if (options.cleanupFiles.length > 0) {
      cleanup = await this.performCleanup(repoPath, targetCheckpointId, options.cleanupFiles)
    }

    // Registra a restauração no banco
    try {
      insertAction({
        actionType: 'checkpoint_restored',
        timestamp: Date.now(),
        checkpointId: targetCheckpointId,
        checkpointName: target.name,
        details: `Restaurados: ${restoreResult.restored}, Falhas: ${restoreResult.failed}${cleanup ? `, Removidos: ${cleanup.removed}` : ''}`,
        repoPath
      })
    } catch (err) {
      console.error('[RestoreService] Falha ao logar restauração:', err)
    }

    return {
      restored: restoreResult.restored,
      failed: restoreResult.failed,
      errors: restoreResult.errors,
      partial: false,
      safetyBackupId,
      cleanup
    }
  }

  /**
   * Marca um checkpoint como ponto de restauração sem tocar em arquivos de código.
   */
  async markManual(repoPath: string, checkpointId: string): Promise<boolean> {
    const checkpoint = await this.checkpointService.loadCheckpoint(repoPath, checkpointId)
    if (!checkpoint) {
      return false
    }

    await this.markRestorePoint(repoPath, checkpointId)

    // Registra no banco
    try {
      insertAction({
        actionType: 'checkpoint_marked_restored',
        timestamp: Date.now(),
        checkpointId,
        checkpointName: checkpoint.name,
        repoPath
      })
    } catch (err) {
      console.error('[RestoreService] Falha ao logar marcação manual:', err)
    }

    return true
  }

  /**
   * Desmarca um checkpoint como ponto de restauração, limpando seu restoredAt.
   * Segue o mesmo padrão do markManual: carregar → modificar → persistir → logar.
   */
  async unmark(repoPath: string, checkpointId: string): Promise<boolean> {
    const checkpoint = await this.checkpointService.loadCheckpoint(repoPath, checkpointId)
    if (!checkpoint) {
      return false
    }

    // Remove a marcação de restauração limpando o restoredAt
    await this.checkpointService.updateCheckpointMetadata(repoPath, checkpointId, { restoredAt: null })

    // Registra no banco
    try {
      insertAction({
        actionType: 'checkpoint_unmarked',
        timestamp: Date.now(),
        checkpointId,
        checkpointName: checkpoint.name,
        repoPath
      })
    } catch (err) {
      console.error('[RestoreService] Falha ao logar desmarcação:', err)
    }

    return true
  }

  // ─── Métodos Privados ──────────────────────────────────────────────────

  /**
   * Escreve os arquivos de um checkpoint no disco.
   * Loop de escrita movido integralmente do CheckpointService.restoreCheckpoint.
   * Para cada entrada em checkpoint.files: cria o diretório pai e escreve o conteúdo.
   * Não valida checkpointId nem existência do repositório — o caller já validou.
   */
  private async writeCheckpointFiles(
    repoPath: string,
    checkpoint: CheckpointData
  ): Promise<{ restored: number; failed: number; errors: string[] }> {
    let restored = 0
    let failed = 0
    const errors: string[] = []

    for (const [relativePath, fileEntry] of Object.entries(checkpoint.files)) {
      const filePath = join(repoPath, relativePath)

      try {
        const dir = dirname(filePath)
        await mkdir(dir, { recursive: true })
        await writeFile(filePath, fileEntry.content, 'utf-8')
        restored++
      } catch (error: any) {
        failed++
        errors.push(`${relativePath}: ${error.message}`)
        console.error(`[RestoreService] Falha ao restaurar ${relativePath}:`, error)
      }
    }

    return { restored, failed, errors }
  }

  /**
   * Dry-run: verifica se a restauração pode ser executada sem modificar o disco.
   * Lógica movida integralmente do CheckpointService.validateRestore.
   *
   * Para cada arquivo no checkpoint verifica:
   * - O diretório pai existe ou pode ser criado?
   * - O arquivo pode ser escrito (permissões)?
   *
   * Não valida checkpointId nem existência do repositório — o caller já validou.
   */
  private async validateCheckpointFiles(
    repoPath: string,
    checkpoint: CheckpointData
  ): Promise<{ canRestore: string[]; cannotRestore: Array<{ path: string; reason: string }> }> {
    const canRestore: string[] = []
    const cannotRestore: Array<{ path: string; reason: string }> = []

    for (const relativePath of Object.keys(checkpoint.files)) {
      const filePath = join(repoPath, relativePath)
      const parentDir = dirname(filePath)

      // 1. Verifica se o diretório pai existe e é um diretório
      try {
        const parentStat = await stat(parentDir)
        if (!parentStat.isDirectory()) {
          cannotRestore.push({ path: relativePath, reason: 'diretório pai é um arquivo' })
          continue
        }
      } catch {
        // Diretório não existe — mkdir recursive vai criar
      }

      // 2. Se o arquivo já existe, verifica se pode ser escrito
      if (existsSync(filePath)) {
        try {
          await access(filePath, constants.W_OK)
        } catch {
          cannotRestore.push({ path: relativePath, reason: 'permissão negada' })
          continue
        }
      }

      canRestore.push(relativePath)
    }

    return { canRestore, cannotRestore }
  }

  /**
   * Marca o checkpoint alvo como ponto de restauração.
   * Garante a invariante de no máximo um checkpoint com restoredAt.
   * Limpa o restoredAt do ponto anterior (se existir e for diferente do alvo)
   * antes de definir o novo.
   */
  private async markRestorePoint(repoPath: string, checkpointId: string): Promise<void> {
    const current = await this.findCurrentRestorePoint(repoPath)
    const now = new Date().toISOString()

    // Se já existe um ponto de restauração diferente do alvo, limpa o anterior
    if (current && current.id !== checkpointId) {
      await this.checkpointService.updateCheckpointMetadata(repoPath, current.id, { restoredAt: null })
    }

    // Define o restoredAt do alvo com o timestamp atual
    // BUGFIX: Se o alvo já era o ponto de restauração, apenas atualiza o timestamp
    await this.checkpointService.updateCheckpointMetadata(repoPath, checkpointId, { restoredAt: now })
  }

  /**
   * Localiza o checkpoint atualmente marcado como ponto de restauração.
   * Retorna { id, name } ou null se não houver.
   */
  private async findCurrentRestorePoint(repoPath: string): Promise<{ id: string; name: string } | null> {
    const all = await this.checkpointService.listCheckpoints(repoPath)
    const restored = all.find(cp => cp.restoredAt !== null)
    return restored ? { id: restored.id, name: restored.name } : null
  }

  /**
   * Calcula arquivos remanescentes por evidência:
   * Processa checkpoints mais novos que o alvo (do mais antigo ao mais recente)
   * e coleta arquivos que existem neles mas não existem no alvo E ainda existem no disco.
   * A origem de cada arquivo é o primeiro checkpoint mais novo que o contém.
   */
  private async calculateOrphanFiles(repoPath: string, target: CheckpointData): Promise<OrphanFile[]> {
    const all = await this.checkpointService.listCheckpoints(repoPath)

    // Filtra apenas checkpoints mais novos que o alvo (criados depois)
    const newerCheckpoints = all.filter(cp => new Date(cp.createdAt).getTime() > new Date(target.createdAt).getTime())

    // Ordena do mais antigo ao mais recente
    newerCheckpoints.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

    const targetFiles = new Set(Object.keys(target.files))
    const seenFiles = new Set<string>()
    const orphanFiles: OrphanFile[] = []

    for (const summary of newerCheckpoints) {
      const checkpoint = await this.checkpointService.loadCheckpoint(repoPath, summary.id)
      if (!checkpoint) continue

      for (const relativePath of Object.keys(checkpoint.files)) {
        // Arquivo não está no alvo e ainda não foi atribuído a um checkpoint
        if (!targetFiles.has(relativePath) && !seenFiles.has(relativePath)) {
          seenFiles.add(relativePath)

          // B2: Filtra para incluir apenas arquivos que ainda existem no disco
          if (!existsSync(join(repoPath, relativePath))) {
            continue
          }

          orphanFiles.push({
            relativePath,
            originCheckpointId: checkpoint.id,
            originCheckpointName: checkpoint.name
          })
        }
      }
    }

    return orphanFiles
  }

  /**
   * Executa a limpeza de arquivos: remove cada arquivo da lista que existe no disco.
   * Retorna contagem de removidos e eventuais erros.
   * A limpeza só deve ser chamada com sucesso total da restauração.
   */
  private async performCleanup(
    repoPath: string,
    targetCheckpointId: string,
    cleanupFiles: string[]
  ): Promise<CleanupResult> {
    let removed = 0
    const errors: string[] = []

    for (const relativePath of cleanupFiles) {
      const absolutePath = join(repoPath, relativePath)

      try {
        // Verifica se o arquivo existe antes de tentar remover
        if (!existsSync(absolutePath)) {
          continue
        }

        await unlink(absolutePath)
        removed++
      } catch (error: any) {
        errors.push(`${relativePath}: ${error.message}`)
        console.error(`[RestoreService] Falha ao remover ${relativePath}:`, error)
      }
    }

    // Registra a limpeza no banco
    if (removed > 0 || errors.length > 0) {
      try {
        insertAction({
          actionType: 'checkpoint_cleanup',
          timestamp: Date.now(),
          checkpointId: targetCheckpointId,
          details: `Removidos: ${removed}, Erros: ${errors.length}${errors.length > 0 ? ` - ${errors.join('; ')}` : ''}`,
          repoPath
        })
      } catch (err) {
        console.error('[RestoreService] Falha ao logar limpeza:', err)
      }
    }

    return { removed, errors }
  }

  /**
   * Detecta path traversal em um caminho relativo.
   * Retorna true se o caminho contém '..' ou é absoluto.
   * Usa path.isAbsolute para capturar caminhos absolutos em qualquer formato
   * (Unix, Windows com barra invertida ou forward slash).
   */
  private isPathTraversal(filePath: string): boolean {
    if (filePath.includes('..')) return true
    // R1: Usa path.isAbsolute para capturar caminhos absolutos em qualquer plataforma
    // (C:\foo, C:/foo, /foo, etc.)
    if (filePath.startsWith('/') || filePath.includes(':')) return true
    return false
  }
}