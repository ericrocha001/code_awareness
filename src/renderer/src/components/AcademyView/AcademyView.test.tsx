// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AcademyView } from './AcademyView'
import { gitPresentation, releasePresentation } from './academy-presentation'

const detail = {
  id: 'skill-1', name: 'alpha', description: 'Alpha skill', status: 'ACTIVE' as const, scope: 'GLOBAL' as const,
  currentVersion: 1, stateRevision: 1, projectIds: [], createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z',
  current: { skillId: 'skill-1', version: 1, package: { skillMd: '---\nname: alpha\ndescription: Alpha skill\n---\n# Alpha', artifacts: { 'README.md': '# Usage' } }, packageHash: 'hash', origin: 'IMPORT' as const, createdAt: '2026-09-23T00:00:00.000Z' }
}
const destination = { id: 'repo', path: 'C:/repo', name: 'repo', enabled: true, reconciliationStatus: 'SYNCED' as const, lastError: null, updatedAt: detail.updatedAt }
const openAiRelease = {
  id: 'release-1', pluginVersion: '0.1.4', createdAt: detail.createdAt, referenceReleaseId: 'baseline', snapshot: [], snapshotHash: 'snapshot',
  delta: { added: [], updated: [], removed: [], renamed: [], destructive: false }, manifest: {}, artifactPath: 'C:/release.zip', artifactHash: 'a'.repeat(64),
  status: 'READY_TO_UPLOAD' as const, blockedReason: null, baseline: false, uploadConfirmation: null, verificationEvidence: null
}

beforeEach(() => {
  window.codeAwareness = {
    getAcademyBootstrapState: vi.fn(async (initializationId: string) => ({ initializationId, hydration: 'READY', provenance: 'ACADEMY_SQLITE', storeDurationMs: 1,
      snapshot: await window.codeAwareness.getAcademySnapshot(), git: await window.codeAwareness.getAcademyGitStatus(),
      publication: { publishedVersion: '0.1.3', release: { id: openAiRelease.id, version: openAiRelease.pluginVersion, status: openAiRelease.status, sourceCommitSha: null }, marketplace: { mode: 'PENDING_EVIDENCE' } } })),
    checkAcademyGit: vi.fn(async () => window.codeAwareness.getAcademyGitStatus()),
    getAcademySnapshot: vi.fn(async () => ({ skills: [detail], destinations: [destination], conflicts: [] })),
    getAcademySkill: vi.fn(async () => detail), getAcademyHistory: vi.fn(async () => [detail.current]),
    createAcademySkill: vi.fn(async () => detail), updateAcademySkill: vi.fn(async () => ({ ...detail, currentVersion: 2, current: { ...detail.current, version: 2 } })),
    setAcademySkillEnabled: vi.fn(async () => ({ ...detail, status: 'DISABLED', stateRevision: 2 })),
    archiveAcademySkill: vi.fn(async () => ({ ...detail, status: 'DISABLED' })), restoreAcademySkill: vi.fn(async () => detail),
    setAcademyDestinationEnabled: vi.fn(), importAcademyDestination: vi.fn(async () => []), resolveAcademyConflict: vi.fn(async () => detail),
    getAcademyDeliveryStatus: vi.fn(async () => ({ skillId: detail.id, version: detail.currentVersion, packageHash: detail.current.packageHash, status: 'CONVERGED', destinations: [] })),
    getAcademyDistributionHealth: vi.fn(async () => ({ targets: [{ target: 'FILESYSTEM_NATIVE', convergence: 'CONVERGED', current: 1, pending: 0, drifted: 0, missing: 0, error: 0, lastReconciledAt: detail.updatedAt }, { target: 'CLAUDE_CODE', convergence: 'CONVERGED', current: 1, pending: 0, drifted: 0, missing: 0, error: 0, lastReconciledAt: detail.updatedAt }, { target: 'ANTIGRAVITY', convergence: 'DEGRADED', current: 0, pending: 0, drifted: 0, missing: 0, error: 1, lastReconciledAt: detail.updatedAt }] })),
    listAcademyDistributionStates: vi.fn(async () => []), reconcileAcademyDistribution: vi.fn(async () => ({ health: { targets: [] }, states: [] })),
    bootstrapAcademyOpenAiPlugin: vi.fn(), getAcademyOpenAiPublicationState: vi.fn(async () => ({
      profile: { name: 'academy-skills', displayName: 'Academy Skills', description: 'Skills', author: {}, openAiInterface: {}, logoPath: null, publishedVersion: '0.1.3', deletionSemantics: 'UNKNOWN', deletionSemanticsEvidence: null, createdAt: detail.createdAt, updatedAt: detail.updatedAt },
      latestPrepared: openAiRelease, latestUploaded: null, selectedRelease: openAiRelease, publicSkillCount: 23, canonicalSnapshotHash: 'snapshot', drifted: false,
      currentPackageRevision: null, hostedStatus: 'HOSTED_UPDATE_AVAILABLE'
    })), listAcademyOpenAiReleases: vi.fn(async () => [openAiRelease]), prepareAcademyOpenAiRelease: vi.fn(async () => openAiRelease),
    getAcademyPackageDistributionState: vi.fn(async () => ({
      packageRevision: { id: 'revision', version: '0.1.5', contentFingerprint: 'content', skillSnapshotHash: 'snapshot', profileFingerprint: 'profile', assetHash: 'asset', delta: openAiRelease.delta, createdAt: detail.createdAt },
      skillCount: 23,
      git: { profile: null, repository: { id: 'repo', name: 'Academy', fullName: 'ericrocha001/Academy', visibility: 'PRIVATE', checkoutPath: 'C:/Academy', branch: 'main' }, syncState: 'SYNCED', lastSyncAt: detail.updatedAt, lastCommitSha: 'abcdef', lastError: null },
      marketplace: { takeoverStatus: 'TAKEOVER_UNSUPPORTED', mode: 'SOURCE_AVAILABLE', observedPluginId: 'academy-skills@academy', evidence: 'probe', updatedAt: detail.updatedAt },
      hosted: { status: 'HOSTED_UPDATE_AVAILABLE', label: 'Hosted Personal', version: '0.1.4' }
    })),
    confirmAcademyOpenAiUpload: vi.fn(async () => ({ ...openAiRelease, status: 'UPLOADED_UNVERIFIED' as const })), revealAcademyOpenAiPackage: vi.fn(async () => true),
    getAcademyGitStatus: vi.fn(async () => ({ profile: null, repository: { id: 'repo', name: 'Academy', fullName: 'ericrocha001/Academy', visibility: 'PRIVATE', checkoutPath: 'C:/Academy', branch: 'main' }, syncState: 'SYNCED', lastSyncAt: detail.updatedAt, lastCommitSha: 'abcdef', lastError: null })),
    listAcademyGitEligibleRepositories: vi.fn(async () => []), syncAcademyGitNow: vi.fn(), openAcademyGitRepository: vi.fn(async () => true), bindAcademyGitRepository: vi.fn()
  } as unknown as Window['codeAwareness']
})
afterEach(cleanup)

