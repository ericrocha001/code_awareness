/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Converter markdown estruturado em documento DOCX com formatação adequada para o NotebookLM.
2. Aplicar estilos de heading (Heading1, Heading2) para criar hierarquia navegável.
3. Renderizar blocos de código com fonte monoespaçada e indentação preservada.
4. Integrar com DocumentChunker para processar documentos grandes em múltiplos arquivos.

Mapa de Relacionamentos do Script

1. document-chunker.ts
   - Tipo: Dependência Direta
   - Relação: Consome chunks de markdown para conversão.
   - Criticidade: Alta

2. src/main/ipc/file-handler.ts
   - Tipo: Dependência Inversa
   - Relação: Será consumido pelo handler IPC de exportação.
   - Criticidade: Alta

Invariantes do Script

1. O documento DOCX gerado deve ter estrutura de headings navegável pelo NotebookLM.
2. Blocos de código devem usar fonte monoespaçada (Courier New).
3. Indentação do código deve ser preservada exatamente como no markdown original.
4. O método exportToDocx deve retornar array de caminhos dos arquivos gerados.
5. Em caso de erro durante a escrita, arquivos já gravados devem ser removidos (cleanup).

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx'
import { writeFile, unlink } from 'fs/promises'
import { join } from 'path'
import { app } from 'electron'
import { DocumentChunker } from './document-chunker'

export class DocxExporter {
  private readonly documentChunker = new DocumentChunker()

  // Constantes de formatação agrupadas para facilitar ajustes futuros
  private readonly FONT_SIZES = {
    h1: 34,
    h2: 30,
    h3: 26,
    body: 22,
    code: 20
  }

  private readonly SPACING = {
    h1Before: 320,
    h2Before: 280,
    h3Before: 240,
    h1After: 120,
    h2After: 120,
    h3After: 120,
    bodyBefore: 60,
    bodyAfter: 60,
    codeLine: 276,
    listBefore: 40,
    listAfter: 40
  }

