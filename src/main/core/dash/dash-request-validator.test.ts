import { describe, expect, it } from 'vitest'
import { validateDashRequest } from './dash-request-validator'
import { parseDashRequest } from './dash-request-parser'
const request = () => ({
  protocol: 'code-dash/v2',
  steps: [
    { id: 'x', find: 'element', where: { name: { exact: 'Sync' } }, expect: { min: 1, max: 1 } }
  ],
  emit: [{ from: 'x', include: ['path', 'source'] }]
})
describe('v2 strict contract', () => {
  it('accepts JSON and fenced JSON', () => {
    for (const text of [
      JSON.stringify(request()),
      '```json\n' + JSON.stringify(request()) + '\n```'
    ]) {
      const parsed = parseDashRequest(text)
      expect(parsed.success).toBe(true)
      if (parsed.success) expect(validateDashRequest(parsed.request).success).toBe(true)
    }
  })
  it.each([
    [{ ...request(), extra: true }, 'UNKNOWN_FIELD'],
    [{ ...request(), protocol: 'code-dash/v1' }, 'UNKNOWN_PROTOCOL'],
    [{ ...request(), steps: [{ ...request().steps[0], where: {} }] }, 'INVALID_FILTER'],
    [{ ...request(), steps: [{ ...request().steps[0], expect: undefined }] }, 'INVALID_STEP'],
    [{ ...request(), emit: [{ from: 'later', include: ['source'] }] }, 'UNKNOWN_STEP_REFERENCE'],
    [{ ...request(), emit: [{ from: 'x', include: ['fileSource'] }] }, 'TYPE_MISMATCH'],
    [{ ...request(), steps: [request().steps[0], request().steps[0]] }, 'DUPLICATE_STEP_ID'],
    [
      {
        ...request(),
        steps: [
          request().steps[0],
          { id: 'y', from: 'x', follow: 'importedBy', expect: { min: 0, max: 1 } }
        ]
      },
      'TYPE_MISMATCH'
    ]
  ])('fails closed', (input, code) => {
    expect(validateDashRequest(input)).toMatchObject({ success: false, code })
  })
})
