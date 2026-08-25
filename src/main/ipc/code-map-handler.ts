/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Registrar handlers IPC para operações do Code Map.
2. Validar parâmetros recebidos antes de delegar ao Code Map Service.
3. Capturar erros e retornar respostas estruturadas ao renderer.
4. Ser o único ponto de entrada IPC para o Code Map — o renderer nunca acessa o Service diretamente.
5. Expor o recorte de trecho de elemento via IPC.
6. Expor a leitura de arquivo integral via IPC com validação de relativePath.
7. Expor a abertura do elemento no VS Code via protocolo vscode://, com fallback para showItemInFolder.
8. Emitir eventos push (code-map:file-modified, code-map:file-confirmed e code-map:file-indexed) para o renderer quando arquivos forem modificados no disco, confirmados ou reindexados.
9. Expor a geração de markdown de escopo (arquivo âncora + relacionados) via IPC.

Mapa de Relacionamentos do Script

1. code-map-service.ts
   - Tipo: Dependência Direta
   - Relação: Instancia e consome Code Map Service para todas as operações.
   - Criticidade: Alta

2. repository-events.ts
   - Tipo: Dependência Direta
   - Relação: Escuta eventos de alteração de arquivo para emitir pushes ao renderer.
   - Criticidade: Alta

3. ../../shared/types
   - Tipo: Contrato / Interface
   - Relação: Fornece os tipos CodeMapRepository, CodeMapFile, CodeMapElement, CodeMapRelationship, CodeMapSyncStatus.
   - Criticidade: Alta

4. preload.ts
   - Tipo: Dependência Inversa
   - Relação: Os métodos expostos no preload invocam estes handlers e escutam os eventos via IPC.
   - Criticidade: Alta

Invariantes do Script

1. Handlers IPC nunca devem lançar exceções não tratadas — erros devem ser capturados e retornados como { success: false, error }.
2. Caminhos recebidos por IPC devem sempre ser validados como strings não vazias.
3. Toda resposta de handler deve conter o campo success.
4. Nenhuma lógica de negócio — apenas validação de parâmetros e delegação ao service.
5. O Code Map Service é injetado via parâmetro no registerCodeMapHandlers — nunca instanciado diretamente.
6. relativePath recebido por IPC nunca pode conter "..", ser absoluto ou conter drive Windows.
7. Eventos de modificação e indexação são propagados a todas as janelas ativas via BrowserWindow.getAllWindows().
8. O listener do repositoryEventBus vive durante todo o ciclo de vida da aplicação (instância única no bootstrap) e o envio via webContents é protegido por try/catch para evitar interrupções no loop.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { ipcMain, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { CodeMapService } from '../core/code-map-service'
import { repositoryEventBus } from '../core/repository-events'
import { telemetryService } from '../core/telemetry-service'

function isValidPath(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes(' ')
}

function isValidRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) return false
  if (value.includes('..')) return false
  if (value.startsWith('/') || value.startsWith('\\')) return false
  if (/^[A-Za-z]:/.test(value)) return false
  return true
}

/**
 * Transmite um evento IPC para todas as janelas ativas do Electron com proteção contra falhas individuais.
 */
function broadcastToWindows(channel: string, payload: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send(channel, payload)
      } catch (err) {
        console.warn(`[CodeMapHandler] Falha ao emitir evento ${channel} para janela:`, err)
      }
    }
  })
}