it('keeps the full package across tabs and refuses to save unchanged content', async () => {
  render(<AcademyView />)
  await selectAlpha()
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }))
  expect(screen.getAllByRole('button', { name: 'Salvar' })).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Salvar' }).hasAttribute('disabled')).toBe(true)
  const full = '---\nname: alpha\ndescription: Unicode ação\nunknown-field: preserve-me\n---\n' + '長い linha '.repeat(150)
  fireEvent.change(screen.getByLabelText('Editar SKILL.md'), { target: { value: full } })
  fireEvent.click(screen.getByRole('button', { name: 'Contexto' }))
  fireEvent.change(screen.getByLabelText('Escopo'), { target: { value: 'PROJECT' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'repo' }))
  fireEvent.click(screen.getByRole('button', { name: 'Arquivos' }))
  expect(screen.getByRole('button', { name: /README.md/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Definição' }))
  expect((screen.getByLabelText('Editar SKILL.md') as HTMLTextAreaElement).value).toBe(full)
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
  await waitFor(() => expect(window.codeAwareness.updateAcademySkill).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 1, scope: 'PROJECT', projectIds: ['repo'], package: { skillMd: full, artifacts: detail.current.package.artifacts } })))
})

it('preserves drafts on selection, cancel and external navigation until discard is confirmed', async () => {
  let guard: ((proceed: () => void) => void) | null = null
  const navigate = vi.fn()
  render(<AcademyView onNavigationGuardChange={value => { guard = value }} />)
  await selectAlpha()
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }))
  fireEvent.change(screen.getByLabelText('Editar SKILL.md'), { target: { value: 'draft to keep' } })
  fireEvent.click(screen.getByRole('button', { name: 'Nova Skill' }))
  expect(screen.getByRole('alertdialog')).toBeTruthy()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect((screen.getByLabelText('Editar SKILL.md') as HTMLTextAreaElement).value).toBe('draft to keep')
  act(() => guard!(navigate))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancelar' }))
  expect(navigate).not.toHaveBeenCalled()
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload)
  expect(unload.defaultPrevented).toBe(true)
  act(() => guard!(navigate))
  fireEvent.click(screen.getByRole('button', { name: 'Descartar alterações' }))
  expect(navigate).toHaveBeenCalledTimes(1)
  expect(window.codeAwareness.updateAcademySkill).not.toHaveBeenCalled()
})

