/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Orquestrar a geração seletiva do Code Source (generateSelectiveSource): decidir transporte, preparar config temporário quando necessário, construir argumentos via builder, executar e limpar.

Mapa de Relacionamentos do Script

1. base-repomix-adapter.ts
   - Tipo: Dependência Direta
   - Relação: Estende BaseRepomixAdapter para herdar getCommand, runProcess e checkInstallation.
   - Criticidade: Alta

2. code-source-arguments-builder.ts
   - Tipo: Dependência Direta
   - Relação: Consome buildSourceCliArguments para derivar argumentos CLI do Code Source.
   - Criticidade: Alta

3. source-include-transport-resolver.ts
   - Tipo: Dependência Direta
   - Relação: Delega decisão de transporte, criação e remoção do config temporário.
   - Criticidade: Alta

4. shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Consome SourceOutputFormat e SourceProfile como contratos do método de geração.
   - Criticidade: Alta

5. code-source-service.ts
   - Tipo: Dependência Inversa
   - Relação: Consome generateSelectiveSource para geração seletiva do Code Source.
   - Criticidade: Alta

6. git-handler.ts
   - Tipo: Dependência Inversa
   - Relação: Instancia e usa checkInstallation para o Code Source.
   - Criticidade: Média

Invariantes do Script

1. checkInstallation usa timeout de 10s e nunca lança (herdado da base).
2. Falha do Repomix (exitCode != 0) lança Error com stderr ou código.
3. Não contém lógica de compressão (cache, batch, fallback, parsing) — limita-se ao output de documentos.
4. generateSelectiveSource JAMAIS emite compressão estrutural — o builder do Code Source é a única fonte de argumentos.
5. O arquivo de configuração temporário é criado e removido pelo resolver; a remoção ocorre no finally mesmo sob erro ou cancelamento.
6. O adapter não importa nenhum módulo do Code Compression.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { BaseRepomixAdapter } from './base-repomix-adapter'
import { buildSourceCliArguments } from './code-source-arguments-builder'
import {
  SourceIncludeTransportResolver,
  SOURCE_MAX_COMMAND_LINE_BUDGET
} from './source-include-transport-resolver'
import type { SourceOutputFormat, SourceProfile } from '../../shared/types'

export class RepomixOutputAdapter extends BaseRepomixAdapter {
  private readonly transportResolver: SourceIncludeTransportResolver

  constructor(
    runner?: ConstructorParameters<typeof BaseRepomixAdapter>[0],
    transportResolver: SourceIncludeTransportResolver = new SourceIncludeTransportResolver()
  ) {
    super(runner)
    this.transportResolver = transportResolver
  }

  /**
   * Geração seletiva do Code Source: decide o transporte via resolver,
   * prepara config temporário quando necessário, constrói argumentos via builder
   * e executa o Repomix, retornando apenas o conteúdo gerado.
   *
   * NUNCA emite compressão estrutural e NUNCA escreve artefato no repositório.
   */
  async generateSelectiveSource(
    repoPath: string,
    selectedFiles: string[],
    format: SourceOutputFormat,
    profile: SourceProfile,
    signal?: AbortSignal
  ): Promise<string> {
    // Validação defensiva antes do builder — o erro aqui é do chamador.
    if (!repoPath || typeof repoPath !== 'string') {
      throw new Error('[RepomixOutputAdapter] repoPath é obrigatório e deve ser uma string não vazia.')
    }
    if (!Array.isArray(selectedFiles) || selectedFiles.length === 0) {
      throw new Error('[RepomixOutputAdapter] Nenhum arquivo selecionado para geração seletiva do Code Source.')
    }

    const command = this.getCommand()
    const transport = this.transportResolver.decide(selectedFiles)

    let configFilePath: string | undefined
    try {
      let args: string[]
      if (transport === 'config-file') {
        configFilePath = this.transportResolver.createTempConfigFile(selectedFiles)
        const estimatedInlineBytes = this.transportResolver.estimateInlineBytes(selectedFiles)
        console.log(
          `[RepomixOutputAdapter] code-source: transporte via --config (${selectedFiles.length} arquivos, estimativa ${estimatedInlineBytes} bytes > orçamento ${SOURCE_MAX_COMMAND_LINE_BUDGET})`
        )
        args = buildSourceCliArguments(profile, format, selectedFiles, 'config-file', configFilePath)
      } else {
        args = buildSourceCliArguments(profile, format, selectedFiles, 'inline-include')
      }

      const res = await this.runProcess(command, args, { cwd: repoPath, timeoutMs: 120000, signal })
      if (res.exitCode !== 0) {
        throw new Error(res.stderr.trim() || `Repomix falhou (código ${res.exitCode}).`)
      }
      return res.stdout
    } finally {
      // Remoção garantida do config temporário — sempre, mesmo sob erro ou cancelamento.
      if (configFilePath) {
        this.transportResolver.removeTempConfigFile(configFilePath)
      }
    }
  }
}
