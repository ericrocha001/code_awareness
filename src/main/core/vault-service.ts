// Responsabilidades do Script
//
// 1. Salvar o Markdown gerado no vault do Obsidian, tratando colisões de nome de arquivo.

import { writeFileSync, existsSync } from 'fs'
import { join, extname, basename } from 'path'

export class VaultService {
  async saveToVault(
    markdown: string,
    repoName: string,
    vaultPath: string
  ): Promise<void> {
    const filename = this.resolveFilename(vaultPath, repoName)
    try {
      writeFileSync(filename, markdown, 'utf-8')
    } catch (error: any) {
      throw new Error(
        `Falha ao salvar o arquivo no vault do Obsidian. Verifique as permissões de escrita do diretório ou se há espaço em disco. Detalhes: ${error.message}`
      )
    }
  }

  private resolveFilename(vaultPath: string, repoName: string): string {
    const base = repoName
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .trim() || 'diff-export'
      
    const candidate = join(vaultPath, `${base}.md`)
    if (!existsSync(candidate)) return candidate

    let counter = 1
    while (true) {
      const name = join(vaultPath, `${base} (${counter}).md`)
      if (!existsSync(name)) return name
      counter++
    }
  }
}
