import { afterEach, expect, it } from 'vitest'
import { ContinuumService } from './continuum-service'
import { fixture, markdown } from './continuum-test-fixtures'
import { readWorkBoard, workBoardRequest } from '../work-orchestration/work-board'

const context = { repositoryId: 'repo', projectId: 'project', revision: 1 }
const resources: (() => void)[] = []
afterEach(() => { for (const close of resources.splice(0)) close() })

function setup() {
  const { store, close } = fixture(context.repositoryId)
  resources.push(close)
  const service = new ContinuumService(store)
  const add = (id: string, kind: string, status = 'PENDING', targets: string[] = [], relation = 'derived-from') =>
    store.create({ artifactId: id, rawMarkdown: markdown(id), metadata: { name: id, description: 'Work Board fixture', kind, status,
      ...(targets.length ? { relations: targets.map(artifactId => ({ artifactId, kind: relation })) } : {}) } })
  return { service, add }
}

it('keeps only eligible work and collapses a direct same-status pair without masking residual work', () => {
  const { service, add } = setup()
  add('item-paired', 'WORK_ITEM')
  add('plan-paired', 'EXECUTABLE_PLAN', 'PENDING', ['item-paired'])
  add('item-shared', 'WORK_ITEM')
  add('plan-one', 'EXECUTABLE_PLAN', 'PENDING', ['item-shared'])
  add('plan-two', 'EXECUTABLE_PLAN', 'PENDING', ['item-shared'])
  add('item-open', 'WORK_ITEM')
  add('plan-complete', 'EXECUTABLE_PLAN', 'COMPLETED', ['item-open'])
  add('plan-independent', 'EXECUTABLE_PLAN', 'PENDING', ['item-open'], 'related-to')
  add('cancelled', 'WORK_ITEM', 'CANCELLED')
  add('handoff', 'IMPLEMENTATION_HANDOFF')
  const queued = readWorkBoard(service, { context, perspective: 'WORK' as const, column: 'PENDING' })
  expect(queued.cards.map(card => card.artifact.artifactId).sort()).toEqual([
    'item-open', 'item-shared', 'plan-independent', 'plan-one', 'plan-paired', 'plan-two'
  ])
  expect(queued.cards.find(card => card.artifact.artifactId === 'plan-paired')?.workItem?.artifactId).toBe('item-paired')
  expect(queued.cards.filter(card => card.ambiguous).map(card => card.artifact.artifactId).sort()).toEqual(['item-shared', 'plan-one', 'plan-two'])
  expect(readWorkBoard(service, { context, perspective: 'WORK', column: 'COMPLETED' }).cards.map(card => card.artifact.artifactId)).toEqual(['plan-complete'])
})

it('queries only Feature Ideas by existence status and preserves cross-perspective relations and cursors', () => {
  const { service, add } = setup()
  add('idea-open', 'FEATURE_IDEA', 'NOT_IMPLEMENTED')
  add('idea-done', 'FEATURE_IDEA', 'IMPLEMENTED')
  add('idea-legacy', 'FEATURE_IDEA', 'PENDING')
  add('work', 'EXECUTABLE_PLAN', 'PENDING', ['idea-open'])
  for (const kind of ['IMPLEMENTATION_HANDOFF', 'VALIDATION_PROOF', 'ARCHITECTURAL_DECISION', 'CAPABILITY_OPPORTUNITY']) {
    add(kind, kind, 'NOT_IMPLEMENTED')
  }
  for (let n = 0; n < 22; n++) add('idea-' + n, 'FEATURE_IDEA', 'NOT_IMPLEMENTED')
  const request = { context, perspective: 'IDEAS' as const, column: 'NOT_IMPLEMENTED' as const }
  const first = readWorkBoard(service, request)
  const last = readWorkBoard(service, { ...request, cursor: first.nextCursor })
  const cards = [...first.cards, ...last.cards]
  expect(first.cards).toHaveLength(20)
  expect(cards).toHaveLength(23)
  expect(new Set(cards.map(card => card.artifact.artifactId)).size).toBe(23)
  expect(cards.every(card => card.artifact.kind === 'FEATURE_IDEA' && card.artifact.status === 'NOT_IMPLEMENTED')).toBe(true)
  expect(cards.find(card => card.artifact.artifactId === 'idea-open')?.relations).toEqual([
    expect.objectContaining({ direction: 'INBOUND', kind: 'derived-from', artifact: expect.objectContaining({ artifactId: 'work', status: 'PENDING' }) })
  ])
  expect(readWorkBoard(service, { ...request, column: 'IMPLEMENTED' }).cards.map(card => card.artifact.artifactId)).toEqual(['idea-done'])
  expect(readWorkBoard(service, { context, perspective: 'WORK', column: 'PENDING' }).cards.map(card => card.artifact.artifactId)).toEqual(['work'])
  expect(() => readWorkBoard(service, { ...request, column: 'IMPLEMENTED', cursor: first.nextCursor })).toThrow('INVALID_ARGUMENT')
  expect(() => readWorkBoard(service, { context, perspective: 'WORK', column: 'PENDING', cursor: first.nextCursor })).toThrow('INVALID_ARGUMENT')
  expect(() => readWorkBoard(service, { ...request, context: { ...context, repositoryId: 'other' }, cursor: first.nextCursor })).toThrow('PROJECT_CONTEXT_CHANGED')
  for (const input of [{ ...request, column: 'PENDING' }, { ...request, perspective: 'WORK', column: 'ACTIVE' },
    { ...request, inspect: { artifactId: 'idea-open', revision: 1 } }]) expect(workBoardRequest.safeParse(input).success).toBe(false)
})

it('paginates mixed kinds without repetition and rejects stale or out-of-scope cursors', () => {
  const { service, add } = setup()
  for (let n = 0; n < 44; n++) add('work-' + n, n % 2 ? 'WORK_ITEM' : 'EXECUTABLE_PLAN')
  const request = { context, perspective: 'WORK' as const, column: 'PENDING' as const }
  const first = readWorkBoard(service, request)
  const second = readWorkBoard(service, { ...request, cursor: first.nextCursor })
  const last = readWorkBoard(service, { ...request, cursor: second.nextCursor })
  expect(first.cards).toHaveLength(20)
  expect(new Set([first, second, last].flatMap(page => page.cards.map(card => card.artifact.artifactId))).size).toBe(44)
  expect(last.coverage).toBe('COMPLETE')
  expect(last.nextCursor).toBeUndefined()
  expect(() => readWorkBoard(service, { ...request, context: { ...context, repositoryId: 'other' } })).toThrow('PROJECT_CONTEXT_CHANGED')
  expect(() => readWorkBoard(service, { ...request, context: { ...context, revision: 2 }, cursor: first.nextCursor })).toThrow('INVALID_ARGUMENT')
  add('changed', 'WORK_ITEM')
  expect(() => readWorkBoard(service, { ...request, cursor: first.nextCursor })).toThrow('BOARD_CHANGED')
})
