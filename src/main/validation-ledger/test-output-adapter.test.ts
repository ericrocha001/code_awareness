import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { ValidationLedger } from './validation-ledger'
import { TestOutputLocalAdapter } from './test-output-adapter'
import { LocalChannelHost } from '../local-agent-channel/local-channel-host'
import { ContinuumLocalAdapter } from '../continuum/local-adapter'
import { RepositoryContinuumSession } from '../continuum/project-continuum-session'
import { receiptDigest } from '../../shared/validation/test-output-receipt.cjs'
import { captureValidationSource } from '../validation-execution/validation-source'

const requireCjs = createRequire(resolve('package.json'))
const runner = requireCjs('./scripts/test-output.cjs')
const { registerReceipt, validationConnection } = requireCjs('./scripts/local-agent/validation.cjs')
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'test-output-ledger-'))
  cleanup.push(() => removeFixture(directory))
  const root = join(directory, 'checkout'), profile = join(directory, 'profile')
  mkdirSync(root)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: root, windowsHide: true, stdio: 'pipe' })
  writeFileSync(join(root, '.gitignore'), '.code-awareness/\n')
  writeFileSync(join(root, 'test.cjs'), "require('node:test')('real assertion', () => require('node:assert/strict').equal(2 + 2, 4))")
  git('init'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture')
  const session = new RepositoryContinuumSession(join(directory, 'continuum'), { findByPath: () => ({ id: 'repo', localCheckout: { path: root } }) })
  session.activate(root); cleanup.push(() => session.dispose())
  const db = join(directory, 'ledger.db')
  let ledger = new ValidationLedger(db)
  cleanup.push(() => ledger.close())
  let host: LocalChannelHost
  const start = async (configure?: (validation: TestOutputLocalAdapter['operations'], continuum: ContinuumLocalAdapter['operations']) => void) => {
    const validation = new TestOutputLocalAdapter(session, ledger), continuum = new ContinuumLocalAdapter(session)
    if (configure) configure(validation.operations, continuum.operations)
    host = new LocalChannelHost([continuum, validation], profile)
    await host.start(); cleanup.push(() => host.dispose())
  }
  return { directory, root, profile, session, start, stop: () => host.dispose(), ledger: () => ledger,
    restart: () => { ledger.close(); ledger = new ValidationLedger(db) } }
}
const association = { kind: 'TARGETED_TEST', scope: ['test.cjs'], evidenceFor: ['plan'] }
const node = process.env.CA_TEST_NODE || 'node'

function removeFixture(directory: string): void {
  if (process.platform !== 'win32') { rmSync(directory, { recursive: true, force: true }); return }
  execFileSync(node, ['-e', "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 5 })", directory], { windowsHide: true })
}

it('real runner → authenticated IPC → SQLite: configured automatic registration, concurrent retry, restart and historical query', async () => {
  const f = fixture(); await f.start()
  const receipt = await runner.run(node, ['--test', '--test-reporter=tap', 'test.cjs'], { cwd: f.root, profile: f.profile, association })
  expect(receipt.validation.state).toBe('SUFFICIENT')
  expect(receipt.ledger.before?.worktreeId).toBeTruthy()
  expect(receipt.ledger.after?.worktreeId).toBe(receipt.ledger.before.worktreeId)
  expect(receipt.registration).toMatchObject({ state: 'PERSISTED', status: 'PASSED', evidenceFor: ['plan'], trust: 'EXECUTOR_REPORTED' })
  const retries = await Promise.all([registerReceipt(receipt.id, { cwd: f.root, profile: f.profile }), registerReceipt(receipt.id, { cwd: f.root, profile: f.profile })])
  expect(retries.map(r => r.proofId)).toEqual([receipt.registration.proofId, receipt.registration.proofId])
  f.stop(); f.restart(); await f.start()
  expect((await registerReceipt(receipt.id, { cwd: f.root, profile: f.profile })).proofId).toBe(receipt.registration.proofId)
  f.stop()
  removeFixture(f.root)
  const history = await f.ledger().listProofs({ requirementId: 'plan' })
  expect(history).toHaveLength(1)
  expect(history[0].freshness).toBe('UNVERIFIABLE')
  expect(JSON.stringify(history)).not.toContain('real assertion')
}, 60000)

