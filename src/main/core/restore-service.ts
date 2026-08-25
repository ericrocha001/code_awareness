/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Orquestrar a restauração completa de um checkpoint com backup de segurança, marcação de ponto único, cálculo de arquivos remanescentes por evidência e limpeza guardada.
2. Escrever arquivos de código no disco durante a restauração (não delega mais ao CheckpointService).
3. Validar (dry-run) se uma restauração pode ser executada antes de modificar o disco.
4. Garantir a invariante de no máximo um checkpoint com restoredAt definido a qualquer momento (inclusive em estado corrompido).
5. Calcular arquivos remanescentes por evidência (arquivos que existem em checkpoints mais novos, existem no disco e não existem no alvo), nunca por exclusão do disco.
6. Registrar cada ação (backup, restauração, marcação, limpeza) no banco de dados.
7. Validar a integridade do checkpoint (hash SHA-256 de cada arquivo) antes de qualquer escrita.
8. Executar rollback automático via backup de segurança quando a escrita falhar parcialmente.
9. Resolver e validar caminhos relativos dentro do repositório de forma centralizada, rejeitando paths maliciosos.
10. Produzir um RestorePlan congelado no preview (com stateHash) que o execute valida antes de executar.
11. Produzir um resumo detalhado de mudanças por arquivo (fileChanges) no preview (criados, modificados com diff de linhas, inalterados, bloqueados).

Mapa de Relacionamentos do Script

 1. checkpoint-service.ts
    - Tipo: Dependência Direta
    - Relação: Consome createCheckpoint, loadCheckpoint, listCheckpoints, updateCheckpointMetadata.
    - Criticidade: Alta

 2. database-ports.ts
    - Tipo: Contrato / Interface
    - Relação: Usa ActionLogPort via injeção de dependência para registrar eventos de restauração no banco.
    - Criticidade: Alta

 3. ../../shared/types.ts
    - Tipo: Contrato / Interface
    - Relação: Fornece os tipos OrphanFile, RestorePlan, RestorePreviewResult, RestoreExecuteOptions, CleanupResult, RestoreExecuteResult, RestoreFileChange.
    - Criticidade: Alta

Invariantes do Script

 1. O RestoreService é o único escritor de arquivos de código durante restauração.
 2. No máximo um checkpoint com restoredAt definido a qualquer momento (markRestorePoint limpa todos os demais).
 3. Limpeza de arquivos remanescentes só executa com sucesso total (failed === 0).
 4. Backup de segurança é fail-safe: se createSafety=true e o backup falha, a restauração não acontece.
 5. Remanescentes calculados por evidência (snapshot de checkpoints mais novos), nunca por exclusão do disco.
 6. Path traversal em cleanupFiles e demais caminhos resolvidos via resolveSafePath (centralizado), validado fail-fast antes de qualquer operação.
 7. Falhas de pré-condição (alvo não encontrado, checkpoint corrompido, path traversal, falha do backup) lançam Error em vez de retornar resultado — o handler captura e retorna { success: false, error }.
 8. Arquivos que não existem no checkpoint mas existem no disco não devem ser deletados durante restauração.
 9. A integridade do checkpoint é validada antes do backup de segurança e de qualquer escrita.
 10. O rollback automático só é considerado sucesso se todos os arquivos do backup foram reescritos (failed === 0).
 11. computeStateHash é determinístico: ordena paths alfabeticamente e usa relativePath + mtimeMs (ou 'missing').
 12. A validação do Plano congelado (stateHash) acontece antes do backup de segurança — plano obsoleto aborta sem criar backup.
 13. computeFileChanges é operação de leitura pura e determinística (ordena alfabeticamente) com teto de segurança de 200.000 caracteres que nunca lança exceção; confere o tamanho via stat antes de ler o conteúdo e normaliza a contagem de linhas descartando um único segmento vazio final.
 14. Nenhuma dependência direta de SQLite — logs são gravados exclusivamente via ActionLogPort.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { existsSync, constants } from 'fs'
