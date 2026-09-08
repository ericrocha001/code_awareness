/*
-T ---
*/

import { existsSync } from 'fs'
import { readFile, writeFile, readdir, unlink, mkdir, stat, open } from 'fs/promises'
import { createHash } from 'crypto'
import { join, basename } from 'path'
import { diffLines } from 'diff'
import { CheckpointData, CheckpointDetails, CheckpointFileEntry, CheckpointSummary, CheckpointHunk, CheckpointDiffFile, CheckpointCatalogRecord } from '../../shared/types'
import { GitService } from './git-service'
import type { CheckpointCatalogPort } from './database-ports'

// Limite máximo de tamanho de arquivo para incluir no snapshot (2MB)
const MAX_FILE_SIZE = 2 * 1024 * 1024

// Nome da pasta onde os checkpoints são persistidos
const CHECKPOINT_DIR_NAME = 'code_checkpoints'

// Limite máximo de checkpoints com conteúdo (JSON) por repositório
const MAX_CONTENT_CHECKPOINTS = 100

// Mapa de extensão para nome de linguagem usado nos blocos de código Markdown
// Deve ser idêntico ao do DiffService para manter consistência visual
const EXTENSION_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.py': 'python',
  '.json': 'json',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.md': 'markdown'
}

// Rótulo em português para cada tipo de alteração
const CHANGE_TYPE_LABEL: Record<'modified' | 'added' | 'deleted', string> = {
  modified: 'modificado',
  added: 'adicionado',
  deleted: 'excluído'
}

export class CheckpointService {
  private readonly catalogPort: CheckpointCatalogPort
  private readonly gitService: GitService

  /**
   * Permite injeção de dependência da porta de catálogo e do GitService.
   */
  constructor(catalogPort: CheckpointCatalogPort, gitService?: GitService) {
    this.catalogPort = catalogPort
    this.gitService = gitService ?? new GitService()
  }

  /**
   * Retorna o caminho absoluto para a pasta de checkpoints do repositório.
   * Não cria a pasta — apenas monta o caminho.
   */
  private getCheckpointDir(repoPath: string): string {
    return join(repoPath, CHECKPOINT_DIR_NAME)
  }

  /**
   * Garante que a pasta code_checkpoints/ existe no repositório.
   * Cria recursivamente se necessário.
   */
  private async ensureCheckpointDir(repoPath: string): Promise<void> {
    const dir = this.getCheckpointDir(repoPath)
    await mkdir(dir, { recursive: true })
  }

  /**
   * Garante que os checkpoints em JSON foram migrados para o catálogo do banco.
   * Migração idempotente: se o banco já tiver registros, retorna imediatamente.
   */
  private async ensureCatalogMigrated(repoPath: string): Promise<void> {
    const existingCatalog = this.catalogPort.getCheckpointsCatalog(repoPath)

    const dir = this.getCheckpointDir(repoPath)
    if (!existsSync(dir)) return

    try {
      const entries = await readdir(dir)
      const jsonFiles = entries.filter(e => e.endsWith('.json'))

      // BUGFIX: Compara contagem de JSONs com contagem do catálogo para detectar
      // migrações parciais (ex.: crash durante migração anterior).
      // Se os números divergirem, re-executa a migração (idempotente via INSERT OR REPLACE).
      if (existingCatalog.length >= jsonFiles.length) {
        return
      }

      // Usando insert individualmente, como try/catch isola as falhas por arquivo
      // (Poderia usar transação para atomicidade completa, mas iterar com replace é simples e idempotente)
      for (const jsonFile of jsonFiles) {
        try {
          const filePath = join(dir, jsonFile)
          const data = JSON.parse(await readFile(filePath, 'utf-8')) as CheckpointData
          this.catalogPort.insertCheckpointCatalog(repoPath, {
            id: data.id,
            name: data.name,
            createdAt: data.createdAt,
            instructions: data.instructions ?? null,
            agentSummary: data.agentSummary ?? null,
            restoredAt: data.restoredAt ?? null,
            fileCount: Object.keys(data.files).length,
            hasContent: true // Nesta sprint, todos têm conteúdo
          })
        } catch (e) {
          console.error(`[CheckpointService] Falha ao migrar ${jsonFile} para o catálogo:`, e)
        }
      }
    } catch (e) {
      console.error('[CheckpointService] Falha ao ler diretório de checkpoints para migração:', e)
    }
  }

