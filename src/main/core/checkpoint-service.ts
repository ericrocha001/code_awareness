/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Criar, listar, carregar e deletar checkpoints de um repositório.
2. Capturar o conteúdo completo dos arquivos do repositório no momento do checkpoint.
3. Persistir cada checkpoint como um arquivo JSON em code_checkpoints/<id>.json.
4. Filtrar arquivos binários e arquivos maiores que 2MB do snapshot.
5. Gerar diffs semânticos entre checkpoints ou entre checkpoint e estado atual do disco (para o primeiro checkpoint).
6. Restaurar arquivos do repositório para o estado de um checkpoint específico.
7. Renomear checkpoints existentes, atualizando o campo name no JSON persistido.
8. Retornar lista de arquivos alterados entre checkpoints sem gerar Markdown.
9. Validar (dry-run) se uma restauração pode ser executada antes de modificar o disco.

Mapa de Relacionamentos do Script

1. git-service.ts
   - Tipo: Dependência Direta
   - Relação: Consome getAllFiles e getCurrentCommitHash para listar arquivos e detectar commits.
   - Criticidade: Alta

2. importance-service.ts
   - Tipo: Dependência Direta
   - Relação: Consome classifyFile para filtrar por importância no modo 'critical-high'.
   - Criticidade: Alta

3. ../../shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Fornece os tipos CheckpointData, CheckpointFileEntry e CheckpointSummary.
   - Criticidade: Alta

4. diff (biblioteca npm)
   - Tipo: Dependência Direta
   - Relação: Usa diffLines para calcular mudanças linha a linha entre conteúdos.
   - Criticidade: Alta

5. fs/promises (writeFile)
   - Tipo: Dependência Direta
   - Relação: Usa writeFile para sobrescrever arquivos no disco durante restauração.
   - Criticidade: Alta


Invariantes do Script

1. Nunca criar checkpoint com arquivos binários ou maiores que 2MB.
2. O id do checkpoint deve ser único — usa timestamp + sufixo aleatório.
3. A pasta code_checkpoints/ deve ser ignorada pelo Git e não entrar no snapshot.
4. Nunca retornar dados corrompidos — toda leitura de JSON deve ser validada.
5. TODO método público que recebe checkpointId deve validar contra path traversal antes de qualquer operação de arquivo.
6. O diff gerado deve seguir exatamente o mesmo formato Markdown do DiffService (blocos 🟥 e 🟩 com hunks numerados).
7. A restauração deve validar se o checkpoint existe antes de sobrescrever arquivos.
8. Arquivos que não existem no checkpoint mas existem no disco não devem ser deletados durante restauração.
9. O renome de checkpoint deve validar que o novo nome não esteja vazio e não exista duplicata.
10. O método getChangedFiles deve retornar arquivos ordenados por mtime descendente, com deleted no final.
11. Arquivos binários não devem ser lidos completamente — apenas os primeiros 4096 bytes são analisados para detecção.
12. O método validateRestore() deve ser chamado antes de restoreCheckpoint() para permitir confirmação do usuário em caso de falhas potenciais.
13. O primeiro checkpoint (mais antigo) deve comparar com o estado atual do disco quando não há checkpoint anterior.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { existsSync, constants } from 'fs'
import { readFile, writeFile, readdir, unlink, mkdir, stat, open, access } from 'fs/promises'
import { createHash } from 'crypto'
import { join, basename, dirname } from 'path'
import { diffLines } from 'diff'
import { CheckpointData, CheckpointFileEntry, CheckpointSummary, CheckpointHunk, CheckpointDiffFile, RestoreValidation } from '../../shared/types'
import { GitService } from './git-service'
import { importanceService } from './importance-service'

// Limite máximo de tamanho de arquivo para incluir no snapshot (2MB)
const MAX_FILE_SIZE = 2 * 1024 * 1024