export function registerCodeMapHandlers(codeMapService: CodeMapService): void {
  // Escuta alterações de arquivos no Event Bus e emite evento push para o renderer
  // Mantido por retrocompatibilidade: o canal code-map:file-modified segue sendo emitido,
  // embora o CodeMapView consuma agora o canal confirmado (code-map:file-confirmed).
  repositoryEventBus.onFileModified((event) => {
    broadcastToWindows('code-map:file-modified', {
      repoPath: event.repositoryId,
      relativePath: event.relativePath
    })
  })

  repositoryEventBus.onFileConfirmed((event) => {
    broadcastToWindows('code-map:file-confirmed', {
      repoPath: event.repositoryId,
      relativePath: event.relativePath
    })
  })

  ipcMain.handle('code-map:open-repository', async (_event, repoPath: unknown) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e deve ser uma string não vazia' }
      }
      await codeMapService.openRepository(repoPath)
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('code-map:close-repository', async (_event, repoPath: unknown) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e deve ser uma string não vazia' }
      }
      codeMapService.closeRepository(repoPath)
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('code-map:index-repository', async (_event, repoPath: unknown) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e deve ser uma string não vazia' }
      }
      const result = await codeMapService.indexRepository(repoPath)
      broadcastToWindows('code-map:file-indexed', { repoPath, relativePath: '' })
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('code-map:synchronize-modified', async (_event, repoPath: unknown) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e deve ser uma string não vazia' }
      }
      const result = await codeMapService.synchronizeModified(repoPath)
      broadcastToWindows('code-map:file-indexed', { repoPath, relativePath: '' })
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * code-map:verify-integrity — Verifica integridade completa do Code Map.
   * Parâmetros: repoPath, options: { autoRepair?: boolean }
   * Retorna: { success, data?: IntegrityCheckResult, error?: string }
   */
  ipcMain.handle('code-map:verify-integrity', async (_event, repoPath: unknown, options: unknown) => {
    if (!isValidPath(repoPath)) {
      return { success: false, error: 'repoPath é obrigatório e deve ser uma string não vazia' }
    }

    // Valida options
    const opts = options && typeof options === 'object' ? options : {}
    const autoRepair =
      typeof (opts as { autoRepair?: unknown }).autoRepair === 'boolean'
        ? (opts as { autoRepair: boolean }).autoRepair
        : false
    const selectedIssues = Array.isArray((opts as { selectedIssues?: unknown }).selectedIssues)
      ? ((opts as { selectedIssues: unknown[] }).selectedIssues.filter(id => typeof id === 'string') as string[])
      : undefined

    // Issues pré-descobertas pelo frontend para a reparação cirúrgica (pula a redescoberta).
    // Só são aceitas se todas forem válidas; caso contrário, o backend cai no fluxo padrão.
    const rawIssues = (opts as { issues?: unknown }).issues
    let issues: import('../../shared/types').IntegrityIssue[] | undefined
    if (Array.isArray(rawIssues) && rawIssues.length > 0) {
      const isIssue = (i: unknown): i is import('../../shared/types').IntegrityIssue =>
        !!i &&
        typeof i === 'object' &&
        typeof (i as { type?: unknown }).type === 'string' &&
        typeof (i as { target?: unknown }).target === 'string'
      const valid = (rawIssues as unknown[]).filter(isIssue)
      if (valid.length === rawIssues.length) {
        issues = valid
      }
    }

    const correlationId = telemetryService.startOperation('INTEGRITY_VIA_IPC')
    telemetryService.log(correlationId, 'INTEGRITY', 'IPC_VERIFY_STARTED', { repoPath, autoRepair, selectedCount: selectedIssues?.length, issuesCount: issues?.length })

    try {
      const result = await codeMapService.verifyIntegrity(repoPath, { autoRepair, selectedIssues, issues })
      telemetryService.log(correlationId, 'INTEGRITY', 'IPC_VERIFY_COMPLETED', {
        status: result.status,
        durationMs: result.durationMs,
        autoRepair
      })
      broadcastToWindows('code-map:file-indexed', { repoPath, relativePath: '' })
      return { success: true, data: result }
    } catch (err) {
      telemetryService.logError(correlationId, 'INTEGRITY', 'IPC_VERIFY_FAILED', {
        error: err instanceof Error ? err.message : String(err)
      })
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('code-map:generate-scope', async (_event, repoPath: unknown, anchorFileId: unknown) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e deve ser uma string não vazia' }
      }
      if (!isValidId(anchorFileId)) {
        return { success: false, error: 'anchorFileId é obrigatório e deve ser uma string não vazia sem espaços' }
      }
      const result = await codeMapService.generateScopeMarkdown(repoPath, anchorFileId)
      return result
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('code-map:generate-compressed-scope', async (_event, repoPath: unknown, anchorFileId: unknown) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e deve ser uma string não vazia' }
      }
      if (!isValidId(anchorFileId)) {
        return { success: false, error: 'anchorFileId é obrigatório e deve ser uma string não vazia sem espaços' }
      }
      const result = await codeMapService.generateCompressedScopeMarkdown(repoPath, anchorFileId)
      return result
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('code-map:get-repository', async (_event, repoPath: unknown) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e deve ser uma string não vazia' }
      }
      const result = codeMapService.getRepository(repoPath)
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('code-map:get-files', async (_event, repoPath: unknown) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e deve ser uma string não vazia' }
      }
      const result = codeMapService.getFiles(repoPath)
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('code-map:get-elements', async (_event, repoPath: unknown) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e deve ser uma string não vazia' }
      }
      const result = codeMapService.getElements(repoPath)
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('code-map:get-relationships', async (_event, repoPath: unknown) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e deve ser uma string não vazia' }
      }
      const result = codeMapService.getRelationships(repoPath)
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('code-map:get-sync-status', async (_event, repoPath: unknown) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e deve ser uma string não vazia' }
      }
      const result = codeMapService.getSyncStatus(repoPath)
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('code-map:get-modified-files-count', async (_event, repoPath: unknown) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e deve ser uma string não vazia' }
      }
      const result = codeMapService.getModifiedFilesCount(repoPath)
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('code-map:get-element-snippet', async (_event, repoPath: unknown, elementId: unknown) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e deve ser uma string não vazia' }
      }
      if (!isValidId(elementId)) {
        return { success: false, error: 'elementId é obrigatório e deve ser uma string não vazia sem espaços' }
      }
      const snippet = await codeMapService.getElementCodeSnippet(repoPath, elementId)
      return { success: true, data: snippet }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Retorna null quando: arquivo não existe, é binário, excede 2MB, ou path traversal inválido
  ipcMain.handle('code-map:get-file-content', async (_event, repoPath: unknown, relativePath: unknown) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e deve ser uma string não vazia' }
      }
      if (!isValidRelativePath(relativePath)) {
        return { success: false, error: 'relativePath é obrigatório e não pode conter ".." nem ser absoluto' }
      }
      const content = await codeMapService.getFileContent(repoPath, relativePath)
      return { success: true, data: content }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('code-map:open-in-vscode', async (_event, repoPath: unknown, elementId: unknown) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e deve ser uma string não vazia' }
      }
      if (!isValidId(elementId)) {
        return { success: false, error: 'elementId é obrigatório e deve ser uma string não vazia sem espaços' }
      }

      // Obtém o snippet apenas para recuperar as coordenadas e o relativePath
      const snippet = await codeMapService.getElementCodeSnippet(repoPath, elementId)
      if (!snippet) {
        return { success: false, error: 'Elemento não encontrado' }
      }

      // WARNING: o VS Code --goto espera coluna 1-indexed; element.location.start.column é 0-indexed.
      // Somar 1 para alinhar com o formato esperado pelo VS Code.
      const column = snippet.startColumn + 1
      const absolutePath = join(repoPath, snippet.relativePath).replace(/\\/g, '/')
      // BUGFIX: caminhos com espaços ou caracteres acentuados (comum em Windows, ex: "João Silva")
      // precisam de URI encoding para o protocolo vscode://file/ não falhar silenciosamente.
      // encodeURI preserva / e : (necessários) mas codifica espaços como %20 e acentos.
      const encodedPath = encodeURI(absolutePath)

      // Tenta abrir via protocolo vscode://file/ (funciona em Windows, Mac e Linux sem depender do PATH)
      const vscodeUrl = `vscode://file/${encodedPath}:${snippet.startLine}:${column}`
      try {
        await shell.openExternal(vscodeUrl)
        return { success: true, usedFallback: false }
      } catch {
        shell.showItemInFolder(join(repoPath, snippet.relativePath))
        return { success: true, usedFallback: true }
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
