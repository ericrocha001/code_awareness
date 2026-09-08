import type { CodeMapElement, CodeMapFile, CodeMapRelationship } from '../../../shared/types'
import { basename, resolve } from 'node:path'
import {
  REPO_DISCOVERY_PROTOCOL_VERSION,
  type RepoDiscoveryLayer,
  type RepoDiscoveryResult,
  type RepoDiscoveryTimings
} from '../../../shared/types/repo-discovery-types'
import { getCanonicalTokenizer, type TokenizerPort } from '../tokenizer'
import { projectRM2, serializeRM2, type RM2Snapshot } from './rm2-encoder'

export interface CodeMapDiscoveryPort {
  awaitSnapshot(repoPath: string): Promise<void>
  getFiles(repoPath: string): CodeMapFile[]
  getElements(repoPath: string): CodeMapElement[]
  getRelationships(repoPath: string): CodeMapRelationship[]
}

function elapsed(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(2))
}

export class RepoDiscovery {
  constructor(
    private readonly codeMap: CodeMapDiscoveryPort,
    private readonly tokenizer: TokenizerPort = getCanonicalTokenizer()
  ) {}

  async generate(repoPath: string, layer: RepoDiscoveryLayer): Promise<RepoDiscoveryResult> {
    const totalStarted = performance.now()
    let phaseStarted = performance.now()
    await this.codeMap.awaitSnapshot(repoPath)
    const readinessMs = elapsed(phaseStarted)

    phaseStarted = performance.now()
    const snapshot: RM2Snapshot = {
      projectName: basename(resolve(repoPath)),
      files: this.codeMap.getFiles(repoPath),
      elements: layer >= 2 ? this.codeMap.getElements(repoPath) : [],
      relationships: layer >= 2 ? this.codeMap.getRelationships(repoPath) : []
    }
    const projection = projectRM2(snapshot, layer)
    const projectionMs = elapsed(phaseStarted)

    phaseStarted = performance.now()
    const content = serializeRM2(projection, this.tokenizer)
    const serializationMs = elapsed(phaseStarted)

    phaseStarted = performance.now()
    const tokenCount = this.tokenizer.count(content)
    const outputTokenizationMs = elapsed(phaseStarted)
    const totalMs = elapsed(totalStarted)
    const timings: RepoDiscoveryTimings = {
      readinessMs,
      projectionMs,
      serializationMs,
      outputTokenizationMs,
      totalMs
    }

    return {
      protocol: REPO_DISCOVERY_PROTOCOL_VERSION,
      layer,
      content,
      tokenCount,
      mapTokenCount: tokenCount,
      tokenizerId: this.tokenizer.id,
      tokenizerEncoding: this.tokenizer.encoding,
      fileCount: snapshot.files.length,
      generationMs: totalMs,
      timings
    }
  }
}
