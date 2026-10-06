import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'
import { DiagnosticSourceAccess } from '../diagnostic-source-access/diagnostic-source-access'
import type { RuntimeRestartController } from '../runtime-restart/runtime-restart-controller'
import type { ValidationExecution } from '../validation-execution/validation-execution'
import { ChannelMcpAdapter } from './channel-mcp-adapter'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

describe('operational MCP capabilities', () => {
  it('binds project capabilities while keeping validation and diagnostics independent from CodeMap readiness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'operational-mcp-'))
    roots.push(root)
    writeFileSync(join(root, 'source.ts'), 'const independent = true', 'utf8')
    const unavailable = vi.fn(async () => { throw new Error('CODEMAP_UNAVAILABLE') })
    const navigation = {
      discoverRepository: unavailable, getRelationships: unavailable, inspectFiles: unavailable,
      getReferences: unavailable, getSymbolDependencies: unavailable, getSymbolHierarchy: unavailable,
      readCode: unavailable
    } as unknown as ProjectContextNavigation
    const validationExecution = {
      listProfiles: () => [{ id: 'typecheck', description: 'typecheck', runtime: 'NODE', lane: 'TYPECHECK', acceptsTargets: false, proofKind: 'TYPECHECK', scope: ['repository'], timeoutMs: 1, script: 'typecheck' }]
    } as unknown as ValidationExecution
    const runtimeRestart = { request: async () => ({ status: 'RESTART_NOT_REQUIRED', message: 'not required' }) } as unknown as RuntimeRestartController
    const adapter = new ChannelMcpAdapter({ projectId: 'project', repoRoot: root, navigation, validationExecution, diagnosticSourceAccess: new DiagnosticSourceAccess(root), runtimeRestart })

    expect(adapter.listTools().map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'list_validation_profiles', 'start_validation', 'get_validation_run',
      'diagnostic_list_directory', 'diagnostic_read_file', 'diagnostic_find_text', 'request_runtime_restart'
    ]))
    const diagnostic = await adapter.callTool('diagnostic_read_file', { relativePath: 'source.ts', startLine: 1, endLine: 1 })
    expect(diagnostic.content[0].text).toContain('independent')
    const profiles = await adapter.callTool('list_validation_profiles', {})
    expect(profiles.content[0].text).toContain('typecheck')
    expect(unavailable).not.toHaveBeenCalled()
  })
})
