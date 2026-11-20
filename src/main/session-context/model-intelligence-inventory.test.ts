import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MODEL_INTELLIGENCE_FIELD_INVENTORY,
  MODEL_INTELLIGENCE_INVENTORY_VERSION,
  extractAuthorizedCodexTokenCount,
  extractAuthorizedCodexTurnContext,
  extractAuthorizedEntireSessionMetadata,
  qualifyEntireVersion
} from './model-intelligence-inventory'

describe('model-intelligence-inventory v1', () => {
  it('maintains unique, well-formed field dispositions aligned with the versioned markdown artifact', () => {
    expect(MODEL_INTELLIGENCE_INVENTORY_VERSION).toBe('model-intelligence-inventory-v1')
    const ids = MODEL_INTELLIGENCE_FIELD_INVENTORY.map(spec => spec.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const spec of MODEL_INTELLIGENCE_FIELD_INVENTORY) {
      expect(spec.versions.length).toBeGreaterThan(0)
      expect(spec.rationale.length).toBeGreaterThan(5)
      if (spec.disposition === 'PERSISTED') {
        expect(spec.targetStoreField).toBeTruthy()
      }
    }
    const markdown = readFileSync(join(__dirname, 'model-intelligence-inventory.v1.md'), 'utf8')
    expect(markdown).toContain('model-intelligence-inventory-v1')
    for (const surface of new Set(MODEL_INTELLIGENCE_FIELD_INVENTORY.map(s => s.surface))) {
      const normalizedPrefix = surface.startsWith('entire_transcript_') ? 'entire_transcript_' : surface
      expect(markdown).toContain(normalizedPrefix)
    }
  })

  it('qualifies Entire 0.12.2 and 0.13.4 only', () => {
    expect(qualifyEntireVersion('0.12.2')).toBe('0.12.2')
    expect(qualifyEntireVersion('0.13.4')).toBe('0.13.4')
    expect(qualifyEntireVersion('0.11.0')).toBeUndefined()
    expect(qualifyEntireVersion(undefined)).toBeUndefined()
  })

  it('extracts Codex turn_context fields and separates benign unknown keys from sensitive keys', () => {
    const parsed = extractAuthorizedCodexTurnContext({
      cwd: 'C:/repo',
      model: 'gpt-5.4',
      effort: 'high',
      approval_policy: 'never',
      sandbox_policy: { type: 'workspace-write' },
      collaboration_mode: { mode: 'default' },
      user_instructions: 'SECRET PROMPT TEXT',
      model_provider: 'openai',
      raw_prompt: 'MUST_BE_EXCLUDED',
      api_key: 'sk-test'
    })
    expect(parsed).toEqual({
      model: 'gpt-5.4',
      effort: 'high',
      approvalPolicy: 'never',
      sandboxPolicyType: 'workspace-write',
      collaborationMode: 'default',
      unknownFields: {
        benignPaths: ['turn_context.payload.model_provider'],
        excludedSensitivePaths: ['turn_context.payload.api_key', 'turn_context.payload.raw_prompt']
      }
    })
  })

  it('distinguishes 0 vs null/omitted and cumulative vs delta token counts in Codex token_count', () => {
    const parsed = extractAuthorizedCodexTokenCount({
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 1200,
          cached_input_tokens: 0,
          output_tokens: 300,
          reasoning_output_tokens: null,
          total_tokens: 1500
        },
        last_token_usage: {
          input_tokens: 200,
          output_tokens: 50,
          total_tokens: 250
        },
        model_context_window: 258400
      }
    })
    expect(parsed?.totalUsage).toEqual({
      input: 1200,
      cacheRead: 0,
      output: 300,
      total: 1500
    })
    expect(parsed?.totalUsage?.reasoningOutput).toBeUndefined()
    expect(parsed?.lastUsage).toEqual({
      input: 200,
      output: 50,
      total: 250
    })
    expect(parsed?.modelContextWindow).toBe(258400)
  })

  it('extracts Entire 0.12.2 and 0.13.4 session metadata without mutating absent vs zero values', () => {
    const legacy = extractAuthorizedEntireSessionMetadata({
      session_id: 's-122',
      agent: 'codex',
      status: 'ENDED',
      turns: 3,
      pending_turns: 0
    }, '0.12.2')
    expect(legacy).toEqual({
      providerVersion: '0.12.2',
      turnsCount: 3,
      pendingTurnsCount: 0,
      unknownFields: { benignPaths: [], excludedSensitivePaths: [] }
    })

    const modern = extractAuthorizedEntireSessionMetadata({
      session_id: 's-134',
      agent: 'claude-code',
      status: 'ACTIVE',
      model: 'claude-sonnet-4-6',
      tokens: { input: 500, output: 100, cache_read: 0, total: 600, api_calls: 2 },
      provider_client: 'cli',
      prompt_preview: 'private prompt'
    }, '0.13.4')
    expect(modern).toEqual({
      providerVersion: '0.13.4',
      model: 'claude-sonnet-4-6',
      tokenUsage: { input: 500, output: 100, cacheRead: 0, total: 600, apiCalls: 2 },
      unknownFields: {
        benignPaths: ['entire.session.provider_client'],
        excludedSensitivePaths: ['entire.session.prompt_preview']
      }
    })
  })
})
