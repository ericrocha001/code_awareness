/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Definir a fonte única de verdade para a extensão de arquivo de exportação derivada do formato de transporte.
2. Mapear os quatro formatos suportados (plain, markdown, xml, json) para sua extensão correspondente.

Mapa de Relacionamentos do Script

1. file-handler.ts
   - Tipo: Dependência Direta
   - Relação: Consome outputFormatToExtension para derivar a extensão do arquivo exportado via save-to-downloads.
   - Criticidade: Alta

2. OutputModal.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome outputFormatToExtension para exibir a extensão derivada do formato selecionado.
   - Criticidade: Alta

3. CodeMapDetailPanel.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome outputFormatToExtension para exibir o nome completo do escopo exportado.
   - Criticidade: Média

4. shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Consome o tipo OutputFormat como entrada do mapeamento.
   - Criticidade: Alta

Invariantes do Script

1. A função é pura — recebe OutputFormat e retorna a extensão com ponto, sem side effects.
2. O mapeamento é exaustivo sobre os formatos válidos: plain → .txt, markdown → .md, xml → .xml, json → .json.
3. Nenhum outro módulo deve duplicar este mapeamento — esta é a fonte única de verdade para a extensão de exportação.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import type { OutputFormat } from '../types'

/** Mapeia o formato de transporte para a extensão de arquivo (com ponto). */
export function outputFormatToExtension(format: OutputFormat): string {
  switch (format) {
    case 'plain':
      return '.txt'
    case 'markdown':
      return '.md'
    case 'xml':
      return '.xml'
    case 'json':
      return '.json'
  }
}