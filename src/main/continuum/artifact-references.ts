export const REFERENCE_INDEX_VERSION = 1

export function extractArtifactReferences(markdown: string): string[] {
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)
  let frontmatter = lines[0] === '---'
  let fence: { marker: string; length: number } | undefined
  const references = new Set<string>()
  for (let index = frontmatter ? 1 : 0; index < lines.length; index++) {
    const line = lines[index].replace(/^(?: {0,3}> ?)+/, '').replace(/^ {0,3}(?:[-+*]|\d+[.)]) +(?=[`~]{3})/, '')
    if (frontmatter) { if (/^(---|\.\.\.)\s*$/.test(line)) frontmatter = false; continue }
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (delimiter && delimiter[1][0] === fence.marker && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined
      continue
    }
    if (delimiter) { fence = { marker: delimiter[1][0], length: delimiter[1].length }; continue }
    if (/^(?: {4}|\t)/.test(line)) continue
    for (const match of line.matchAll(/(?<![\p{L}\p{N}_-])artifact-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\p{L}\p{N}_-])/gu)) references.add(match[0])
  }
  return [...references].sort()
}