it('keeps a failed CAS draft and blocks duplicate saves while pending', async () => {
  let reject!: (error: Error) => void
  vi.mocked(window.codeAwareness.updateAcademySkill).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
  render(<AcademyView />)
  await selectAlpha()
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }))
  fireEvent.change(screen.getByLabelText('Editar SKILL.md'), { target: { value: 'CAS draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
  expect(screen.getByRole('button', { name: 'Salvar' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
  expect(window.codeAwareness.updateAcademySkill).toHaveBeenCalledTimes(1)
  await act(async () => reject(new Error('VERSION_CONFLICT')))
  expect((screen.getByLabelText('Editar SKILL.md') as HTMLTextAreaElement).value).toBe('CAS draft')
  expect(screen.getByText('VERSION_CONFLICT')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Salvar' }).hasAttribute('disabled')).toBe(false)
})

it('guards the file drawer with Escape and restores focus without losing its draft', async () => {
  render(<AcademyView />)
  await selectAlpha()
  fireEvent.click(screen.getByRole('button', { name: 'Arquivos' }))
  const trigger = screen.getByRole('button', { name: /README.md/ })
  trigger.focus()
  fireEvent.click(trigger)
  fireEvent.change(screen.getByLabelText('Conteúdo do artefato'), { target: { value: 'keep file text' } })
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.getByRole('alertdialog', { name: 'Descartar alterações do arquivo?' })).toBeTruthy()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect((screen.getByLabelText('Conteúdo do artefato') as HTMLTextAreaElement).value).toBe('keep file text')
  fireEvent.click(screen.getByRole('button', { name: 'Salvar no draft' }))
  expect(document.activeElement).toBe(trigger)
  expect(window.codeAwareness.updateAcademySkill).not.toHaveBeenCalled()
})

it('keeps public approval and local tombstone deletion behind explicit confirmation', async () => {
  const local = { ...detail, catalogRevision: 4, publicationEligibility: 'PRIVATE' as const }
  vi.mocked(window.codeAwareness.getAcademySkill).mockResolvedValue(local)
  const git = await window.codeAwareness.getAcademyGitStatus()
  vi.mocked(window.codeAwareness.getAcademyGitStatus).mockResolvedValue({ ...git, convergence: { cutover: 'LOCAL', localRevision: 4, lastConvergedRevision: null, pending: true, freshness: 'UNVERIFIED' } })
  window.codeAwareness.approveAcademyPublicSkill = vi.fn(async () => local)
  window.codeAwareness.deleteAcademyGlobalSkill = vi.fn(async () => local)
  render(<AcademyView />)
  await selectAlpha()
  fireEvent.click(screen.getByRole('button', { name: 'Contexto' }))
  fireEvent.click(screen.getByRole('button', { name: 'Aprovar publicação pública' }))
  expect(window.codeAwareness.approveAcademyPublicSkill).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Aprovar publicação' }))
  await waitFor(() => expect(window.codeAwareness.approveAcademyPublicSkill).toHaveBeenCalledWith(detail.id, 1, true))
  fireEvent.click(screen.getByRole('button', { name: 'Excluir Skill' }))
  expect(window.codeAwareness.deleteAcademyGlobalSkill).not.toHaveBeenCalled()
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Excluir Skill' }))
  await waitFor(() => expect(window.codeAwareness.deleteAcademyGlobalSkill).toHaveBeenCalledWith(detail.id, 1, true))
})

it('does not cut over, change automation, prepare a release or upload on mount', async () => {
  const git = await window.codeAwareness.getAcademyGitStatus()
  const pending = { ...git, profile: { githubRepositoryId: 'repo', branch: 'main' }, publication: { autoPublish: false, autoUpdate: false, conflictPaths: [] }, convergence: { cutover: 'PENDING', freshness: 'UNVERIFIED', localRevision: 0, lastConvergedRevision: null, pending: true } } as any
  vi.mocked(window.codeAwareness.getAcademyGitStatus).mockResolvedValue(pending)
  window.codeAwareness.completeAcademyLocalCutover = vi.fn(async () => pending)
  window.codeAwareness.configureAcademyGitAutomation = vi.fn(async () => pending)
  render(<AcademyView />)
  await screen.findByRole('button', { name: 'Migrar para edição local' })
  expect(window.codeAwareness.completeAcademyLocalCutover).not.toHaveBeenCalled()
  expect(window.codeAwareness.prepareAcademyOpenAiRelease).not.toHaveBeenCalled()
  expect(window.codeAwareness.confirmAcademyOpenAiUpload).not.toHaveBeenCalled()
  expect(window.codeAwareness.configureAcademyGitAutomation).not.toHaveBeenCalled()
  const toggle = screen.getByRole('checkbox', { name: 'Publicação automática de edições locais' }) as HTMLInputElement
  expect(toggle.checked).toBe(false)
  fireEvent.click(toggle)
  expect(window.codeAwareness.configureAcademyGitAutomation).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Salvar preferência' }))
  await waitFor(() => expect(window.codeAwareness.configureAcademyGitAutomation).toHaveBeenCalledWith({ autoPublish: true, autoUpdate: false, confirmed: true, expectedRepositoryId: 'repo', expectedBranch: 'main' }))
})

it.each(['IDLE', 'FAILED', 'CHECKING', undefined])('never calls old SYNCED evidence current when remote check is %s', async state => {
  const git = await window.codeAwareness.getAcademyGitStatus()
  expect(gitPresentation({ ...git, remoteCheck: state ? { state, generation: 1 } as any : undefined }, 'READY')).toEqual({ label: 'Última sincronização conhecida; verificação pendente', tone: 'neutral' })
})

it('distinguishes remote observation, local pending changes, PR, conflict and unverified upload', async () => {
  const git = await window.codeAwareness.getAcademyGitStatus()
  const observed = { ...git, remoteCheck: { state: 'OK', generation: 1 } as any }
  expect(gitPresentation(observed, 'READY').tone).toBe('success')
  expect(gitPresentation({ ...observed, convergence: { cutover: 'LOCAL', localRevision: 2, lastConvergedRevision: 1, pending: true, freshness: 'UNVERIFIED' } }, 'READY').tone).toBe('neutral')
  expect(gitPresentation({ ...git, syncState: 'PR_PENDING' }, 'READY').label).toContain('revisão de PR')
  expect(gitPresentation({ ...git, syncState: 'CONFLICT' }, 'READY').tone).toBe('danger')
  expect(gitPresentation({ ...git, syncState: 'REMOTE_CHANGES' }, 'READY').label).toContain('remota')
  expect(releasePresentation({ status: 'UPLOADED_UNVERIFIED' }, false).tone).toBe('neutral')
  expect(releasePresentation({ status: 'VERIFIED' }, true).tone).toBe('warning')
})

it('keeps a new unsaved draft when an earlier skill selection completes late', async () => {
  let finish!: (value: typeof detail) => void
  vi.mocked(window.codeAwareness.getAcademySkill).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  render(<AcademyView />)
  fireEvent.click(await screen.findByRole('button', { name: /alpha.*Alpha skill/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Nova Skill' }))
  fireEvent.change(screen.getByLabelText('Editar SKILL.md'), { target: { value: 'unsaved new draft' } })
  await act(async () => finish(detail))
  expect((screen.getByLabelText('Editar SKILL.md') as HTMLTextAreaElement).value).toBe('unsaved new draft')
})

it('paints only the persisted bootstrap before secondary reads and coalesces slow offline verification without losing flags', async () => {
  const base = await window.codeAwareness.getAcademyGitStatus()
  vi.mocked(window.codeAwareness.getAcademyGitStatus).mockClear()
  const git = { ...base, profile: { repositoryCatalogId: 'repo', githubRepositoryId: 'github-id', branch: 'main' },
    publication: { autoPublish: true, autoUpdate: true, remoteHead: 'a'.repeat(40), conflictPaths: [] },
    lastKnown: { repositoryId: 'github-id', branch: 'main', remoteHead: 'a'.repeat(40), confirmedAt: detail.updatedAt, result: 'SYNCED', autoPublish: true, autoUpdate: true, localHead: 'a'.repeat(40) },
    remoteCheck: { state: 'IDLE', generation: 4, requestId: null, error: null, completedAt: null } } as any
  let finishBootstrap!: (value: any) => void
  let finishRemote!: (value: any) => void
  vi.mocked(window.codeAwareness.getAcademyBootstrapState).mockImplementation(() => new Promise(resolve => { finishBootstrap = resolve }))
  vi.mocked(window.codeAwareness.getAcademyOpenAiPublicationState).mockImplementation(() => new Promise(() => {}))
  vi.mocked(window.codeAwareness.getAcademyDistributionHealth).mockImplementation(() => new Promise(() => {}))
  vi.mocked(window.codeAwareness.checkAcademyGit).mockImplementation(() => new Promise(resolve => { finishRemote = resolve }))
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  try {
    render(<AcademyView />)
    expect(screen.getByText('Carregando Academy do estado local…')).toBeTruthy()
    expect(screen.queryByText('Não configurado')).toBeNull()
    expect(screen.queryByText('UNCONFIGURED')).toBeNull()
    expect(window.codeAwareness.getAcademyBootstrapState).toHaveBeenCalledTimes(1)
    expect(window.codeAwareness.getAcademySnapshot).not.toHaveBeenCalled()
    expect(window.codeAwareness.getAcademyGitStatus).not.toHaveBeenCalled()
    expect(window.codeAwareness.getAcademyOpenAiPublicationState).not.toHaveBeenCalled()
    expect(window.codeAwareness.checkAcademyGit).not.toHaveBeenCalled()
    finishBootstrap({ initializationId: vi.mocked(window.codeAwareness.getAcademyBootstrapState).mock.calls[0][0], hydration: 'READY', provenance: 'ACADEMY_SQLITE', storeDurationMs: 1,
      snapshot: { skills: [detail], destinations: [destination], conflicts: [] }, git,
      publication: { publishedVersion: '0.27.16', release: { id: 'legacy', version: '0.27.16', status: 'UPLOADED_UNVERIFIED', sourceCommitSha: null } } })
    await screen.findByText('Alpha skill')
    await waitFor(() => expect(window.codeAwareness.checkAcademyGit).toHaveBeenCalledTimes(1))
    expect(screen.getAllByText(/ericrocha001\/Academy/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/UPLOADED_UNVERIFIED/).length).toBeGreaterThan(0)
    const publication = screen.getByRole('checkbox', { name: 'Publicação automática de edições locais' }) as HTMLInputElement
    const update = screen.getByRole('checkbox', { name: 'Atualização automática do remoto' }) as HTMLInputElement
    expect(publication.checked && update.checked).toBe(true)
    const search = screen.getByRole('textbox', { name: 'Buscar Skills' })
    fireEvent.change(search, { target: { value: 'alpha' } })
    fireEvent.focus(window); fireEvent(window, new Event('online'))
    expect(window.codeAwareness.checkAcademyGit).toHaveBeenCalledTimes(1)
    finishRemote({ ...git, syncState: 'OFFLINE', remoteCheck: { state: 'FAILED', generation: 5, requestId: 'current', error: 'offline', completedAt: detail.updatedAt } })
    await screen.findByText(/Falha ao verificar GitHub/)
    expect(screen.getByRole('textbox', { name: 'Buscar Skills' })).toBe(search)
    expect((search as HTMLInputElement).value).toBe('alpha')
    expect(publication.checked && update.checked).toBe(true)
    const marks = log.mock.calls.filter(([tag]) => tag === '[Academy hydration]').map(([, body]) => JSON.parse(body as string))
    expect(marks.map(mark => mark.milestone)).toEqual(['STORE_RESPONSE', 'FIRST_USEFUL_PAINT', 'REMOTE_CHECK_COMPLETE'])
    expect(new Set(marks.map(mark => mark.initializationId)).size).toBe(1)
  } finally { log.mockRestore() }
})

it('discards older publication and Git responses after selective invalidation and an automation change', async () => {
  const base = await window.codeAwareness.getAcademyGitStatus()
  const state = await window.codeAwareness.getAcademyOpenAiPublicationState()
  const git = { ...base, profile: { repositoryCatalogId: 'repo', githubRepositoryId: 'github-id', branch: 'main' },
    publication: { autoPublish: false, autoUpdate: true, conflictPaths: [] }, remoteCheck: { state: 'OK', generation: 10, requestId: 'known', error: null, completedAt: detail.updatedAt } } as any
  vi.mocked(window.codeAwareness.getAcademyBootstrapState).mockResolvedValue({ initializationId: 'fixture', hydration: 'READY', provenance: 'ACADEMY_SQLITE', storeDurationMs: 1,
    snapshot: { skills: [detail], destinations: [destination], conflicts: [] }, git, publication: { publishedVersion: '0.1.3', release: null, marketplace: { mode: 'PENDING_EVIDENCE' } } } as any)
  vi.mocked(window.codeAwareness.checkAcademyGit).mockResolvedValue(git)
  let changed!: Parameters<Window['codeAwareness']['onAcademyChanged']>[0]
  window.codeAwareness.onAcademyChanged = vi.fn(listener => { changed = listener; return () => {} })
  let oldPublication!: (error: Error) => void
  vi.mocked(window.codeAwareness.getAcademyOpenAiPublicationState).mockReset().mockImplementationOnce(() => new Promise((_resolve, reject) => { oldPublication = reject }))
    .mockResolvedValue({ ...state, selectedRelease: { ...openAiRelease, pluginVersion: '0.2.9' } })
  render(<AcademyView />)
  await waitFor(() => expect(window.codeAwareness.getAcademyOpenAiPublicationState).toHaveBeenCalledTimes(1))
  act(() => changed({ kind: 'publication' }))
  await screen.findByText(/v0.2.9 · READY_TO_UPLOAD/)
  await act(async () => oldPublication(new Error('obsolete publication response')))
  expect(screen.queryByText('obsolete publication response')).toBeNull()
  expect(screen.queryByText(/v0.1.4 · READY_TO_UPLOAD/)).toBeNull()
  let oldGit!: (value: any) => void
  vi.mocked(window.codeAwareness.getAcademyGitStatus).mockImplementationOnce(() => new Promise(resolve => { oldGit = resolve }))
  act(() => changed({ kind: 'git' }))
  await waitFor(() => expect(oldGit).toBeTypeOf('function'))
  const newer = { ...git, publication: { autoPublish: false, autoUpdate: false, conflictPaths: [] }, remoteCheck: { ...git.remoteCheck, generation: 12 } }
  window.codeAwareness.configureAcademyGitAutomation = vi.fn(async () => newer)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Atualização automática do remoto' }))
  fireEvent.click(screen.getByRole('button', { name: 'Salvar preferência' }))
  await waitFor(() => expect((screen.getByRole('checkbox', { name: 'Atualização automática do remoto' }) as HTMLInputElement).checked).toBe(false))
  await act(async () => oldGit({ ...git, remoteCheck: { ...git.remoteCheck, generation: 11 } }))
  expect((screen.getByRole('checkbox', { name: 'Atualização automática do remoto' }) as HTMLInputElement).checked).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: /alpha.*Alpha skill/ }))
  await screen.findByRole('button', { name: 'Editar' })
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }))
  const reads = vi.mocked(window.codeAwareness.getAcademySkill).mock.calls.length
  act(() => changed({ kind: 'catalog' }))
  await waitFor(() => expect(window.codeAwareness.getAcademySnapshot).toHaveBeenCalled())
  expect(window.codeAwareness.getAcademySkill).toHaveBeenCalledTimes(reads)
})

it('explains a legacy version collision and saves only the explicitly reviewed manifest revision', async () => {
  const state = await window.codeAwareness.getAcademyOpenAiPublicationState()
  vi.mocked(window.codeAwareness.getAcademyOpenAiPublicationState).mockResolvedValue({ ...state, versionPreflight: {
    outcome: 'VERSION_ALREADY_USED_FOR_OTHER_CONTENT', manifestVersion: '0.27.16', registeredVersion: '0.27.16',
    highestKnownVersion: '0.27.16', suggestedVersion: '0.27.17', sourceCommitSha: 'a'.repeat(40),
    message: 'O manifesto declara 0.27.16, mas a release 0.27.16 já está registrada. Prepare uma nova versão no Git.' } })
  const preview = { repositoryId: 'repo', branch: 'main', sourceCommitSha: 'a'.repeat(40), workspaceCommitSha: 'b'.repeat(40), manifestHash: 'hash',
    previousVersion: '0.27.16', newVersion: '0.27.17', before: '{"version":"0.27.16"}', after: '{"version":"0.27.17"}', token: 'reviewed' }
  window.codeAwareness.previewAcademyManifestVersion = vi.fn(async () => preview)
  const git = await window.codeAwareness.getAcademyGitStatus()
  window.codeAwareness.saveAcademyManifestVersion = vi.fn(async () => ({ ...git, syncState: 'LOCAL_CHANGES' as const }))
  render(<AcademyView />)
  await screen.findByText(/O manifesto declara 0.27.16/)
  fireEvent.click(screen.getByRole('button', { name: 'Preparar nova versão do manifesto' }))
  const dialog = await screen.findByRole('dialog', { name: 'Revisar versão do manifesto' })
  expect(window.codeAwareness.saveAcademyManifestVersion).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar revisão no workspace' }))
  await waitFor(() => expect(window.codeAwareness.saveAcademyManifestVersion).toHaveBeenCalledWith({ preview, confirmed: true }))
  expect(window.codeAwareness.prepareAcademyOpenAiRelease).not.toHaveBeenCalled()
})

it('requires reviewed conflict content and forwards the exact observed revision', async () => {
  const current = await window.codeAwareness.getAcademyGitStatus()
  const conflict = { ...current, syncState: 'CONFLICT' as const, publication: { destinationKey: 'destination', checkoutPath: 'C:/publication', baselineTree: null, desiredRevision: 'revision', desiredTree: '', localHead: null, remoteHead: 'a'.repeat(40), verifiedAt: null, operationId: null, pendingCommit: null, legacyPendingHead: null, migrationComplete: true, conflictPaths: ['skills/alpha/SKILL.md'], phase: 'CONFLICT' as const } }
  vi.mocked(window.codeAwareness.getAcademyGitStatus).mockResolvedValue(conflict)
  window.codeAwareness.resolveAcademyGitConflict = vi.fn(async () => conflict)
  window.codeAwareness.reviewAcademyGitConflict = vi.fn(async () => ({ path: 'skills/alpha/SKILL.md', head: 'local-head', revision: 'observed-revision', base: 'base', local: 'local text', remote: 'remote text', working: 'conflict markers' }))
  window.codeAwareness.resolveAcademyGitConflictPath = vi.fn(async () => ({ ...conflict, syncState: 'LOCAL_CHANGES', publication: { ...conflict.publication, conflictPaths: [] } })) as any
  render(<AcademyView />)
  fireEvent.click(await screen.findByRole('button', { name: 'Resolver' }))
  const dialog = await screen.findByRole('dialog', { name: 'Revisar conflito Git' })
  expect(window.codeAwareness.resolveAcademyGitConflictPath).not.toHaveBeenCalled()
  fireEvent.change(within(dialog).getByLabelText('Conteúdo reconciliado'), { target: { value: 'reviewed merge' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar conteúdo revisado' }))
  await waitFor(() => expect(window.codeAwareness.resolveAcademyGitConflictPath).toHaveBeenCalledWith({ path: 'skills/alpha/SKILL.md', head: 'local-head', revision: 'observed-revision', content: 'reviewed merge', confirmed: true }))
  expect(screen.queryByText('Git sincronizado.')).toBeNull()
})

it('shows Git provenance and requests an explicit cached rebuild without implying latest or upload', async () => {
  const state = await window.codeAwareness.getAcademyOpenAiPublicationState()
  const source = { id: 'build', releaseId: openAiRelease.id, buildSchema: 1 as const, sourceRepositoryId: 'repository', branch: 'main',
    sourceCommitSha: 'b'.repeat(40), managedTreeHash: 'tree', manifestFingerprint: 'manifest', assetFingerprint: 'asset',
    entriesFingerprint: 'entries', pluginVersion: openAiRelease.pluginVersion, zipSha256: openAiRelease.artifactHash,
    remoteConfirmation: 'CACHED' as const, confirmedAt: detail.createdAt }
  vi.mocked(window.codeAwareness.getAcademyOpenAiPublicationState).mockResolvedValue({ ...state, selectedRelease: { ...openAiRelease, source } })
  render(<AcademyView />)
  await screen.findByText(/Rebuild em cache; atualidade remota não verificada/)
  expect(screen.getByText(/main@bbbbbbbbbbbb/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Rebuild do commit em cache' }))
  await waitFor(() => expect(window.codeAwareness.prepareAcademyOpenAiRelease).toHaveBeenCalledWith({ mode: 'REBUILD', sourceCommitSha: source.sourceCommitSha }))
  expect(window.codeAwareness.confirmAcademyOpenAiUpload).not.toHaveBeenCalled()
})

it('reports a Git draft without claiming a canonical version or scheduling delivery', async () => {
  window.codeAwareness.getAcademyDraft = vi.fn(async () => ({ package: detail.current.package, workspaceCommitSha: 'draft-base', sourceBaseCommitSha: 'confirmed-main' }))
  vi.mocked(window.codeAwareness.updateAcademySkill).mockResolvedValue({ state: 'DRAFT_SAVED', skillId: detail.id, name: detail.name, baseVersion: 1, sourceBaseCommitSha: 'confirmed-main', workspaceCommitSha: 'draft-next', packageHash: 'draft-hash', distribution: { status: 'NOT_APPLICABLE' } })
  render(<AcademyView />)
  await selectAlpha()
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }))
  await screen.findByLabelText('Editar SKILL.md')
  fireEvent.change(screen.getByLabelText('Editar SKILL.md'), { target: { value: detail.current.package.skillMd + '\nDraft edit' } })
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
  await waitFor(() => expect(window.codeAwareness.updateAcademySkill).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 1, expectedDraftCommitSha: 'draft-base' })))
  expect(await screen.findByText('Rascunho salvo em commit local. Publicação pendente.')).toBeTruthy()
  expect(window.codeAwareness.getAcademyDeliveryStatus).not.toHaveBeenCalled()
})

