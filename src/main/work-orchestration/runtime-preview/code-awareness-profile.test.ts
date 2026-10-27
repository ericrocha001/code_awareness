import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodeAwarenessProfileResolver } from './code-awareness-profile'
import { PreviewProfileStore } from '../preview-profile-store'

const directories: string[] = []

it('persists only owner-approved repository trust and refuses security drift or revocation', async () => {
  const { store, resolver, directory } = await setup()
  const profile = await resolver.resolve('repo', 'tree', process.cwd())
  const policy = { idleMs: 60000, maxPrivateBytes: 2 ** 30, maxWorkingSetBytes: 2 ** 30, maxCpuPercent: 5, minAvailableBytes: 0, sampleMs: 2000 }
  await expect(store.trust(profile, policy, async () => false, () => {})).rejects.toThrow('REPOSITORY_TRUST_REQUIRED')
  expect(await store.approved(profile)).toBe(false)
  await store.trust(profile, policy, async () => true, () => {})
  const reopened = new PreviewProfileStore(directory)
  expect(await reopened.trusted(profile)).toEqual(policy)
  expect(await reopened.approved({ ...profile, profileId: 'other-tree', revision: 2, adapter: { ...profile.adapter!, port: 52525 }, network: { ...profile.network, destinations: ['http://127.0.0.1:52525'] } })).toBe(true)
  for (const changed of [{ ...profile, repositoryId: 'other' }, { ...profile, command: { ...profile.command, executableHash: 'f'.repeat(64) } },
    { ...profile, bootstrap: { ...profile.bootstrap!, maxBytes: 1024 } }, { ...profile, network: { ...profile.network, openNetworkConsent: true } }]) expect(await reopened.trusted(changed)).toBeUndefined()
  await reopened.revoke('repo', () => {})
  expect(await store.approved(profile)).toBe(false)
}, 60000)
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function setup(root = process.cwd(), executable = join(process.cwd(), 'node_modules/electron/dist/electron.exe')) {
  const directory = await mkdtemp(join(tmpdir(), 'app-profile-')); directories.push(directory)
  const store = new PreviewProfileStore(directory), resolver = new CodeAwarenessProfileResolver(store, { root, executable, electronVersion: '32.0.0', abi: '128' })
  return { store, resolver, directory }
}
it('resolves the installed Windows environment into one reusable host profile without manual configuration', async () => {
  const { store, resolver, directory } = await setup()
  const profile = await resolver.resolve('repo', 'tree', process.cwd())
  expect(profile.bootstrap?.dataPolicy).toBe('REPOSITORY_SNAPSHOT')
  expect(profile.adapter?.artifacts).toHaveLength(12)
  await store.approve(profile, async () => true)
  const bytes = await readFile(join(directory, 'profiles.json'), 'utf8')
  expect(await resolver.resolve('repo', 'tree', process.cwd())).toEqual(profile)
  expect(await readFile(join(directory, 'profiles.json'), 'utf8')).toBe(bytes)
  expect(await store.approved(profile)).toBe(true)
}, 60000)
it('refuses an unavailable host template rather than trusting target manifests', async () => {
  const f = await setup(tmpdir())
  await expect(f.resolver.resolve('repo', 'tree', process.cwd())).rejects.toThrow('APP_HOST_PROFILE_UNAVAILABLE')
  expect(await f.store.profiles('repo')).toEqual([])
}, 60000)
it('diagnoses a legacy checkout before creating a profile or attempting launch', async () => {
  const f = await setup(), checkout = await mkdtemp(join(tmpdir(), 'legacy-app-')); directories.push(checkout)
  await writeFile(join(checkout, 'package.json'), JSON.stringify({ name: 'code-awareness', packageManager: 'npm@10.9.4' }))
  await expect(f.resolver.resolve('repo', 'tree', checkout)).rejects.toThrow('APP_COOPERATION_MISSING')
  expect(await f.store.profiles('repo')).toEqual([])
}, 60000)
it('refuses an incompatible runtime instead of inventing a binary or runtime version', async () => {
  const f = await setup(process.cwd(), process.execPath)
  await expect(f.resolver.resolve('repo', 'tree', process.cwd())).rejects.toThrow('APP_RUNTIME_INCOMPATIBLE')
  expect(await f.store.profiles('repo')).toEqual([])
}, 60000)
it('does not downgrade security or data policy changed outside the canonical default', async () => {
  const f = await setup(), profile = await f.resolver.resolve('repo', 'tree', process.cwd())
  for (const patch of [{ security: { mode: 'VM', requirements: [] } }, { bootstrap: { ...profile.bootstrap!, dataPolicy: 'EMPTY' } }, { bootstrap: { ...profile.bootstrap!, maxArtifacts: 1 } }]) {
    const changed = { ...profile, ...patch }
    await writeFile(join(f.directory, 'profiles.json'), JSON.stringify([changed]))
    await expect(f.resolver.resolve('repo', 'tree', process.cwd())).rejects.toThrow('APP_PROFILE_POLICY_CHANGED')
    expect(JSON.parse(await readFile(join(f.directory, 'profiles.json'), 'utf8'))).toEqual([changed])
  }
}, 60000)
