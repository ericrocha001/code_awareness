import { afterEach, expect, it } from 'vitest'
import { fixture, markdown, withFixtureDatabase } from './continuum-test-fixtures'
import { ContinuumService } from './continuum-service'
import { executeGetArtifact, executePublishArtifact, executeUpdateArtifact } from './continuum-mcp'
import { editArtifactStatus } from './artifact-lifecycle-policy'
const closes: (() => void)[] = []
afterEach(() => { closes.splice(0).reverse().forEach(close => close()) })
function setup() { const f = fixture(); closes.push(f.close); return f }
const body = '# Governed artifact\n\nThis introduction supplies enough explicit semantic context.\n\nBody literal 🚀.'
it('U1 materializes safe initial states in economic and authored publications, without inventing other lifecycle states', () => {
  const f = setup()
  for (const kind of ['EXECUTABLE_PLAN','WORK_ITEM']) {
    const receipt = f.service.publish(body, { kind }), artifact = f.service.get(receipt.artifactId)!
    expect(artifact.metadata.status).toBe('PENDING'); expect(artifact.rawMarkdown).toContain('status: PENDING')
    expect(artifact.lifecycle).toMatchObject({ effectiveState: 'PENDING', basis: 'INITIAL_STATE' })
  }
  for (const kind of ['DOCUMENT','OBSERVATION','IMPLEMENTATION_HANDOFF','VALIDATION_PROOF','ARCHITECTURAL_DECISION']) {
    const receipt = f.service.publish(body, { kind })
    expect(f.service.get(receipt.artifactId)!.metadata.status).toBeUndefined()
  }
  const authored = markdown('Authored', 'kindAlias: preserved\nlifecyclePolicy: WORK\n')
  const receipt = f.service.publish(authored)
  expect(f.service.get(receipt.artifactId)!.metadata.status).toBe('PENDING')
  expect(f.service.get(receipt.artifactId)!.rawMarkdown.replace('status: PENDING\n', '')).toBe(authored)
})
it('U1 preserves semantic dates, explicit legacy status, content and history without read-time normalization', () => {
  const f = setup(), raw = markdown('Legacy', 'status: ACTIVE\ndate: "2020-01-01"\n')
  const receipt = f.service.publish(raw), before = f.store.get(receipt.artifactId)
  const read = f.service.get(receipt.artifactId)!
  expect(read.rawMarkdown).toBe(raw); expect(read.metadata.date).toBe('2020-01-01')
  expect(read.lifecycle).toMatchObject({ effectiveState: 'ACTIVE', basis: 'NO_LIFECYCLE_POLICY' })
  expect(f.store.get(receipt.artifactId)).toEqual(before)
  withFixtureDatabase(f.path, db => expect(db.prepare('SELECT count(*) AS n FROM artifact_revisions').get()).toEqual({ n: 1 }))
})
it('U1 exposes observed operation separately through MCP and never turns activity or a handoff claim into approval', () => {
  const f = setup(), service = new ContinuumService(f.store, undefined, undefined, { activity: () => ({ state: 'IN_PROGRESS', source: 'VALIDATION_EXECUTION', evidenceRef: 'run-fixture' }) })
  const receipt = service.publish(body, { kind: 'EXECUTABLE_PLAN' })
  const read = JSON.parse(executeGetArtifact(service, { artifactId: receipt.artifactId }).content[0].text)
  expect(read).toMatchObject({ metadata: { status: 'PENDING' }, lifecycle: { effectiveState: 'PENDING' }, operationalActivity: { state: 'IN_PROGRESS' } })
  const legacy = service.publish(markdown('Claim', 'status: VALIDATED\n'))
  expect(service.get(legacy.artifactId)!.rawMarkdown).toContain('status: VALIDATED')
  const handoff = service.publish(body, { kind: 'IMPLEMENTATION_HANDOFF' })
  expect(service.get(handoff.artifactId)!.lifecycle?.effectiveState).toBeNull()
})
it('U1 edits only the status scalar while preserving body, YAML comments and line endings', () => {
  const raw = '\uFEFF---\r\nname: Literal # keep\r\nkind: EXECUTABLE_PLAN\r\nstatus: "PENDING" # keep too\r\n---\r\n# Literal\r\n\r\n$(private) 🚀\r\n'
  expect(editArtifactStatus(raw, 'COMPLETED')).toBe(raw.replace('"PENDING"', 'COMPLETED'))
})

