/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Gerar o Markdown completo de um repositório via Repomix CLI (generateFullRepositoryMarkdown).
2. Gerar Markdown/XML seletivo dos arquivos escolhidos com contagem heurística de tokens (generateSelectiveMarkdown).

Mapa de Relacionamentos do Script

1. base-repomix-adapter.ts
   - Tipo: Dependência Direta
   - Relação: Estende BaseRepomixAdapter para herdar getCommand, runProcess e checkInstallation.
   - Criticidade: Alta

2. code-source-service.ts
   - Tipo: Dependência Inversa
   - Relação: Consome generateFullRepositoryMarkdown e generateSelectiveMarkdown.
   - Criticidade: Alta

3. git-handler.ts
   - Tipo: Dependência Inversa
   - Relação: Instancia e usa checkInstallation para o Code Source.
   - Criticidade: Média

Invariantes do Script

1. generateSelectiveMarkdown nunca lança para selectedFiles vazio — lança Error explícito.
2. A contagem de tokens é heurística (~4 caracteres por token) calculada sobre o conteúdo gerado.
3. checkInstallation usa timeout de 10s e nunca lança (herdado da base).
4. Falha do Repomix (exitCode != 0) lança Error com stderr ou código.
5. Não contém lógica de compressão (cache, batch, fallback, parsing) — limita-se ao output de documentos.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { BaseRepomixAdapter } from './base-repomix-adapter'

export class RepomixOutputAdapter extends BaseRepomixAdapter {
  /**
   * Gera o markdown completo de um repositório via Repomix.
   */
  async generateFullRepositoryMarkdown(repoPath: string): Promise<string> {
    const args = [
      '--style', 'markdown',
      '--stdout'
      // Omitido --no-file-summary para manter o resumo padrão
    ]
    const res = await this.runProcess(this.getCommand(), args, { cwd: repoPath, timeoutMs: 120000 })
    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || `Repomix falhou (código ${res.exitCode}).`)
    }
    return res.stdout
  }

  /**
   * Gera Markdown apenas dos arquivos selecionados e retorna também a contagem de tokens.
   * A contagem é calculada diretamente sobre o conteúdo gerado, refletindo o tamanho real
   * do texto que será enviado para a IA.
   */
  async generateSelectiveMarkdown(
    repoPath: string,
    selectedFiles: string[],
    format: 'markdown' | 'xml' = 'markdown'
  ): Promise<{ content: string; tokenCount: number }> {
    if (selectedFiles.length === 0) {
      throw new Error('Nenhum arquivo selecionado para geração seletiva.')
    }

    const includePattern = selectedFiles.join(',')

    // Execução única: gera o conteúdo Markdown/XML dos arquivos selecionados
    const res = await this.runProcess(this.getCommand(), [
      '--include', includePattern,
      '--style', format,
      '--stdout',
      '--no-file-summary'
    ], { cwd: repoPath, timeoutMs: 120000 })

    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || `Repomix falhou (código ${res.exitCode}).`)
    }

    // Contagem de tokens diretamente sobre o conteúdo gerado.
    // Estimativa conservadora: ~4 caracteres por token (média para texto em inglês/código).
    // Sem dependência externa de tokenização, esta é a aproximação mais simples e confiável.
    const tokenCount = Math.ceil(res.stdout.length / 4)

    return { content: res.stdout, tokenCount }
  }
}
