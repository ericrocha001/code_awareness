import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectIntelligenceEvidence } from '../intelligence-center/projections'
import { executeSessionTool, type SessionToolName } from './mcp'
import { digest } from './privacy'
import { SessionStore } from './store'

const dirs: string[] = []
function tempStore() {
  const base = mkdtempSync(join(tmpdir(), 'mi-mcp-'))
  dirs.push(base)
  const storePath = join(base, 'store', 'session-context.sqlite')
  mkdirSync(dirname(storePath), { recursive: true })
  return { storePath, repoId: 'repo-mi-mcp' }
}

function parseToolJson<T>(result: { content: Array<{ type: string; text?: string }> }): T {
  const text = result.content.find(c => typeof c.text === 'string')?.text ?? '{}'
  return JSON.parse(text) as T
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Model Intelligence end-to-end MCP consumption (U3)', () => {
  it('exposes persisted model/effort/usage through list_agent_sessions, inspect_agent_session, and Q26 after reopen', async () => {
    const { storePath, repoId } = tempStore()
    const store = new SessionStore(storePath, repoId)
    const { sessionId } = store.ingest({
      providerSessionId: 'mi-e2e-1',
      providerVersion: '0.13.4',
      agent: 'codex',
      state: 'ENDED',
      endedAt: '2026-11-20T15:00:00.000Z',
      coverage: 'PARTIAL',
      importState: 'METADATA_ONLY',
      sourceDigest: digest('mi-e2e-1'),
      sourceBytes: 0
    }, [])

    store.modelIntelligence.recordFacts(sessionId, {
      modelFacts: [
        {
          scope: 'turn', scopeId: 'turn:1', ordinal: 1, sourceSurface: 'codex_native_jsonl',
          sourceVersion: '0.169.0-alpha.11.1', observability: 'requested', provider: 'openai',
          client: 'codex', model: 'gpt-5.4', effort: 'high', coverageStatus: 'COMPLETE'
        },
        {
          scope: 'turn', scopeId: 'turn:2', ordinal: 2, sourceSurface: 'codex_native_jsonl',
          sourceVersion: '0.169.0-alpha.11.1', observability: 'requested', provider: 'openai',
          client: 'codex', model: 'gpt-5.4-mini', effort: 'low', coverageStatus: 'COMPLETE'
        }
      ],
      usageFacts: [
        {
          usageScope: 'session_cumulative', scopeId: 'cum:2', ordinal: 2, sourceSurface: 'codex_native_jsonl',
          sourceVersion: '0.169.0-alpha.11.1', observability: 'reported', model: 'gpt-5.4-mini',
          inputTokens: 200, cacheReadTokens: 0, outputTokens: 50, totalTokens: 250, coverageStatus: 'COMPLETE'
        },
        {
          usageScope: 'subagent_total', scopeId: 'sub:1', ordinal: 3, sourceSurface: 'codex_native_jsonl',
          sourceVersion: '0.169.0-alpha.11.1', observability: 'reported', model: 'gpt-5.4-mini',
          parentSessionId: sessionId, inputTokens: 1000, outputTokens: 200, totalTokens: 1200, coverageStatus: 'COMPLETE'
        }
      ]
    })
    store.close()

    const reopened = new SessionStore(storePath, repoId, true)
    try {
      const listed = parseToolJson<{
        sessions: Array<{ sessionId: string; modelIntelligence?: { models: string[]; efforts?: string[]; primaryUsage: { scope: string; total?: number } } }>
      }>(await executeSessionTool(reopened, {}, 'list_agent_sessions', { limit: 10 }, () => {}))
      expect(listed.sessions).toHaveLength(1)
      expect(listed.sessions[0].modelIntelligence).toMatchObject({
        models: ['gpt-5.4', 'gpt-5.4-mini'],
        efforts: ['high', 'low'],
        primaryUsage: { scope: 'session_cumulative', total: 250 }
      })

      const inspected = parseToolJson<{
        modelIntelligence?: {
          models: string[]
          efforts: string[]
          primaryUsage: { total?: number }
          subagentUsage: Array<{ total?: number }>
        }
      }>(await executeSessionTool(reopened, {}, 'inspect_agent_session', { sessionId, view: 'FOCAL' }, () => {}))
      expect(inspected.modelIntelligence?.models).toEqual(['gpt-5.4', 'gpt-5.4-mini'])
      expect(inspected.modelIntelligence?.primaryUsage.total).toBe(250)
      expect(inspected.modelIntelligence?.subagentUsage[0]?.total).toBe(1200)

      const q26 = await inspectIntelligenceEvidence(
        { questionId: 'Q26', target: { sessionId }, includeEntireUsage: true },
        {
          repositoryId: repoId,
          allowArtifactMetadata: false,
          assertSourceAuthorized: () => {},
          assertCurrent: () => {},
          sessionContext: {
            call: (name: string, args: unknown) =>
              executeSessionTool(reopened, {}, name as SessionToolName, args, () => {})
          } as never
        }
      ) as {
        questionId: string
        coverage: { model: string; perCall: string }
        evidence: {
          supportState: string
          sessionLevelModel?: { model: string; models: string[]; efforts: string[] }
          reportedUsage?: { billingCoverage: string; metrics: { total: number } }
          gaps: string[]
        }
      }
      expect(q26.questionId).toBe('Q26')
      expect(q26.coverage).toEqual({ model: 'SUPPORTED', perCall: 'SUPPORTED' })
      expect(q26.evidence.supportState).toBe('SUPPORTED')
      expect(q26.evidence.sessionLevelModel?.models).toEqual(['gpt-5.4', 'gpt-5.4-mini'])
      expect(q26.evidence.reportedUsage?.billingCoverage).toBe('UNAVAILABLE')
      expect(q26.evidence.reportedUsage?.metrics.total).toBe(250)
      expect(q26.evidence.gaps).toEqual([])
    } finally {
      reopened.close()
    }
  })
})