import { writeFile, readFile, mkdir, unlink, stat, access } from 'fs/promises'
import { join, dirname, resolve, isAbsolute } from 'path'
import { createHash } from 'crypto'
import { diffLines } from 'diff'
import { CheckpointService } from './checkpoint-service'
import type { ActionLogPort } from './database-ports'
import { CheckpointData, CheckpointSummary, OrphanFile, RestorePreviewResult, RestoreExecuteOptions, CleanupResult, RestoreExecuteResult, RestorePlan, RestoreFileChange } from '../../shared/types'

export class RestoreService {
  private readonly checkpointService: CheckpointService
  private readonly actionLogPort: ActionLogPort
  private readonly activeRestores = new Map<string, Promise<RestoreExecuteResult>>()

  /**
   * Recebe CheckpointService e ActionLogPort via injeção de dependência.
   */
  constructor(checkpointService: CheckpointService, actionLogPort: ActionLogPort) {
    this.checkpointService = checkpointService
    this.actionLogPort = actionLogPort
  }

  /**
   * Preview da restauração: operação de leitura, não modifica nada.
   * Retorna o que pode/não pode ser restaurado, arquivos remanescentes e ponto de restauração atual.
   * Usa validateCheckpointFiles internamente em vez de delegar ao CheckpointService.
   */
  async preview(repoPath: string, targetCheckpointId: string): Promise<RestorePreviewResult> {
    const target = await this.checkpointService.loadCheckpoint(repoPath, targetCheckpointId)
    if (!target) {
      return {
        plan: {
          targetCheckpointId,
          targetCheckpointName: '',
          repoPath,
          filesToWrite: [],
          orphanFiles: [],
          currentRestorePoint: null,
          canRestore: [],
          cannotRestore: [],
          fileChanges: [],
          stateHash: '',
          createdAt: Date.now()
        }
      }
    }

    const validation = await this.validateCheckpointFiles(repoPath, target)
    const orphanFiles = await this.calculateOrphanFiles(repoPath, target)
    const currentRestorePoint = await this.findCurrentRestorePoint(repoPath)
    const stateHash = await this.computeStateHash(repoPath, target)
    const fileChanges = await this.computeFileChanges(repoPath, target, validation)

    const plan: RestorePlan = {
      targetCheckpointId,
      targetCheckpointName: target.name,
      repoPath,
      filesToWrite: Object.keys(target.files),
      orphanFiles,
      currentRestorePoint,
      canRestore: validation.canRestore,
      cannotRestore: validation.cannotRestore,
      fileChanges,
      stateHash,
      createdAt: Date.now()
    }

    return { plan }
  }

  /**
   * Executa a restauração orquestrada garantindo a serialização por repositório.
   * Rejeita chamadas concorrentes para o mesmo repoPath.
   */
  async execute(
    repoPath: string,
    targetCheckpointId: string,
    options: RestoreExecuteOptions
  ): Promise<RestoreExecuteResult> {
    if (this.activeRestores.has(repoPath)) {
      throw new Error('Já existe uma restauração em andamento para este repositório')
    }

    const promise = this._executeInternal(repoPath, targetCheckpointId, options)
    this.activeRestores.set(repoPath, promise)

    try {
      return await promise
    } finally {
      this.activeRestores.delete(repoPath)
    }
  }

