import { publicationReceiptDigest, publicationRequestDigest, type PublicationReceipt, type PublicationRequest } from '../../shared/types/publication-provenance-types'

export const nativeArtifactTools = {
  mcp__code_awareness_local__publish_artifact: 'PUBLISH',
  mcp__code_awareness_local__update_artifact: 'UPDATE'
} as const
export interface NativeArtifactFact {
  schemaVersion: 1
  category: 'ARTIFACT_PUBLISH' | 'ARTIFACT_UPDATE'
  tool: keyof typeof nativeArtifactTools
  requestDigest: string
  outcome: 'SUCCESS' | 'FAILURE' | 'UNKNOWN'
  receipt?: { receiptId: string; artifactId: string; revision: number; digest: string; replayed: boolean }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const artifactId = (value: unknown): value is string => typeof value === 'string' && /^artifact-[a-f0-9-]{36}$/.test(value)
export function nativeArtifactFact(payload: Record<string, unknown>, repositoryId: string): NativeArtifactFact | undefined {
  const tool = payload.tool_name
  if (typeof tool !== 'string' || !Object.hasOwn(nativeArtifactTools, tool) || !object(payload.tool_input)) return
  const action = nativeArtifactTools[tool as keyof typeof nativeArtifactTools], input = payload.tool_input
  const keys = ['rawMarkdown', 'name', 'description', 'kind', ...(action === 'UPDATE' ? ['artifactId', 'expectedRevision'] : [])]
  if (Object.keys(input).some(key => !keys.includes(key)) || typeof input.rawMarkdown !== 'string' || !input.rawMarkdown.trim() ||
    ['name','description','kind'].some(key => input[key] !== undefined && (typeof input[key] !== 'string' || !(input[key] as string).trim())) ||
    action === 'UPDATE' && (!artifactId(input.artifactId) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1)) return
  const requestDigest = publicationRequestDigest(action, input as unknown as PublicationRequest)
  const fact: NativeArtifactFact = { schemaVersion: 1, category: action === 'PUBLISH' ? 'ARTIFACT_PUBLISH' : 'ARTIFACT_UPDATE', tool: tool as keyof typeof nativeArtifactTools, requestDigest, outcome: 'UNKNOWN' }
  if (payload.hook_event_name !== 'PostToolUse' || !object(payload.tool_response)) return fact
  const response = payload.tool_response
  if (response.isError === true) return { ...fact, outcome: 'FAILURE' }
  let result: unknown = response.structuredContent
  if (!result && Array.isArray(response.content)) {
    const first = response.content[0]
    if (object(first) && first.type === 'text' && typeof first.text === 'string') {
      try { result = JSON.parse(first.text) } catch {}
    }
  }
  if (!object(result)) return fact
  if (result.success === false) return { ...fact, outcome: 'FAILURE' }
  if (result.success !== true || typeof result.replayed !== 'boolean' || !object(result.publicationReceipt)) return fact
  const receipt = result.publicationReceipt
  const { digest, ...body } = receipt
  if (Object.keys(receipt).some(key => !['schemaVersion','receiptId','repositoryId','artifactId','revision','contentHash','requestDigest','action','digest'].includes(key)) ||
    receipt.schemaVersion !== 1 || typeof receipt.receiptId !== 'string' || !/^publication-[a-f0-9-]{36}$/.test(receipt.receiptId) || receipt.repositoryId !== repositoryId ||
    !artifactId(receipt.artifactId) || !Number.isSafeInteger(receipt.revision) || Number(receipt.revision) < 1 || !hash(receipt.contentHash) || !hash(digest) ||
    receipt.action !== action || receipt.requestDigest !== requestDigest || result.artifactId !== receipt.artifactId || result.revision !== receipt.revision ||
    action === 'UPDATE' && (input.artifactId !== receipt.artifactId || Number(input.expectedRevision) + 1 !== receipt.revision) ||
    publicationReceiptDigest(body as unknown as Omit<PublicationReceipt, 'digest'>) !== digest) return fact
  return { ...fact, outcome: 'SUCCESS', receipt: { receiptId: receipt.receiptId, artifactId: receipt.artifactId, revision: Number(receipt.revision), digest, replayed: result.replayed } }
}
export function validNativeArtifactFact(value: unknown): value is NativeArtifactFact {
  if (!object(value) || Object.keys(value).some(key => !['schemaVersion','category','tool','requestDigest','outcome','receipt'].includes(key)) || value.schemaVersion !== 1 ||
    typeof value.tool !== 'string' || !Object.hasOwn(nativeArtifactTools, value.tool) || !hash(value.requestDigest) || !['SUCCESS','FAILURE','UNKNOWN'].includes(String(value.outcome)) ||
    value.category !== (nativeArtifactTools[value.tool as keyof typeof nativeArtifactTools] === 'PUBLISH' ? 'ARTIFACT_PUBLISH' : 'ARTIFACT_UPDATE')) return false
  if (value.receipt === undefined) return value.outcome !== 'SUCCESS'
  const r = value.receipt
  return value.outcome === 'SUCCESS' && object(r) && !Object.keys(r).some(key => !['receiptId','artifactId','revision','digest','replayed'].includes(key)) &&
    typeof r.receiptId === 'string' && /^publication-[a-f0-9-]{36}$/.test(r.receiptId) && artifactId(r.artifactId) && Number.isSafeInteger(r.revision) && Number(r.revision) >= 1 && hash(r.digest) && typeof r.replayed === 'boolean'
}