it.each(['ERROR', 'PUSH_PENDING', 'REMOTE_DIVERGED', 'SYNCING'])('does not announce successful Git publication for %s', async (syncState) => {
  vi.mocked(window.codeAwareness.syncAcademyGitNow).mockResolvedValue({ profile: null, repository: null, syncState: syncState as any, lastSyncAt: null, lastCommitSha: null, lastError: 'Publication pending' })
  render(<AcademyView />)
  const button = await screen.findByRole('button', { name: 'Atualizar' })
  fireEvent.click(button)
  expect((await screen.findAllByText('Publication pending')).length).toBeGreaterThan(0)
  expect(screen.queryByText('Git sincronizado.')).toBeNull()
  expect(screen.getByRole('status').className).toContain('error')
})

const selectAlpha = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /alpha/i }))
  await screen.findByRole('button', { name: 'Editar' })
}

it('activates only in context and preserves selection, filters and disabled history', async () => {
  let current: any = { ...detail }
  vi.mocked(window.codeAwareness.getAcademySnapshot).mockImplementation(async () => ({ skills: [current], destinations: [destination], conflicts: [] }))
  vi.mocked(window.codeAwareness.getAcademySkill).mockImplementation(async () => current)
  vi.mocked(window.codeAwareness.setAcademySkillEnabled).mockImplementation(async (id, enabled, revision) => {
    expect(id).toBe(detail.id); expect(revision).toBe(current.stateRevision)
    current = { ...current, status: enabled ? 'ACTIVE' : 'DISABLED', stateRevision: revision + 1 }
    return current
  })
  render(<AcademyView />)
  await selectAlpha()
  expect(screen.queryByRole('switch', { name: 'Ativação de alpha' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Contexto' }))
  fireEvent.click(screen.getByRole('switch', { name: 'Ativação da Skill selecionada' }))
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Ativação da Skill selecionada' }).getAttribute('aria-checked')).toBe('false'))
  fireEvent.change(screen.getByLabelText('Filtrar por status'), { target: { value: 'ACTIVE' } })
  expect(screen.queryByRole('button', { name: /alpha.*Alpha skill/ })).toBeNull()
  fireEvent.change(screen.getByLabelText('Filtrar por status'), { target: { value: 'DISABLED' } })
  fireEvent.click(screen.getByRole('button', { name: 'Histórico' }))
  expect(await screen.findByText('Import')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Voltar ao contexto' }))
  fireEvent.click(screen.getByRole('switch', { name: 'Ativação da Skill selecionada' }))
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Ativação da Skill selecionada' }).getAttribute('aria-checked')).toBe('true'))
  expect(window.codeAwareness.setAcademySkillEnabled).toHaveBeenLastCalledWith(detail.id, true, 2)
  expect(screen.getByRole('heading', { name: 'alpha' })).toBeTruthy()
})

it('keeps switches pending and refreshes the persisted state after a CAS conflict', async () => {
  let reject!: (error: Error) => void
  vi.mocked(window.codeAwareness.setAcademySkillEnabled).mockImplementation(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise }))
  render(<AcademyView />)
  await selectAlpha()
  fireEvent.click(screen.getByRole('button', { name: 'Contexto' }))
  fireEvent.click(screen.getByRole('switch', { name: 'Ativação da Skill selecionada' }))
  expect(screen.getByRole('switch', { name: 'Ativação da Skill selecionada' }).hasAttribute('disabled')).toBe(true)
  reject(new Error('STATE_REVISION_CONFLICT'))
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Ativação da Skill selecionada' }).hasAttribute('disabled')).toBe(false))
  expect(screen.getByRole('switch', { name: 'Ativação da Skill selecionada' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.getByRole('status').textContent).toContain('STATE_REVISION_CONFLICT')
  expect(window.codeAwareness.getAcademySkill).toHaveBeenCalledTimes(2)
})

it('lists, opens in VIEW and updates a canonical skill with expectedVersion', async () => {
  render(<AcademyView />)
  await selectAlpha()
  expect(within(screen.getByLabelText('Resumo derivado da Skill')).getByText('alpha')).toBeTruthy()
  expect(document.querySelector('.academy-source-disclosure')?.hasAttribute('open')).toBe(false)
  expect(await screen.findByText(/name: alpha/)).toBeTruthy()
  expect(screen.queryByLabelText('Editar SKILL.md')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }))
  expect(document.querySelector('.academy-source-disclosure')?.hasAttribute('open')).toBe(true)
  const editor = screen.getByLabelText('Editar SKILL.md')
  fireEvent.change(editor, { target: { value: `${detail.current.package.skillMd}\nUpdated` } })
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
  await waitFor(() => expect(window.codeAwareness.updateAcademySkill).toHaveBeenCalledWith(expect.objectContaining({ skillId: 'skill-1', expectedVersion: 1 })))
  expect(await screen.findByText(/Versão 2 salva/)).toBeTruthy()
})

it('cancels an edit without persistence and creates a new skill only on save', async () => {
  render(<AcademyView />)
  await selectAlpha()
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }))
  fireEvent.change(screen.getByLabelText('Editar SKILL.md'), { target: { value: 'discard me' } })
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
  expect(window.codeAwareness.updateAcademySkill).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Descartar alterações' }))
  expect(screen.getByText(/name: alpha/)).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Nova Skill' }))
  expect(screen.getByLabelText('Editar SKILL.md')).toBeTruthy()
  expect(window.codeAwareness.createAcademySkill).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
  await waitFor(() => expect(window.codeAwareness.createAcademySkill).toHaveBeenCalled())
})