// Nome da pasta onde os checkpoints são persistidos
const CHECKPOINT_DIR_NAME = 'code_checkpoints'

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
  private readonly gitService: GitService

  /**
   * Permite injeção de dependência do GitService para facilitar testes unitários.
   * Se não for passado, cria uma instância padrão.
   */
  constructor(gitService?: GitService) {
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
    strategy: 'all' | 'critical-high'
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

    let filesToSnapshot = allFiles
    if (strategy === 'critical-high') {
      const classificationPromises = allFiles.map(async (file) => {
        try {
          const result = await importanceService.classifyFile(repoPath, file.relativePath)
          return { file, level: result.level }
        } catch {
          return { file, level: 'critical' as const }
        }
      })

      const classified = await Promise.all(classificationPromises)
      filesToSnapshot = classified
        .filter(({ level }) => level === 'critical' || level === 'high')
        .map(({ file }) => file)
    }

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
      snapshotStrategy: strategy,
      files
    }

    const checkpointPath = join(this.getCheckpointDir(repoPath), `${id}.json`)
    await writeFile(checkpointPath, JSON.stringify(checkpointData, null, 2), 'utf-8')

    return checkpointData
  }

  /**
   * Lista todos os checkpoints do repositório.
   */
  async listCheckpoints(repoPath: string): Promise<CheckpointSummary[]> {
    const dir = this.getCheckpointDir(repoPath)

    try {
      const entries = await readdir(dir)
      const jsonFiles = entries.filter(e => e.endsWith('.json'))

      const summaries: CheckpointSummary[] = []

      for (const jsonFile of jsonFiles) {
        try {
          const filePath = join(dir, jsonFile)
          const data = JSON.parse(await readFile(filePath, 'utf-8')) as CheckpointData

          summaries.push({
            id: data.id,
            name: data.name,
            createdAt: data.createdAt,
            fileCount: Object.keys(data.files).length
          })
        } catch {
          continue
        }
      }

      return summaries.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
    } catch {
      return []
    }
  }

  /**
   * Carrega um checkpoint específico pelo ID.
   */
  async loadCheckpoint(repoPath: string, checkpointId: string): Promise<CheckpointData | null> {
    // Defesa em profundidade contra path traversal — valida o checkpointId antes de usá-lo em caminhos de arquivo
    if (!/^[a-zA-Z0-9_-]+$/.test(checkpointId)) {
      return null
    }

    const filePath = join(this.getCheckpointDir(repoPath), `${checkpointId}.json`)

    try {
      const data = JSON.parse(await readFile(filePath, 'utf-8')) as CheckpointData
      return data
    } catch {
      return null
    }
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

    try {
      await unlink(filePath)
      return true
    } catch {
      return false
    }
  }

  /**
   * Deleta todos os checkpoints do repositório.
   * Remove todos os arquivos .json da pasta de checkpoints.
   */
  async deleteAllCheckpoints(repoPath: string): Promise<number> {
    const dir = this.getCheckpointDir(repoPath)

    try {
      const entries = await readdir(dir)
      // Deleta TODOS os arquivos .json da pasta de checkpoints
      const jsonFiles = entries.filter(e => e.endsWith('.json'))

      if (jsonFiles.length === 0) {
        console.warn('[CheckpointService] Nenhum checkpoint encontrado para deletar')
        return 0
      }

      await Promise.all(
        jsonFiles.map(jsonFile => unlink(join(dir, jsonFile)))
      )

      return jsonFiles.length
    } catch {
      console.warn('[CheckpointService] Pasta de checkpoints não encontrada ou erro ao ler')
      return 0
    }
  }

  // ─── Métodos de Restauração ──────────────────────────────────────────────

  /**
   * Restaura os arquivos do repositório para o estado de um checkpoint específico.
   */
  async restoreCheckpoint(
    repoPath: string,
    checkpointId: string
  ): Promise<{ restored: number; failed: number; errors: string[] }> {
    if (!/^[a-zA-Z0-9_-]+$/.test(checkpointId)) {
      return { restored: 0, failed: 0, errors: ['checkpointId contém caracteres inválidos'] }
    }

    if (!existsSync(repoPath)) {
      return { restored: 0, failed: 0, errors: [`Repositório não encontrado: ${repoPath}`] }
    }

    const checkpoint = await this.loadCheckpoint(repoPath, checkpointId)
    if (!checkpoint) {
      return { restored: 0, failed: 0, errors: ['Checkpoint não encontrado'] }
    }

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
        console.error(`[CheckpointService] Falha ao restaurar ${relativePath}:`, error)
      }
    }

    return { restored, failed, errors }
  }

  /**
   * Dry-run: verifica se a restauração pode ser executada sem modificar o disco.
   * Usado pelo frontend para mostrar modal de confirmação ANTES de executar.
   *
   * Para cada arquivo no checkpoint verifica:
   * - O diretório pai existe ou pode ser criado?
   * - O arquivo pode ser escrito (permissões)?
   */
  async validateRestore(
    repoPath: string,
    checkpointId: string
  ): Promise<RestoreValidation> {
    if (!/^[a-zA-Z0-9_-]+$/.test(checkpointId)) {
      return { canRestore: [], cannotRestore: [] }
    }

    if (!existsSync(repoPath)) {
      return { canRestore: [], cannotRestore: [] }
    }

    const checkpoint = await this.loadCheckpoint(repoPath, checkpointId)
    // Se o checkpoint não existe, deixa o restoreCheckpoint() real tratar depois
    if (!checkpoint) {
      return { canRestore: [], cannotRestore: [] }
    }

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

  // Métodos de detecção de commits removidos — limpeza agora é manual via botão 'Limpar Tudo' na UI

  // ─── Métodos de Renomeação ───────────────────────────────────────────────

  /**
   * Renomeia um checkpoint existente, atualizando o campo name no JSON persistido.
   *
   * @param repoPath Caminho absoluto para a raiz do repositório.
   * @param checkpointId ID do checkpoint a ser renomeado.
   * @param newName Novo nome para o checkpoint.
   * @returns true se renomeou com sucesso, false se o checkpoint não existe.
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

    const checkpoint = await this.loadCheckpoint(repoPath, checkpointId)
    if (!checkpoint) {
      return false
    }

    // Valida unicidade do novo nome
    const existing = await this.listCheckpoints(repoPath)
    if (existing.some(cp => cp.name === newName.trim() && cp.id !== checkpointId)) {
      throw new Error(`Já existe um checkpoint com o nome "${newName.trim()}"`)
    }

    // Atualiza o nome
    checkpoint.name = newName.trim()

    // Persiste as alterações
    const checkpointPath = join(this.getCheckpointDir(repoPath), `${checkpointId}.json`)
    await writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), 'utf-8')

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

      // Classifica todos os arquivos do diff por importância (usando ImportanceService real)
      const importancePromises = diffFiles.map(async (file) => {
        try {
          const result = await importanceService.classifyFile(repoPath, file.relativePath)
          return { file, level: result.level }
        } catch {
          return { file, level: 'low' as const }
        }
      })
      const importanceResults = await Promise.all(importancePromises)
      const importanceMap = new Map<string, string>()
      for (const { file, level } of importanceResults) {
        importanceMap.set(file.relativePath, level)
      }

      const header = this.buildDiffHeader(repoPath, fromCheckpoint.name, 'atual')
      const sections: string[] = []

      for (const file of diffFiles) {
        // Injeta a importância real no arquivo de diff para o buildFileSection usar
        file.importance = (importanceMap.get(file.relativePath) || 'low') as 'critical' | 'high' | 'medium' | 'low'
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

    // Classifica todos os arquivos do diff por importância (usando ImportanceService real)
    const importancePromises = diffFiles.map(async (file) => {
      try {
        const result = await importanceService.classifyFile(repoPath, file.relativePath)
        return { file, level: result.level }
      } catch {
        return { file, level: 'low' as const }
      }
    })
    const importanceResults = await Promise.all(importancePromises)
    const importanceMap = new Map<string, string>()
    for (const { file, level } of importanceResults) {
      importanceMap.set(file.relativePath, level)
    }

    const header = this.buildDiffHeader(repoPath, fromCheckpoint.name, toCheckpoint.name)
    const sections: string[] = []

    for (const file of diffFiles) {
      // Injeta a importância real no arquivo de diff para o buildFileSection usar
      file.importance = (importanceMap.get(file.relativePath) || 'low') as 'critical' | 'high' | 'medium' | 'low'
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

    // Classifica todos os arquivos por importância e obtém mtime real do disco
    const metadataPromises = diffFiles.map(async (file) => {
      try {
        const result = await importanceService.classifyFile(repoPath, file.relativePath)
        // Obtém mtime real do arquivo no disco (ou 0 se não existir/deleted)
        let mtime = 0
        try {
          const fileStat = await stat(join(repoPath, file.relativePath))
          mtime = fileStat.mtimeMs
        } catch {
          mtime = 0
        }
        return { file, level: result.level, mtime }
      } catch {
        return { file, level: 'low' as const, mtime: 0 }
      }
    })
    const metadataResults = await Promise.all(metadataPromises)

    // Injeta importância e mtime nos arquivos de diff
    const filesWithMetadata: CheckpointDiffFile[] = metadataResults.map(({ file, level, mtime }) => ({
      ...file,
      importance: level,
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

    // Mapeia nível de importância para emoji (mesmo padrão do ImportanceBadge)
    const importanceEmoji: Record<string, string> = {
      critical: '🔴',
      high: '🟠',
      medium: '🟡',
      low: '⚪'
    }
    const emoji = file.importance ? importanceEmoji[file.importance] || '' : ''
    const badge = emoji ? ` ${emoji}` : ''

    const fileHeader = `## 📄 \`${file.relativePath}\` (${label})${badge}`

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