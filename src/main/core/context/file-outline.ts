import type { CodeMapElement } from '../../../shared/types'
import type { FileOutlineElement, InspectFilesOptions } from '../../../shared/types/context-navigation-types'
import { projectFullTarget } from './code-target'

const navigableKinds = new Set(['class', 'function', 'method', 'interface', 'enum', 'typeAlias', 'constant', 'document', 'section'])

export function projectFileOutline(elements: CodeMapElement[], options: InspectFilesOptions): FileOutlineElement[] {
  const children = new Map<string | null, CodeMapElement[]>()
  for (const element of elements) {
    const siblings = children.get(element.parentElementId) ?? []
    siblings.push(element)
    children.set(element.parentElementId, siblings)
  }
  const project = (parentId: string | null): FileOutlineElement[] => {
    const result: FileOutlineElement[] = []
    const siblings = (children.get(parentId) ?? []).slice().sort((a, b) => a.location.start.byte - b.location.start.byte || a.id.localeCompare(b.id))
    for (const element of siblings) {
      if (element.kind === 'export') {
        result.push(...project(element.id))
        continue
      }
      if (!navigableKinds.has(element.kind)) continue
      if (element.kind === 'method' && parentId === null) continue
      const target = projectFullTarget(element)
      const outline: FileOutlineElement = {
        kind: element.kind as FileOutlineElement['kind'],
        name: element.name,
        ...(target ? { target } : {})
      }
      if (options.signatures && element.kind !== 'document' && element.kind !== 'section') {
        if (element.declarationSignature != null) {
          outline.signature = element.declarationSignature
        } else {
          const rawParameters = (children.get(element.id) ?? []).filter((entry) => entry.kind === 'parameter')
            .sort((a, b) => a.location.start.byte - b.location.start.byte)
          const parameters = typeof element.parameterCount === 'number'
            ? rawParameters.slice(0, element.parameterCount)
            : rawParameters
          let signature = element.name
          if (element.kind === 'function' || element.kind === 'method') {
            signature += `(${parameters.map((parameter) => parameter.name).join(', ')})`
            if (element.returnType) signature += `: ${element.returnType}`
          }
          if (element.baseClass) signature += ` extends ${element.baseClass}`
          outline.signature = signature
        }
      }
      if (element.kind === 'class' || element.kind === 'interface') {
        const members = project(element.id).filter((entry) => entry.kind === 'method')
        if (members.length) outline.children = members
      }
      if (element.kind === 'document' || element.kind === 'section') {
        const sections = project(element.id).filter((entry) => entry.kind === 'section')
        if (sections.length) outline.children = sections
      }
      result.push(outline)
    }
    return result
  }
  return project(null)
}