it('switches overview and history without changing the selected skill', async () => {
  render(<AcademyView />)
  await selectAlpha()
  fireEvent.click(screen.getByRole('button', { name: 'Contexto' }))
  expect(screen.getByLabelText('Visão geral da Skill')).toBeTruthy()
  expect(screen.getByText('Sem destino aplicável')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Histórico' }))
  const historyPanel = screen.getByLabelText('Histórico imutável')
  expect(historyPanel).toBeTruthy()
  expect(within(historyPanel).getByText('v1')).toBeTruthy()
  expect(window.codeAwareness.getAcademySkill).toHaveBeenCalledTimes(1)
})

it('edits artifacts in a secondary surface and confirms removal inside the app', async () => {
  render(<AcademyView />)
  await selectAlpha()
  fireEvent.click(screen.getByRole('button', { name: 'Arquivos' }))
  fireEvent.click(screen.getByRole('button', { name: /README.md/i }))
  expect(screen.getByRole('dialog', { name: 'README.md' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Conteúdo do artefato'), { target: { value: '# Updated usage' } })
  fireEvent.click(screen.getByRole('button', { name: 'Salvar no draft' }))
  expect(screen.getByRole('button', { name: 'Salvar' })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: /README.md/i }))
  fireEvent.click(screen.getByRole('button', { name: 'Remover' }))
  expect(screen.getByRole('alertdialog', { name: 'Remover artefato?' })).toBeTruthy()
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remover' }))
  expect(screen.queryByRole('button', { name: /README.md/i })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Adicionar artefato' }))
  expect(screen.getByRole('dialog', { name: 'Novo artefato' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Caminho do artefato'), { target: { value: 'references/guide.md' } })
  fireEvent.click(screen.getByRole('button', { name: 'Salvar no draft' }))
  expect(screen.getByRole('button', { name: /references\/guide.md/i })).toBeTruthy()
})

it('keeps operational capabilities in the rail and omits healthy conflict noise', async () => {
  render(<AcademyView />)
  expect(await screen.findByText('Destinos de Distribuição')).toBeTruthy()
  expect(screen.queryByText('Nenhum conflito aberto.')).toBeNull()
  expect(await screen.findByText('Source Available')).toBeTruthy()
  expect(screen.getByText('Hosted ZIP fallback')).toBeTruthy()
  expect(screen.getAllByText('CONVERGED')).toHaveLength(2)

  fireEvent.click(screen.getByRole('button', { name: 'Gerenciar' }))
  const manager = screen.getByRole('dialog', { name: 'Destinos de Distribuição' })
  fireEvent.click(within(manager).getByRole('button', { name: 'Importar .skills' }))
  await waitFor(() => expect(window.codeAwareness.importAcademyDestination).toHaveBeenCalledWith('repo'))
  fireEvent.click(within(manager).getByRole('button', { name: 'Fechar destinos' }))

  fireEvent.click(screen.getByRole('button', { name: 'Reconciliar distribuição' }))
  await waitFor(() => expect(window.codeAwareness.reconcileAcademyDistribution).toHaveBeenCalled())
  fireEvent.click(screen.getByRole('button', { name: 'Prepare ZIP fallback' }))
  await waitFor(() => expect(window.codeAwareness.prepareAcademyOpenAiRelease).toHaveBeenCalled())

  fireEvent.click(screen.getByRole('button', { name: 'Confirm Upload' }))
  expect(screen.getByRole('alertdialog', { name: 'Confirmar upload manual?' })).toBeTruthy()
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Confirmar upload' }))
  await waitFor(() => expect(window.codeAwareness.confirmAcademyOpenAiUpload).toHaveBeenCalledWith('release-1', 'a'.repeat(64)))
})

it('opens and closes the responsive operations drawer from the compact control', async () => {
  render(<AcademyView />)
  await screen.findByText('Destinos de Distribuição')
  const operations = screen.getByLabelText('Operações da Academy')
  expect(operations.classList.contains('is-open')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Abrir operações' }))
  expect(operations.classList.contains('is-open')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Fechar operações' }))
  expect(operations.classList.contains('is-open')).toBe(false)
})

it('renders actionable conflicts only when they exist', async () => {
  const conflict = { id: 'conflict-1', skillId: detail.id, skillName: detail.name, origin: 'FILESYSTEM' as const, baseVersion: 1, currentVersion: 2, divergentPackage: detail.current.package, divergentHash: 'divergent', projectId: null, projectionPath: null, status: 'OPEN' as const, createdAt: detail.createdAt, resolvedAt: null }
  window.codeAwareness.reviewAcademyConflict = vi.fn(async () => ({ conflict, candidateHash: 'candidate', historicalVersion: null, cause: 'DIVERGENT' as const, canonicalHash: 'hash', currentVersion: 2, diskHash: 'disk', diff: '-before\n+after', token: 'review-token', safeCanonical: false, reason: 'Revisão individual' }))
  const { divergentPackage: _package, ...summary } = conflict
  vi.mocked(window.codeAwareness.getAcademySnapshot).mockResolvedValueOnce({
    skills: [detail], destinations: [destination], conflicts: [{ ...summary, hasDivergentPackage: true, historicalVersion: null, occurrenceCount: 1, cause: 'DIVERGENT' }]
  })
  render(<AcademyView />)
  expect(await screen.findByText('Conflitos')).toBeTruthy()
  expect(window.codeAwareness.reviewAcademyConflict).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Manter canônica' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Conteúdo divergente 1' }))
  fireEvent.click(screen.getByRole('button', { name: /alpha.*canônica v2/ }))
  await screen.findByLabelText('Diferenças entre canônica e divergente')
  fireEvent.click(screen.getByRole('button', { name: 'Manter canônica' }))
  expect(window.codeAwareness.resolveAcademyConflict).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar canônica' }))
  await waitFor(() => expect(window.codeAwareness.resolveAcademyConflict).toHaveBeenCalledWith('conflict-1', 'CANONICAL', undefined, { token: 'review-token', confirmed: true }))
})

it('shows independent Antigravity health alongside the existing distribution targets', async () => {
  render(<AcademyView />)
  expect(await screen.findByText('Antigravity')).toBeTruthy()
  expect(screen.getByText('Claude code')).toBeTruthy()
  expect(screen.getByText('Filesystem native')).toBeTruthy()
  expect(screen.getByText('0 current · 1 error')).toBeTruthy()
})
