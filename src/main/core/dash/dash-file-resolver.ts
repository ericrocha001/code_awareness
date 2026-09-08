/*
-T ---
*/

import fs from 'fs'
import path from 'path'
import type {
  DashFailureReason,
  DashItem,
  DashRequest,
  DashResolutionFailure,
  DashResolutionReport
} from '../../../shared/types/dash-types'
import { DASH_PROTOCOL_VERSION } from '../../../shared/utils/dash-protocol'

export class DashFileResolver {
  private readonly normalizedRepoPath: string
  private cachedBasenameMap: Map<string, string[]> | null = null

  constructor(private readonly repoPath: string) {
    this.normalizedRepoPath = path.resolve(repoPath)
  }

  /**
   * Resolve uma lista de itens ou um DashRequest completo contra o sistema de arquivos.
   */
  public resolve(
    itemsOrRequest: DashItem[] | DashRequest,
    originalRequest?: DashRequest
  ): DashResolutionReport {
    const isRequestObject =
      typeof itemsOrRequest === 'object' &&
      itemsOrRequest !== null &&
      'items' in itemsOrRequest &&
      Array.isArray((itemsOrRequest as DashRequest).items)

    const items: DashItem[] = isRequestObject
      ? (itemsOrRequest as DashRequest).items
      : (itemsOrRequest as DashItem[])

    const baseRequest: DashRequest = isRequestObject
      ? (itemsOrRequest as DashRequest)
      : (originalRequest ?? {
          protocol: DASH_PROTOCOL_VERSION,
          output: { format: 'xml' },
          items
        })

    const failures: DashResolutionFailure[] = []
    const resolvedItems: DashItem[] = []

    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      const resolvedResult = this.resolveItem(item.path)

      if (resolvedResult.success) {
        resolvedItems.push({
          path: resolvedResult.resolvedPath,
          representation: item.representation
        })
      } else {
        failures.push({
          index,
          path: item.path,
          reason: resolvedResult.reason
        })
      }
    }

    const valid = failures.length === 0

    return {
      valid,
      request:
        resolvedItems.length > 0 || valid
          ? {
              ...baseRequest,
              items: resolvedItems
            }
          : null,
      failures
    }
  }

  private resolveItem(
    rawPath: string
  ):
    | { success: true; resolvedPath: string }
    | { success: false; reason: DashFailureReason } {
    const targetPath = path.resolve(this.normalizedRepoPath, rawPath)
    const relativeFromRepo = path.relative(this.normalizedRepoPath, targetPath)

    // 1. Verificação de path traversal (não pode escapar da raiz do repositório)
    if (
      relativeFromRepo.startsWith('..') ||
      path.isAbsolute(relativeFromRepo)
    ) {
      return { success: false, reason: 'path_traversal' }
    }

    // 2. Verificação de caminho relativo exato
    if (this.isFile(targetPath)) {
      return {
        success: true,
        resolvedPath: relativeFromRepo.replace(/\\/g, '/')
      }
    }

    // 3. Fallback por basename
    const targetBasename = path.basename(rawPath)
    if (!targetBasename || targetBasename === '.' || targetBasename === '..') {
      return { success: false, reason: 'not_found' }
    }

    const matches = this.findBasenameMatches(targetBasename)

    if (matches.length === 1) {
      return {
        success: true,
        resolvedPath: matches[0]
      }
    }

    if (matches.length > 1) {
      return { success: false, reason: 'ambiguous' }
    }

    return { success: false, reason: 'not_found' }
  }

  private isFile(filePath: string): boolean {
    try {
      if (!fs.existsSync(filePath)) {
        return false
      }
      return fs.statSync(filePath).isFile()
    } catch {
      return false
    }
  }

  private findBasenameMatches(targetBasename: string): string[] {
    if (!this.cachedBasenameMap) {
      this.cachedBasenameMap = this.buildBasenameMap()
    }
    return this.cachedBasenameMap.get(targetBasename) || []
  }

  private buildBasenameMap(): Map<string, string[]> {
    const map = new Map<string, string[]>()

    const scanDirectory = (currentDir: string) => {
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.name === '.git' && entry.isDirectory()) {
            continue
          }

          const fullPath = path.join(currentDir, entry.name)

          if (entry.isDirectory()) {
            scanDirectory(fullPath)
          } else if (entry.isFile()) {
            const relPath = path
              .relative(this.normalizedRepoPath, fullPath)
              .replace(/\\/g, '/')

            const list = map.get(entry.name) ?? []
            list.push(relPath)
            map.set(entry.name, list)
          }
        }
      } catch {
        // Ignora erros de leitura de diretórios inacessíveis
      }
    }

    scanDirectory(this.normalizedRepoPath)
    return map
  }
}