  /**
   * Converte markdown para DOCX e salva na pasta Downloads.
   * Se o markdown exceder o limite de chunking, gera múltiplos arquivos.
   *
   * @param markdown Markdown estruturado do Repomix.
   * @param baseFileName Nome base para o arquivo (sem extensão).
   * @returns Array com caminhos absolutos dos arquivos .docx gerados.
   */
  async exportToDocx(markdown: string, baseFileName: string): Promise<string[]> {
    if (typeof markdown !== 'string') {
      throw new TypeError('markdown must be a string')
    }
    if (!markdown || markdown.length === 0) {
      throw new Error('No content to export')
    }
    if (!baseFileName || baseFileName.length === 0) {
      throw new Error('File name cannot be empty')
    }

    const sanitized = baseFileName.replace(/[<>:"/\\|?*]/g, '_')
    const chunks = this.documentChunker.chunkMarkdown(markdown)
    const downloadsPath = app.getPath('downloads')
    const filePaths: string[] = []
    const writtenFiles: string[] = []

    try {
      for (let i = 0; i < chunks.length; i++) {
        const doc = this.convertMarkdownToDocx(chunks[i])
        const buffer = await Packer.toBuffer(doc)
        const suffix = chunks.length === 1 ? '' : `-part-${i + 1}`
        const filePath = join(downloadsPath, `${sanitized}${suffix}.docx`)
        await writeFile(filePath, buffer)
        writtenFiles.push(filePath)
        filePaths.push(filePath)
      }
    } catch (err) {
      // Cleanup: remove arquivos já escritos antes de propagar o erro
      for (const file of writtenFiles) {
        await unlink(file).catch(() => { /* ignora falha no cleanup */ })
      }
      throw err
    }

    return filePaths
  }

  /**
   * Converte um chunk de markdown em documento DOCX estruturado.
   */
  private convertMarkdownToDocx(markdown: string): Document {
    const lines = markdown.split('\n')
    const paragraphs = this.parseMarkdownLines(lines)

    return new Document({
      sections: [
        {
          properties: {},
          children: paragraphs
        }
      ]
    })
  }

  /**
   * Parseia markdown linha por linha e converte em parágrafos DOCX.
   *
   * SUPORTADO:
   * - Headings (#, ##, ###) → HeadingLevel
   * - Blocos de código (``` ... ```) → Courier New, indentação preservada
   * - Bold (**texto**) → TextRun bold
   * - Italic (*texto*) → TextRun italic
   * - Listas não-ordenadas (- item, * item) → bullet points
   * - Inline code (`code`) → Courier New com fundo cinza
   *
 * NÃO SUPORTADO (renderizado como texto plano):
 * - Tabelas
 * - Links [texto](url)
 * - Blockquotes (> texto)
 * - Horizontal rules (---, ***)
 * - Listas ordenadas (1. item)
 * - Formatação inline aninhada (ex: **bold `code`**)
 *
 * Estas limitações são aceitáveis pois o output do Repomix gera
 * principalmente headings, blocos de código e texto normal.
   */
  private parseMarkdownLines(lines: string[]): Paragraph[] {
    const paragraphs: Paragraph[] = []
    let inCodeBlock = false

    for (const line of lines) {
      if (!inCodeBlock && line.trimStart().startsWith('```')) {
        // Abertura de bloco de código: não renderiza a linha de abertura
        inCodeBlock = true
        continue
      }

      if (inCodeBlock && line.trimStart().startsWith('```')) {
        // Fechamento de bloco de código
        inCodeBlock = false
        continue
      }

      if (inCodeBlock) {
        // Linha dentro de bloco de código
        paragraphs.push(
          new Paragraph({
            spacing: { before: 0, after: 0, line: this.SPACING.codeLine },
            indent: { left: 0 },
            children: [
              new TextRun({
                text: line,
                font: 'Courier New',
                size: this.FONT_SIZES.code,
                bold: false,
                italics: false
              })
            ]
          })
        )
        continue
      }

      // Fora de bloco de código
      const trimmed = line.trim()

      if (trimmed.startsWith('### ')) {
        paragraphs.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_3,
            spacing: { before: this.SPACING.h3Before, after: this.SPACING.h3After },
            children: [new TextRun({ text: trimmed.slice(4), bold: true, size: this.FONT_SIZES.h3 })]
          })
        )
      } else if (trimmed.startsWith('## ')) {
        paragraphs.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            spacing: { before: this.SPACING.h2Before, after: this.SPACING.h2After },
            children: [new TextRun({ text: trimmed.slice(3), bold: true, size: this.FONT_SIZES.h2 })]
          })
        )
      } else if (trimmed.startsWith('# ')) {
        paragraphs.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            spacing: { before: this.SPACING.h1Before, after: this.SPACING.h1After },
            children: [new TextRun({ text: trimmed.slice(2), bold: true, size: this.FONT_SIZES.h1 })]
          })
        )
      } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        // Lista não-ordenada
        paragraphs.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { before: this.SPACING.listBefore, after: this.SPACING.listAfter },
            children: this.createInlineRuns(trimmed.slice(2))
          })
        )
      } else if (trimmed.length === 0) {
        // Linha vazia: parágrafo de espaçamento
        paragraphs.push(new Paragraph({ spacing: { before: 0, after: 0 }, children: [] }))
      } else {
        // Texto normal com suporte a bold, italic e inline code
        paragraphs.push(this.createTextParagraph(trimmed))
      }
    }

    return paragraphs
  }

  /**
   * Cria um Paragraph com suporte a formatação bold, italic e inline code.
   *
   * Suporta:
   * - **texto** → bold
   * - *texto* → italic
   * - `code` → Courier New com fundo cinza (#E8E8E8)
   *
   * @param text Linha de texto para converter.
   * @returns Paragraph formatado.
   */
  private createTextParagraph(text: string): Paragraph {
    return new Paragraph({
      spacing: { before: this.SPACING.bodyBefore, after: this.SPACING.bodyAfter, line: this.SPACING.codeLine },
      children: this.createInlineRuns(text)
    })
  }

  /**
   * Cria um array de TextRun a partir de uma linha de texto, aplicando
   * formatação inline (bold, italic e inline code).
   *
   * @param text Linha de texto.
   * @returns Array de TextRun com formatação aplicada.
   */
  private createInlineRuns(text: string): TextRun[] {
    const children: TextRun[] = []

    // Regex para detectar **bold**, *italic* e `inline code`
    const parts = text.split(/(\*\*.*?\*\*|\*.*?\*|`.*?`)/)

    for (const part of parts) {
      if (part.startsWith('**') && part.endsWith('**')) {
        children.push(new TextRun({ text: part.slice(2, -2), bold: true, size: this.FONT_SIZES.body }))
      } else if (part.startsWith('*') && part.endsWith('*')) {
        children.push(new TextRun({ text: part.slice(1, -1), italics: true, size: this.FONT_SIZES.body }))
      } else if (part.startsWith('`') && part.endsWith('`')) {
        children.push(new TextRun({
          text: part.slice(1, -1),
          font: 'Courier New',
          size: this.FONT_SIZES.code,
          shading: { fill: 'E8E8E8' }
        }))
      } else {
        children.push(new TextRun({ text: part, size: this.FONT_SIZES.body }))
      }
    }

    return children
  }
}