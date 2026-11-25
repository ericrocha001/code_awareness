import type { AcademyPackage } from '../../../shared/types/academy-types'
import { AcademyError, hashAcademyPackage, normalizeAcademyPackage, parseSkillMetadata } from '../academy-package'
import type { PackageFacts } from './skill-lint-types'
import {
  assertCanonicalSkillFilePath,
  getPackageFileContent,
  parseSnapshotSelector
} from './skill-navigation'

export type FocalEditOp =
  | { op: 'replace'; path: string; oldText: string; newText: string; selector?: never }
  | { op: 'replace'; path: string; selector: string; newText: string; oldText?: never }
  | { op: 'add'; path: string; content: string }
  | { op: 'remove'; path: string }
  | { op: 'move'; path: string; toPath: string }

interface ResolvedReplace {
  editIndex: number
  start: number
  end: number
  newText: string
}

export function applyFocalEdits(
  basePkg: AcademyPackage,
  baseHash: string,
  baseFacts: PackageFacts,
  rawEdits: unknown
): {
  candidate: AcademyPackage
  candidateHash: string
  candidateValid: boolean
  validationError?: { code: string; message: string }
} {
  if (!Array.isArray(rawEdits) || rawEdits.length < 1 || rawEdits.length > 50) {
    throw new AcademyError('INVALID_ARGUMENT', 'edits must be a non-empty array of at most 50 operations')
  }

  const baseFiles = new Map<string, string>([
    ['SKILL.md', basePkg.skillMd],
    ...Object.entries(basePkg.artifacts)
  ])
  const baseFolded = new Set<string>([...baseFiles.keys()].map(p => p.toLowerCase()))

  const removedOrMovedSources = new Set<string>()
  const addedOrMovedTargets = new Map<string, string>()
  const addedOrMovedFolded = new Set<string>()
  const replacesByPath = new Map<string, ResolvedReplace[]>()

  for (let editIndex = 0; editIndex < rawEdits.length; editIndex++) {
    const raw = rawEdits[editIndex]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AcademyError('INVALID_ARGUMENT', 'Each edit must be an object', { editIndex })
    }
    const edit = raw as Record<string, unknown>
    const op = edit.op

    if (op === 'replace') {
      const path = assertCanonicalSkillFilePath(edit.path)
      const content = baseFiles.get(path)
      if (content === undefined) {
        throw new AcademyError('PATH_NOT_FOUND', `Path not found in base package: ${path}`, { editIndex, path })
      }
      if (typeof edit.newText !== 'string') {
        throw new AcademyError('INVALID_ARGUMENT', 'replace requires string newText', { editIndex, path })
      }
      const hasOldText = edit.oldText !== undefined
      const hasSelector = edit.selector !== undefined
      if (hasOldText === hasSelector) {
        throw new AcademyError('INVALID_ARGUMENT', 'replace requires exactly one of oldText or selector', {
          editIndex,
          path
        })
      }

      let start: number
      let end: number

      if (hasOldText) {
        if (typeof edit.oldText !== 'string' || !edit.oldText) {
          throw new AcademyError('INVALID_ARGUMENT', 'oldText must be a non-empty string', { editIndex, path })
        }
        const firstIdx = content.indexOf(edit.oldText)
        if (firstIdx === -1) {
          throw new AcademyError('OLD_TEXT_NOT_FOUND', `oldText not found in ${path}`, { editIndex, path })
        }
        const secondIdx = content.indexOf(edit.oldText, firstIdx + 1)
        if (secondIdx !== -1) {
          throw new AcademyError('OLD_TEXT_AMBIGUOUS', `oldText occurs multiple times in ${path}`, {
            editIndex,
            path
          })
        }
        start = firstIdx
        end = firstIdx + edit.oldText.length
      } else {
        if (typeof edit.selector !== 'string' || !edit.selector) {
          throw new AcademyError('INVALID_ARGUMENT', 'selector must be a non-empty string', { editIndex, path })
        }
        parseSnapshotSelector(edit.selector, baseHash, path)
        const entry = baseFacts.outlines[path]?.entries.find(e => e.selector === edit.selector)
        if (!entry) {
          throw new AcademyError('SELECTOR_NOT_FOUND', `Selector not found in ${path}: ${edit.selector}`, {
            editIndex,
            path,
            selector: edit.selector
          })
        }
        start = entry.range.startOffset
        end = entry.range.endOffset
      }

      const list = replacesByPath.get(path) ?? []
      list.push({ editIndex, start, end, newText: edit.newText })
      replacesByPath.set(path, list)
      continue
    }

    if (op === 'add') {
      const path = assertCanonicalSkillFilePath(edit.path)
      if (path === 'SKILL.md') {
        throw new AcademyError('INVALID_ARTIFACT_PATH', 'Cannot add SKILL.md', { editIndex, path })
      }
      if (typeof edit.content !== 'string' || edit.content.includes('\0')) {
        throw new AcademyError('NON_TEXT_ARTIFACT', `Artifact content must be UTF-8 text: ${path}`, {
          editIndex,
          path
        })
      }
      const folded = path.toLowerCase()
      if (baseFolded.has(folded) || addedOrMovedFolded.has(folded)) {
        throw new AcademyError('RESOURCE_EXISTS', `Resource already exists: ${path}`, { editIndex, path })
      }
      addedOrMovedFolded.add(folded)
      addedOrMovedTargets.set(path, edit.content)
      continue
    }

    if (op === 'remove') {
      const path = assertCanonicalSkillFilePath(edit.path)
      if (path === 'SKILL.md') {
        throw new AcademyError('INVALID_ARTIFACT_PATH', 'Cannot remove SKILL.md', { editIndex, path })
      }
      if (!baseFiles.has(path)) {
        throw new AcademyError('PATH_NOT_FOUND', `Path not found in base package: ${path}`, { editIndex, path })
      }
      if (removedOrMovedSources.has(path)) {
        throw new AcademyError('EDIT_CONFLICT', `Path already removed or moved in batch: ${path}`, {
          editIndex,
          path
        })
      }
      removedOrMovedSources.add(path)
      continue
    }

    if (op === 'move') {
      const path = assertCanonicalSkillFilePath(edit.path)
      const toPath = assertCanonicalSkillFilePath(edit.toPath)
      if (path === 'SKILL.md' || toPath === 'SKILL.md') {
        throw new AcademyError('INVALID_ARTIFACT_PATH', 'Cannot move SKILL.md', { editIndex, path })
      }
      const content = baseFiles.get(path)
      if (content === undefined) {
        throw new AcademyError('PATH_NOT_FOUND', `Source path not found in base package: ${path}`, {
          editIndex,
          path
        })
      }
      if (removedOrMovedSources.has(path)) {
        throw new AcademyError('EDIT_CONFLICT', `Source path already removed or moved in batch: ${path}`, {
          editIndex,
          path
        })
      }
      const targetFolded = toPath.toLowerCase()
      if (baseFolded.has(targetFolded) || addedOrMovedFolded.has(targetFolded)) {
        throw new AcademyError('RESOURCE_EXISTS', `Target resource already exists: ${toPath}`, {
          editIndex,
          path: toPath
        })
      }
      removedOrMovedSources.add(path)
      addedOrMovedFolded.add(targetFolded)
      addedOrMovedTargets.set(toPath, content)
      continue
    }

    throw new AcademyError('INVALID_ARGUMENT', `Unknown focal edit op: ${String(op)}`, { editIndex })
  }

  // Verify no replace targets a removed/moved path and no ranges overlap
  const nextFiles = new Map(baseFiles)
  for (const removed of removedOrMovedSources) {
    if (replacesByPath.has(removed)) {
      throw new AcademyError('EDIT_CONFLICT', `Cannot replace on path removed or moved in the same batch: ${removed}`, {
        path: removed
      })
    }
    nextFiles.delete(removed)
  }

  for (const [addedPath, addedContent] of addedOrMovedTargets) {
    if (replacesByPath.has(addedPath)) {
      throw new AcademyError('EDIT_CONFLICT', `Cannot replace on path added in the same batch: ${addedPath}`, {
        path: addedPath
      })
    }
    nextFiles.set(addedPath, addedContent)
  }

  for (const [path, replaces] of replacesByPath) {
    const sorted = [...replaces].sort((a, b) => a.start - b.start || a.end - b.end)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start < sorted[i - 1].end) {
        throw new AcademyError('EDIT_RANGES_OVERLAP', `Overlapping replace ranges in ${path}`, {
          editIndex: sorted[i].editIndex,
          path
        })
      }
    }
    let updated = getPackageFileContent(basePkg, path)!
    for (let i = sorted.length - 1; i >= 0; i--) {
      const r = sorted[i]
      updated = updated.slice(0, r.start) + r.newText + updated.slice(r.end)
    }
    nextFiles.set(path, updated)
  }

  const skillMd = nextFiles.get('SKILL.md') ?? ''
  const artifacts: Record<string, string> = {}
  for (const [path, content] of [...nextFiles.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (path !== 'SKILL.md') artifacts[path] = content
  }

  const rawCandidate: AcademyPackage = { skillMd, artifacts }
  try {
    const normalized = normalizeAcademyPackage(rawCandidate)
    parseSkillMetadata(normalized.skillMd)
    return {
      candidate: normalized,
      candidateHash: hashAcademyPackage(normalized),
      candidateValid: true
    }
  } catch (err) {
    const code = err instanceof AcademyError ? err.code : 'INVALID_PACKAGE'
    const message = err instanceof Error ? err.message : String(err)
    return {
      candidate: rawCandidate,
      candidateHash: baseHash,
      candidateValid: false,
      validationError: { code, message }
    }
  }
}
