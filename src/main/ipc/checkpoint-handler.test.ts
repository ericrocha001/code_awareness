/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar o contrato IPC do CheckpointHandler isoladamente sem instanciar o Electron.
2. Provar o registro de todos os 9 canais IPC de checkpoint no ipcMain.
3. Provar validações de parâmetros de entrada (repoPath, name, checkpointId, campaignIds, details, newName).
4. Provar rejeição de tentativas de path traversal nos IDs de checkpoint em canais IPC.
5. Provar a captura de exceções do CheckpointService e sua tradução em respostas estruturadas { success: false, error }.
6. Provar o retorno de respostas bem-sucedidas estruturadas { success: true, data }.

Mapa de Relacionamentos do Script

1. checkpoint-handler.ts
   - Tipo: Dependência Direta
   - Relação: Módulo sob teste — valida a função registerCheckpointHandlers.
   - Criticidade: Alta

2. electron
   - Tipo: Contrato / Interface
   - Relação: Mockado via vi.mock para capturar os handlers do ipcMain.handle.
   - Criticidade: Alta

3. ../core/checkpoint-service
   - Tipo: Contrato / Interface
   - Relação: Objeto mockado injetado no handler para controlar sucessos e falhas do serviço sem tocar no filesystem/Git.
   - Criticidade: Alta

4. ../core/fake-ports
   - Tipo: Dependência Direta
   - Relação: Fornece FakeActionLogPort injetado no handler para evitar escrita real no SQLite.
   - Criticidade: Média

Invariantes do Script

1. Handlers IPC nunca lançam exceções não tratadas para o caller — todas as falhas retornam { success: false, error }.
2. O mapa de handlers capturados é limpo no beforeEach de cada teste.
3. Nenhuma operação executa comandos Git, filesystem real ou SQLite durante os testes do handler.
4. Nenhuma dependência direta de better-sqlite3 ou database-service.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { CheckpointData } from '../../shared/types'
import { CheckpointService } from '../core/checkpoint-service'
import { FakeActionLogPort } from '../core/fake-ports'

// Mapa de handlers capturados: channel → handler function
const registeredHandlers = new Map<string, Function>()

// Mocks das funções do CheckpointService
const mockServiceMethods = {
  createCheckpoint: vi.fn(),
  listCheckpoints: vi.fn(),
  loadCheckpoint: vi.fn(),
  deleteCheckpoint: vi.fn(),
  generateDiffBetween: vi.fn(),
  getChangedFiles: vi.fn(),
  updateCheckpointMetadata: vi.fn(),
  setCheckpointCampaigns: vi.fn(),
  renameCheckpoint: vi.fn()
}

// Mock do ipcMain do Electron para capturar os canais registrados
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      registeredHandlers.set(channel, handler)
    })
  }
}))

// Importa a função de registro do handler
import { registerCheckpointHandlers } from './checkpoint-handler'

// Helper para invocar handler capturado por canal
async function invokeHandler(channel: string, ...args: unknown[]): Promise<any> {
  const handler = registeredHandlers.get(channel)
  if (!handler) throw new Error(`Handler não registrado: ${channel}`)
  const mockEvent = {} as IpcMainInvokeEvent
  return handler(mockEvent, ...args)
}

