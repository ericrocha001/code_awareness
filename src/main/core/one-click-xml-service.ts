/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Orquestrar a geração do One-Click XML utilizando Repomix Direct Output nativo.
2. Delegar a resolução da lista de arquivos permitidos à IgnorePolicy.
3. Construir o contrato tipado RepomixRequest para o formato XML com as opções de limpeza solicitadas.
4. Chamar a porta RepomixDirectOutputPort e retornar o documento nativo sem parsing, sem envelope e sem reassembly.
5. Capturar e estruturar métricas de tempo (timings) e metadados de execução.

Mapa de Relacionamentos do Script

1. ignore-policy.ts
   - Tipo: Dependência Direta
   - Relação: Resolve a allowlist final de arquivos a serem incluídos no documento.
   - Criticidade: Alta

2. repomix-request.ts
   - Tipo: Contrato / Interface
   - Relação: Constrói e repassa o RepomixRequest para a porta de Direct Output.
   - Criticidade: Alta

3. repomix-arguments-builder.ts
   - Tipo: Dependência Direta
   - Relação: Utiliza buildRepomixRequest para compor o contrato tipado.
   - Criticidade: Alta

4. effective-profile.ts
   - Tipo: Dependência Direta
   - Relação: Resolve o EffectiveProfile canônico para saída no formato XML.
   - Criticidade: Alta

5. compression-profile.ts
   - Tipo: Dependência Direta
   - Relação: Utiliza DEFAULT_PROFILE como base para opções de perfil.
   - Criticidade: Média

Invariantes do Script

1. Em caso de sucesso, o XML retornado é rigorosamente idêntico ao stdout recebido da porta de Direct Output (fidelidade pura, zero envelope/transformação).
2. O serviço não faz cache por arquivo, não utiliza DashService nem pipeline de blocos.
3. Se a allowlist estiver vazia, o serviço encerra com erro estruturado sem invocar a porta de Direct Output.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import type { CompressionProfile } from '../../shared/types'
import { DEFAULT_PROFILE } from './compression-profile'
import { resolveEffectiveProfile } from './effective-profile'
import { IgnorePolicy } from './ignore-policy'
import { buildRepomixRequest } from './repomix-arguments-builder'
import type { RepomixRequest } from './repomix-request'

export interface RepomixDirectOutputPort {
  generateDirectOutput(
    request: RepomixRequest
  ): Promise<{ content: string; failed: boolean; reason?: string }>
}

export interface OneClickXmlOptions {
  removeComments?: boolean
  removeEmptyLines?: boolean
  truncateBase64?: boolean
}

export interface OneClickXmlResult {
  success: boolean
  xml?: string
  error?: string
  timings?: {
    listFilesMs: number
    generateMs: number
    totalMs: number
  }
  metadata?: {
    fileCount: number
  }
}

export class OneClickXmlService {
  constructor(
    private readonly ignorePolicy: IgnorePolicy,
    private readonly directOutputPort: RepomixDirectOutputPort
  ) {}

  /**
   * Gera o One-Click XML do repositório delegando ao Direct Output nativo do Repomix.
   */
  public async generateOneClickXml(
    repoPath: string,
    options?: OneClickXmlOptions
  ): Promise<OneClickXmlResult> {
    const totalStart = performance.now()

    // 1. Obter allowlist via IgnorePolicy
    const listStart = performance.now()
    let allowlist: string[]
    try {
      allowlist = await this.ignorePolicy.resolveAllowlist(repoPath)
    } catch (err) {
      const listFilesMs = Math.round(performance.now() - listStart)
      const totalMs = Math.round(performance.now() - totalStart)
      return {
        success: false,
        error:
          err instanceof Error
            ? `Falha ao listar arquivos do repositório: ${err.message}`
            : 'Falha ao listar arquivos do repositório.',
        timings: { listFilesMs, generateMs: 0, totalMs },
        metadata: { fileCount: 0 }
      }
    }
    const listFilesMs = Math.round(performance.now() - listStart)

    if (allowlist.length === 0) {
      const totalMs = Math.round(performance.now() - totalStart)
      return {
        success: false,
        error: 'Nenhum arquivo elegível encontrado no repositório.',
        timings: { listFilesMs, generateMs: 0, totalMs },
        metadata: { fileCount: 0 }
      }
    }

    // 2. Construir perfil efetivo e request Repomix para formato XML
    const rawProfile: CompressionProfile = {
      ...DEFAULT_PROFILE,
      removeComments: options?.removeComments ?? false,
      removeEmptyLines: options?.removeEmptyLines ?? false,
      truncateBase64: options?.truncateBase64 ?? false
    }

    const effectiveProfile = resolveEffectiveProfile(rawProfile, 'xml')
    const request = buildRepomixRequest(repoPath, allowlist, effectiveProfile, 'xml')

    // 3. Executar Repomix Direct Output
    const generateStart = performance.now()
    let directOutputResult: { content: string; failed: boolean; reason?: string }
    try {
      directOutputResult = await this.directOutputPort.generateDirectOutput(request)
    } catch (err) {
      const generateMs = Math.round(performance.now() - generateStart)
      const totalMs = Math.round(performance.now() - totalStart)
      return {
        success: false,
        error:
          err instanceof Error
            ? `Falha na execução do Repomix: ${err.message}`
            : 'Falha inesperada na execução do Repomix.',
        timings: { listFilesMs, generateMs, totalMs },
        metadata: { fileCount: allowlist.length }
      }
    }
    const generateMs = Math.round(performance.now() - generateStart)
    const totalMs = Math.round(performance.now() - totalStart)

    // 4. Tratar resultado
    if (directOutputResult.failed) {
      return {
        success: false,
        error:
          directOutputResult.reason ||
          'Falha na geração do Direct Output XML pelo Repomix.',
        timings: { listFilesMs, generateMs, totalMs },
        metadata: { fileCount: allowlist.length }
      }
    }

    return {
      success: true,
      xml: directOutputResult.content,
      timings: { listFilesMs, generateMs, totalMs },
      metadata: { fileCount: allowlist.length }
    }
  }
}
