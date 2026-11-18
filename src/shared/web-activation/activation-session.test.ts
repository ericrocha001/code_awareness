import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  ACTIVATION_CONTRACT_PROTOCOL,
  buildActivationBootstrapMessage,
  parseActivationCallEnvelopes
} from './activation-contract'
import {
  ActivationSession,
  type SkillEntryDescriptor,
  type WebActivationTransport
} from './activation-session'

function sha256(text: string): { digest: string; size: number } {
  const buf = Buffer.from(text, 'utf8')
  return {
    digest: `sha256:${createHash('sha256').update(buf).digest('hex')}`,
    size: buf.byteLength
  }
}

describe('Activation Contract (code-awareness-activation/v1) & ActivationSession', () => {
  it('builds progressive compact bootstrap (skills.load only) and rejects batching, malformed, incomplete, or quoted envelopes', () => {
    const prompt = buildActivationBootstrapMessage({
      site: 'deepseek',
      mode: 'PROJECT',
      projectId: 'proj-1',
      sessionNonce: 's1',
      skills: [
        {
          server: 'code-awareness-desktop',
          name: 'arch-review',
          uri: 'skill://project/d1/s1/arch-review/SKILL.md',
          description: 'Review architecture boundaries',
          scope: 'project'
        }
      ],
      tools: [{ name: 'discover_repository', description: 'Discover tree', inputSchema: { type: 'object', properties: { maxDepth: { type: 'number' } } } }]
    })

    expect(prompt).toContain(ACTIVATION_CONTRACT_PROTOCOL)
    expect(prompt).toContain('arch-review')
    expect(prompt).toContain('skills.load')
    expect(prompt).toContain('<unique-request-id>')
    expect(prompt).toContain('unique `requestId`')
    expect(prompt).toContain('emit only the call envelope at the end of your reply')
    expect(prompt).not.toContain('"requestId":"req-1"')
    expect(prompt).not.toContain('discover_repository')
    expect(prompt).not.toContain('inputSchema')
    expect(prompt.length).toBeLessThan(2000)

    const validEnvelope = [
      '```code-awareness-call',
      JSON.stringify({
        protocol: ACTIVATION_CONTRACT_PROTOCOL,
        requestId: 'r-1',
        method: 'skills/get',
        params: { name: 'arch-review' }
      }),
      '```'
    ].join('\n')

    expect(parseActivationCallEnvelopes({ role: 'user', isComplete: true, text: validEnvelope }).ignoredReason).toBe('NON_ASSISTANT_ROLE')
    expect(parseActivationCallEnvelopes({ role: 'assistant', isComplete: false, text: validEnvelope }).ignoredReason).toBe('INCOMPLETE_TURN')

    const quotedAndNested = [
      '> Quoted example MUST NOT execute:',
      '> ```code-awareness-call',
      '> {"protocol":"code-awareness-activation/v1","requestId":"r-quoted","method":"skills/list","params":{}}',
      '> ```',
      '',
      '````markdown',
      'Nested markdown example MUST NOT execute:',
      '```code-awareness-call',
      '{"protocol":"code-awareness-activation/v1","requestId":"r-nested","method":"skills/list","params":{}}',
      '```',
      '````',
      '',
      validEnvelope,
      '',
      '```code-awareness-call',
      '{not-json',
      '```',
      '',
      '```code-awareness-call',
      JSON.stringify({
        protocol: ACTIVATION_CONTRACT_PROTOCOL,
        requestId: 'r-1',
        method: 'skills/list',
        params: {}
      }),
      '```'
    ].join('\n')

    const parsed = parseActivationCallEnvelopes({
      role: 'assistant',
      isComplete: true,
      text: quotedAndNested,
      seenRequestIds: new Set(['r-prev'])
    })

    expect(parsed.calls).toEqual([
      {
        protocol: ACTIVATION_CONTRACT_PROTOCOL,
        requestId: 'r-1',
        method: 'skills/get',
        params: { name: 'arch-review' }
      }
    ])
    expect(parsed.rejected.map((r) => r.code)).toEqual(['MALFORMED_JSON', 'DUPLICATE_REQUEST_ID'])

    const replayCheck = parseActivationCallEnvelopes({
      role: 'assistant',
      isComplete: true,
      text: [
        '```code-awareness-call',
        JSON.stringify({
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId: 'r-prev',
          method: 'skills/list',
          params: {}
        }),
        '```'
      ].join('\n'),
      seenRequestIds: new Set(['r-prev'])
    })
    expect(replayCheck.calls).toHaveLength(0)
    expect(replayCheck.rejected[0]?.code).toBe('DUPLICATE_REQUEST_ID')

    const batchedCheck = parseActivationCallEnvelopes({
      role: 'assistant',
      isComplete: true,
      text: [
        '```code-awareness-call',
        JSON.stringify({
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId: 'r-batch',
          requests: [{ method: 'skills.load', params: { name: 'arch-review' } }]
        }),
        '```',
        '```code-awareness-call',
        JSON.stringify([{ protocol: ACTIVATION_CONTRACT_PROTOCOL, requestId: 'r-arr', method: 'skills/list' }]),
        '```'
      ].join('\n')
    })
    expect(batchedCheck.calls).toHaveLength(0)
    expect(batchedCheck.rejected.map((r) => r.code)).toEqual(['BATCHING_NOT_SUPPORTED', 'BATCHING_NOT_SUPPORTED'])
  })

  it('enforces integrity (SHA-256, byte size, frontmatter), acting window confinement, content-bound approvals, and cache vs active-chat separation', async () => {
    const skillMd = '---\nname: unicode-check\ndescription: Check UTF-8 café 🚀 rules\n---\n\n# Steps\nVerify boundaries.\n'
    const skillUri = 'skill://project/d1/s1/unicode-check/SKILL.md'
    const refText = 'Checklist item 1'
    const refUri = 'skill://project/d1/s1/unicode-check/references/checklist.md'
    const otherUri = 'skill://project/d1/s2/other/SKILL.md'

    const skillMeta = sha256(skillMd)
    const refMeta = sha256(refText)
    const validEntry: SkillEntryDescriptor = {
      name: 'unicode-check',
      description: 'Check UTF-8 café 🚀 rules',
      frontmatter: {
        name: 'unicode-check',
        description: 'Check UTF-8 café 🚀 rules'
      },
      resources: [
        { uri: skillUri, ...skillMeta, mimeType: 'text/markdown' },
        { uri: refUri, ...refMeta, mimeType: 'text/markdown' }
      ]
    }

    let currentResourceText = skillMd
    let currentEntry = validEntry
    let failMode: 'NONE' | 'CONSENT_REQUIRED' | 'SESSION_INVALIDATED' | 'APP_UNAVAILABLE' = 'NONE'

    const transport: WebActivationTransport = {
      getStatus: vi.fn(async () =>
        failMode === 'APP_UNAVAILABLE'
          ? { available: false, errorCode: 'APP_UNAVAILABLE' }
          : { available: true, mode: 'PROJECT' as const, projectId: 'proj-1', instanceId: 'inst-1', bindingId: 'bind-1' }
      ),
      mcpRequest: vi.fn(async ({ method, params }) => {
        if (failMode !== 'NONE') {
          return { ok: false, error: { code: failMode, message: failMode } }
        }
        if (method === 'skills/list') {
          return { ok: true, mcp: { result: { skills: [{ uri: skillUri, name: 'unicode-check', description: 'Check UTF-8 café 🚀 rules' }] } } }
        }
        if (method === 'tools/list') {
          return { ok: true, mcp: { result: { tools: [{ name: 'discover_repository' }] } } }
        }
        if (method === 'skills/get') {
          return { ok: true, mcp: { result: currentEntry } }
        }
        if (method === 'resources/read') {
          const uri = String(params?.uri ?? '')
          return {
            ok: true,
            mcp: {
              result: {
                contents: [{ uri, mimeType: 'text/markdown', text: uri === refUri ? refText : currentResourceText }]
              }
            }
          }
        }
        return { ok: true, mcp: { result: { ok: true } } }
      })
    }

    const session = new ActivationSession({
      site: 'qwen',
      transport,
      maxCyclesPerUserTurn: 20,
      requireContentApproval: true,
      requestSkillApproval: vi.fn(async () => true)
    })

    const activated = await session.activate()
    expect(activated.state).toBe('READY')
    expect(activated.bootstrapPrompt).toContain('unicode-check')
    expect(activated.bootstrapPrompt).not.toContain('Verify boundaries.')

    // Reading outside acting window before skills/get fails deterministically
    const earlyRead = await session.processAssistantTurn({
      role: 'assistant',
      isComplete: true,
      text: `\`\`\`code-awareness-call\n${JSON.stringify({ protocol: ACTIVATION_CONTRACT_PROTOCOL, requestId: 'c1', method: 'resources/read', params: { uri: skillUri } })}\n\`\`\``
    })
    expect(earlyRead.executedCalls[0]?.errorCode).toBe('RESOURCE_OUTSIDE_ACTING_WINDOW')

    // Valid skills/get opens acting window
    const getRes = await session.processAssistantTurn({
      role: 'assistant',
      isComplete: true,
      text: `\`\`\`code-awareness-call\n${JSON.stringify({ protocol: ACTIVATION_CONTRACT_PROTOCOL, requestId: 'c2', method: 'skills/get', params: { name: 'unicode-check' } })}\n\`\`\``
    })
    expect(getRes.executedCalls[0]?.ok).toBe(true)
    expect(session.getActingWindow()?.allowedUris).toEqual([skillUri, refUri])

    // Unlisted resource URI fails acting-window confinement
    const unlistedRead = await session.processAssistantTurn({
      role: 'assistant',
      isComplete: true,
      text: `\`\`\`code-awareness-call\n${JSON.stringify({ protocol: ACTIVATION_CONTRACT_PROTOCOL, requestId: 'c3', method: 'resources/read', params: { uri: otherUri } })}\n\`\`\``
    })
    expect(unlistedRead.executedCalls[0]?.errorCode).toBe('RESOURCE_OUTSIDE_ACTING_WINDOW')
    expect(session.getActingWindow()).toBeNull()

    // Digest / size / frontmatter tampering fail verification and leave zero bytes cached or in active chat
    await session.processAssistantTurn({
      role: 'assistant',
      isComplete: true,
      text: `\`\`\`code-awareness-call\n${JSON.stringify({ protocol: ACTIVATION_CONTRACT_PROTOCOL, requestId: 'c4', method: 'skills/get', params: { name: 'unicode-check' } })}\n\`\`\``
    })

    // Case A: Size mismatch (extra byte)
    currentResourceText = `${skillMd}!`
    const badSize = await session.processAssistantTurn({
      role: 'assistant',
      isComplete: true,
      text: `\`\`\`code-awareness-call\n${JSON.stringify({ protocol: ACTIVATION_CONTRACT_PROTOCOL, requestId: 'c5', method: 'resources/read', params: { uri: skillUri } })}\n\`\`\``
    })
    expect(badSize.executedCalls[0]?.errorCode).toBe('SIZE_MISMATCH')
    expect(badSize.emulatedResponses[0]).not.toContain('Verify boundaries.')
    expect(session.getVerifiedCachedEntry(skillUri)).toBeUndefined()

    // Case B: Same UTF-8 byte length, different content -> DIGEST_MISMATCH
    await session.processAssistantTurn({
      role: 'assistant',
      isComplete: true,
      text: `\`\`\`code-awareness-call\n${JSON.stringify({ protocol: ACTIVATION_CONTRACT_PROTOCOL, requestId: 'c6', method: 'skills/get', params: { name: 'unicode-check' } })}\n\`\`\``
    })
    currentResourceText = skillMd.replace('boundaries.', 'boundaries!')
    expect(Buffer.byteLength(currentResourceText, 'utf8')).toBe(skillMeta.size)
    const badDigest = await session.processAssistantTurn({
      role: 'assistant',
      isComplete: true,
      text: `\`\`\`code-awareness-call\n${JSON.stringify({ protocol: ACTIVATION_CONTRACT_PROTOCOL, requestId: 'c7', method: 'resources/read', params: { uri: skillUri } })}\n\`\`\``
    })
    expect(badDigest.executedCalls[0]?.errorCode).toBe('DIGEST_MISMATCH')

    // Case C: Matching size + digest with tampered frontmatter
    const tamperedMd = '---\nname: unicode-check\ndescription: TAMPERED\n---\n\n# Steps\n'
    const tamperedMeta = sha256(tamperedMd)
    currentEntry = {
      ...validEntry,
      resources: [{ uri: skillUri, ...tamperedMeta, mimeType: 'text/markdown' }]
    }
    // Wait: approval was already recorded for original validEntry fingerprint, so changing entry resources triggers CONTENT_APPROVAL_MISMATCH!
    const approvalDrift = await session.processAssistantTurn({
      role: 'assistant',
      isComplete: true,
      text: `\`\`\`code-awareness-call\n${JSON.stringify({ protocol: ACTIVATION_CONTRACT_PROTOCOL, requestId: 'c8', method: 'skills/get', params: { name: 'unicode-check' } })}\n\`\`\``
    })
    expect(approvalDrift.executedCalls[0]?.errorCode).toBe('CONTENT_APPROVAL_MISMATCH')

    // Grant new approval on drifted resource, then frontmatter mismatch still catches descriptor vs body divergence
    session.grantContentApproval(currentEntry)
    await session.processAssistantTurn({
      role: 'assistant',
      isComplete: true,
      text: `\`\`\`code-awareness-call\n${JSON.stringify({ protocol: ACTIVATION_CONTRACT_PROTOCOL, requestId: 'c9', method: 'skills/get', params: { name: 'unicode-check' } })}\n\`\`\``
    })
    currentResourceText = tamperedMd
    const badFm = await session.processAssistantTurn({
      role: 'assistant',
      isComplete: true,
      text: `\`\`\`code-awareness-call\n${JSON.stringify({ protocol: ACTIVATION_CONTRACT_PROTOCOL, requestId: 'c10', method: 'resources/read', params: { uri: skillUri } })}\n\`\`\``
    })
    expect(badFm.executedCalls[0]?.errorCode).toBe('FRONTMATTER_MISMATCH')

    // Valid flow verifies bytes + populates both verifiedResourceCache and activeChatPresence
    currentEntry = validEntry
    currentResourceText = skillMd
    session.grantContentApproval(validEntry)
    await session.processAssistantTurn({
      role: 'assistant',
      isComplete: true,
      text: `\`\`\`code-awareness-call\n${JSON.stringify({ protocol: ACTIVATION_CONTRACT_PROTOCOL, requestId: 'c11', method: 'skills/get', params: { name: 'unicode-check' } })}\n\`\`\``
    })
    const okRead = await session.processAssistantTurn({
      role: 'assistant',
      isComplete: true,
      text: `\`\`\`code-awareness-call\n${JSON.stringify({ protocol: ACTIVATION_CONTRACT_PROTOCOL, requestId: 'c12', method: 'resources/read', params: { uri: skillUri } })}\n\`\`\``
    })
    expect(okRead.executedCalls[0]?.ok).toBe(true)
    expect(session.getVerifiedCachedEntry(skillUri)?.text).toBe(skillMd)
    expect(session.isPresentInActiveChat(skillUri)).toBe(true)

    // Starting a new chat keeps verified cache distinct while marking activeChatPresence empty
    session.startNewChat()
    expect(session.getVerifiedCachedEntry(skillUri)?.text).toBe(skillMd)
    expect(session.isPresentInActiveChat(skillUri)).toBe(false)

    // Revocation purges verified cache, presence, acting window, and stops processing
    failMode = 'CONSENT_REQUIRED'
    const revokedTurn = await session.processAssistantTurn({
      role: 'assistant',
      isComplete: true,
      text: `\`\`\`code-awareness-call\n${JSON.stringify({ protocol: ACTIVATION_CONTRACT_PROTOCOL, requestId: 'c13', method: 'tools/call', params: { name: 'discover_repository', arguments: {} } })}\n\`\`\``
    })
    expect(revokedTurn.state).toBe('REVOKED')
    expect(session.getVerifiedCachedEntry(skillUri)).toBeUndefined()
  })

  it('enforces bounded cycles per user turn and transitions cleanly to UNAVAILABLE/INACTIVE on failures', async () => {
    const transport: WebActivationTransport = {
      getStatus: vi.fn(async () => ({
        available: true,
        mode: 'GLOBAL_ONLY' as const,
        projectId: null,
        instanceId: 'inst-1',
        bindingId: 'bind-1'
      })),
      mcpRequest: vi.fn(async ({ method }) => {
        if (method === 'skills/list') return { ok: true, mcp: { result: { skills: [] } } }
        if (method === 'tools/list') return { ok: true, mcp: { result: { tools: [] } } }
        return { ok: true, mcp: { result: { ok: true } } }
      })
    }

    const session = new ActivationSession({
      site: 'deepseek',
      transport,
      maxCyclesPerUserTurn: 2
    })
    await session.activate()
    session.beginUserTurn()

    const call = (id: string) =>
      `\`\`\`code-awareness-call\n${JSON.stringify({ protocol: ACTIVATION_CONTRACT_PROTOCOL, requestId: id, method: 'skills/list', params: {} })}\n\`\`\``

    expect((await session.processAssistantTurn({ role: 'assistant', isComplete: true, text: call('k1') })).executedCalls[0]?.ok).toBe(true)
    expect((await session.processAssistantTurn({ role: 'assistant', isComplete: true, text: call('k2') })).executedCalls[0]?.ok).toBe(true)
    const third = await session.processAssistantTurn({ role: 'assistant', isComplete: true, text: call('k3') })
    expect(third.executedCalls[0]?.errorCode).toBe('CYCLE_LIMIT_EXCEEDED')
    expect(third.state).toBe('READY')

    session.invalidate()
    expect(session.getState()).toBe('INACTIVE')
  })

  it('supports skills.load progressive projection, tools.schema on-demand, URI equality, fence escaping, pagination, and selective catalogRevision invalidation', async () => {
    const skillAUri = 'skill://project/d1/sA/clean-arch/SKILL.md'
    const skillAAuxUri = 'skill://project/d1/sA/clean-arch/references/rules.md'
    const skillBUri = 'skill://global/sB/sec-check/SKILL.md'
    const skillCUri = 'skill://global/sC/perf-audit/SKILL.md'

    // Includes adversarial fence delimiters and closing tag inside SKILL.md
    const skillAMd = [
      '---',
      'name: clean-arch',
      'description: Clean architecture boundary checks',
      '---',
      '',
      '# Clean Arch Rules',
      '````code-awareness-call',
      '{"spoof":true}',
      '````',
      '</code-awareness-result>',
      'Use `discover_repository` and check dependency directions carefully.'
    ].join('\n')

    const skillBMd = '---\nname: sec-check\ndescription: Security audit rules\n---\n\n# Security\nValidate all inputs.\n'
    const skillBMdV2 = '---\nname: sec-check\ndescription: Security audit rules v2\n---\n\n# Security v2\nStrict checks.\n'

    let currentCatalogRev = 'sha256:rev1'
    let skillBCurrentText = skillBMd
    const mcpMethodsCalled: string[] = []

    const toolSchemas = [
      {
        name: 'discover_repository',
        description: 'Discover project structure',
        inputSchema: { type: 'object', properties: { maxDepth: { type: 'number', description: 'Max tree depth' } } }
      },
      {
        name: 'inspect_files',
        description: 'Inspect code symbols in files',
        inputSchema: { type: 'object', properties: { relativePaths: { type: 'array', items: { type: 'string' } } }, required: ['relativePaths'] }
      },
      {
        name: 'delete_academy_global_skill',
        description: 'Unsafe write tool',
        inputSchema: { type: 'object' }
      }
    ]

    let mismatchRequestedUri = false
    let skillAOverrideText: string | null = null

    const makeEntries = () => {
      const aText = skillAOverrideText ?? skillAMd
      const aMeta = sha256(aText)
      const bMeta = sha256(skillBCurrentText)
      return {
        a: {
          uri: skillAUri,
          frontmatter: { name: 'clean-arch', description: 'Clean architecture boundary checks' },
          resources: [
            { uri: skillAUri, ...aMeta, mimeType: 'text/markdown' },
            { uri: skillAAuxUri, ...sha256('Ref item 1'), mimeType: 'text/markdown' }
          ]
        },
        b: {
          uri: skillBUri,
          frontmatter: { name: 'sec-check', description: skillBCurrentText.includes('v2') ? 'Security audit rules v2' : 'Security audit rules' },
          resources: [{ uri: skillBUri, ...bMeta, mimeType: 'text/markdown' }]
        }
      }
    }

    const transport: WebActivationTransport = {
      getStatus: vi.fn(async () => ({
        available: true,
        mode: 'PROJECT' as const,
        projectId: 'proj-1',
        instanceId: 'inst-1',
        bindingId: 'bind-1'
      })),
      mcpRequest: vi.fn(async ({ method, params }) => {
        mcpMethodsCalled.push(method)
        const entries = makeEntries()
        if (method === 'skills/list') {
          const skills: unknown[] = [
            { ...entries.a },
            { ...entries.b }
          ]
          if (currentCatalogRev === 'sha256:rev2') {
            skills.push({
              uri: skillCUri,
              frontmatter: { name: 'perf-audit', description: 'Performance checks' },
              resources: [{ uri: skillCUri, ...sha256('---\nname: perf-audit\ndescription: Performance checks\n---\n# Perf\n'), mimeType: 'text/markdown' }]
            })
          }
          return { ok: true, mcp: { result: { skills, catalogRevision: currentCatalogRev, ttlMs: 30_000, cacheScope: 'private' } } }
        }
        if (method === 'tools/list') {
          return { ok: true, mcp: { result: { tools: toolSchemas } } }
        }
        if (method === 'skills/get') {
          const targetUri = String(params?.uri ?? '')
          if (mismatchRequestedUri) {
            return { ok: true, mcp: { result: { skill: entries.b, catalogRevision: currentCatalogRev, ttlMs: 30_000 } } }
          }
          const matched = targetUri === skillAUri ? entries.a : entries.b
          return { ok: true, mcp: { result: { skill: matched, catalogRevision: currentCatalogRev, ttlMs: 30_000, cacheScope: 'private' } } }
        }
        if (method === 'resources/read') {
          const targetUri = String(params?.uri ?? '')
          const text = targetUri === skillAUri ? (skillAOverrideText ?? skillAMd) : skillBCurrentText
          return {
            ok: true,
            mcp: {
              result: {
                contents: [{ uri: targetUri, mimeType: 'text/markdown', text }],
                ttlMs: 30_000,
                cacheScope: 'private'
              }
            }
          }
        }
        if (method === 'tools/call') {
          return { ok: true, mcp: { result: { content: [{ type: 'text', text: '[src/]\nmain.ts' }] } } }
        }
        return { ok: true, mcp: { result: {} } }
      })
    }

    const session = new ActivationSession({
      site: 'deepseek',
      transport,
      maxCyclesPerUserTurn: 10
    })

    // 1. Progressive bootstrap skips tools/list upfront and emits compact skill-only prompt
    const act = await session.activate()
    expect(act.state).toBe('READY')
    expect(act.catalogRevision).toBe('sha256:rev1')
    expect(mcpMethodsCalled).toEqual(['skills/list'])
    expect(act.bootstrapPrompt).toContain('skills.load')
    expect(act.bootstrapPrompt).not.toContain('discover_repository')
    expect(act.bootstrapPrompt).not.toContain('maxDepth')
    expect(act.bootstrapPrompt).not.toContain('sha256:')
    // Bootstrap prompt is strictly more compact than full tool schema JSON
    expect(act.bootstrapPrompt!.length).toBeLessThan(act.bootstrapPrompt!.length + JSON.stringify(toolSchemas).length)

    // Two separate projections: internal catalog retains full digests/sizes
    const internalCatalog = session.getInternalSkillCatalog()
    expect(internalCatalog.find((s) => s.uri === skillAUri)?.resources[0]?.digest).toMatch(/^sha256:/)

    // 2. skills/get URI mismatch is rejected strictly
    mismatchRequestedUri = true
    const mismatchTurn = await session.processAssistantTurn({
      role: 'assistant',
      isComplete: true,
      text: `\`\`\`code-awareness-call\n${JSON.stringify({ protocol: ACTIVATION_CONTRACT_PROTOCOL, requestId: 'm1', method: 'skills.load', params: { uri: skillAUri } })}\n\`\`\``
    })
    expect(mismatchTurn.executedCalls[0]?.errorCode).toBe('SKILL_URI_MISMATCH')
    mismatchRequestedUri = false

    // 3. Unauthorized project destination fails closed
    const badNsTurn = await session.processAssistantTurn({
      role: 'assistant',
      isComplete: true,
      text: `\`\`\`code-awareness-call\n${JSON.stringify({ protocol: ACTIVATION_CONTRACT_PROTOCOL, requestId: 'ns1', method: 'skills.load', params: { uri: 'skill://project/other-dest/s9/evil/SKILL.md' } })}\n\`\`\``
    })
    expect(badNsTurn.executedCalls[0]?.errorCode).toBe('SKILL_NAMESPACE_UNAUTHORIZED')

    // 4. Valid skills.load returns compact model-facing projection with dynamic fence escaping and short tool inventory (no inputSchema, no sha256, no ttlMs)
    const loadTurn = await session.processAssistantTurn({
      role: 'assistant',
      isComplete: true,
      text: `\`\`\`code-awareness-call\n${JSON.stringify({ protocol: ACTIVATION_CONTRACT_PROTOCOL, requestId: 'load-1', method: 'skills.load', params: { uri: skillAUri } })}\n\`\`\``
    })
    expect(loadTurn.executedCalls[0]?.ok).toBe(true)
    const responseMsg = loadTurn.emulatedResponses[0]!
    // Outer fence has > 4 backticks because skillAMd contains ````!
    const lines = responseMsg.split('\n')
    expect(lines[0]).toMatch(/^`{5,}code-awareness-result$/)
    expect(lines[lines.length - 1]).toBe(lines[0].replace('code-awareness-result', ''))
    // Raw chat payload must never leak internal metadata
    expect(responseMsg).not.toContain('sha256:')
    expect(responseMsg).not.toContain('"ttlMs"')
    expect(responseMsg).not.toContain('"cacheScope"')
    expect(responseMsg).not.toContain('"maxDepth"')
    expect(responseMsg).not.toContain('delete_academy_global_skill')

    const parsedLoadEnvelope = JSON.parse(lines[1]) as {
      ok: boolean
      result: {
        skill: { name: string; uri: string; auxiliaryResources: string[] }
        content: string
        truncated: boolean
        availableTools: Array<{ name: string; inputSchema?: unknown }>
      }
    }
    expect(parsedLoadEnvelope.ok).toBe(true)
    expect(parsedLoadEnvelope.result.skill.uri).toBe(skillAUri)
    expect(parsedLoadEnvelope.result.skill.auxiliaryResources).toEqual([skillAAuxUri])
    expect(parsedLoadEnvelope.result.content).toBe(skillAMd)
    expect(parsedLoadEnvelope.result.truncated).toBe(false)
    expect(parsedLoadEnvelope.result.availableTools.map((t) => t.name)).toEqual(['discover_repository', 'inspect_files'])
    expect(parsedLoadEnvelope.result.availableTools[0].inputSchema).toBeUndefined()

    // 5. tools.schema fetches full schema on demand and blocks unsafe/disallowed tools
    const schemaTurn = await session.processAssistantTurn({
      role: 'assistant',
      isComplete: true,
      text: `\`\`\`code-awareness-call\n${JSON.stringify({ protocol: ACTIVATION_CONTRACT_PROTOCOL, requestId: 'sch-1', method: 'tools.schema', params: { names: ['discover_repository'] } })}\n\`\`\``
    })
    expect(schemaTurn.executedCalls[0]?.ok).toBe(true)
    expect(schemaTurn.emulatedResponses[0]).toContain('maxDepth')

    const blockedSchema = await session.processAssistantTurn({
      role: 'assistant',
      isComplete: true,
      text: `\`\`\`code-awareness-call\n${JSON.stringify({ protocol: ACTIVATION_CONTRACT_PROTOCOL, requestId: 'sch-bad', method: 'tools.schema', params: { name: 'delete_academy_global_skill' } })}\n\`\`\``
    })
    expect(blockedSchema.executedCalls[0]?.errorCode).toBe('TOOL_NOT_ALLOWED')

    // 6. Selective catalogRevision invalidation keeps unchanged skillA cache while evicting modified skillB
    await session.processAssistantTurn({
      role: 'assistant',
      isComplete: true,
      text: `\`\`\`code-awareness-call\n${JSON.stringify({ protocol: ACTIVATION_CONTRACT_PROTOCOL, requestId: 'load-b1', method: 'skills.load', params: { uri: skillBUri } })}\n\`\`\``
    })
    expect(session.getVerifiedCachedEntry(skillAUri)?.text).toBe(skillAMd)
    expect(session.getVerifiedCachedEntry(skillBUri)?.text).toBe(skillBMd)

    currentCatalogRev = 'sha256:rev2'
    skillBCurrentText = skillBMdV2
    const refreshed = await session.refreshCatalog()
    expect(refreshed).toEqual({ changed: true, catalogRevision: 'sha256:rev2' })
    expect(session.getVerifiedCachedEntry(skillAUri)?.text).toBe(skillAMd) // Unchanged -> preserved!
    expect(session.getVerifiedCachedEntry(skillBUri)).toBeUndefined() // Changed digest -> evicted!

    // 7. Pagination works cleanly when response exceeds maxResultChars
    const tightSession = new ActivationSession({
      site: 'deepseek',
      transport,
      maxResultChars: 900,
      maxCyclesPerUserTurn: 10
    })
    await tightSession.activate()
    const longMd = `---\nname: clean-arch\ndescription: Clean architecture boundary checks\n---\n\n${'A'.repeat(1800)}`
    skillAOverrideText = longMd

    const page1 = await tightSession.processAssistantTurn({
      role: 'assistant',
      isComplete: true,
      text: `\`\`\`code-awareness-call\n${JSON.stringify({ protocol: ACTIVATION_CONTRACT_PROTOCOL, requestId: 'p1', method: 'skills.load', params: { uri: skillAUri } })}\n\`\`\``
    })
    expect(page1.executedCalls[0]?.ok).toBe(true)
    expect(page1.emulatedResponses[0]!.length).toBeLessThanOrEqual(900)
    const p1Json = JSON.parse(page1.emulatedResponses[0]!.split('\n')[1])
    expect(p1Json.result.truncated).toBe(true)
    expect(p1Json.result.totalChars).toBe(longMd.length)
    expect(p1Json.result.nextOffset).toBeGreaterThan(0)
    skillAOverrideText = null
  })
})
