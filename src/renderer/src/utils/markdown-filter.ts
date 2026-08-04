/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Função pura utilitária para filtrar seções de arquivo em markdown baseando-se nos caminhos selecionados.

Mapa de Relacionamentos do Script

1. ../components/CodeJourneyView/hooks/useJourneyPreview.ts
   - Tipo: Dependência Inversa
   - Relação: Importa filterMarkdownBySelection para filtrar markdown do diff.
   - Criticidade: Alta

Invariantes do Script

1. A função é pura e determinística.
2. Se o markdown não contiver seções divididas por cabeçalho de arquivo, retorna o markdown original intacto.

--- FIM ARQUITETURA DO SCRIPT ---
*/

/**
 * Filtra as seções de arquivo do markdown mantendo apenas os arquivos selecionados em selectedFilePaths.
 */
export function filterMarkdownBySelection(markdown: string, selectedFilePaths: Set<string>): string {
  const sections = markdown.split(/\n(?=## 📄)/)
  if (sections.length <= 1) return markdown
  const [header, ...fileSections] = sections
  const filtered = fileSections.filter(section => {
    const match = section.match(/## 📄 `(.+?)`/)
    if (!match) return true
    return selectedFilePaths.has(match[1])
  })
  return [header, ...filtered].join('\n')
}
