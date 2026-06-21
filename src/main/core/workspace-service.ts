// Responsabilidades do Script
//
// 1. Escanear pastas raiz em busca de subdiretórios que representem projetos válidos.
// 2. Verificar a existência de repositórios Git nas subpastas e projetos isolados.
// 3. Consolidar e retornar a listagem final de projetos disponíveis.

import fs from 'fs'
import path from 'path'
import { AppSettings, ProjectInfo } from '../../shared/types'

export class WorkspaceService {
  /**
   * Verifica fisicamente se a pasta existe e se possui um `.git` dentro dela.
   */
  private async checkProjectGitInfo(folderPath: string): Promise<ProjectInfo | null> {
    try {
      const stats = await fs.promises.stat(folderPath)
      if (!stats.isDirectory()) return null

      const name = path.basename(folderPath)
      const gitPath = path.join(folderPath, '.git')
      
      let isGit = false
      try {
        const gitStats = await fs.promises.stat(gitPath)
        isGit = gitStats.isDirectory() || gitStats.isFile() // .git can be a file in submodules/worktrees
      } catch {
        isGit = false
      }

      return { path: folderPath, name, isGit }
    } catch {
      // Pasta não existe mais ou sem permissão
      return null
    }
  }

  /**
   * Lê o primeiro nível de uma pasta raiz e retorna todos os subdiretórios válidos.
   */
  private async scanRootFolder(rootPath: string): Promise<ProjectInfo[]> {
    const projects: ProjectInfo[] = []
    try {
      const entries = await fs.promises.readdir(rootPath, { withFileTypes: true })

      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        const name = entry.name
        // Ignorar pastas ocultas, build e config comum
        if (name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === 'build') {
          continue
        }

        const fullPath = path.join(rootPath, name)
        const projectInfo = await this.checkProjectGitInfo(fullPath)
        
        if (projectInfo) {
          projects.push(projectInfo)
        }
      }
    } catch (err) {
      console.error(`Erro ao ler root folder ${rootPath}:`, err)
    }

    return projects
  }

  /**
   * Método consolidado que processa rootFolders e individualProjects das configurações
   * para retornar uma lista única de projetos.
   */
  async getProjectsList(settings: AppSettings): Promise<ProjectInfo[]> {
    const allProjects: Map<string, ProjectInfo> = new Map()

    // 1. Processar pastas individuais (ganham precedência)
    for (const projPath of settings.individualProjects || []) {
      const info = await this.checkProjectGitInfo(projPath)
      if (info) {
        // Normaliza chave para evitar duplicatas em Windows vs Unix
        allProjects.set(path.resolve(projPath), info)
      }
    }

    // 2. Escanear pastas raízes
    for (const rootPath of settings.rootFolders || []) {
      const scanned = await this.scanRootFolder(rootPath)
      for (const info of scanned) {
        const key = path.resolve(info.path)
        if (!allProjects.has(key)) {
          allProjects.set(key, info)
        }
      }
    }

    const hiddenSet = new Set(settings.hiddenProjects || [])
    const visibleProjects = Array.from(allProjects.values()).filter(p => !hiddenSet.has(p.path))

    // Ordenar alfabeticamente pelo nome do projeto
    return visibleProjects.sort((a, b) => a.name.localeCompare(b.name))
  }
}
