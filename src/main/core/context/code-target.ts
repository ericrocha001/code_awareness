import type { CodeMapElement } from '../../../shared/types'

export function createFullTargetId(elementId: string): string {
  if (!/^[0-9a-f]{16}$/.test(elementId)) throw new Error('Expected a 64-bit CodeMap element identity')
  return 't:' + Buffer.from(elementId, 'hex').toString('base64url')
}

export function parseCodeTargetId(targetId: string): { elementId: string; kind: 'full' } | null {
  if (targetId.startsWith('target:') && targetId.endsWith(':full')) {
    const elementId = targetId.slice(7, -5)
    return elementId ? { elementId, kind: 'full' } : null
  }
  if (!/^t:[A-Za-z0-9_-]{11}$/.test(targetId)) return null
  const elementId = Buffer.from(targetId.slice(2), 'base64url').toString('hex')
  if (createFullTargetId(elementId) !== targetId) return null
  return { elementId, kind: 'full' }
}

export function projectFullTarget(element: CodeMapElement): string | undefined {
  return element.retrievable ? createFullTargetId(element.id) : undefined
}
