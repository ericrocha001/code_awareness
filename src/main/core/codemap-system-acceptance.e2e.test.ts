import { renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { CodeMapElement, CodeMapFile, CodeMapRelationship } from '../../shared/types'
import type { CompressionPort } from './compression-port'
import { CodeMapService } from './code-map-service'
import { createCodeMapSystemFixture, eventually } from './codemap-system-fixture'
import { WatcherService } from './watcher-service'

const unusedCompressionPort: CompressionPort = {
  async generateCompressionMarkdown() {
    throw new Error('Compression is outside the CodeMap system acceptance scope.')
  }
}

function findFile(files: CodeMapFile[], relativePath: string): CodeMapFile | undefined {
  return files.find((file) => file.relativePath === relativePath)
}

function findElement(
  elements: CodeMapElement[],
  files: CodeMapFile[],
  relativePath: string,
  name: string
): CodeMapElement | undefined {
  const file = findFile(files, relativePath)
  return file && elements.find((element) => element.fileId === file.id && element.name === name)
}

function hasImport(
  relationships: CodeMapRelationship[],
  elements: CodeMapElement[],
  files: CodeMapFile[],
  sourcePath: string,
  targetPath: string
): boolean {
  const sourceFile = findFile(files, sourcePath)
  const targetFile = findFile(files, targetPath)
  if (!sourceFile || !targetFile) return false
  const sourceElementIds = new Set(
    elements.filter((element) => element.fileId === sourceFile.id).map((element) => element.id)
  )
  return relationships.some((relationship) => (
    relationship.type === 'imports' &&
    relationship.targetId === targetFile.id &&
    (relationship.sourceId === sourceFile.id || sourceElementIds.has(relationship.sourceId))
  ))
}

describe('CodeMap Core — System Acceptance', () => {
  it('mantem o Core vivo durante indexacao, auto-sync, mutacoes, restart e integridade', async () => {
    const fixture = createCodeMapSystemFixture()
    const watcherService = new WatcherService()
    const service = new CodeMapService(watcherService, unusedCompressionPort)
    const repoPath = fixture.repoPath

    try {
      await service.openRepository(repoPath)
      await service.awaitSnapshot(repoPath)
      // Never-indexed repo: no DB record, no files until indexRepository runs.
      expect(service.getRepository(repoPath)).toBeNull()
      expect(service.getFiles(repoPath)).toHaveLength(0)

      const indexed = await service.indexRepository(repoPath)
      expect(indexed.filesIndexed).toBe(11)

      // After indexing, repository record and all files are in the DB.
      expect(service.getRepository(repoPath)).not.toBeNull()

      let files = service.getFiles(repoPath)
      let elements = service.getElements(repoPath)
      let relationships = service.getRelationships(repoPath)

      expect(new Set(files.map((file) => file.language))).toEqual(new Set([
        'typescript',
        'typescript-react',
        'javascript',
        'javascript-react',
        'css'
      ]))
      expect(findElement(elements, files, 'src/core/UserService.ts', 'UserService')).toBeDefined()
      expect(findElement(elements, files, 'src/renderer/App.tsx', 'App')).toBeDefined()
      expect(findElement(elements, files, 'src/renderer/Widget.jsx', 'Widget')).toBeDefined()
      expect(hasImport(relationships, elements, files, 'src/core/UserService.ts', 'src/core/BaseService.ts')).toBe(true)
      expect(hasImport(relationships, elements, files, 'src/renderer/styles.css', 'src/renderer/theme.css')).toBe(true)
      expect(hasImport(relationships, elements, files, 'src/renderer/module.mjs', 'src/renderer/helper.js')).toBe(true)
      expect(hasImport(relationships, elements, files, 'src/renderer/legacy.cjs', 'src/renderer/helper.js')).toBe(true)
      expect(findElement(elements, files, 'src/renderer/legacy.cjs', 'run')?.kind).toBe('export')
      expect(findElement(elements, files, 'src/renderer/legacy.cjs', 'ready')?.kind).toBe('export')

      const initialMethod = findElement(elements, files, 'src/core/UserService.ts', 'getLabel')
      expect(initialMethod).toBeDefined()
      const initialSource = await service.getElementExactSource(repoPath, initialMethod!.id)
      expect(initialSource?.relativePath).toBe('src/core/UserService.ts')
      expect(initialSource?.content).toContain('user-v1')
      expect(initialSource?.content).not.toContain('class UserService')

      fixture.write('src/core/UserService.ts', [
        'import { BaseService } from "./BaseService"',
        'export class UserService extends BaseService {',
        '  getLabel(): string { return "user-v2" }',
        '}',
        ''
      ].join('\n'))

      await eventually(async () => {
        files = service.getFiles(repoPath)
        elements = service.getElements(repoPath)
        const method = findElement(elements, files, 'src/core/UserService.ts', 'getLabel')
        const source = method && await service.getElementExactSource(repoPath, method.id)
        return source?.content.includes('user-v2') ? source : null
      }, { description: 'modified method to be reindexed and retrievable' })

      fixture.write('src/core/UserService.ts', [
        'import { AdminService } from "./AdminService"',
        'export class UserService extends AdminService {',
        '  getLabel(): string { return "user-v2" }',
        '}',
        ''
      ].join('\n'))

      await eventually(() => {
        files = service.getFiles(repoPath)
        elements = service.getElements(repoPath)
        relationships = service.getRelationships(repoPath)
        return hasImport(relationships, elements, files, 'src/core/UserService.ts', 'src/core/AdminService.ts') &&
          !hasImport(relationships, elements, files, 'src/core/UserService.ts', 'src/core/BaseService.ts')
      }, { description: 'UserService import relationship to move from BaseService to AdminService' })

      fixture.write('src/core/AuditService.ts', [
        'import { AdminService } from "./AdminService"',
        'export class AuditService extends AdminService {',
        '  audit(): boolean { return true }',
        '}',
        ''
      ].join('\n'))

      await eventually(() => {
        files = service.getFiles(repoPath)
        elements = service.getElements(repoPath)
        relationships = service.getRelationships(repoPath)
        return Boolean(
          findElement(elements, files, 'src/core/AuditService.ts', 'audit') &&
          hasImport(relationships, elements, files, 'src/core/AuditService.ts', 'src/core/AdminService.ts')
        )
      }, { description: 'created AuditService file, element and relationship to appear' })

      const oldHelper = findFile(files, 'src/renderer/helper.js')!
      renameSync(join(repoPath, 'src/renderer/helper.js'), join(repoPath, 'src/shared/helper.js'))
      fixture.write('src/renderer/Widget.jsx', [
        'import { helper } from "../shared/helper"',
        'export function Widget() { return <span>{helper()}</span> }',
        ''
      ].join('\n'))

      await eventually(() => {
        files = service.getFiles(repoPath)
        elements = service.getElements(repoPath)
        relationships = service.getRelationships(repoPath)
        return !findFile(files, 'src/renderer/helper.js') &&
          Boolean(findElement(elements, files, 'src/shared/helper.js', 'helper')) &&
          hasImport(relationships, elements, files, 'src/renderer/Widget.jsx', 'src/shared/helper.js') &&
          relationships.every((relationship) => relationship.sourceId !== oldHelper.id && relationship.targetId !== oldHelper.id)
      }, { description: 'renamed helper file to replace the old path without dead relationships' })

      const auditFile = findFile(files, 'src/core/AuditService.ts')!
      const auditElementIds = new Set(elements.filter((element) => element.fileId === auditFile.id).map((element) => element.id))
      unlinkSync(join(repoPath, 'src/core/AuditService.ts'))

      await eventually(() => {
        files = service.getFiles(repoPath)
        elements = service.getElements(repoPath)
        relationships = service.getRelationships(repoPath)
        return !findFile(files, 'src/core/AuditService.ts') &&
          elements.every((element) => !auditElementIds.has(element.id)) &&
          relationships.every((relationship) => (
            relationship.sourceId !== auditFile.id &&
            relationship.targetId !== auditFile.id &&
            !auditElementIds.has(relationship.sourceId) &&
            !auditElementIds.has(relationship.targetId)
          ))
      }, { description: 'deleted AuditService state and relationships to disappear' })

      const integrityBeforeRestart = await service.verifyIntegrity(repoPath, { autoRepair: false, deep: true })
      expect(integrityBeforeRestart.status, JSON.stringify(integrityBeforeRestart.details)).toBe('healthy')
      expect(integrityBeforeRestart.repairResult).toBeUndefined()

      service.closeRepository(repoPath)
      fixture.write('src/shared/OfflineFeature.ts', 'export class OfflineFeature { wake(): void {} }\n')
      await service.openRepository(repoPath)

      await eventually(() => {
        const reopenedFiles = service.getFiles(repoPath)
        const reopenedElements = service.getElements(repoPath)
        return Boolean(findElement(reopenedElements, reopenedFiles, 'src/shared/OfflineFeature.ts', 'OfflineFeature'))
      }, { description: 'offline file to be discovered during repository reopen' })

      const finalIntegrity = await service.verifyIntegrity(repoPath, { autoRepair: false, deep: true })
      expect(finalIntegrity.status, JSON.stringify(finalIntegrity.details)).toBe('healthy')
      expect(finalIntegrity.repairResult).toBeUndefined()
    } finally {
      service.closeAll()
      watcherService.stop()
      await fixture.cleanup()
    }
  }, 120_000)
})