describe('CheckpointHandler — Contrato IPC (PA-19)', () => {
  let fakeActionLog: FakeActionLogPort

  beforeEach(() => {
    registeredHandlers.clear()
    vi.clearAllMocks()
    fakeActionLog = new FakeActionLogPort()
    registerCheckpointHandlers(mockServiceMethods as unknown as CheckpointService, fakeActionLog)
  })

  it('Cenário A — registra todos os 9 handlers IPC de checkpoint', () => {
    const expectedChannels = [
      'checkpoint:create',
      'checkpoint:list',
      'checkpoint:load',
      'checkpoint:delete',
      'checkpoint:generate-diff',
      'checkpoint:get-changed-files',
      'checkpoint:update-details',
      'checkpoint:set-campaigns',
      'checkpoint:rename'
    ]

    for (const channel of expectedChannels) {
      expect(registeredHandlers.has(channel)).toBe(true)
    }
  })

  it('Cenário B — validação de repoPath vazio', async () => {
    const result = await invokeHandler('checkpoint:create', '', 'Nome Válido')
    expect(result).toEqual({
      success: false,
      error: expect.stringMatching(/repoPath é obrigatório/)
    })
  })

  it('Cenário C — validação de name vazio no create', async () => {
    const result = await invokeHandler('checkpoint:create', '/valid/repo/path', '')
    expect(result).toEqual({
      success: false,
      error: expect.stringMatching(/name é obrigatório/)
    })
  })

  it('Cenário D — validação de checkpointId inválido (path traversal)', async () => {
    const result = await invokeHandler('checkpoint:load', '/valid/repo/path', '../../../etc/passwd')
    expect(result).toEqual({
      success: false,
      error: expect.stringMatching(/caracteres inválidos/)
    })
  })

  it('Cenário E — validação de campaignIds não-array', async () => {
    const result = await invokeHandler('checkpoint:set-campaigns', '/valid/repo/path', 'cp_valid_id', 'not-an-array')
    expect(result).toEqual({
      success: false,
      error: expect.stringMatching(/deve ser um array/)
    })
  })

  it('Cenário F — validação de campaignIds com string vazia', async () => {
    const result = await invokeHandler('checkpoint:set-campaigns', '/valid/repo/path', 'cp_valid_id', [''])
    expect(result).toEqual({
      success: false,
      error: expect.stringMatching(/strings não vazias/)
    })
  })

  it('Cenário G — validação de details com tipo inválido', async () => {
    const result = await invokeHandler('checkpoint:create', '/valid/repo/path', 'Nome Válido', 'string-em-vez-de-objeto')
    expect(result).toEqual({
      success: false,
      error: expect.stringMatching(/details deve ser um objeto/)
    })
  })

  it('Cenário H — erro do serviço é capturado e traduzido', async () => {
    mockServiceMethods.createCheckpoint.mockRejectedValueOnce(
      new Error('Já existe um checkpoint com o nome "X"')
    )

    const result = await invokeHandler('checkpoint:create', '/valid/repo/path', 'X')

    expect(result).toEqual({
      success: false,
      error: 'Já existe um checkpoint com o nome "X"'
    })
  })

  it('Cenário I — sucesso retorna resposta estruturada com os dados do checkpoint', async () => {
    const mockCheckpoint: CheckpointData = {
      id: 'cp_123_abc',
      name: 'Novo Checkpoint',
      createdAt: new Date().toISOString(),
      files: {
        'src/index.ts': {
          content: 'console.log("hello")\n',
          hash: 'sha256hash',
          size: 21
        }
      }
    }

    mockServiceMethods.createCheckpoint.mockResolvedValueOnce(mockCheckpoint)

    const result = await invokeHandler('checkpoint:create', '/valid/repo/path', 'Novo Checkpoint')

    expect(result).toEqual({
      success: true,
      data: mockCheckpoint
    })
  })

  it('Cenário J — toCheckpointId obrigatório e validado no generate-diff', async () => {
    const result = await invokeHandler('checkpoint:generate-diff', '/valid/repo/path', 'cp_from_id', '')
    expect(result).toEqual({
      success: false,
      error: expect.stringMatching(/toCheckpointId contém caracteres inválidos/)
    })
  })

  it('Cenário K — validação de newName vazio no rename', async () => {
    const result = await invokeHandler('checkpoint:rename', '/valid/repo/path', 'cp_valid_id', '')
    expect(result).toEqual({
      success: false,
      error: expect.stringMatching(/O novo nome não pode estar vazio/)
    })
  })
})