  /**
   * Execução interna da restauração orquestrada com operationId correlacionado:
   * 1. Valida existência do alvo
   * 2. Valida integridade do checkpoint (hash SHA-256) antes de qualquer operação
   * 3. Valida path traversal nos cleanupFiles via resolveSafePath (fail-fast)
   * 4. Se plano congelado foi fornecido, valida o estado atual (stateHash) antes do backup
   * 5. Cria backup de segurança (se solicitado) — fail-safe
   * 6. Escreve arquivos no disco via writeCheckpointFiles
   * 7. Se falha parcial, tenta rollback automático via backup e retorna sem marcar/limpar
   * 8. Se sucesso total, marca o ponto, limpa remanescentes (se houver), registra no banco
   *
   * Falhas de pré-condição (alvo não encontrado, checkpoint corrompido, path traversal,
   * falha do backup) lançam Error para que o handler retorne { success: false, error }.
   */
  private async _executeInternal(
    repoPath: string,
    targetCheckpointId: string,
    options: RestoreExecuteOptions
  ): Promise<RestoreExecuteResult> {
    const operationId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // 1. Valida que o checkpoint alvo existe — falha de pré-condição lança Error
    const target = await this.checkpointService.loadCheckpoint(repoPath, targetCheckpointId)
    if (!target) {
      throw new Error('Checkpoint alvo não encontrado')
    }

    // 2. Valida integridade do checkpoint ANTES de qualquer operação (inclusive backup)
    this.validateCheckpointIntegrity(target)

    // 3. Valida path traversal nos cleanupFiles usando resolveSafePath (fail-fast)
    for (const filePath of options.cleanupFiles) {
      this.resolveSafePath(repoPath, filePath)
    }

    // 4. Se plano foi fornecido, valida que o estado ainda corresponde (antes do backup)
    if (options.plan) {
      const currentStateHash = await this.computeStateHash(repoPath, target)
      if (currentStateHash !== options.plan.stateHash) {
        return {
          restored: 0,
          failed: 0,
          errors: ['O estado do projeto mudou desde o preview. Gere um novo preview.'],
          partial: false,
          planStale: true
        }
      }
    }

    // 5. Backup de segurança (fail-safe) — falha de pré-condição lança Error
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
          this.actionLogPort.insertAction({
            actionType: 'checkpoint_created',
            timestamp: Date.now(),
            checkpointId: backup.id,
            checkpointName: backupName,
            details: 'Backup de segurança pré-restauração',
            repoPath,
            operationId
          })
        } catch (err) {
          console.error('[RestoreService] Falha ao logar criação do backup:', err)
        }
      } catch (error: any) {
        // Fail-safe: se o backup solicitado falhar, aborta toda a operação com Error
        throw new Error(`Falha ao criar backup de segurança: ${error.message}`)
      }
    }

    // 6. Escreve arquivos no disco
    const restoreResult = await this.writeCheckpointFiles(repoPath, target)

    // 7. Se houve falha parcial, tenta rollback via backup de segurança
    if (restoreResult.failed > 0) {
      let rollbackAttempted = false
      let rollbackSuccess = false
      if (safetyBackupId) {
        rollbackAttempted = true
        const rollbackResult = await this.attemptRollback(repoPath, safetyBackupId)
        rollbackSuccess = rollbackResult.success

        // Best-effort: registrar tentativa de rollback no banco
        try {
          this.actionLogPort.insertAction({
            actionType: 'restore_rollback',
            timestamp: Date.now(),
            checkpointId: targetCheckpointId,
            checkpointName: target.name,
            details: `Rollback ${rollbackSuccess ? 'bem-sucedido' : 'falhou'} após falha parcial`,
            repoPath,
            operationId
          })
        } catch (err) {
          console.error('[RestoreService] Falha ao logar rollback:', err)
        }
      }
      return {
        restored: restoreResult.restored,
        failed: restoreResult.failed,
        errors: restoreResult.errors,
        partial: true,
        safetyBackupId,
        rollbackAttempted,
        rollbackSuccess
      }
    }

    // 8. Sucesso total: marca o ponto de restauração
    let markFailed = false
    try {
      await this.markRestorePoint(repoPath, targetCheckpointId)
    } catch (err) {
      markFailed = true
      console.error('[RestoreService] Falha ao marcar ponto de restauração:', err)
    }

    // 9. Limpa remanescentes se solicitado
    let cleanup: CleanupResult | undefined
    if (options.cleanupFiles.length > 0) {
      cleanup = await this.performCleanup(repoPath, targetCheckpointId, options.cleanupFiles, operationId)
    }

    // 10. Registra a restauração no banco
    try {
      this.actionLogPort.insertAction({
        actionType: 'checkpoint_restored',
        timestamp: Date.now(),
        checkpointId: targetCheckpointId,
        checkpointName: target.name,
        details: `Restaurados: ${restoreResult.restored}, Falhas: ${restoreResult.failed}${cleanup ? `, Removidos: ${cleanup.removed}` : ''}`,
        repoPath,
        operationId
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
      cleanup,
      markFailed
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
      this.actionLogPort.insertAction({
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
      this.actionLogPort.insertAction({
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
   * Garante a invariante de no máximo um checkpoint com restoredAt, inclusive em
   * estado corrompido: limpa o restoredAt de TODOS os demais checkpoints com
   * marcação antes de definir o novo.
   */
  private async markRestorePoint(repoPath: string, checkpointId: string): Promise<void> {
    const all = await this.checkpointService.listCheckpoints(repoPath)
    const now = new Date().toISOString()

    // Limpa TODOS os checkpoints com restoredAt (não apenas o primeiro)
    for (const cp of all) {
      if (cp.restoredAt !== null && cp.id !== checkpointId) {
        await this.checkpointService.updateCheckpointMetadata(repoPath, cp.id, { restoredAt: null })
      }
    }

    // Define o restoredAt do alvo com o timestamp atual
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
    cleanupFiles: string[],
    operationId?: string
  ): Promise<CleanupResult> {
    let removed = 0
    const errors: string[] = []

    for (const relativePath of cleanupFiles) {
      const absolutePath = this.resolveSafePath(repoPath, relativePath)

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
        this.actionLogPort.insertAction({
          actionType: 'checkpoint_cleanup',
          timestamp: Date.now(),
          checkpointId: targetCheckpointId,
          details: `Removidos: ${removed}, Erros: ${errors.length}${errors.length > 0 ? ` - ${errors.join('; ')}` : ''}`,
          repoPath,
          operationId
        })
      } catch (err) {
        console.error('[RestoreService] Falha ao logar limpeza:', err)
      }
    }

    return { removed, errors }
  }

  /**
   * Resolve e valida um caminho relativo dentro do repositório.
   * Rejeita caminhos absolutos, path traversal e caminhos que escapam do repo.
   * Lança Error se o caminho for inválido.
   */
  private resolveSafePath(repoPath: string, relativePath: string): string {
    if (isAbsolute(relativePath)) {
      throw new Error(`Caminho absoluto não permitido: ${relativePath}`)
    }
    if (relativePath.includes('..')) {
      throw new Error(`Path traversal não permitido: ${relativePath}`)
    }
    const resolved = resolve(join(repoPath, relativePath))
    const normalizedRepo = resolve(repoPath)
    if (!resolved.startsWith(normalizedRepo)) {
      throw new Error(`Caminho fora do repositório: ${relativePath}`)
    }
    return resolved
  }

  /**
   * Valida a integridade do checkpoint verificando hashes de todos os arquivos.
   * Lança Error se qualquer hash for inválido ou divergente.
   */
  private validateCheckpointIntegrity(checkpoint: CheckpointData): void {
    for (const [relativePath, fileEntry] of Object.entries(checkpoint.files)) {
      if (!fileEntry.hash || typeof fileEntry.hash !== 'string') {
        throw new Error(`Checkpoint corrompido: hash inválido para ${relativePath}`)
      }
      const computedHash = createHash('sha256')
        .update(fileEntry.content, 'utf-8')
        .digest('hex')
      if (computedHash !== fileEntry.hash) {
        throw new Error(`Checkpoint corrompido: hash divergente para ${relativePath}`)
      }
    }
  }

  /**
   * Tenta reverter a restauração usando o backup de segurança.
   * Retorna sucesso apenas se todos os arquivos do backup forem escritos.
   */
  private async attemptRollback(
    repoPath: string,
    backupId: string
  ): Promise<{ success: boolean }> {
    const backup = await this.checkpointService.loadCheckpoint(repoPath, backupId)
    if (!backup) return { success: false }
    const result = await this.writeCheckpointFiles(repoPath, backup)
    return { success: result.failed === 0 }
  }

  /**
   * Calcula hash determinístico do estado atual dos arquivos do checkpoint no disco.
   * Usa relativePath + mtime de cada arquivo. Arquivos inexistentes contribuem com 'missing'.
   *
   * LIMITAÇÃO: Depende da resolução de tempo do sistema de arquivos. Sistemas com
   * resolução inferior a 1 segundo (ex: FAT32, alguns NFS) podem produzir mtimes
   * idênticos para arquivos modificados em janelas curtas, causando falsos positivos
   * de planStale. Em sistemas modernos (NTFS, APFS, ext4) isso não ocorre.
   */
  private async computeStateHash(
    repoPath: string,
    checkpoint: CheckpointData
  ): Promise<string> {
    const hash = createHash('sha256')
    const files = Object.keys(checkpoint.files).sort()
    for (const relativePath of files) {
      hash.update(relativePath)
      const fullPath = join(repoPath, relativePath)
      try {
        const statResult = await stat(fullPath)
        hash.update(String(statResult.mtimeMs))
      } catch {
        hash.update('missing')
      }
    }
    return hash.digest('hex')
  }

  /**
   * Calcula o resumo de mudanças por arquivo (fileChanges) para o preview.
   * Operação determinística de leitura pura que nunca lança erro.
   */
  private async computeFileChanges(
    repoPath: string,
    target: CheckpointData,
    validation: { canRestore: string[]; cannotRestore: Array<{ path: string; reason: string }> }
  ): Promise<RestoreFileChange[]> {
    const fileChanges: RestoreFileChange[] = []
    const relativePaths = Object.keys(target.files).sort()
    const blockedMap = new Map(validation.cannotRestore.map(c => [c.path, c.reason]))
    const MAX_DIFF_CHARS = 200_000

    for (const relativePath of relativePaths) {
      // 1. Arquivo bloqueado por validação de permissão / diretório
      if (blockedMap.has(relativePath)) {
        fileChanges.push({
          relativePath,
          status: 'blocked',
          addedLines: null,
          removedLines: null,
          reason: blockedMap.get(relativePath)
        })
        continue
      }

      const fullPath = join(repoPath, relativePath)
      const checkpointEntry = target.files[relativePath]
      const checkpointContent = checkpointEntry.content ?? ''

      // 2. Arquivo não existe no disco -> será criado
      if (!existsSync(fullPath)) {
        // Contagem de linhas normalizada: um único segmento vazio final (trailing
        // newline) não conta linha extra; conteúdo vazio permanece 0.
        let lineCount = 0
        if (checkpointContent.length > 0) {
          const segments = checkpointContent.split('\n')
          if (segments[segments.length - 1] === '') {
            segments.pop()
          }
          lineCount = segments.length
        }
        fileChanges.push({
          relativePath,
          status: 'created',
          addedLines: lineCount,
          removedLines: 0
        })
        continue
      }

      // 3. Arquivo existe no disco: confere o tamanho antes de ler — evita I/O
      // integral quando o diff seria descartado pelo teto de segurança.
      let diskStat
      try {
        diskStat = await stat(fullPath)
      } catch {
        fileChanges.push({
          relativePath,
          status: 'blocked',
          addedLines: null,
          removedLines: null,
          reason: 'erro de leitura'
        })
        continue
      }

      if (diskStat.size > MAX_DIFF_CHARS || checkpointContent.length > MAX_DIFF_CHARS) {
        fileChanges.push({
          relativePath,
          status: 'modified',
          addedLines: null,
          removedLines: null
        })
        continue
      }

      // 4. Lê o conteúdo (dentro do teto) e compara com o checkpoint
      let diskContent: string
      try {
        diskContent = await readFile(fullPath, 'utf-8')
      } catch {
        fileChanges.push({
          relativePath,
          status: 'blocked',
          addedLines: null,
          removedLines: null,
          reason: 'erro de leitura'
        })
        continue
      }

      // 5. Conteúdo idêntico -> sem alteração
      if (diskContent === checkpointContent) {
        fileChanges.push({
          relativePath,
          status: 'unchanged',
          addedLines: 0,
          removedLines: 0
        })
        continue
      }

      // 6. Calcula diffLines(disco, checkpoint):
      // Linhas adicionadas no diff = entram no disco na restauração
      // Linhas removidas no diff = saem do disco na restauração
      try {
        const changes = diffLines(diskContent, checkpointContent)
        let addedLines = 0
        let removedLines = 0
        for (const part of changes) {
          if (part.added) {
            addedLines += part.count ?? 0
          } else if (part.removed) {
            removedLines += part.count ?? 0
          }
        }
        fileChanges.push({
          relativePath,
          status: 'modified',
          addedLines,
          removedLines
        })
      } catch {
        fileChanges.push({
          relativePath,
          status: 'modified',
          addedLines: null,
          removedLines: null
        })
      }
    }

    return fileChanges
  }
}