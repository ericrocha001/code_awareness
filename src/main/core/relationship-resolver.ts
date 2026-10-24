/*
-T ---
*/

import { createHash } from 'crypto'
import type {
  CodeMapElement,
  CodeMapFile,
  CodeMapRelationship,
  CodeMapRelationshipType
} from '../../shared/types'
import { ImportResolver } from './import-resolver'

const REL_IMP: CodeMapRelationshipType = 'imports'

export class RelationshipResolver {
  private readonly repositoryId: string
  private readonly repoPath: string
  private readonly importResolver: ImportResolver

  constructor(repositoryId: string, repoPath: string) {
    this.repositoryId = repositoryId
    this.repoPath = repoPath
    this.importResolver = new ImportResolver(repoPath)
  }

  private generateRelationshipId(sourceId: string, targetId: string, type: string): string {
    const input = `${sourceId}:${targetId}:${type}`
    return createHash('sha256').update(input).digest('hex').substring(0, 16)
  }

  private makeRel(
    sourceId: string,
    targetId: string,
    type: CodeMapRelationshipType,
    sourceKind: 'element' | 'file',
    targetKind: 'element' | 'file'
  ): CodeMapRelationship {
    return {
      id: this.generateRelationshipId(sourceId, targetId, type),
      repositoryId: this.repositoryId,
      sourceId,
      targetId,
      type,
      sourceKind,
      targetKind
    }
  }

  getImportResolver(): ImportResolver {
    return this.importResolver
  }

  /**
   * Constrói as arestas do grafo.
   * importSources: { elementId, source (specifier), importerRelativePath (arquivo onde o import aparece) }.
   */
  resolve(
    elements: CodeMapElement[],
    elementInterfaces: Array<{ elementId: string; interfaceNames: string[] }>,
    importSources: Array<{ elementId: string; source: string; importerRelativePath: string }>,
    files: CodeMapFile[]
  ): CodeMapRelationship[] {
    const relationships: CodeMapRelationship[] = []
    const elementsById = new Map(elements.map(element => [element.id, element]))
    const symbolsByKindAndName = new Map<string, CodeMapElement[]>()
    for (const element of elements) {
      const key = element.kind + ':' + element.name
      const entries = symbolsByKindAndName.get(key) ?? []
      entries.push(element)
      symbolsByKindAndName.set(key, entries)
    }

    const filesByPath = new Map<string, CodeMapFile>()
    for (const f of files) {
      filesByPath.set(f.relativePath, f)
    }

    this.importResolver.setFiles(files.map((f) => f.relativePath))

    // Mapa: arquivo importador (relativePath) → [fileIds internos que importa] (desambiguação de herança)
    const importedFilesByImporterPath = new Map<string, string[]>()

    // Mapa: fileId → relativePath
    const fileIdToPath = new Map<string, string>()
    for (const f of files) {
      fileIdToPath.set(f.id, f.relativePath)
    }

    // i) imports (element → file) — só quando internal
    for (const entry of importSources) {
      const resolution = this.importResolver.resolve(entry.source, entry.importerRelativePath)
      if (resolution.status === 'internal') {
        const targetFile = filesByPath.get(resolution.targetRelativePath)
        if (targetFile) {
          relationships.push(this.makeRel(entry.elementId, targetFile.id, REL_IMP, 'element', 'file'))
          let list = importedFilesByImporterPath.get(entry.importerRelativePath)
          if (!list) {
            list = []
            importedFilesByImporterPath.set(entry.importerRelativePath, list)
          }
          list.push(targetFile.id)
        }
      }
    }

    // ii) extends (class baseClass)
    for (const elem of elements) {
      if (elem.kind === 'class' && elem.baseClass) {
        const target = this.resolveSymbol(elem, elem.baseClass, 'class', symbolsByKindAndName, importedFilesByImporterPath, fileIdToPath)
        if (target) {
          relationships.push(this.makeRel(elem.id, target.id, 'extends', 'element', 'element'))
        }
      }
    }

    // iii) implements (via elementInterfaces)
    for (const entry of elementInterfaces) {
      const sourceEl = elementsById.get(entry.elementId)
      if (!sourceEl) continue
      for (const ifaceName of entry.interfaceNames) {
        const target = this.resolveSymbol(sourceEl, ifaceName, 'interface', symbolsByKindAndName, importedFilesByImporterPath, fileIdToPath)
        if (target) {
          relationships.push(this.makeRel(entry.elementId, target.id, 'implements', 'element', 'element'))
        }
      }
    }

    return relationships
  }

  /**
   * Resolve um símbolo (classe base/interface) para um elemento:
   * - se o arquivo importa o símbolo (há um único candidato em um arquivo importado), liga a ele;
   * - senão, se há exatamente um candidato no mesmo arquivo, liga a ele;
   * - senão, se há um único candidato global, liga a ele;
   * - senão, omite (null).
   */
  private resolveSymbol(
    sourceEl: CodeMapElement,
    symbol: string,
    kind: 'class' | 'interface',
    symbolsByKindAndName: Map<string, CodeMapElement[]>,
    importedFilesByImporterPath: Map<string, string[]>,
    fileIdToPath: Map<string, string>
  ): CodeMapElement | null {
    // Candidatos globais por nome+kind (diferentes do próprio)
    const all = (symbolsByKindAndName.get(kind + ':' + symbol) ?? []).filter(element => element.id !== sourceEl.id)
    if (all.length === 0) return null

    // 1) Candidato num arquivo que o source importa → preferido
    const importerPath = fileIdToPath.get(sourceEl.fileId)
    const importedFileIds = importerPath ? new Set(importedFilesByImporterPath.get(importerPath) ?? []) : new Set<string>()
    const fromImported = all.filter((e) => importedFileIds.has(e.fileId))
    if (fromImported.length === 1) return fromImported[0]

    // 2) Candidato único no mesmo arquivo
    const local = all.filter((e) => e.fileId === sourceEl.fileId)
    if (local.length === 1) return local[0]

    // 3) Candidato único global (sem ambiguidade)
    if (all.length === 1) return all[0]

    // Ambiguidade não resolvida → omite (não fabrica aresta)
    return null
  }
}