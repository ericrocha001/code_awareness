/*
-T ---
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
