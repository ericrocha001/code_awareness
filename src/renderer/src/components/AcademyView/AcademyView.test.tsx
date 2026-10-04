// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AcademyView } from './AcademyView'

const detail = {
  id: 'skill-1', name: 'alpha', description: 'Alpha skill', status: 'ACTIVE' as const, scope: 'GLOBAL' as const,
  currentVersion: 1, projectIds: [], createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z',
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
    getAcademySnapshot: vi.fn(async () => ({ skills: [detail], destinations: [destination], conflicts: [] })),
    getAcademySkill: vi.fn(async () => detail), getAcademyHistory: vi.fn(async () => [detail.current]),
    createAcademySkill: vi.fn(async () => detail), updateAcademySkill: vi.fn(async () => ({ ...detail, currentVersion: 2, current: { ...detail.current, version: 2 } })),
    archiveAcademySkill: vi.fn(async () => ({ ...detail, status: 'ARCHIVED' })), restoreAcademySkill: vi.fn(async () => detail),
    setAcademyDestinationEnabled: vi.fn(), importAcademyDestination: vi.fn(async () => []), resolveAcademyConflict: vi.fn(async () => detail),
    getAcademyDistributionHealth: vi.fn(async () => ({ targets: [{ target: 'FILESYSTEM_NATIVE', convergence: 'CONVERGED', current: 1, pending: 0, drifted: 0, missing: 0, error: 0, lastReconciledAt: detail.updatedAt }, { target: 'CLAUDE_CODE', convergence: 'CONVERGED', current: 1, pending: 0, drifted: 0, missing: 0, error: 0, lastReconciledAt: detail.updatedAt }] })),
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

const selectAlpha = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /alpha/i }))
  await screen.findByRole('button', { name: 'Editar' })
}

it('lists, opens in VIEW and updates a canonical skill with expectedVersion', async () => {
  render(<AcademyView />)
  await selectAlpha()
  expect(await screen.findByText(/name: alpha/)).toBeTruthy()
  expect(screen.queryByLabelText('Editar SKILL.md')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }))
  const editor = screen.getByLabelText('Editar SKILL.md')
  fireEvent.change(editor, { target: { value: `${detail.current.package.skillMd}\nUpdated` } })
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
  await waitFor(() => expect(window.codeAwareness.updateAcademySkill).toHaveBeenCalledWith(expect.objectContaining({ skillId: 'skill-1', expectedVersion: 1 })))
  expect(await screen.findByText('Versão 2 salva.')).toBeTruthy()
})

it('cancels an edit without persistence and creates a new skill only on save', async () => {
  render(<AcademyView />)
  await selectAlpha()
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }))
  fireEvent.change(screen.getByLabelText('Editar SKILL.md'), { target: { value: 'discard me' } })
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
  expect(window.codeAwareness.updateAcademySkill).not.toHaveBeenCalled()
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
  fireEvent.click(screen.getByRole('button', { name: 'Visão Geral' }))
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
  expect(screen.getByText('Source Available')).toBeTruthy()
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
  vi.mocked(window.codeAwareness.getAcademySnapshot).mockResolvedValueOnce({
    skills: [detail], destinations: [destination], conflicts: [{ id: 'conflict-1', skillId: detail.id, skillName: detail.name, origin: 'FILESYSTEM', baseVersion: 1, currentVersion: 2, divergentPackage: detail.current.package, divergentHash: 'divergent', projectId: null, projectionPath: null, status: 'OPEN', createdAt: detail.createdAt, resolvedAt: null }]
  })
  render(<AcademyView />)
  expect(await screen.findByText('Conflitos')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Manter canônica' }))
  await waitFor(() => expect(window.codeAwareness.resolveAcademyConflict).toHaveBeenCalledWith('conflict-1', 'CANONICAL'))
})