it('offline finish survives restart; explicit post-run association is declared and immutable; digest and path attacks fail', async () => {
  const f = fixture()
  const receipt = await runner.run(node, ['--test', '--test-reporter=tap', 'test.cjs'], { cwd: f.root, profile: f.profile })
  expect(receipt.registration.state).toBe('REGISTRATION_PENDING')
  await f.start()
  const proof = await registerReceipt(receipt.id, { cwd: f.root, profile: f.profile, association })
  expect(proof.state).toBe('PERSISTED')
  expect(f.ledger().getProof(proof.proofId)?.commandProfile?.receipt?.association).toBe('POST_RUN_DECLARED')
  await expect(registerReceipt(receipt.id, { cwd: f.root, profile: f.profile, association: { ...association, evidenceFor: ['other'] } })).rejects.toMatchObject({ code: 'RECEIPT_IDENTITY_CONFLICT' })
  const file = join(receipt.directory, 'receipt.json'), raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.exitCode = 19; writeFileSync(file, JSON.stringify(raw))
  await expect(registerReceipt(receipt.id, { cwd: f.root, profile: f.profile })).rejects.toMatchObject({ code: 'RECEIPT_INTEGRITY_ERROR' })
  await expect(registerReceipt('../receipt', { cwd: f.root, profile: f.profile })).rejects.toThrow('INVALID_RECEIPT_ID')
  const external = join(f.directory, 'external'); mkdirSync(external)
  writeFileSync(join(external, 'receipt.json'), JSON.stringify(raw))
  rmSync(receipt.directory, { recursive: true })
  symlinkSync(external, receipt.directory, 'junction')
  await expect(registerReceipt(receipt.id, { cwd: f.root, profile: f.profile })).rejects.toMatchObject({ code: 'INVALID_RECEIPT_PATH' })
}, 60000)

it('no tests, source drift, foreign checkout and launch failure cannot produce a reliable PASS', async () => {
  const f = fixture(); await f.start()
  const noTests = await runner.run(node, ['-e', 'process.exit(0)'], { cwd: f.root, profile: f.profile, association })
  expect(noTests.registration.status).toBe('ERROR')
  const changed = await runner.run(node, ['-e', "require('fs').appendFileSync('test.cjs', '\\n');console.log('Tests 1 passed (1)')"], { cwd: f.root, profile: f.profile, association })
  expect(changed.registration.status).toBe('ERROR')
  expect(f.ledger().getProof(changed.registration.proofId)?.summary).toContain('SOURCE_CHANGED_DURING_RUN')
  const launch = await runner.run('missing-executable-ca', [], { cwd: f.root, profile: f.profile, association })
  expect(launch.registration.status).toBe('ERROR')
  const raw = JSON.parse(readFileSync(join(noTests.directory, 'receipt.json'), 'utf8'))
  raw.ledger.before = await captureValidationSource(f.root, 'foreign')
  raw.digest = receiptDigest(raw)
  writeFileSync(join(noTests.directory, 'receipt.json'), JSON.stringify(raw))
  await expect(registerReceipt(raw.id, { cwd: f.root, profile: f.profile })).rejects.toMatchObject({ code: 'RECEIPT_IDENTITY_MISMATCH' })
}, 60000)


it('isolates validation from a slow global status and recovers a persisted receipt after the response deadline', async () => {
  const f = fixture()
  let registrations = 0, lookups = 0, statuses = 0
  await f.start((validation, continuum) => {
    Object.assign(continuum, { status: { execute: () => { statuses++; return new Promise(() => {}) } } })
    const register = validation.register, lookup = validation.lookup
    Object.assign(validation, {
      register: { execute: async (...args: Parameters<typeof register.execute>) => {
        registrations++
        await register.execute(...args)
        return new Promise(() => {})
      } },
      lookup: { execute: (...args: Parameters<typeof lookup.execute>) => { lookups++; return lookup.execute(...args) } }
    })
  })
  const receipt = await runner.run(node, ['--test', '--test-reporter=tap', 'test.cjs'], { cwd: f.root, profile: f.profile, association })
  expect(receipt.registration).toMatchObject({ state: 'PERSISTED', trust: 'EXECUTOR_REPORTED', freshness: 'UNVERIFIABLE' })
  expect(statuses).toBe(0)
  expect(registrations).toBe(1)
  expect(lookups).toBe(1)
  const connection = await validationConnection(f.root, f.profile)
  expect(await connection.lookup(receipt.id, receipt.digest, { ...association, evidenceFor: ['other'] })).toMatchObject({ state: 'AMBIGUOUS' })
  expect(await connection.lookup(receipt.id, 'a'.repeat(64))).toMatchObject({ state: 'SOURCE_CHANGED' })
  expect(await f.ledger().listProofs({ requirementId: 'plan' })).toHaveLength(1)
}, 60000)

it('rejects a symlink, a foreign repository and a stale or cancelled selection', async () => {
  const f = fixture(); await f.start()
  const alias = join(f.directory, 'alias')
  symlinkSync(f.root, alias, 'junction')
  await expect(validationConnection(alias, f.profile)).rejects.toMatchObject({ code: 'WORKTREE_UNLINKED' })
  const foreign = join(f.directory, 'foreign')
  mkdirSync(foreign)
  execFileSync('git', ['init'], { cwd: foreign, windowsHide: true })
  await expect(validationConnection(foreign, f.profile)).rejects.toMatchObject({ code: 'WORKTREE_UNLINKED' })
  const adapter = new TestOutputLocalAdapter(f.session, f.ledger())
  const identity = (await validationConnection(f.root, f.profile)).identity
  await expect(Promise.resolve(adapter.operations.snapshot.execute({ ...identity, cwd: f.root, generation: 'a'.repeat(64) }, { connected: () => true }))).rejects.toThrow('WORKTREE_STALE')
  const pending = adapter.operations.resolve.execute({ cwd: f.root }, { connected: () => false })
  await expect(pending).rejects.toThrow('PROJECT_CONTEXT_CHANGED')
}, 60000)