it('U3 publication rehearsal keeps agent input semantic across Plan, Handoff, Work Item and a kind without lifecycle', () => {
  const f = setup()
  for (const kind of ['EXECUTABLE_PLAN', 'IMPLEMENTATION_HANDOFF', 'WORK_ITEM', 'OBSERVATION']) {
    const input = { rawMarkdown: body, kind }
    const published = executePublishArtifact(f.service, input)
    expect(published.isError).not.toBe(true)
    const receipt = JSON.parse(published.content[0].text), artifact = f.service.get(receipt.artifactId)!
    expect(artifact.metadata).toMatchObject({ kind, name: 'Governed artifact', description: 'This introduction supplies enough explicit semantic context.' })
    expect(artifact.rawMarkdown.endsWith(body)).toBe(true)
    expect(artifact.metadata.status).toBe(['EXECUTABLE_PLAN', 'WORK_ITEM'].includes(kind) ? 'PENDING' : undefined)
    expect(artifact.metadata.date).toBeUndefined()
    expect(artifact.metadata.relations).toBeUndefined()
    expect(artifact.revision).toBe(1); expect(artifact.createdAt).toBeTruthy(); expect(artifact.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.keys(input)).toEqual(['rawMarkdown', 'kind'])
  }
})

it('preserves native observations alongside scoped agent declarations through ordinary MCP CAS edits', () => {
  const f = setup(), published = f.service.publish(body, { kind: 'EXECUTABLE_PLAN' })
  const initial = f.store.get(published.artifactId)!
  const observation = { origin: 'HOOK_OBSERVED', checkpoint: 'checkpoint-fixture' }
  f.store.updatePublished({ artifactId: initial.artifactId, expectedRevision: 1, rawMarkdown: initial.rawMarkdown, metadata: initial.metadata, provenance: { hookObservation: observation } }, 'a'.repeat(64))
  const current = f.store.get(initial.artifactId)!
  const declaration = '\nagentAttestations:\n  - origin: AGENT_ATTESTED\n    reference: report-fixture\n    scope: missing-hook-observation\n    limitations: Not independently verified\n'
  const raw = current.rawMarkdown.replace('status: PENDING', 'status: PENDING' + declaration)
  const updated = executeUpdateArtifact(f.service, { artifactId: initial.artifactId, expectedRevision: 2, rawMarkdown: raw })
  expect(updated.isError).not.toBe(true)
  expect(f.store.get(initial.artifactId)).toMatchObject({ revision: 3, metadata: { status: 'PENDING', agentAttestations: [{ origin: 'AGENT_ATTESTED' }] }, provenance: { hookObservation: observation } })
  expect(executeUpdateArtifact(f.service, { artifactId: initial.artifactId, expectedRevision: 2, rawMarkdown: raw }).isError).toBe(true)
  const revised = f.store.get(initial.artifactId)!
  f.store.updatePublished({ artifactId: revised.artifactId, expectedRevision: 3, rawMarkdown: revised.rawMarkdown, metadata: revised.metadata, provenance: { hookObservation: { ...observation, checkpoint: 'next-checkpoint' } } }, 'b'.repeat(64))
  expect(f.store.get(initial.artifactId)!.metadata.agentAttestations).toEqual(revised.metadata.agentAttestations)
  expect(() => f.service.update(initial.artifactId, 4, raw.replace('status: PENDING', 'status: COMPLETED'))).toThrow('LIFECYCLE_TRANSITION_REQUIRED')
  expect(() => f.service.update(initial.artifactId, 4, raw.replace('kind: EXECUTABLE_PLAN', 'kind: DOCUMENT'))).toThrow('LIFECYCLE_POLICY_CHANGE_REQUIRES_REVIEW')
  expect(() => f.service.update(initial.artifactId, 4, raw.replace('status: PENDING', 'status: PENDING\nrepositoryId: forged'))).toThrow('AUTHORITATIVE_METADATA_RESERVED')
  expect(f.store.get(initial.artifactId)!.createdAt).toBe(initial.createdAt)
})