  /**
   * Detecta se o conteúdo de um buffer é binário (não UTF-8 válido).
   * Analisa apenas os primeiros 4096 bytes para evitar processamento desnecessário.
   */
  private isBinaryContent(content: Buffer): boolean {
    for (let i = 0; i < Math.min(content.length, 4096); i++) {
      const byte = content[i]
      if (byte === 0) return true
      if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
        return true
      }
    }
    return false
  }

  /**
   * Lê apenas os primeiros 4096 bytes de um arquivo para detectar se é binário.
   * Evita carregar arquivos binários grandes inteiros na memória.
   * Usa open/read/close de fs/promises já importados no topo do arquivo.
   */
  private async isBinaryFile(filePath: string): Promise<boolean> {
    const buffer = Buffer.alloc(4096)
    let handle: import('fs').promises.FileHandle | undefined
    try {
      handle = await open(filePath, 'r')
      const { bytesRead } = await handle.read(buffer, 0, 4096, 0)
      return this.isBinaryContent(buffer.subarray(0, bytesRead))
    } catch {
      // Se não conseguir ler (permissão, arquivo inexistente), assume não-binário
      return false
    } finally {
      // Garante que o file handle seja fechado mesmo em caso de erro
      if (handle !== undefined) {
        await handle.close()
      }
    }
  }

  /**
   * Cria um novo checkpoint do repositório.
   */
  async createCheckpoint(
    repoPath: string,
    name: string,
    details?: CheckpointDetails
  ): Promise<CheckpointData> {
    if (!existsSync(repoPath)) {
      throw new Error(`Repositório não encontrado: ${repoPath}`)
    }

    await this.ensureCheckpointDir(repoPath)

    const existing = await this.listCheckpoints(repoPath)
    if (existing.some(cp => cp.name === name)) {
      throw new Error(`Já existe um checkpoint com o nome "${name}"`)
    }

    const allFiles = await this.gitService.getAllFiles(repoPath)

    const filesToSnapshot = allFiles

    const files: Record<string, CheckpointFileEntry> = {}

    for (const file of filesToSnapshot) {
      const filePath = join(repoPath, file.relativePath)

      try {
        const fileStat = await stat(filePath)

        if (fileStat.size > MAX_FILE_SIZE) {
          continue
        }

        // Primeiro detecta se é binário lendo apenas 4096 bytes (evita carregar binários grandes)
        if (await this.isBinaryFile(filePath)) {
          continue
        }

        const content = await readFile(filePath, 'utf-8')

        const hash = createHash('sha256').update(content).digest('hex')

        files[file.relativePath] = {
          content,
          hash,
          size: fileStat.size
        }
      } catch {
        continue
      }
    }

    const id = 'cp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
    const createdAt = new Date().toISOString()

    const checkpointData: CheckpointData = {
      id,
      name,
      createdAt,
      files
    }

    // Se detalhes forem fornecidos, grava instruções e resumo no checkpoint
    if (details) {
      if (details.instructions !== undefined) {
        checkpointData.instructions = details.instructions
      }
      if (details.agentSummary !== undefined) {
        checkpointData.agentSummary = details.agentSummary
      }
    }

    const checkpointPath = join(this.getCheckpointDir(repoPath), `${id}.json`)
    await writeFile(checkpointPath, JSON.stringify(checkpointData, null, 2), 'utf-8')

    // Dual-write: atualizar catálogo no banco (best-effort)
    try {
      this.catalogPort.insertCheckpointCatalog(repoPath, {
        id: checkpointData.id,
        name: checkpointData.name,
        createdAt: checkpointData.createdAt,
        instructions: checkpointData.instructions ?? null,
        agentSummary: checkpointData.agentSummary ?? null,
        restoredAt: checkpointData.restoredAt ?? null,
        fileCount: Object.keys(checkpointData.files).length,
        hasContent: true
      })
    } catch (e) {
      console.error('[CheckpointService] Falha ao gravar checkpoint no catálogo do banco (best-effort):', e)
    }

    // Aplica o limite de checkpoints com conteúdo (best-effort)
    try {
      const contentCheckpoints = this.catalogPort.getContentCheckpoints(repoPath)
      if (contentCheckpoints.length > MAX_CONTENT_CHECKPOINTS) {
        const toArchiveCount = contentCheckpoints.length - MAX_CONTENT_CHECKPOINTS
        for (let i = 0; i < toArchiveCount; i++) {
          const cp = contentCheckpoints[i]
          // Exclui o arquivo JSON (ignora falha — pode já não existir)
          try {
            const cpPath = join(this.getCheckpointDir(repoPath), `${cp.id}.json`)
            await unlink(cpPath)
          } catch {
            // ignora
          }
          // Marca como sem conteúdo no banco
          this.catalogPort.archiveCheckpointCatalog(repoPath, cp.id)
          console.log(`[CheckpointService] Checkpoint "${cp.name}" arquivado (limite de ${MAX_CONTENT_CHECKPOINTS} atingido)`)
        }
      }
    } catch (e) {
      console.error('[CheckpointService] Falha ao aplicar limite de checkpoints (best-effort):', e)
    }

    return checkpointData
  }

  /**
   * Lista todos os checkpoints do repositório.
   */
  async listCheckpoints(repoPath: string): Promise<CheckpointSummary[]> {
    await this.ensureCatalogMigrated(repoPath)

    try {
      // Lê do catálogo do banco, que já retorna ordenado
      const catalog = this.catalogPort.getCheckpointsCatalog(repoPath)
      const campaignIdsMap = this.catalogPort.getCheckpointCampaignIdsMap(repoPath)

      return catalog.map(record => ({
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        fileCount: record.fileCount,
        restoredAt: record.restoredAt,
        instructions: record.instructions ?? undefined,
        agentSummary: record.agentSummary ?? undefined,
        // BUGFIX: Default defensivo — se hasContent vier como undefined/null (dado corrompido),
        // trata como true (tem conteúdo) para evitar falso positivo do selo "Arquivado".
        hasContent: record.hasContent ?? true,
        campaignIds: campaignIdsMap[record.id] ?? []
      }))
    } catch (e) {
      console.error('[CheckpointService] Erro ao listar checkpoints do catálogo:', e)
      return []
    }
  }

  /**
   * Carrega um checkpoint específico pelo ID.
   * Une o conteúdo do JSON (arquivos) com os metadados atuais do banco.
   * O banco é a fonte autoritativa de metadados; o JSON contém os arquivos congelados.
   */
  async loadCheckpoint(repoPath: string, checkpointId: string): Promise<CheckpointData | null> {
    // Defesa em profundidade contra path traversal — valida o checkpointId antes de usá-lo em caminhos de arquivo
    if (!/^[a-zA-Z0-9_-]+$/.test(checkpointId)) {
      return null
    }

    const filePath = join(this.getCheckpointDir(repoPath), `${checkpointId}.json`)

    let data: CheckpointData
    try {
      data = JSON.parse(await readFile(filePath, 'utf-8')) as CheckpointData
    } catch {
      return null
    }

    // União com metadados do banco (best-effort)
    try {
      const dbRecord = this.catalogPort.getCheckpointCatalog(repoPath, checkpointId)
      if (dbRecord) {
        // Sobrescreve metadados com os valores atuais do banco
        data.name = dbRecord.name
        data.instructions = dbRecord.instructions ?? undefined
        data.agentSummary = dbRecord.agentSummary ?? undefined
        data.restoredAt = dbRecord.restoredAt ?? undefined
      }
    } catch (e) {
      // Se o banco falhar, retorna os dados do JSON com metadados congelados
      console.error('[CheckpointService] Falha ao ler metadados do banco para loadCheckpoint:', e)
    }

    return data
  }

  /**
   * Deleta um checkpoint específico pelo ID.
   */
  async deleteCheckpoint(repoPath: string, checkpointId: string): Promise<boolean> {
    // Defesa em profundidade contra path traversal — valida o checkpointId antes de usá-lo em caminhos de arquivo
    if (!/^[a-zA-Z0-9_-]+$/.test(checkpointId)) {
      return false
    }

    const filePath = join(this.getCheckpointDir(repoPath), `${checkpointId}.json`)

    // BUGFIX: Deleta do catálogo primeiro (best-effort) e depois do JSON.
    // Se a deleção do JSON falhar, o registro já foi removido do catálogo
    // (checkpoint some da timeline, JSON órfão pode ser limpo manualmente).
    // Se o JSON já não existir (ENOENT), prossegue com a deleção do catálogo.
    try {
      this.catalogPort.deleteCheckpointCatalog(repoPath, checkpointId)
    } catch (e) {
      console.error('[CheckpointService] Falha ao deletar checkpoint do catálogo do banco (best-effort):', e)
    }

    try {
      await unlink(filePath)
      return true
    } catch (err: any) {
      // Se o JSON já foi removido (ENOENT), considera sucesso (registro órfão limpo)
      if (err.code === 'ENOENT') {
        return true
      }
      return false
    }
  }

  // ─── Métodos de Metadados ──────────────────────────────────────────────

  /**
   * Atualiza campos de metadados de um checkpoint existente exclusivamente no banco.
   * O JSON não é reescrito — os metadados no JSON são congelados no momento da criação.
   * Esta é a correção do pico de CPU: atualizar uma linha no banco é instantâneo.
   *
   * @param repoPath Caminho absoluto para a raiz do repositório.
   * @param checkpointId ID do checkpoint a ser atualizado.
   * @param patch Objeto com campos opcionais a serem atualizados.
   * @returns true se atualizou com sucesso, false se o checkpoint não existe no catálogo.
   */
  async updateCheckpointMetadata(
    repoPath: string,
    checkpointId: string,
    patch: Partial<Pick<CheckpointData, 'instructions' | 'agentSummary' | 'restoredAt'>>
  ): Promise<boolean> {
    // Validação contra path traversal (defesa em profundidade)
    if (!/^[a-zA-Z0-9_-]+$/.test(checkpointId)) {
      return false
    }

    // Valida existência no catálogo do banco (não lê o JSON)
    try {
      const dbRecord = this.catalogPort.getCheckpointCatalog(repoPath, checkpointId)
      if (!dbRecord) {
        return false
      }
    } catch (e) {
      console.error('[CheckpointService] Falha ao verificar existência do checkpoint no catálogo:', e)
      return false
    }

    // Atualiza exclusivamente no banco — sem reescrita do JSON
    try {
      this.catalogPort.updateCheckpointCatalog(repoPath, checkpointId, {
        ...(patch.instructions !== undefined && { instructions: patch.instructions ?? null }),
        ...(patch.agentSummary !== undefined && { agentSummary: patch.agentSummary ?? null }),
        ...(patch.restoredAt !== undefined && { restoredAt: patch.restoredAt ?? null })
      })
    } catch (e) {
      console.error('[CheckpointService] Falha ao atualizar metadados do checkpoint no catálogo:', e)
      return false
    }

    return true
  }

   /**
    * Define as campanhas vinculadas a um checkpoint.
    * Grava as ligações na caderneta.
    * 
    * @param repoPath Caminho absoluto para a raiz do repositório.
    * @param checkpointId ID do checkpoint.
    * @param campaignIds Array de IDs das campanhas.
    * @returns true se atualizado com sucesso.
    * @throws Error se checkpointId for inválido ou se houver falha de banco.
    */
  async setCheckpointCampaigns(
    repoPath: string,
    checkpointId: string,
    campaignIds: string[]
  ): Promise<boolean> {
    // Validação contra path traversal (defesa em profundidade)
    if (!/^[a-zA-Z0-9_-]+$/.test(checkpointId)) {
      return false
    }

    // Normalizar a lista: remover não-strings ou vazios após trim; remover duplicatas preservando a ordem
    const cleanedIds = Array.from(new Set(
      campaignIds
        .filter(id => typeof id === 'string' && id.trim().length > 0)
        .map(id => id.trim())
    ))

    // Valida existência no catálogo do banco (não lê o JSON)
    let dbRecord: CheckpointCatalogRecord | null = null
    try {
      dbRecord = this.catalogPort.getCheckpointCatalog(repoPath, checkpointId)
    } catch (e) {
      console.error('[CheckpointService] Falha ao verificar existência do checkpoint no catálogo:', e)
      // R2 da auditoria: falha de banco lança Error (o handler traduz em mensagem específica)
      throw new Error('Falha ao verificar existência do checkpoint no catálogo')
    }

    if (!dbRecord) {
      return false
    }

    // Atualiza ligações na caderneta
    try {
      this.catalogPort.setCheckpointCampaignLinks(repoPath, checkpointId, cleanedIds)
    } catch (e) {
      console.error('[CheckpointService] Falha ao atualizar vínculo de campanha no catálogo:', e)
      // R2 da auditoria: falha de banco lança Error (o handler traduz em mensagem específica)
      throw new Error('Falha ao atualizar vínculo de campanha no catálogo/caderneta')
    }

    return true
  }

  // ─── Métodos de Renomeação ───────────────────────────────────────────────

  /**
   * Renomeia um checkpoint existente exclusivamente no banco.
   * O JSON não é reescrito — o nome no JSON é congelado no momento da criação.
   *
   * @param repoPath Caminho absoluto para a raiz do repositório.
   * @param checkpointId ID do checkpoint a ser renomeado.
   * @param newName Novo nome para o checkpoint.
   * @returns true se renomeou com sucesso, false se o checkpoint não existe no catálogo.
   * @throws Error se o novo nome estiver vazio ou já existir duplicata.
   */
  async renameCheckpoint(
    repoPath: string,
    checkpointId: string,
    newName: string
  ): Promise<boolean> {
    // Validação contra path traversal (defesa em profundidade)
    if (!/^[a-zA-Z0-9_-]+$/.test(checkpointId)) {
      throw new Error('checkpointId contém caracteres inválidos')
    }

    if (!newName || newName.trim().length === 0) {
      throw new Error('O novo nome não pode estar vazio')
    }

    // Valida existência no catálogo do banco (não lê o JSON)
    let dbRecord: CheckpointCatalogRecord | null = null
    try {
      dbRecord = this.catalogPort.getCheckpointCatalog(repoPath, checkpointId)
    } catch (e) {
      console.error('[CheckpointService] Falha ao verificar existência do checkpoint no catálogo:', e)
      return false
    }

    if (!dbRecord) {
      return false
    }

    // Valida unicidade do novo nome via catálogo do banco
    // BUGFIX: Sem try/catch — o throw intencional de nome duplicado deve propagar
    // ao caller (checkpoint-handler) para exibir a mensagem específica ao usuário.
    const catalog = this.catalogPort.getCheckpointsCatalog(repoPath)
    if (catalog.some(cp => cp.name === newName.trim() && cp.id !== checkpointId)) {
      throw new Error(`Já existe um checkpoint com o nome "${newName.trim()}"`)
    }

    // Atualiza exclusivamente no banco — sem reescrita do JSON
    try {
      this.catalogPort.updateCheckpointCatalog(repoPath, checkpointId, { name: newName.trim() })
    } catch (e) {
      console.error('[CheckpointService] Falha ao atualizar nome do checkpoint no catálogo:', e)
      return false
    }

    return true
  }

  // ─── Métodos de Geração de Diff ──────────────────────────────────────────

  /**
   * Gera um diff semântico em Markdown entre dois checkpoints.
   * Se toCheckpointId for igual a fromCheckpointId, compara com o estado atual do disco.
   * Isso é usado pelo frontend para comparar o primeiro checkpoint (mais antigo) com o disco.
   */
  async generateDiffBetween(
    repoPath: string,
    fromCheckpointId: string,
    toCheckpointId: string
  ): Promise<string> {
    const fromCheckpoint = await this.loadCheckpoint(repoPath, fromCheckpointId)
    if (!fromCheckpoint) {
      return '# ❌ Erro: Checkpoint de origem não encontrado.'
    }

    const diffFiles: CheckpointDiffFile[] = []

    // Se toCheckpointId === fromCheckpointId, é um sinal do frontend para comparar com disco.
    // Isso ocorre quando o checkpoint selecionado é o primeiro/mais antigo na timeline.
    if (toCheckpointId === fromCheckpointId) {
      await this.compareCheckpointWithDisk(repoPath, fromCheckpoint, diffFiles)

      if (diffFiles.length === 0) {
        const header = this.buildDiffHeader(repoPath, fromCheckpoint.name, 'atual')
        return `${header}\n\n*Nenhuma alteração detectada entre o checkpoint e o estado atual do disco.*`
      }

      const header = this.buildDiffHeader(repoPath, fromCheckpoint.name, 'atual')
      const sections: string[] = []

      for (const file of diffFiles) {
        const section = this.buildFileSection(file)
        if (section) sections.push(section)
      }

      if (sections.length === 0) {
        return `${header}\n\n*Nenhuma alteração significativa encontrada.*`
      }

      return [header, ...sections].join('\n\n---\n\n')
    }

    // Fluxo normal: comparar com outro checkpoint
    const toCheckpoint = await this.loadCheckpoint(repoPath, toCheckpointId)
    if (!toCheckpoint) {
      return '# ❌ Erro: Checkpoint de destino não encontrado.'
    }

    this.compareCheckpoints(fromCheckpoint, toCheckpoint, diffFiles)

    if (diffFiles.length === 0) {
      const header = this.buildDiffHeader(repoPath, fromCheckpoint.name, toCheckpoint.name)
      return `${header}\n\n*Nenhuma alteração detectada entre os checkpoints.*`
    }

    const header = this.buildDiffHeader(repoPath, fromCheckpoint.name, toCheckpoint.name)
    const sections: string[] = []

    for (const file of diffFiles) {
      const section = this.buildFileSection(file)
      if (section) sections.push(section)
    }

    if (sections.length === 0) {
      return `${header}\n\n*Nenhuma alteração significativa encontrada.*`
    }

    return [header, ...sections].join('\n\n---\n\n')
  }

  /**
   * Retorna apenas a lista de arquivos alterados entre dois checkpoints,
   * ou entre um checkpoint e o estado atual do disco (para o primeiro checkpoint).
   * Não gera Markdown — apenas retorna os metadados dos arquivos changed.
   *
   * @param repoPath Caminho absoluto para a raiz do repositório.
   * @param fromCheckpointId ID do checkpoint de origem.
   * @param toCheckpointId ID do checkpoint de destino (obrigatório).
   *   Se igual a fromCheckpointId, compara com o estado atual do disco.
   * @returns Array de CheckpointDiffFile ordenado por mtime descendente (deleted no final).
   */
  async getChangedFiles(
    repoPath: string,
    fromCheckpointId: string,
    toCheckpointId: string
  ): Promise<CheckpointDiffFile[]> {
    const fromCheckpoint = await this.loadCheckpoint(repoPath, fromCheckpointId)
    if (!fromCheckpoint) {
      return []
    }

    const diffFiles: CheckpointDiffFile[] = []

    // Se toCheckpointId === fromCheckpointId, compara com disco (primeiro checkpoint)
    if (toCheckpointId === fromCheckpointId) {
      await this.compareCheckpointWithDisk(repoPath, fromCheckpoint, diffFiles)
    } else {
      const toCheckpoint = await this.loadCheckpoint(repoPath, toCheckpointId)
      if (!toCheckpoint) {
        return []
      }
      this.compareCheckpoints(fromCheckpoint, toCheckpoint, diffFiles)
    }

    // Obtém mtime real do disco
    const metadataPromises = diffFiles.map(async (file) => {
      let mtime = 0
      try {
        const fileStat = await stat(join(repoPath, file.relativePath))
        mtime = fileStat.mtimeMs
      } catch {
        mtime = 0
      }
      return { file, mtime }
    })
    const metadataResults = await Promise.all(metadataPromises)

    // Injeta mtime nos arquivos de diff
    const filesWithMetadata: CheckpointDiffFile[] = metadataResults.map(({ file, mtime }) => ({
      ...file,
      mtime
    }))

    // Ordena por mtime descendente (deleted no final)
    return filesWithMetadata.sort((a, b) => {
      if (a.changeType === 'deleted' && b.changeType !== 'deleted') return 1
      if (a.changeType !== 'deleted' && b.changeType === 'deleted') return -1
      return (b.mtime ?? 0) - (a.mtime ?? 0)
    })
  }

  private buildDiffHeader(repoPath: string, fromName: string, toLabel: string): string {
    const repoName = basename(repoPath)
    const date = new Date().toLocaleString('pt-BR')
    return [
      `# Semantic Diff — \`${repoName}\``, ``,
      `*Checkpoint: "${fromName}" → ${toLabel} | Gerado em: ${date}*`, ``,
      `> Este documento foi gerado automaticamente para auxiliar modelos de linguagem na compreensão das alterações do repositório.`,
      `> Cada seção contém os blocos exatos de código removido (🟥) e adicionado (🟩), organizados por hunk de diff.`
    ].join('\n')
  }

  private compareCheckpoints(
    fromCheckpoint: CheckpointData,
    toCheckpoint: CheckpointData,
    diffFiles: CheckpointDiffFile[]
  ): void {
    const fromFiles = fromCheckpoint.files
    const toFiles = toCheckpoint.files

    for (const [relativePath, fromEntry] of Object.entries(fromFiles)) {
      const toEntry = toFiles[relativePath]

      if (!toEntry) {
        diffFiles.push({ relativePath, changeType: 'deleted', hunks: [], oldContent: fromEntry.content })
      } else if (fromEntry.content !== toEntry.content) {
        const hunks = this.calculateHunks(fromEntry.content, toEntry.content)
        if (hunks.length > 0) {
          diffFiles.push({ relativePath, changeType: 'modified', hunks })
        }
      }
    }

    for (const [relativePath, toEntry] of Object.entries(toFiles)) {
      if (!fromFiles[relativePath]) {
        diffFiles.push({ relativePath, changeType: 'added', hunks: [], newContent: toEntry.content })
      }
    }
  }

  /**
   * Compara o conteúdo de um checkpoint com o estado atual dos arquivos no disco.
   * Usado quando o checkpoint selecionado é o primeiro/mais antigo na timeline.
   */
  private async compareCheckpointWithDisk(
    repoPath: string,
    checkpoint: CheckpointData,
    diffFiles: CheckpointDiffFile[]
  ): Promise<void> {
    const checkpointFiles = checkpoint.files

    for (const [relativePath, checkpointEntry] of Object.entries(checkpointFiles)) {
      const filePath = join(repoPath, relativePath)

      try {
        const currentContent = await readFile(filePath, 'utf-8')
        if (currentContent !== checkpointEntry.content) {
          const hunks = this.calculateHunks(checkpointEntry.content, currentContent)
          if (hunks.length > 0) {
            diffFiles.push({ relativePath, changeType: 'modified', hunks })
          }
        }
      } catch {
        diffFiles.push({ relativePath, changeType: 'deleted', hunks: [], oldContent: checkpointEntry.content })
      }
    }

    try {
      const trackedFiles = await this.gitService.getAllFiles(repoPath)

      for (const file of trackedFiles) {
        if (!checkpointFiles[file.relativePath]) {
          try {
            const filePath = join(repoPath, file.relativePath)
            const fileStat = await stat(filePath)

            if (fileStat.size > MAX_FILE_SIZE) continue

            // Primeiro detecta se é binário lendo apenas 4096 bytes (evita carregar binários grandes)
            if (await this.isBinaryFile(filePath)) continue

            const currentContent = await readFile(filePath, 'utf-8')

            diffFiles.push({ relativePath: file.relativePath, changeType: 'added', hunks: [], newContent: currentContent })
          } catch {
            continue
          }
        }
      }
    } catch {
      console.error('[CheckpointService] Falha ao listar tracked files para comparação com disco')
    }
  }

  private calculateHunks(oldContent: string, newContent: string): CheckpointHunk[] {
    const changes = diffLines(oldContent, newContent)
    const hunks: CheckpointHunk[] = []
    let currentHunk: CheckpointHunk | null = null
    let oldLine = 1
    let newLine = 1

    for (const change of changes) {
      const lines = change.value.replace(/\n$/, '').split('\n')

      if (change.removed) {
        if (!currentHunk) {
          currentHunk = { oldStart: oldLine, oldLines: 0, newStart: newLine, newLines: 0, removedLines: [], addedLines: [] }
        }
        currentHunk.removedLines.push(...lines)
        currentHunk.oldLines += lines.length
        oldLine += lines.length
      } else if (change.added) {
        if (!currentHunk) {
          currentHunk = { oldStart: oldLine, oldLines: 0, newStart: newLine, newLines: 0, removedLines: [], addedLines: [] }
        }
        currentHunk.addedLines.push(...lines)
        currentHunk.newLines += lines.length
        newLine += lines.length
      } else {
        if (currentHunk) {
          hunks.push(currentHunk)
          currentHunk = null
        }
        oldLine += lines.length
        newLine += lines.length
      }
    }

    if (currentHunk) {
      hunks.push(currentHunk)
    }

    return hunks
  }

  private buildFileSection(file: CheckpointDiffFile): string {
    const dotIndex = file.relativePath.lastIndexOf('.')
    const ext = dotIndex !== -1 ? file.relativePath.substring(dotIndex) : ''
    const lang = EXTENSION_MAP[ext.toLowerCase()] || 'text'
    const label = CHANGE_TYPE_LABEL[file.changeType]

    const fileHeader = `## 📄 \`${file.relativePath}\` (${label})`

    if (file.changeType === 'deleted') {
      if (!file.oldContent) return ''
      return [fileHeader, ``, `#### 🟥 [Código Original / Removido]`, `\`\`\`${lang}`, file.oldContent.trimEnd(), `\`\`\``].join('\n')
    }

    if (file.changeType === 'added') {
      if (!file.newContent && file.newContent !== '') return ''
      return [fileHeader, ``, `### 🔍 Hunk 1 (Arquivo novo)`, ``, `#### 🟥 [Código Original / Removido]`, `*(Nenhuma versão anterior identificada)*`, ``, `#### 🟩 [Código Novo / Adicionado]`, `\`\`\`${lang}`, file.newContent, `\`\`\``].join('\n')
    }

    if (file.hunks.length === 0) return ''

    const hunkSections: string[] = []

    file.hunks.forEach((hunk, index) => {
      let originalRange: string
      if (hunk.oldLines === 0) {
        originalRange = 'Sem alterações no arquivo original'
      } else if (hunk.oldLines === 1) {
        originalRange = `Linha ${hunk.oldStart}`
      } else {
        const oldEnd = hunk.oldStart + hunk.oldLines - 1
        originalRange = `Linhas ${hunk.oldStart} a ${oldEnd}`
      }

      let newRange: string
      if (hunk.newLines === 0) {
        newRange = 'Sem linhas no arquivo novo'
      } else if (hunk.newLines === 1) {
        newRange = `Linha ${hunk.newStart}`
      } else {
        const newEnd = hunk.newStart + hunk.newLines - 1
        newRange = `Linhas ${hunk.newStart} a ${newEnd}`
      }

      const hunkTitle = `### 🔍 Hunk ${index + 1} (${originalRange} ➔ ${newRange})`

      const negativeBlock = hunk.removedLines.length > 0
        ? [`#### 🟥 [Código Original / Removido]`, `\`\`\`${lang}`, hunk.removedLines.join('\n'), `\`\`\``].join('\n')
        : [`#### 🟥 [Código Original / Removido]`, `*(Nenhuma versão anterior identificada)*`].join('\n')

      const positiveBlock = hunk.addedLines.length > 0
        ? [`#### 🟩 [Código Novo / Adicionado]`, `\`\`\`${lang}`, hunk.addedLines.join('\n'), `\`\`\``].join('\n')
        : [`#### 🟩 [Código Novo / Adicionado]`, `*(Nenhuma linha adicionada neste hunk)*`].join('\n')

      hunkSections.push([hunkTitle, '', negativeBlock, '', positiveBlock].join('\n'))
    })

    const parts: string[] = [fileHeader]
    parts.push(...hunkSections)

    return parts.join('\n\n')
  }
}