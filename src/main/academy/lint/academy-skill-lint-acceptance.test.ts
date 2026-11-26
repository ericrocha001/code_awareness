import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../../continuum/agent-authority'
import { ChannelMcpAdapter } from '../../mcp/channel-mcp-adapter'
import { createMcpHttpServer } from '../../mcp/mcp-http-server'
import type { McpProjectContext } from '../../mcp/project-mcp-context'
import { digest } from '../../session-context/privacy'
import { SessionStore } from '../../session-context/store'
import { AcademyService } from '../academy-service'

const cleanup: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

function safeRemove(dir: string) {
  execFileSync(
    'node',
    [
      '-e',
      "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })",
      dir
    ],
    { windowsHide: true }
  )
}

describe('Academy Skill Linter global acceptance (U1-U4 real HTTP/SDK/AJV)', () => {
  it('executes full Signal + Navigation + Focal Edit + Maintenance In-Flow journey without blocking or AI', async () => {
    const [{ Client }, { StreamableHTTPClientTransport }, { AjvJsonSchemaValidator }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      import('@modelcontextprotocol/sdk/validation/ajv')
    ])

    const base = mkdtempSync(join(tmpdir(), 'academy-lint-e2e-'))
    cleanup.push(() => safeRemove(base))
    const repoRoot = join(base, 'repo')
    const storePath = join(base, 'session-context.sqlite')
    const academyDbPath = join(base, 'academy.sqlite')
    mkdirSync(repoRoot, { recursive: true })
    mkdirSync(dirname(storePath), { recursive: true })

    const academy = new AcademyService(academyDbPath)
    cleanup.push(() => academy.close())
    const dest = academy.store.upsertDestination(repoRoot, 'Repo')

    const sessionStore = new SessionStore(storePath, dest.id)
    cleanup.push(() => sessionStore.close())
    const { sessionId } = sessionStore.ingest(
      {
        providerSessionId: 'lint-accept-sess',
        providerVersion: '1.0.0',
        agent: 'codex',
        state: 'ENDED',
        endedAt: '2026-11-25T10:00:00.000Z',
        coverage: 'PARTIAL',
        importState: 'METADATA_ONLY',
        sourceDigest: digest('lint-accept-sess'),
        sourceBytes: 0
      },
      []
    )

    const principal = authenticatedAgentPrincipal('MCP', () => true)
    const authority = authorizeArtifactAgent(principal, dest.id, () => true, undefined, {
      sessionWitness: { provider: 'codex', sessionId }
    })

    const adapter = new ChannelMcpAdapter(
      {
        projectId: dest.id,
        repoRoot,
        navigation: {} as McpProjectContext['navigation'],
        continuum: { repositoryId: dest.id } as never,
        skillObserver: ev => {
          sessionStore.skillIntelligence.recordSkillEvent(ev)
        },
        skillIntelligence: sessionStore.skillIntelligence
      },
      undefined,
      undefined,
      undefined,
      academy
    )

    const server = createMcpHttpServer(adapter, () => {}, undefined, undefined, () => authority)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(
      () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
    )
    const address = server.address() as { port: number }
    const mcpEndpoint = `http://127.0.0.1:${address.port}/mcp`

    const client = new Client({ name: 'academy-lint-acceptance', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(mcpEndpoint))
    await client.connect(transport)
    cleanup.push(() => client.close())

    const { tools } = await client.listTools()
    const ajv = new AjvJsonSchemaValidator()
    const validators = new Map<string, ReturnType<typeof ajv.getValidator>>()
    const outputValidators = new Map<string, ReturnType<typeof ajv.getValidator>>()
    for (const tool of tools) {
      validators.set(tool.name, ajv.getValidator(tool.inputSchema as any))
      if (tool.outputSchema) {
        outputValidators.set(tool.name, ajv.getValidator(tool.outputSchema as any))
      }
    }
    expect(outputValidators.has('get_academy_skill')).toBe(true)

    const callMcp = async (name: string, args: Record<string, unknown>) => {
      const validate = validators.get(name)
      expect(validate).toBeDefined()
      expect(validate!(args).valid).toBe(true)
      const res = await client.callTool({ name, arguments: args })
      const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}'
      const structuredContent = res.structuredContent as Record<string, unknown> | undefined
      if (res.isError) {
        expect(structuredContent).toBeUndefined()
      } else {
        const outValidate = outputValidators.get(name)
        if (outValidate) {
          expect(structuredContent).toBeDefined()
          expect(outValidate(structuredContent).valid).toBe(true)
        }
      }
      return { isError: res.isError === true, raw: text, data: JSON.parse(text), structuredContent }
    }

    // 1. Create a realistic large skill with duplicated prose, broken local link, and new script
    const duplicatedProse =
      'Verify every canonical target path and read the exact section before applying edits so no unintended sibling sections are modified.'
    const fillerLines = Array.from(
      { length: 520 },
      (_, idx) => `Guideline ${idx + 1}: preserve exact canonical formatting and verify preconditions.`
    ).join('\n')
    const v1Body = [
      '---',
      'name: acceptance-skill',
      'description: Realistic skill with large root, duplicate prose, broken link, and script',
      '---',
      '# Overview',
      'BODY_SENTINEL_SECRET_V1',
      '',
      duplicatedProse,
      '',
      'See [guide](references/guide.md) before editing.',
      '',
      duplicatedProse,
      '',
      '# Guidelines',
      fillerLines
    ].join('\n')

    const created = await callMcp('create_academy_skill', {
      scope: 'PROJECT',
      projectIds: [dest.id],
      package: {
        skillMd: v1Body,
        artifacts: { 'scripts/helper.sh': '#!/bin/sh\necho ok\n' }
      }
    })
    expect(created.isError).toBe(false)
    // Legacy fields preserved + automatic in-flow lint present
    expect(created.data.id).toBeTruthy()
    expect(created.data.currentVersion).toBe(1)
    expect(created.data.publication).toBeDefined()
    expect(created.data.lint.coverage).toBe('COMPLETE')
    expect(created.data.lint.lintHealth).toBe('REVIEW_OPEN')
    expect(created.data.lint.delta.introduced.some((f: any) => f.ruleId === 'CAPABILITY_SURFACE_CHANGE')).toBe(true)
    expect(created.data.lint.delta.introduced.some((f: any) => f.ruleId === 'ROOT_CONTEXT_REVIEW')).toBe(true)

    const skillId = created.data.id as string
    const v1Hash = created.data.current.packageHash as string

    // 2. Catalog & Focal audit
    const catalogAudit = await callMcp('get_academy_skill_lint', { limit: 10 })
    expect(catalogAudit.isError).toBe(false)
    expect(catalogAudit.data.items[0].skillId).toBe(skillId)
    expect(catalogAudit.data.items[0].lintHealth).toBe('REVIEW_OPEN')

    const focalAudit = await callMcp('get_academy_skill_lint', { skillId, includeInventory: true })
    expect(focalAudit.isError).toBe(false)
    expect(focalAudit.data.findings[0].ruleId).toBe('CAPABILITY_SURFACE_CHANGE')
    expect(focalAudit.data.findings[0].priority).toBe('HIGH')
    expect(focalAudit.data.inventory.scripts.map((s: any) => s.path)).toEqual(['scripts/helper.sh'])

    const focalActions = await callMcp('get_academy_skill_lint', { skillId, view: 'actions' })
    expect(focalActions.isError).toBe(false)
    expect(focalActions.data.view).toBe('actions')
    expect(focalActions.data.nextAction.priority).toBe('HIGH')

    const catalogActions = await callMcp('get_academy_skill_lint', { view: 'actions', limit: 10 })
    expect(catalogActions.isError).toBe(false)
    expect(catalogActions.data.items[0].nextAction.priority).toBe('NORMAL')

    const focalRefCost = await callMcp('get_academy_skill_lint', { skillId, deepen: ['REFERENCE_COST'] })
    expect(focalRefCost.isError).toBe(false)
    expect(focalRefCost.data.referenceCost.directReferenceCount).toBe(0)

    // 3. Selective navigation: manifest (no body), outline, section (no siblings) + structuredContent
    const manifest = await callMcp('get_academy_skill', { skillId, view: 'manifest' })
    expect(manifest.raw).not.toContain('BODY_SENTINEL_SECRET_V1')
    expect(manifest.structuredContent).toEqual(manifest.data)

    const outline = await callMcp('get_academy_skill', {
      skillId,
      view: 'outline',
      version: 1,
      path: 'SKILL.md'
    })
    expect(outline.structuredContent).toEqual(outline.data)
    const overviewHeading = outline.data.entries.find((e: any) => e.kind === 'HEADING' && e.title === 'Overview')
    const section = await callMcp('get_academy_skill', {
      skillId,
      view: 'section',
      version: 1,
      path: 'SKILL.md',
      selector: overviewHeading.selector
    })
    expect(section.data.content.text).toContain('BODY_SENTINEL_SECRET_V1')
    expect(section.data.content.text).not.toContain('Guideline 1:')
    expect(section.structuredContent).toMatchObject({
      skillId,
      name: 'acceptance-skill',
      scope: 'PROJECT',
      version: 1,
      packageHash: v1Hash,
      path: 'SKILL.md',
      selector: overviewHeading.selector,
      kind: 'HEADING',
      blockType: 'heading',
      includeDescendants: false,
      content: section.data.content.text,
      offset: section.data.content.offset,
      totalCharacters: section.data.content.totalCharacters,
      nextOffset: section.data.content.nextOffset
    })
    expect((section.structuredContent as any).text).toBeUndefined()

    const searchView = await callMcp('get_academy_skill', {
      skillId,
      view: 'search',
      version: 1,
      query: 'BODY_SENTINEL_SECRET_V1'
    })
    expect(searchView.structuredContent).toEqual(searchView.data)

    const legacyPackage = await callMcp('get_academy_skill', { skillId })
    expect(legacyPackage.structuredContent).toEqual(legacyPackage.data)

    // Invalid selector/hash/path must return isError without structuredContent
    const staleErr = await callMcp('get_academy_skill', {
      skillId,
      view: 'resource',
      version: 1,
      path: '../escape.md'
    })
    expect(staleErr.isError).toBe(true)
    expect(staleErr.structuredContent).toBeUndefined()

    // Check SessionStore SkillIntelligence observation classes
    const recordedEvents = sessionStore.skillIntelligence.querySkillEvents({ sessionId, limit: 20 }).events
    expect(
      recordedEvents.some(e => e.operation === 'get_academy_skill' && e.observationClass === 'DISCOVERED_MANIFEST_FETCHED')
    ).toBe(true)
    expect(
      recordedEvents.some(e => e.operation === 'get_academy_skill' && e.observationClass === 'CONTENT_DELIVERED')
    ).toBe(true)

    // 4. PREVIEW focal edit: shard guidelines, fix broken link, add secret-bearing external URL (must sanitize)
    const edits = [
      { op: 'add', path: 'references/guide.md', content: '# Guide\n\n' + fillerLines.slice(0, 500) + '\n' },
      {
        op: 'replace',
        path: 'SKILL.md',
        oldText: 'See [guide](references/guide.md) before editing.',
        newText: 'See [guide](references/guide.md) and [docs](https://user:pass@api.example/v1?token=SECRET_XYZ).'
      }
    ]
    const preview = await callMcp('edit_academy_skill', {
      skillId,
      expectedVersion: 1,
      expectedPackageHash: v1Hash,
      mode: 'PREVIEW',
      edits
    })
    expect(preview.isError).toBe(false)
    expect(preview.data.state).toBe('PREVIEW')
    expect(preview.data.valid).toBe(true)
    expect(JSON.stringify(preview.data.lint)).not.toContain('SECRET_XYZ')
    expect(JSON.stringify(preview.data.lint)).not.toContain('pass@')
    expect(preview.data.lint.delta.resolved.some((f: any) => f.ruleId === 'LOCAL_REFERENCE_BROKEN')).toBe(true)
    expect(preview.data.lint.delta.introduced.some((f: any) => f.ruleId === 'CAPABILITY_SURFACE_CHANGE')).toBe(true)
    expect(academy.get(skillId).currentVersion).toBe(1)

    // 4b. Impact preflight via edits (AJV-validated, without sending full package) matches PREVIEW hash
    const impactByEdits = await callMcp('analyze_academy_change_impact', {
      skillId,
      expectedVersion: 1,
      expectedPackageHash: v1Hash,
      edits
    })
    expect(impactByEdits.isError).toBe(false)
    expect(impactByEdits.data.snapshot.candidateHash).toBe(preview.data.candidateHash)
    expect(academy.get(skillId).currentVersion).toBe(1)

    // 5. APPLY focal edit -> v2 with automatic lint
    const applied = await callMcp('edit_academy_skill', {
      skillId,
      expectedVersion: 1,
      expectedPackageHash: v1Hash,
      mode: 'APPLY',
      edits
    })
    expect(applied.isError).toBe(false)
    expect(applied.raw).not.toContain('SECRET_XYZ')
    expect(applied.raw).not.toContain('pass@')
    expect(applied.data.state).toBe('PERSISTED')
    expect(applied.data.version).toBe(2)
    expect(applied.data.lint.delta.resolved.some((f: any) => f.ruleId === 'LOCAL_REFERENCE_BROKEN')).toBe(true)
    expect(applied.data.lint.delta.introduced.some((f: any) => f.ruleId === 'CAPABILITY_SURFACE_CHANGE')).toBe(true)

    // 6. Reduce root size (still > 500 lines -> REVIEW persists but improved:true) via update_academy_skill
    const v2Pkg = academy.get(skillId).current.package
    const v3Body = v2Pkg.skillMd.replace(fillerLines, Array.from({ length: 505 }, (_, i) => `Short ${i}`).join('\n'))
    const updatedV3 = await callMcp('update_academy_skill', {
      skillId,
      expectedVersion: 2,
      package: { ...v2Pkg, skillMd: v3Body }
    })
    expect(updatedV3.isError).toBe(false)
    expect(updatedV3.data.current.origin).toBe('MCP')
    const persistedRoot = updatedV3.data.lint.delta.persistent.top.find((f: any) => f.ruleId === 'ROOT_CONTEXT_REVIEW')
    expect(persistedRoot?.improved).toBe(true)

    // 7. Two consecutive unchanged edits on SKILL.md -> stagnationNotice without blocking
    const v4 = await callMcp('update_academy_skill', {
      skillId,
      expectedVersion: 3,
      package: { ...v2Pkg, skillMd: v3Body.replace('BODY_SENTINEL_SECRET_V1', 'BODY_SENTINEL_V4') }
    })
    const v5 = await callMcp('update_academy_skill', {
      skillId,
      expectedVersion: 4,
      package: { ...v2Pkg, skillMd: v3Body.replace('BODY_SENTINEL_SECRET_V1', 'BODY_SENTINEL_V5') }
    })
    expect(v5.data.lint.stagnationNotice).toBeDefined()
    expect(v5.data.lint.stagnationNotice.message).toContain('Do not repeat the same strategy')

    // 8. Rollback to v3 package triggers CYCLE_DETECTED recurrence without blocking
    const v6 = await callMcp('update_academy_skill', {
      skillId,
      expectedVersion: 5,
      package: { ...v2Pkg, skillMd: v3Body }
    })
    expect(v6.data.lint.recurrence).toMatchObject({ state: 'CYCLE_DETECTED', matchedVersion: 3 })

    // 9. Review all open REVIEW findings on v6 -> REVIEWED
    const repV6 = await callMcp('get_academy_skill_lint', { skillId })
    for (const f of repV6.data.findings.filter((x: any) => x.category === 'REVIEW')) {
      const rev = await callMcp('review_academy_skill_lint', {
        skillId,
        expectedVersion: 6,
        findingId: f.findingId,
        evidenceFingerprint: f.evidenceFingerprint,
        action: 'RECORD',
        rationale: 'Accepted in acceptance walkthrough'
      })
      expect(rev.isError).toBe(false)
    }
    const repAfterRev = await callMcp('get_academy_skill_lint', { skillId })
    expect(repAfterRev.data.lintHealth).toBe('REVIEWED')

    // 10. Historical v1 remains literally recoverable + short paged CRLF/Unicode resource reconstruction via structuredContent
    const histV1 = await callMcp('get_academy_skill', {
      skillId,
      view: 'resource',
      version: 1,
      path: 'SKILL.md'
    })
    expect(histV1.data.content.text).toContain('BODY_SENTINEL_SECRET_V1')
    expect(histV1.structuredContent?.content).toBe(histV1.data.content.text)

    const unicodeArtifact = 'Linha 1 ç 漢字\r\nLinha 2 🧪 𠀋\r\nFim'
    const v7 = await callMcp('update_academy_skill', {
      skillId,
      expectedVersion: 6,
      package: {
        ...v2Pkg,
        skillMd: v3Body + '\nUnicode\n',
        artifacts: { ...v2Pkg.artifacts, 'references/unicode.md': unicodeArtifact }
      }
    })
    expect(v7.isError).toBe(false)
    let reconstructed = ''
    let nextOffset: number | null = 0
    while (nextOffset !== null) {
      const page = await callMcp('get_academy_skill', {
        skillId,
        view: 'resource',
        version: 7,
        path: 'references/unicode.md',
        textOffset: nextOffset,
        textLimit: 8
      })
      expect(typeof page.structuredContent?.content).toBe('string')
      expect(page.structuredContent?.content).toBe(page.data.content.text)
      expect(page.structuredContent?.offset).toBe(page.data.content.offset)
      expect(page.structuredContent?.totalCharacters).toBe(unicodeArtifact.length)
      reconstructed += page.structuredContent!.content as string
      nextOffset = page.structuredContent!.nextOffset as number | null
    }
    expect(reconstructed).toBe(unicodeArtifact)

    // 11. Analysis failure after write keeps PERSISTED result and marks lint UNAVAILABLE/ANALYSIS_FAILED
    const inFlowSpy = vi.spyOn(academy.lint, 'inFlow').mockImplementationOnce(() => {
      throw new Error('SIMULATED_LINT_FAILURE')
    })
    const v8 = await callMcp('update_academy_skill', {
      skillId,
      expectedVersion: 7,
      package: { ...v2Pkg, skillMd: v3Body + '\nFinal note\n' }
    })
    expect(v8.isError).toBe(false)
    expect(v8.data.currentVersion).toBe(8)
    expect(v8.data.lint).toMatchObject({ coverage: 'UNAVAILABLE', reason: 'ANALYSIS_FAILED' })
    inFlowSpy.mockRestore()

    // 12. Verify SQLite academy_lint_facts stores NO package bodies
    const rawDb = new Database(academyDbPath, { readonly: true })
    const factRows = rawDb.prepare('SELECT facts_json FROM academy_lint_facts').all()
    rawDb.close()
    expect(JSON.stringify(factRows)).not.toContain('BODY_SENTINEL_SECRET_V1')
    expect(JSON.stringify(factRows)).not.toContain('SECRET_XYZ')
  }, 30_000)
})
