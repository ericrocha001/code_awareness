// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AcademyView } from './AcademyView'
import { gitPresentation, releasePresentation } from './academy-presentation'
import type { AcademyPublicationPreference } from '../../../../shared/types/academy-types'

const detail = {
  id: 'skill-1',
  name: 'alpha',
  description: 'Alpha skill',
  status: 'ACTIVE' as const,
  scope: 'GLOBAL' as const,
  publicationEligibility: 'APPROVED' as const,
  publicationSource: 'MANUAL' as const,
  currentVersion: 1,
  stateRevision: 1,
  projectIds: [],
  createdAt: '2026-09-23T00:00:00.000Z',
  updatedAt: '2026-09-23T00:00:00.000Z',
  current: {
    skillId: 'skill-1',
    version: 1,
    package: { skillMd: '---\nname: alpha\ndescription: Alpha skill\n---\n# Alpha', artifacts: { 'README.md': '# Usage' } },
    packageHash: 'hash',
    origin: 'IMPORT' as const,
    createdAt: '2026-09-23T00:00:00.000Z'
  }
}
const destination = {
  id: 'repo',
  path: 'C:/repo',
  name: 'repo',
  enabled: true,
  reconciliationStatus: 'SYNCED' as const,
  lastError: null,
  updatedAt: detail.updatedAt
}
const openAiRelease = {
  id: 'release-1',
  pluginVersion: '0.1.4',
  createdAt: detail.createdAt,
  referenceReleaseId: 'baseline',
  snapshot: [{ skillId: detail.id, name: detail.name, academyVersion: 1, packageHash: 'hash' }],
  snapshotHash: 'snapshot',
  delta: { added: [], updated: [], removed: [], renamed: [], destructive: false },
  manifest: {},
  artifactPath: 'C:/release.zip',
  artifactHash: 'a'.repeat(64),
  status: 'READY_TO_UPLOAD' as const,
  blockedReason: null,
  baseline: false,
  uploadConfirmation: null,
  verificationEvidence: null
}
const defaultPreference: AcademyPublicationPreference = {
  autoIncludeGlobal: false,
  revision: 0,
  authority: null,
  consentVersion: null,
  updatedAt: null
}

beforeEach(() => {
  let preference = { ...defaultPreference }
  window.codeAwareness = {
    getAcademyBootstrapState: vi.fn(async (initializationId: string) => ({
      initializationId,
      hydration: 'READY',
      provenance: 'ACADEMY_SQLITE',
      storeDurationMs: 1,
      snapshot: await window.codeAwareness.getAcademySnapshot(),
      git: await window.codeAwareness.getAcademyGitStatus(),
      publication: {
        publishedVersion: '0.1.3',
        release: { id: openAiRelease.id, version: openAiRelease.pluginVersion, status: openAiRelease.status, sourceCommitSha: null },
        marketplace: { takeoverStatus: 'TAKEOVER_UNSUPPORTED', mode: 'PENDING_EVIDENCE', observedPluginId: null, evidence: '', updatedAt: detail.updatedAt }
      }
    })),
    onAcademyChanged: vi.fn(() => () => {}),
    checkAcademyGit: vi.fn(async () => window.codeAwareness.getAcademyGitStatus()),
    getAcademySnapshot: vi.fn(async () => ({ skills: [detail], destinations: [destination], conflicts: [] })),
    getAcademySkill: vi.fn(async () => detail),
    getAcademyHistory: vi.fn(async () => [detail.current]),
    getAcademyDraft: vi.fn(async () => ({ package: detail.current.package, workspaceCommitSha: 'draft-base', sourceBaseCommitSha: 'confirmed-main' })),
    createAcademySkill: vi.fn(async () => detail),
    updateAcademySkill: vi.fn(async () => ({ ...detail, currentVersion: 2, current: { ...detail.current, version: 2 } })),
    setAcademySkillEnabled: vi.fn(async () => ({ ...detail, status: 'DISABLED', stateRevision: 2 })),
    approveAcademyPublicSkill: vi.fn(async () => ({ ...detail, publicationEligibility: 'APPROVED' })),
    approveAcademyPublicSkills: vi.fn(async () => [{ ...detail, publicationEligibility: 'APPROVED' }]),
    getAcademyPublicationPreference: vi.fn(async () => preference),
    setAcademyPublicationPreference: vi.fn(async (autoIncludeGlobal: boolean) => {
      preference = {
        autoIncludeGlobal,
        revision: preference.revision + 1,
        authority: 'ELECTRON_OPERATOR',
        consentVersion: '1',
        updatedAt: detail.updatedAt
      }
      return preference
    }),
    deleteAcademyGlobalSkill: vi.fn(async () => detail),
    restoreAcademySkill: vi.fn(async () => detail),
    setAcademyDestinationEnabled: vi.fn(),
    importAcademyDestination: vi.fn(async () => []),
    reviewAcademyConflict: vi.fn(),
    previewAcademyConflictBatch: vi.fn(),
    resolveAcademyConflictBatch: vi.fn(),
    resolveAcademyConflict: vi.fn(async () => detail),
    getAcademyDeliveryStatus: vi.fn(async () => ({
      skillId: detail.id,
      version: detail.currentVersion,
      packageHash: detail.current.packageHash,
      status: 'CONVERGED',
      destinations: []
    })),
    getAcademyDistributionHealth: vi.fn(async () => ({
      targets: [
        { target: 'FILESYSTEM_NATIVE', convergence: 'CONVERGED', current: 1, pending: 0, drifted: 0, missing: 0, error: 0, lastReconciledAt: detail.updatedAt },
        { target: 'CLAUDE_CODE', convergence: 'CONVERGED', current: 1, pending: 0, drifted: 0, missing: 0, error: 0, lastReconciledAt: detail.updatedAt },
        { target: 'ANTIGRAVITY', convergence: 'DEGRADED', current: 0, pending: 0, drifted: 0, missing: 0, error: 1, lastReconciledAt: detail.updatedAt }
      ]
    })),
    listAcademyDistributionStates: vi.fn(async () => []),
    reconcileAcademyDistribution: vi.fn(async () => ({ health: { targets: [] }, states: [] })),
    bootstrapAcademyOpenAiPlugin: vi.fn(),
    getAcademyOpenAiPublicationState: vi.fn(async () => ({
      profile: {
        name: 'academy-skills',
        displayName: 'Academy Skills',
        description: 'Skills',
        author: {},
        openAiInterface: {},
        logoPath: null,
        publishedVersion: '0.1.3',
        deletionSemantics: 'UNKNOWN',
        deletionSemanticsEvidence: null,
        createdAt: detail.createdAt,
        updatedAt: detail.updatedAt
      },
      latestPrepared: openAiRelease,
      latestUploaded: null,
      selectedRelease: openAiRelease,
      publicSkillCount: 1,
      artifactAvailable: true,
      coverage: {
        catalog: 1,
        eligible: 1,
        includedInLastZip: 1,
        awaitingZip: 0,
        notApplicable: 0,
        excluded: [],
        preference: defaultPreference
      },
      canonicalSnapshotHash: 'snapshot',
      drifted: false,
      currentPackageRevision: null,
      importConfirmationPreference: { mode: 'MANUAL' as const, updatedAt: null },
      hostedStatus: 'HOSTED_UPDATE_AVAILABLE'
    })),
    listAcademyOpenAiReleases: vi.fn(async () => [openAiRelease]),
    prepareAcademyOpenAiRelease: vi.fn(async () => openAiRelease),
    getAcademyPackageDistributionState: vi.fn(async () => ({
      packageRevision: {
        id: 'revision',
        version: '0.1.5',
        contentFingerprint: 'content',
        skillSnapshotHash: 'snapshot',
        profileFingerprint: 'profile',
        assetHash: 'asset',
        delta: openAiRelease.delta,
        createdAt: detail.createdAt
      },
      skillCount: 1,
      git: {
        profile: null,
        repository: { id: 'repo', name: 'Academy', fullName: 'ericrocha001/Academy', visibility: 'PRIVATE', checkoutPath: 'C:/Academy', branch: 'main' },
        syncState: 'SYNCED',
        lastSyncAt: detail.updatedAt,
        lastCommitSha: 'abcdef',
        lastError: null
      },
      marketplace: {
        takeoverStatus: 'TAKEOVER_UNSUPPORTED',
        mode: 'SOURCE_AVAILABLE',
        observedPluginId: 'academy-skills@academy',
        evidence: 'probe',
        updatedAt: detail.updatedAt
      },
      hosted: { status: 'HOSTED_UPDATE_AVAILABLE', label: 'Hosted Personal', version: '0.1.4' }
    })),
    confirmAcademyOpenAiUpload: vi.fn(async () => ({ ...openAiRelease, status: 'UPLOADED_UNVERIFIED' as const })),
    revealAcademyOpenAiPackage: vi.fn(async () => true),
    getAcademyGeminiExportState: vi.fn(async () => ({
      mode: 'FULL' as const,
      requiresMcp: false,
      baselineEstablished: false,
      importConfirmationPreference: { mode: 'MANUAL' as const, updatedAt: null },
      fullImportConfirmation: null,
      latestExport: {
        exportId: 'gemini-export-1',
        exportedAt: detail.createdAt,
        snapshotHash: 'snapshot',
        artifactPath: 'C:/gemini/academy-gemini.zip',
        artifactHash: 'g'.repeat(64),
        skillCount: 1,
        totalBytes: 1024,
        skills: [{ name: 'alpha', zipSha256: 'sha', entryCount: 2, byteLength: 512 }]
      },
      coverage: {
        catalog: 1,
        eligible: 1,
        includedInLastZip: 1,
        awaitingZip: 0,
        notApplicable: 0,
        excluded: []
      },
      canonicalSnapshotHash: 'snapshot',
      pendingSkills: [],
      importedSkills: [],
      manualActions: [],
      drifted: false,
      artifactAvailable: true,
      lastError: null
    })),
    getAcademyImportConfirmationPreference: vi.fn(async () => ({ mode: 'MANUAL' as const, updatedAt: null })),
    setAcademyImportConfirmationPreference: vi.fn(async (mode: 'MANUAL' | 'AUTOMATIC') => ({
      mode,
      updatedAt: detail.updatedAt
    })),
    setAcademyGeminiExportMode: vi.fn(),
    downloadAcademyGeminiExport: vi.fn(),
    confirmAcademyGeminiImport: vi.fn(),
    revokeAcademyGeminiImport: vi.fn(),
    establishAcademyGeminiBaseline: vi.fn(),
    acknowledgeAcademyGeminiManualAction: vi.fn(),
    downloadAcademyOpenAiPackage: vi.fn(async () => openAiRelease),
    revokeAcademyOpenAiUpload: vi.fn(async () => openAiRelease),
    prepareAcademyGeminiExport: vi.fn(async () => ({
      exportId: 'gemini-export-2',
      exportedAt: detail.createdAt,
      snapshotHash: 'snapshot',
      artifactPath: 'C:/gemini/academy-gemini.zip',
      artifactHash: 'g'.repeat(64),
      skillCount: 1,
      totalBytes: 1024,
      skills: [{ name: 'alpha', zipSha256: 'sha', entryCount: 2, byteLength: 512 }]
    })),
    revealAcademyGeminiExport: vi.fn(async () => 'C:/gemini/academy-gemini.zip'),
    getAcademyGitStatus: vi.fn(async () => ({
      profile: null,
      repository: { id: 'repo', name: 'Academy', fullName: 'ericrocha001/Academy', visibility: 'PRIVATE', checkoutPath: 'C:/Academy', branch: 'main' },
      syncState: 'SYNCED',
      lastSyncAt: detail.updatedAt,
      lastCommitSha: 'abcdef',
      lastError: null
    })),
    listAcademyGitEligibleRepositories: vi.fn(async () => []),
    syncAcademyGitNow: vi.fn(),
    openAcademyGitRepository: vi.fn(async () => true),
    bindAcademyGitRepository: vi.fn()
  } as unknown as Window['codeAwareness']
})
afterEach(cleanup)

const openSkillsSurface = async () => {
  const skillsTab = await screen.findByRole('button', { name: 'Skills' })
  fireEvent.click(skillsTab)
}

const openGeminiSurface = async () => {
  const geminiTab = await screen.findByRole('button', { name: 'Gemini' })
  fireEvent.click(geminiTab)
}

const selectAlpha = async () => {
  await openSkillsSurface()
  fireEvent.click(await screen.findByRole('button', { name: /alpha/i }))
  await screen.findByRole('button', { name: 'Editar' })
}

const openSettingsDrawer = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Configurações' }))
  return screen.findByRole('dialog', { name: 'Configurações da Academy' })
}

it('opens directly on the 1-click Plugin ChatGPT surface without the legacy OperationsRail', async () => {
  render(<AcademyView />)
  const region = await screen.findByRole('region', { name: 'Plugin ChatGPT' })
  expect(screen.queryByLabelText('Operações da Academy')).toBeNull()
  expect(within(region).getByText('Plugin ChatGPT pronto para abrir')).toBeTruthy()
  expect(screen.getByTestId('academy-coverage-summary').textContent).toContain('1 Skill global no plugin')

  fireEvent.click(within(region).getByRole('button', { name: 'Abrir ZIP' }))
  await waitFor(() => expect(window.codeAwareness.revealAcademyOpenAiPackage).toHaveBeenCalledWith('release-1'))

  fireEvent.click(within(region).getByRole('button', { name: 'Regerar ZIP' }))
  await waitFor(() => expect(window.codeAwareness.prepareAcademyOpenAiRelease).toHaveBeenCalled())
})

it('navigates to Gemini surface and supports 1-click export and reveal', async () => {
  render(<AcademyView />)
  await openGeminiSurface()
  const region = await screen.findByRole('region', { name: 'Exportação Gemini' })
  expect(within(region).getByText('Pacote Gemini pronto para importação')).toBeTruthy()
  expect(screen.getByTestId('academy-gemini-coverage-summary').textContent).toContain('1 Skill compatível para Gemini')

  fireEvent.click(within(region).getByRole('button', { name: 'Regerar ZIP' }))
  await waitFor(() => expect(window.codeAwareness.prepareAcademyGeminiExport).toHaveBeenCalled())

  fireEvent.click(within(region).getByRole('button', { name: 'Abrir ZIP' }))
  await waitFor(() => expect(window.codeAwareness.revealAcademyGeminiExport).toHaveBeenCalled())
})

it('reviews excluded Gemini skills and displays incompatibility details', async () => {
  vi.mocked(window.codeAwareness.getAcademyGeminiExportState).mockResolvedValueOnce({
    mode: 'FULL',
    requiresMcp: false,
    baselineEstablished: false,
    importConfirmationPreference: { mode: 'MANUAL', updatedAt: null },
    fullImportConfirmation: null,
    latestExport: null,
    coverage: {
      catalog: 3,
      eligible: 1,
      includedInLastZip: null,
      awaitingZip: 1,
      notApplicable: 0,
      excluded: [
        {
          skillId: 'skill-incomp',
          name: 'incomp-skill',
          version: 1,
          reason: 'INCOMPATIBLE',
          action: 'VIEW_SKILL',
          details: "Arquivo 'scripts/run.py' não suportado pelo Gemini Web."
        },
        {
          skillId: 'skill-priv',
          name: 'priv-skill',
          version: 2,
          reason: 'PRIVATE',
          action: 'APPROVE_PUBLICATION',
          details: 'Skill privada sem aprovação para publicação.'
        }
      ]
    },
    canonicalSnapshotHash: 'hash',
    pendingSkills: [],
    importedSkills: [],
    manualActions: [],
    drifted: true,
    artifactAvailable: false,
    lastError: null
  })

  render(<AcademyView />)
  await openGeminiSurface()
  const region = await screen.findByRole('region', { name: 'Exportação Gemini' })
  expect(within(region).getByText(/2 Skills fora do pacote/)).toBeTruthy()

  fireEvent.click(within(region).getByRole('button', { name: 'Revisar' }))
  const modal = await screen.findByRole('dialog', { name: 'Revisar Skills fora do pacote Gemini' })
  expect(within(modal).getByText("Arquivo 'scripts/run.py' não suportado pelo Gemini Web.")).toBeTruthy()
  expect(within(modal).getByText('Incompatível com Gemini')).toBeTruthy()
  expect(within(modal).getByText('Privada · Requer aprovação')).toBeTruthy()

  fireEvent.click(within(modal).getByRole('button', { name: 'Aprovar publicação' }))
  await waitFor(() => expect(window.codeAwareness.approveAcademyPublicSkill).toHaveBeenCalledWith('skill-priv', 2, true))
})

it('shows empty and stale ZIP states distinctly and confirms manual upload only intentionally', async () => {
  const state = await window.codeAwareness.getAcademyOpenAiPublicationState()
  vi.mocked(window.codeAwareness.getAcademyOpenAiPublicationState).mockResolvedValueOnce({
    ...state,
    selectedRelease: null,
    latestPrepared: null,
    artifactAvailable: false,
    coverage: { ...state.coverage!, includedInLastZip: null, awaitingZip: 1 }
  })

  render(<AcademyView />)
  expect(await screen.findByText('Nenhum ZIP gerado ainda')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Gerar plugin' }))
  await waitFor(() => expect(window.codeAwareness.prepareAcademyOpenAiRelease).toHaveBeenCalledTimes(1))

  fireEvent.click(await screen.findByRole('button', { name: 'Confirmar envio ao ChatGPT' }))
  const dialog = screen.getByRole('dialog', { name: 'Confirmar envio manual ao ChatGPT?' })
  expect(window.codeAwareness.confirmAcademyOpenAiUpload).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar envio' }))
  await waitFor(() => expect(window.codeAwareness.confirmAcademyOpenAiUpload).toHaveBeenCalledWith('release-1', 'a'.repeat(64)))
})

it('reviews excluded PRIVATE and DISABLED skills with individual/batch CAS approval and single-consent opt-out', async () => {
  const priv = { ...detail, id: 'skill-priv', name: 'priv-skill', publicationEligibility: 'PRIVATE' as const, currentVersion: 2, stateRevision: 3 }
  const disabled = { ...detail, id: 'skill-off', name: 'off-skill', status: 'DISABLED' as const, publicationEligibility: 'APPROVED' as const, currentVersion: 1, stateRevision: 4 }
  const state = await window.codeAwareness.getAcademyOpenAiPublicationState()
  vi.mocked(window.codeAwareness.getAcademySnapshot).mockResolvedValue({ skills: [detail, priv, disabled], destinations: [destination], conflicts: [] })
  vi.mocked(window.codeAwareness.getAcademyOpenAiPublicationState).mockResolvedValue({
    ...state,
    coverage: {
      catalog: 4,
      eligible: 1,
      includedInLastZip: 1,
      awaitingZip: 0,
      notApplicable: 1,
      excluded: [
        { skillId: priv.id, name: priv.name, version: 2, reason: 'PRIVATE', action: 'APPROVE_PUBLICATION' },
        { skillId: disabled.id, name: disabled.name, version: 1, reason: 'DISABLED', action: 'ENABLE_SKILL' }
      ],
      preference: defaultPreference
    }
  })

  render(<AcademyView />)
  await screen.findByText('2 Skills fora do plugin')
  fireEvent.click(screen.getByRole('button', { name: 'Revisar' }))
  const modal = await screen.findByRole('dialog', { name: 'Revisar Skills fora do plugin' })
  expect(within(modal).getByText('priv-skill')).toBeTruthy()
  expect(within(modal).getByText('off-skill')).toBeTruthy()
  expect(within(modal).getByText(/1 com escopo PROJECT/)).toBeTruthy()

  fireEvent.click(within(modal).getByRole('button', { name: 'Reativar Skill' }))
  await waitFor(() => expect(window.codeAwareness.setAcademySkillEnabled).toHaveBeenCalledWith(disabled.id, true, 4))

  fireEvent.click(within(modal).getByRole('checkbox', { name: 'Selecionar priv-skill para inclusão' }))
  fireEvent.click(within(modal).getByRole('button', { name: 'Incluir selecionadas no plugin (1)' }))
  const batchConfirm = await screen.findByRole('dialog', { name: 'Incluir 1 Skills no plugin?' })
  fireEvent.click(within(batchConfirm).getByRole('button', { name: 'Incluir selecionadas' }))
  await waitFor(() => expect(window.codeAwareness.approveAcademyPublicSkills).toHaveBeenCalledWith([{ skillId: priv.id, expectedVersion: 2 }], true))

  fireEvent.click(within(modal).getByRole('button', { name: 'Autorizar inclusão automática' }))
  const consentConfirm = await screen.findByRole('dialog', { name: 'Autorizar inclusão automática de novas Skills globais?' })
  fireEvent.click(within(consentConfirm).getByRole('button', { name: 'Ativar autorização única' }))
  await waitFor(() => expect(window.codeAwareness.setAcademyPublicationPreference).toHaveBeenCalledWith(true, true))
  await within(modal).findByText(/Autorização única ativa/)

  fireEvent.click(within(modal).getByRole('button', { name: 'Fechar' }))
  await openSkillsSurface()
  fireEvent.click(screen.getByRole('button', { name: 'Nova Skill' }))
  const keepPrivateCheck = await screen.findByRole('checkbox', { name: /Manter privada/ })
  fireEvent.click(keepPrivateCheck)
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
  await waitFor(() => expect(window.codeAwareness.createAcademySkill).toHaveBeenCalledWith(expect.objectContaining({ scope: 'GLOBAL', keepPrivate: true })))
})

it('keeps the full package across tabs and refuses to save unchanged content', async () => {
  render(<AcademyView />)
  await selectAlpha()
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }))
  const editor = await screen.findByLabelText('Conteúdo do SKILL.md')
  expect(screen.getAllByRole('button', { name: 'Salvar' })).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Salvar' }).hasAttribute('disabled')).toBe(true)
  const full = '---\nname: alpha\ndescription: Unicode ação\nunknown-field: preserve-me\n---\n' + '長い linha '.repeat(150)
  fireEvent.change(editor, { target: { value: full } })
  fireEvent.change(screen.getByLabelText('Escopo'), { target: { value: 'PROJECT' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'repo' }))
  expect(screen.getByRole('button', { name: /README.md/ })).toBeTruthy()
  expect((screen.getByLabelText('Conteúdo do SKILL.md') as HTMLTextAreaElement).value).toBe(full)
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
  await waitFor(() => expect(window.codeAwareness.updateAcademySkill).toHaveBeenCalledWith(expect.objectContaining({
    expectedVersion: 1,
    scope: 'PROJECT',
    projectIds: ['repo'],
    package: { skillMd: full, artifacts: detail.current.package.artifacts }
  })))
})

it('preserves drafts on selection, surface switch, cancel and external navigation until discard is confirmed', async () => {
  let guard: ((proceed: () => void) => void) | null = null
  const navigate = vi.fn()
  render(<AcademyView onNavigationGuardChange={value => { guard = value }} />)
  await selectAlpha()
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }))
  fireEvent.change(await screen.findByLabelText('Conteúdo do SKILL.md'), { target: { value: 'draft to keep' } })

  fireEvent.click(screen.getByRole('button', { name: 'Plugin ChatGPT' }))
  expect(screen.getByRole('alertdialog')).toBeTruthy()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect((screen.getByLabelText('Conteúdo do SKILL.md') as HTMLTextAreaElement).value).toBe('draft to keep')

  act(() => guard!(navigate))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancelar' }))
  expect(navigate).not.toHaveBeenCalled()
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload)
  expect(unload.defaultPrevented).toBe(true)

  act(() => guard!(navigate))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Descartar' }))
  expect(navigate).toHaveBeenCalledTimes(1)
  expect(window.codeAwareness.updateAcademySkill).not.toHaveBeenCalled()
})

it('keeps a failed CAS draft and blocks duplicate saves while pending', async () => {
  let reject!: (error: Error) => void
  vi.mocked(window.codeAwareness.updateAcademySkill).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
  render(<AcademyView />)
  await selectAlpha()
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }))
  fireEvent.change(await screen.findByLabelText('Conteúdo do SKILL.md'), { target: { value: 'CAS draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
  const savingButton = screen.getByRole('button', { name: 'Salvando…' })
  expect(savingButton.hasAttribute('disabled')).toBe(true)
  fireEvent.click(savingButton)
  expect(window.codeAwareness.updateAcademySkill).toHaveBeenCalledTimes(1)
  await act(async () => reject(new Error('VERSION_CONFLICT')))
  expect((screen.getByLabelText('Conteúdo do SKILL.md') as HTMLTextAreaElement).value).toBe('CAS draft')
  expect(screen.getByText('VERSION_CONFLICT')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Salvar' }).hasAttribute('disabled')).toBe(false)
})

it('guards the file drawer with Escape and restores focus without losing its draft', async () => {
  render(<AcademyView />)
  await selectAlpha()
  const trigger = screen.getByRole('button', { name: /README.md/ })
  trigger.focus()
  fireEvent.click(trigger)
  fireEvent.change(screen.getByLabelText('Conteúdo'), { target: { value: 'keep file text' } })
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.getByRole('alertdialog', { name: 'Descartar alterações do artefato?' })).toBeTruthy()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect((screen.getByLabelText('Conteúdo') as HTMLTextAreaElement).value).toBe('keep file text')
  fireEvent.click(screen.getByRole('button', { name: 'Aplicar no rascunho' }))
  expect(document.activeElement).toBe(trigger)
  expect(window.codeAwareness.updateAcademySkill).not.toHaveBeenCalled()
})

it('keeps public approval and local tombstone deletion behind explicit confirmation', async () => {
  const local = { ...detail, catalogRevision: 4, publicationEligibility: 'PRIVATE' as const }
  vi.mocked(window.codeAwareness.getAcademySkill).mockResolvedValue(local)
  const git = await window.codeAwareness.getAcademyGitStatus()
  vi.mocked(window.codeAwareness.getAcademyGitStatus).mockResolvedValue({
    ...git,
    convergence: { cutover: 'LOCAL', localRevision: 4, lastConvergedRevision: null, pending: true, freshness: 'UNVERIFIED' }
  })
  render(<AcademyView />)
  await selectAlpha()
  fireEvent.click(screen.getByRole('button', { name: 'Incluir no plugin' }))
  expect(window.codeAwareness.approveAcademyPublicSkill).not.toHaveBeenCalled()
  const approvalDialog = await screen.findByRole('dialog', { name: 'Incluir Skill no plugin ChatGPT?' })
  fireEvent.click(within(approvalDialog).getByRole('button', { name: 'Incluir no plugin' }))
  await waitFor(() => expect(window.codeAwareness.approveAcademyPublicSkill).toHaveBeenCalledWith(detail.id, 1, true))

  fireEvent.click(screen.getByRole('button', { name: 'Excluir global' }))
  expect(window.codeAwareness.deleteAcademyGlobalSkill).not.toHaveBeenCalled()
  fireEvent.click(within(screen.getByRole('alertdialog', { name: 'Excluir Skill global?' })).getByRole('button', { name: 'Excluir' }))
  await waitFor(() => expect(window.codeAwareness.deleteAcademyGlobalSkill).toHaveBeenCalledWith(detail.id, 1, true))
})

it('keeps Git cutover and automation in Configurações without running mutations on mount', async () => {
  const git = await window.codeAwareness.getAcademyGitStatus()
  const pending = {
    ...git,
    profile: { githubRepositoryId: 'repo', branch: 'main' },
    publication: { autoPublish: false, autoUpdate: false, conflictPaths: [] },
    convergence: { cutover: 'PENDING', freshness: 'UNVERIFIED', localRevision: 0, lastConvergedRevision: null, pending: true }
  } as any
  vi.mocked(window.codeAwareness.getAcademyGitStatus).mockResolvedValue(pending)
  window.codeAwareness.completeAcademyLocalCutover = vi.fn(async () => pending)
  window.codeAwareness.configureAcademyGitAutomation = vi.fn(async () => pending)

  render(<AcademyView />)
  expect(window.codeAwareness.completeAcademyLocalCutover).not.toHaveBeenCalled()
  expect(window.codeAwareness.prepareAcademyOpenAiRelease).not.toHaveBeenCalled()
  expect(window.codeAwareness.confirmAcademyOpenAiUpload).not.toHaveBeenCalled()
  expect(window.codeAwareness.configureAcademyGitAutomation).not.toHaveBeenCalled()

  const drawer = await openSettingsDrawer()
  expect(within(drawer).getByRole('button', { name: 'Concluir cutover local' })).toBeTruthy()
  const toggle = within(drawer).getByRole('checkbox', { name: 'Publicar automaticamente alterações aprovadas no Git' }) as HTMLInputElement
  expect(toggle.checked).toBe(false)
  fireEvent.click(toggle)
  await waitFor(() => expect(window.codeAwareness.configureAcademyGitAutomation).toHaveBeenCalledWith({
    autoPublish: true,
    autoUpdate: false,
    confirmed: true,
    expectedRepositoryId: 'repo',
    expectedBranch: 'main'
  }))
})

it.each(['IDLE', 'FAILED', 'CHECKING', undefined])('never calls old SYNCED evidence current when remote check is %s', async state => {
  const git = await window.codeAwareness.getAcademyGitStatus()
  expect(gitPresentation({ ...git, remoteCheck: state ? { state, generation: 1 } as any : undefined }, 'READY')).toEqual({
    label: 'Última sincronização conhecida; verificação pendente',
    tone: 'neutral'
  })
})

it('distinguishes remote observation, external workspace review, conflict and unverified upload', async () => {
  const git = await window.codeAwareness.getAcademyGitStatus()
  const observed = { ...git, remoteCheck: { state: 'OK', generation: 1 } as any }
  expect(gitPresentation(observed, 'READY').tone).toBe('success')
  expect(gitPresentation({ ...observed, convergence: { cutover: 'LOCAL', localRevision: 2, lastConvergedRevision: 1, pending: true, freshness: 'UNVERIFIED' } }, 'READY').tone).toBe('neutral')
  expect(gitPresentation({ ...git, lastError: 'WORKSPACE_EXTERNAL_CHANGES_REVIEW_REQUIRED' }, 'READY')).toEqual({
    label: 'Alterações externas no workspace · revisão necessária',
    tone: 'warning'
  })
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
  await openSkillsSurface()
  fireEvent.click(await screen.findByRole('button', { name: /alpha/i }))
  fireEvent.click(screen.getByRole('button', { name: 'Nova Skill' }))
  fireEvent.change(await screen.findByLabelText('Conteúdo do SKILL.md'), { target: { value: 'unsaved new draft' } })
  await act(async () => finish(detail))
  expect((screen.getByLabelText('Conteúdo do SKILL.md') as HTMLTextAreaElement).value).toBe('unsaved new draft')
})

it('paints persisted bootstrap before secondary reads and coalesces offline verification without losing flags', async () => {
  const base = await window.codeAwareness.getAcademyGitStatus()
  vi.mocked(window.codeAwareness.getAcademyGitStatus).mockClear()
  const git = {
    ...base,
    profile: { repositoryCatalogId: 'repo', githubRepositoryId: 'github-id', branch: 'main' },
    publication: { autoPublish: true, autoUpdate: true, remoteHead: 'a'.repeat(40), conflictPaths: [] },
    lastKnown: { repositoryId: 'github-id', branch: 'main', remoteHead: 'a'.repeat(40), confirmedAt: detail.updatedAt, result: 'SYNCED', autoPublish: true, autoUpdate: true, localHead: 'a'.repeat(40) },
    remoteCheck: { state: 'IDLE', generation: 4, requestId: null, error: null, completedAt: null }
  } as any
  let finishBootstrap!: (value: any) => void
  let finishRemote!: (value: any) => void
  vi.mocked(window.codeAwareness.getAcademyBootstrapState).mockImplementation(() => new Promise(resolve => { finishBootstrap = resolve }))
  vi.mocked(window.codeAwareness.getAcademyOpenAiPublicationState).mockImplementation(() => new Promise(() => {}))
  vi.mocked(window.codeAwareness.getAcademyDistributionHealth).mockImplementation(() => new Promise(() => {}))
  vi.mocked(window.codeAwareness.checkAcademyGit).mockImplementation(() => new Promise(resolve => { finishRemote = resolve }))
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  try {
    render(<AcademyView />)
    expect(screen.getByText('Carregando catálogo…')).toBeTruthy()
    expect(window.codeAwareness.getAcademyBootstrapState).toHaveBeenCalledTimes(1)
    expect(window.codeAwareness.getAcademySnapshot).not.toHaveBeenCalled()
    expect(window.codeAwareness.getAcademyGitStatus).not.toHaveBeenCalled()
    expect(window.codeAwareness.getAcademyOpenAiPublicationState).not.toHaveBeenCalled()
    expect(window.codeAwareness.checkAcademyGit).not.toHaveBeenCalled()

    await act(async () => finishBootstrap({
      initializationId: vi.mocked(window.codeAwareness.getAcademyBootstrapState).mock.calls[0][0],
      hydration: 'READY',
      provenance: 'ACADEMY_SQLITE',
      storeDurationMs: 1,
      snapshot: { skills: [detail], destinations: [destination], conflicts: [] },
      git,
      publication: { publishedVersion: '0.27.16', release: { id: 'legacy', version: '0.27.16', status: 'UPLOADED_UNVERIFIED', sourceCommitSha: null } }
    }))

    await waitFor(() => expect(window.codeAwareness.checkAcademyGit).toHaveBeenCalledTimes(1))
    await openSkillsSurface()
    const search = screen.getByRole('searchbox', { name: 'Buscar Skills' })
    fireEvent.change(search, { target: { value: 'alpha' } })
    fireEvent.focus(window)
    fireEvent(window, new Event('online'))
    expect(window.codeAwareness.checkAcademyGit).toHaveBeenCalledTimes(1)

    await act(async () => finishRemote({
      ...git,
      syncState: 'OFFLINE',
      remoteCheck: { state: 'FAILED', generation: 5, requestId: 'current', error: 'offline', completedAt: detail.updatedAt }
    }))

    const drawer = await openSettingsDrawer()
    expect(within(drawer).getByText(/Falha ao verificar GitHub: offline/)).toBeTruthy()
    expect((within(drawer).getByRole('checkbox', { name: 'Publicar automaticamente alterações aprovadas no Git' }) as HTMLInputElement).checked).toBe(true)
    expect((within(drawer).getByRole('checkbox', { name: 'Atualizar automaticamente quando o remoto avançar' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('searchbox', { name: 'Buscar Skills' }) as HTMLInputElement).value).toBe('alpha')

    const marks = log.mock.calls.filter(([tag]) => tag === '[Academy hydration]').map(([, body]) => JSON.parse(body as string))
    expect(marks.map(mark => mark.milestone)).toEqual(['STORE_RESPONSE', 'FIRST_USEFUL_PAINT', 'REMOTE_CHECK_COMPLETE'])
    expect(new Set(marks.map(mark => mark.initializationId)).size).toBe(1)
  } finally { log.mockRestore() }
})

it('discards older publication and Git responses after selective invalidation without wiping draft edits', async () => {
  const base = await window.codeAwareness.getAcademyGitStatus()
  const state = await window.codeAwareness.getAcademyOpenAiPublicationState()
  const git = {
    ...base,
    profile: { repositoryCatalogId: 'repo', githubRepositoryId: 'github-id', branch: 'main' },
    publication: { autoPublish: false, autoUpdate: true, conflictPaths: [] },
    remoteCheck: { state: 'OK', generation: 10, requestId: 'known', error: null, completedAt: detail.updatedAt }
  } as any
  vi.mocked(window.codeAwareness.getAcademyBootstrapState).mockResolvedValue({
    initializationId: 'fixture',
    hydration: 'READY',
    provenance: 'ACADEMY_SQLITE',
    storeDurationMs: 1,
    snapshot: { skills: [detail], destinations: [destination], conflicts: [] },
    git,
    publication: { publishedVersion: '0.1.3', release: null, marketplace: { mode: 'PENDING_EVIDENCE' } }
  } as any)
  vi.mocked(window.codeAwareness.checkAcademyGit).mockResolvedValue(git)
  let changed!: Parameters<Window['codeAwareness']['onAcademyChanged']>[0]
  window.codeAwareness.onAcademyChanged = vi.fn(listener => { changed = listener; return () => {} })
  let oldPublication!: (error: Error) => void
  vi.mocked(window.codeAwareness.getAcademyOpenAiPublicationState).mockReset()
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { oldPublication = reject }))
    .mockResolvedValue({ ...state, selectedRelease: { ...openAiRelease, pluginVersion: '0.2.9' } })

  render(<AcademyView />)
  await waitFor(() => expect(window.codeAwareness.getAcademyOpenAiPublicationState).toHaveBeenCalledTimes(1))
  act(() => changed({ kind: 'publication' }))
  await screen.findByText('v0.2.9')
  await act(async () => oldPublication(new Error('obsolete publication response')))
  expect(screen.queryByText('obsolete publication response')).toBeNull()
  expect(screen.queryByText('v0.1.4')).toBeNull()

  await selectAlpha()
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }))
  await screen.findByLabelText('Conteúdo do SKILL.md')
  const reads = vi.mocked(window.codeAwareness.getAcademySkill).mock.calls.length
  act(() => changed({ kind: 'catalog' }))
  await waitFor(() => expect(window.codeAwareness.getAcademySnapshot).toHaveBeenCalled())
  expect(window.codeAwareness.getAcademySkill).toHaveBeenCalledTimes(reads)
})

it('saves manifest revision and Git conflict resolutions only after explicit confirmation in Configurações', async () => {
  const preview = {
    repositoryId: 'repo',
    branch: 'main',
    sourceCommitSha: 'a'.repeat(40),
    workspaceCommitSha: 'b'.repeat(40),
    manifestHash: 'hash',
    previousVersion: '0.27.16',
    newVersion: '0.27.17',
    before: '{"version":"0.27.16"}',
    after: '{"version":"0.27.17"}',
    token: 'reviewed'
  }
  window.codeAwareness.previewAcademyManifestVersion = vi.fn(async () => preview)
  const current = await window.codeAwareness.getAcademyGitStatus()
  const conflict = {
    ...current,
    syncState: 'CONFLICT' as const,
    publication: {
      destinationKey: 'destination',
      checkoutPath: 'C:/publication',
      baselineTree: null,
      desiredRevision: 'revision',
      desiredTree: '',
      localHead: null,
      remoteHead: 'a'.repeat(40),
      verifiedAt: null,
      operationId: null,
      pendingCommit: null,
      legacyPendingHead: null,
      migrationComplete: true,
      conflictPaths: ['skills/alpha/SKILL.md'],
      phase: 'CONFLICT' as const
    }
  }
  vi.mocked(window.codeAwareness.getAcademyGitStatus).mockResolvedValue(conflict)
  window.codeAwareness.saveAcademyManifestVersion = vi.fn(async () => ({ ...conflict, syncState: 'LOCAL_CHANGES' as const }))
  window.codeAwareness.reviewAcademyGitConflict = vi.fn(async () => ({
    path: 'skills/alpha/SKILL.md',
    head: 'local-head',
    revision: 'observed-revision',
    base: 'base',
    local: 'local text',
    remote: 'remote text',
    working: 'conflict markers'
  }))
  window.codeAwareness.resolveAcademyGitConflictPath = vi.fn(async () => ({
    ...conflict,
    syncState: 'LOCAL_CHANGES',
    publication: { ...conflict.publication, conflictPaths: [] }
  })) as any

  render(<AcademyView />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Configurações' }).className).toContain('has-alert'))
  expect(screen.getByRole('button', { name: 'Abrir ZIP' })).toBeTruthy()

  const drawer = await openSettingsDrawer()
  fireEvent.click(within(drawer).getByRole('button', { name: 'Atualizar versão do manifesto (Git)' }))
  const manifestDialog = await screen.findByRole('dialog', { name: 'Atualizar versão para 0.27.17?' })
  expect(window.codeAwareness.saveAcademyManifestVersion).not.toHaveBeenCalled()
  fireEvent.click(within(manifestDialog).getByRole('button', { name: 'Salvar revisão' }))
  await waitFor(() => expect(window.codeAwareness.saveAcademyManifestVersion).toHaveBeenCalledWith({ preview, confirmed: true }))

  fireEvent.click(within(drawer).getByRole('button', { name: 'Revisar' }))
  const gitDialog = await screen.findByRole('dialog', { name: 'Conflito skills/alpha/SKILL.md' })
  expect(window.codeAwareness.resolveAcademyGitConflictPath).not.toHaveBeenCalled()
  fireEvent.change(within(gitDialog).getByRole('textbox'), { target: { value: 'reviewed merge' } })
  fireEvent.click(within(gitDialog).getByRole('button', { name: 'Aplicar resolução' }))
  await waitFor(() => expect(window.codeAwareness.resolveAcademyGitConflictPath).toHaveBeenCalledWith({
    path: 'skills/alpha/SKILL.md',
    head: 'local-head',
    revision: 'observed-revision',
    content: 'reviewed merge',
    confirmed: true
  }))
})

it('shows Git provenance rebuild, destination management and distribution health in Configurações', async () => {
  const state = await window.codeAwareness.getAcademyOpenAiPublicationState()
  const source = {
    id: 'build',
    releaseId: openAiRelease.id,
    buildSchema: 1 as const,
    sourceRepositoryId: 'repository',
    branch: 'main',
    sourceCommitSha: 'b'.repeat(40),
    managedTreeHash: 'tree',
    manifestFingerprint: 'manifest',
    assetFingerprint: 'asset',
    entriesFingerprint: 'entries',
    pluginVersion: openAiRelease.pluginVersion,
    zipSha256: openAiRelease.artifactHash,
    remoteConfirmation: 'CACHED' as const,
    confirmedAt: detail.createdAt
  }
  vi.mocked(window.codeAwareness.getAcademyOpenAiPublicationState).mockResolvedValue({ ...state, selectedRelease: { ...openAiRelease, source } })
  vi.mocked(window.codeAwareness.listAcademyOpenAiReleases).mockResolvedValue([{ ...openAiRelease, source }])

  render(<AcademyView />)
  const drawer = await openSettingsDrawer()
  expect(within(drawer).getByText('Antigravity')).toBeTruthy()
  expect(within(drawer).getByText('Claude Code')).toBeTruthy()
  expect(within(drawer).getByText('Filesystem local')).toBeTruthy()

  fireEvent.click(within(drawer).getByRole('button', { name: 'Reconstruir commit' }))
  const rebuildDialog = await screen.findByRole('dialog', { name: 'Reconstruir pacote do commit bbbbbbb?' })
  fireEvent.click(within(rebuildDialog).getByRole('button', { name: 'Reconstruir ZIP' }))
  await waitFor(() => expect(window.codeAwareness.prepareAcademyOpenAiRelease).toHaveBeenCalledWith({ mode: 'REBUILD', sourceCommitSha: source.sourceCommitSha }))

  fireEvent.click(within(drawer).getByRole('button', { name: 'Gerenciar destinos e importar' }))
  const manager = await screen.findByRole('dialog', { name: 'Destinos Academy' })
  fireEvent.click(within(manager).getByRole('button', { name: 'Importar .skills' }))
  await waitFor(() => expect(window.codeAwareness.importAcademyDestination).toHaveBeenCalledWith('repo'))
  fireEvent.click(within(manager).getByRole('button', { name: 'Fechar' }))

  fireEvent.click(within(drawer).getByRole('button', { name: 'Reconciliar destinos' }))
  await waitFor(() => expect(window.codeAwareness.reconcileAcademyDistribution).toHaveBeenCalled())
})

it('reports Git draft without claiming canonical version and surfaces failed sync honestly', async () => {
  window.codeAwareness.getAcademyDraft = vi.fn(async () => ({
    package: detail.current.package,
    workspaceCommitSha: 'draft-base',
    sourceBaseCommitSha: 'confirmed-main'
  }))
  vi.mocked(window.codeAwareness.updateAcademySkill).mockResolvedValue({
    state: 'DRAFT_SAVED',
    skillId: detail.id,
    name: detail.name,
    baseVersion: 1,
    sourceBaseCommitSha: 'confirmed-main',
    workspaceCommitSha: 'draft-next',
    packageHash: 'draft-hash',
    distribution: { status: 'NOT_APPLICABLE' }
  })
  vi.mocked(window.codeAwareness.syncAcademyGitNow).mockResolvedValue({
    profile: null,
    repository: { id: 'repo', name: 'Academy', fullName: 'ericrocha001/Academy', visibility: 'PRIVATE', checkoutPath: 'C:/Academy', branch: 'main' },
    syncState: 'PUSH_PENDING',
    lastSyncAt: null,
    lastCommitSha: null,
    lastError: 'Publication pending'
  })

  render(<AcademyView />)
  await selectAlpha()
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }))
  fireEvent.change(await screen.findByLabelText('Conteúdo do SKILL.md'), { target: { value: detail.current.package.skillMd + '\nDraft edit' } })
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
  await waitFor(() => expect(window.codeAwareness.updateAcademySkill).toHaveBeenCalledWith(expect.objectContaining({
    expectedVersion: 1,
    expectedDraftCommitSha: 'draft-base'
  })))
  expect(await screen.findByText(/Rascunho salvo em revisão no Git/)).toBeTruthy()
  expect(window.codeAwareness.getAcademyDeliveryStatus).not.toHaveBeenCalled()

  const drawer = await openSettingsDrawer()
  fireEvent.click(within(drawer).getByRole('button', { name: 'Sincronizar' }))
  expect(await within(drawer).findByText('Publication pending')).toBeTruthy()
})

it('renders actionable conflicts inside Configurações and switches tabs cleanly', async () => {
  const conflict = {
    id: 'conflict-1',
    skillId: detail.id,
    skillName: detail.name,
    origin: 'FILESYSTEM' as const,
    baseVersion: 1,
    currentVersion: 2,
    divergentPackage: detail.current.package,
    divergentHash: 'divergent',
    projectId: null,
    projectionPath: null,
    status: 'OPEN' as const,
    createdAt: detail.createdAt,
    resolvedAt: null
  }
  window.codeAwareness.reviewAcademyConflict = vi.fn(async () => ({
    conflict,
    candidateHash: 'candidate',
    historicalVersion: null,
    cause: 'DIVERGENT' as const,
    canonicalHash: 'hash',
    currentVersion: 2,
    diskHash: 'disk',
    diff: '-before\n+after',
    token: 'review-token',
    safeCanonical: false,
    reason: 'Revisão individual'
  }))
  const { divergentPackage: _package, ...summary } = conflict
  vi.mocked(window.codeAwareness.getAcademySnapshot).mockResolvedValue({
    skills: [detail],
    destinations: [destination],
    conflicts: [{ ...summary, hasDivergentPackage: true, historicalVersion: null, occurrenceCount: 1, cause: 'DIVERGENT' }]
  })

  render(<AcademyView />)
  const drawer = await openSettingsDrawer()
  fireEvent.click(within(drawer).getByRole('button', { name: /Conteúdo divergente/ }))
  fireEvent.click(within(drawer).getByRole('button', { name: /alpha.*canônica v2/ }))
  await screen.findByLabelText('Diferenças entre canônica e divergente')
  fireEvent.click(screen.getByRole('button', { name: 'Manter canônica' }))
  await waitFor(() => expect(window.codeAwareness.resolveAcademyConflict).toHaveBeenCalledWith('conflict-1', 'CANONICAL', undefined, {
    token: 'review-token',
    confirmed: true
  }))

  fireEvent.click(within(drawer).getByRole('button', { name: 'Fechar' }))
  await selectAlpha()
  const reads = vi.mocked(window.codeAwareness.getAcademySkill).mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: /Histórico/ }))
  const historyPanel = screen.getByText('IMPORT · ' + new Date(detail.createdAt).toLocaleString())
  expect(historyPanel).toBeTruthy()
  expect(window.codeAwareness.getAcademySkill).toHaveBeenCalledTimes(reads)
})

it('supports Gemini mode switching, differential pending/imported/manual-action controls, and baseline actions', async () => {
  const incrementalState = {
    mode: 'INCREMENTAL' as const,
    requiresMcp: false,
    baselineEstablished: false,
    importConfirmationPreference: { mode: 'AUTOMATIC' as const, updatedAt: detail.updatedAt },
    fullImportConfirmation: null,
    latestExport: {
      exportId: 'inc-export-1',
      mode: 'INCREMENTAL' as const,
      exportedAt: detail.createdAt,
      snapshotHash: 'snapshot',
      artifactPath: 'C:/gemini/incremental',
      artifactHash: 'i'.repeat(64),
      skillCount: 1,
      totalBytes: 512,
      skills: [{
        skillId: 'skill-pending',
        name: 'pending-skill',
        academyVersion: 1,
        fingerprint: 'fp-pending',
        reason: 'NEW_SKILL' as const,
        zipFileName: 'pending-skill.zip',
        zipSha256: 'sha',
        entryCount: 1,
        byteLength: 512
      }]
    },
    coverage: {
      catalog: 3,
      eligible: 2,
      includedInLastZip: 1,
      awaitingZip: 0,
      notApplicable: 1,
      adaptedCount: 0,
      excluded: [],
      imported: 1,
      upToDate: 1,
      pendingExport: 0,
      awaitingImport: 1,
      manualActionsCount: 1
    },
    canonicalSnapshotHash: 'snapshot',
    pendingSkills: [{
      skillId: 'skill-pending',
      name: 'pending-skill',
      academyVersion: 1,
      packageHash: 'pkg-pending',
      profileVersion: 'v1-script-markdown-reference',
      fingerprint: 'fp-pending',
      reason: 'NEW_SKILL' as const,
      zipFileName: 'pending-skill.zip',
      zipPath: 'C:/gemini/incremental/pending-skill.zip',
      zipHash: 'sha',
      zipSizeBytes: 512,
      awaitingImport: true
    }],
    importedSkills: [{
      skillId: 'skill-imported',
      name: 'imported-skill',
      academyVersion: 2,
      packageHash: 'pkg-imported',
      profileVersion: 'v1-script-markdown-reference',
      fingerprint: 'fp-imported',
      confirmedAt: detail.updatedAt,
      origin: 'ASSUMED_ON_DOWNLOAD' as const,
      upToDate: true
    }],
    manualActions: [{
      skillId: 'skill-removed',
      previousName: 'old-skill',
      action: 'REMOVE_IN_GEMINI' as const,
      reason: "Skill 'old-skill' foi excluída da Academy. Remova manualmente no Gemini Web.",
      checkpointedAt: detail.updatedAt
    }],
    drifted: false,
    artifactAvailable: true,
    lastError: null
  }

  vi.mocked(window.codeAwareness.setAcademyGeminiExportMode).mockResolvedValue(incrementalState)
  vi.mocked(window.codeAwareness.downloadAcademyGeminiExport).mockResolvedValue(incrementalState)
  vi.mocked(window.codeAwareness.confirmAcademyGeminiImport).mockResolvedValue(incrementalState)
  vi.mocked(window.codeAwareness.revokeAcademyGeminiImport).mockResolvedValue(incrementalState)
  vi.mocked(window.codeAwareness.acknowledgeAcademyGeminiManualAction).mockResolvedValue({ ...incrementalState, manualActions: [] })
  vi.mocked(window.codeAwareness.establishAcademyGeminiBaseline).mockResolvedValue(incrementalState)

  render(<AcademyView />)
  await openGeminiSurface()
  expect(screen.getByTestId('gemini-active-mode').textContent).toBe('Completo')

  // Open mode switcher dialog and apply Incremental mode
  fireEvent.click(screen.getByRole('button', { name: 'Configurar modo' }))
  const modeDialog = await screen.findByRole('dialog', { name: 'Modo de exportação Gemini' })
  fireEvent.click(within(modeDialog).getByLabelText(/Incremental/))
  fireEvent.click(within(modeDialog).getByRole('button', { name: 'Aplicar modo' }))
  await waitFor(() => expect(window.codeAwareness.setAcademyGeminiExportMode).toHaveBeenCalledWith('INCREMENTAL'))

  const region = await screen.findByRole('region', { name: 'Exportação Gemini' })
  expect(within(region).getByTestId('gemini-active-mode').textContent).toBe('Incremental')

  // Batch download & confirm controls (plus stale-conflict lastError surfacing on automatic download)
  vi.mocked(window.codeAwareness.downloadAcademyGeminiExport).mockResolvedValueOnce({
    ...incrementalState,
    lastError: 'GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT: Existe uma atualização pendente na Academy.'
  })
  fireEvent.click(within(region).getAllByRole('button', { name: 'Baixar pacote' })[0])
  await waitFor(() => expect(window.codeAwareness.downloadAcademyGeminiExport).toHaveBeenCalledTimes(1))
  expect((await within(region).findByRole('status')).textContent).toMatch(/atualização pendente/)

  fireEvent.click(within(region).getAllByRole('button', { name: 'Baixar pacote' })[0])
  await waitFor(() => expect(window.codeAwareness.downloadAcademyGeminiExport).toHaveBeenCalledTimes(2))
  fireEvent.click(within(region).getAllByRole('button', { name: 'Confirmar importação' })[0])
  await waitFor(() => expect(window.codeAwareness.confirmAcademyGeminiImport).toHaveBeenCalledWith({
    expectedFingerprints: { 'skill-pending': 'fp-pending' }
  }))

  // Imported skills list with provenance tag and undo
  const importedRegion = within(region).getByRole('region', { name: 'Skills importadas no Gemini' })
  expect(within(importedRegion).getByText('imported-skill')).toBeTruthy()
  expect(within(importedRegion).getByText('Importação assumida após download')).toBeTruthy()
  fireEvent.click(within(importedRegion).getByRole('button', { name: 'Desfazer' }))
  await waitFor(() => expect(window.codeAwareness.revokeAcademyGeminiImport).toHaveBeenCalledWith({ skillIds: ['skill-imported'] }))

  // Manual action acknowledge
  const manualRegion = within(region).getByRole('region', { name: 'Ações manuais no Gemini' })
  expect(within(manualRegion).getByText('old-skill')).toBeTruthy()
  fireEvent.click(within(manualRegion).getByRole('button', { name: 'Já removi no Gemini' }))
  await waitFor(() => expect(window.codeAwareness.acknowledgeAcademyGeminiManualAction).toHaveBeenCalledWith('skill-removed'))

  // Baseline establish button when no imported skills yet and no prepared batch
  vi.mocked(window.codeAwareness.getAcademyGeminiExportState).mockResolvedValueOnce({
    ...incrementalState,
    importedSkills: [],
    latestExport: null,
    artifactAvailable: false,
    drifted: true
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Configurar modo' }))
  const mcpDialog = await screen.findByRole('dialog', { name: 'Modo de exportação Gemini' })
  expect(within(mcpDialog).getByText('Requer MCP no Gemini Web')).toBeTruthy()
  vi.mocked(window.codeAwareness.setAcademyGeminiExportMode).mockResolvedValueOnce({
    ...incrementalState,
    mode: 'MCP_TRIGGERS',
    requiresMcp: true,
    importedSkills: [],
    latestExport: null,
    artifactAvailable: false,
    drifted: true
  })
  fireEvent.click(within(mcpDialog).getByLabelText(/Gatilhos MCP/))
  fireEvent.click(within(mcpDialog).getByRole('button', { name: 'Aplicar modo' }))
  await waitFor(() => expect(window.codeAwareness.setAcademyGeminiExportMode).toHaveBeenCalledWith('MCP_TRIGGERS'))
  const baselineBtn = await screen.findByRole('button', { name: 'Já importei antes (estabelecer base)' })
  fireEvent.click(baselineBtn)
  await waitFor(() => expect(window.codeAwareness.establishAcademyGeminiBaseline).toHaveBeenCalled())
})

it('renders Plugin ChatGPT download, provenance, undo confirmation, and Downloads preference in Configurações', async () => {
  const uploadedAssumedRelease = {
    ...openAiRelease,
    status: 'UPLOADED_UNVERIFIED' as const,
    uploadConfirmation: {
      releaseId: openAiRelease.id,
      pluginVersion: openAiRelease.pluginVersion,
      artifactHash: openAiRelease.artifactHash,
      confirmedAt: detail.updatedAt,
      method: 'ASSUMED_ON_DOWNLOAD' as const,
      origin: 'ASSUMED_ON_DOWNLOAD' as const
    }
  }
  vi.mocked(window.codeAwareness.getAcademyOpenAiPublicationState).mockResolvedValue({
    profile: {
      name: 'academy-skills',
      displayName: 'Academy Skills',
      description: 'Skills',
      author: {},
      openAiInterface: {},
      logoPath: null,
      publishedVersion: '0.1.4',
      deletionSemantics: 'UNKNOWN',
      deletionSemanticsEvidence: null,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt
    },
    latestPrepared: uploadedAssumedRelease,
    latestUploaded: uploadedAssumedRelease,
    selectedRelease: uploadedAssumedRelease,
    publicSkillCount: 1,
    artifactAvailable: true,
    coverage: { catalog: 1, eligible: 1, includedInLastZip: 1, awaitingZip: 0, notApplicable: 0, excluded: [], preference: defaultPreference },
    canonicalSnapshotHash: 'snapshot',
    drifted: false,
    currentPackageRevision: null,
    importConfirmationPreference: { mode: 'AUTOMATIC', updatedAt: detail.updatedAt },
    hostedStatus: 'CURRENT'
  })
  vi.mocked(window.codeAwareness.listAcademyOpenAiReleases).mockResolvedValue([uploadedAssumedRelease])
  vi.mocked(window.codeAwareness.downloadAcademyOpenAiPackage).mockResolvedValue(uploadedAssumedRelease)
  vi.mocked(window.codeAwareness.revokeAcademyOpenAiUpload).mockResolvedValue({ ...openAiRelease, status: 'READY_TO_UPLOAD', uploadConfirmation: null })

  render(<AcademyView />)
  const region = await screen.findByRole('region', { name: 'Plugin ChatGPT' })
  expect(within(region).getByTestId('openai-upload-provenance').textContent).toBe('Importação assumida após download')

  fireEvent.click(within(region).getByRole('button', { name: 'Baixar ZIP' }))
  await waitFor(() => expect(window.codeAwareness.downloadAcademyOpenAiPackage).toHaveBeenCalledWith(openAiRelease.id))

  fireEvent.click(within(region).getByRole('button', { name: 'Desfazer confirmação' }))
  await waitFor(() => expect(window.codeAwareness.revokeAcademyOpenAiUpload).toHaveBeenCalledWith(openAiRelease.id))

  // Verify shared Downloads import confirmation mode control in AcademySettingsDrawer
  const drawer = await openSettingsDrawer()
  const select = within(drawer).getByLabelText('Confirmação de importação') as HTMLSelectElement
  fireEvent.change(select, { target: { value: 'AUTOMATIC' } })
  await waitFor(() => expect(window.codeAwareness.setAcademyImportConfirmationPreference).toHaveBeenCalledWith('AUTOMATIC'))
})

function mockPluginPublicationWithRelease() {
  vi.mocked(window.codeAwareness.getAcademyOpenAiPublicationState).mockResolvedValue({
    profile: {
      name: 'academy-skills',
      displayName: 'Academy Skills',
      description: 'Skills',
      author: {},
      openAiInterface: {},
      logoPath: null,
      publishedVersion: '0.1.4',
      deletionSemantics: 'UNKNOWN',
      deletionSemanticsEvidence: null,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt
    },
    latestPrepared: openAiRelease,
    latestUploaded: null,
    selectedRelease: openAiRelease,
    publicSkillCount: 1,
    artifactAvailable: true,
    coverage: { catalog: 1, eligible: 1, includedInLastZip: 1, awaitingZip: 0, notApplicable: 0, excluded: [], preference: defaultPreference },
    canonicalSnapshotHash: 'snapshot',
    drifted: false,
    currentPackageRevision: null,
    importConfirmationPreference: { mode: 'MANUAL', updatedAt: detail.updatedAt },
    hostedStatus: 'CURRENT'
  })
  vi.mocked(window.codeAwareness.listAcademyOpenAiReleases).mockResolvedValue([openAiRelease])
}

it('shows real pending feedback on the Plugin download CTA, blocks duplicate work and recovers after resolution', async () => {
  mockPluginPublicationWithRelease()
  let finish!: (value: typeof openAiRelease) => void
  vi.mocked(window.codeAwareness.downloadAcademyOpenAiPackage).mockReturnValue(new Promise((resolve) => { finish = resolve }))
  render(<AcademyView />)
  const region = await screen.findByRole('region', { name: 'Plugin ChatGPT' })
  const button = within(region).getByRole('button', { name: 'Baixar ZIP' })
  expect(button.getAttribute('aria-busy')).toBeNull()

  fireEvent.click(button)
  await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('true'))
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(button.hasAttribute('disabled')).toBe(false)
  expect(within(button).getByRole('status').textContent).toBe('Baixando ZIP')
  fireEvent.click(button)
  fireEvent.click(button)
  expect(window.codeAwareness.downloadAcademyOpenAiPackage).toHaveBeenCalledTimes(1)

  finish(openAiRelease)
  await waitFor(() => expect(button.getAttribute('aria-busy')).toBeNull())
  expect(within(button).queryByRole('status')).toBeNull()
  fireEvent.click(button)
  await waitFor(() => expect(window.codeAwareness.downloadAcademyOpenAiPackage).toHaveBeenCalledTimes(2))
})

it('ends Plugin download pending state on rejection with a recoverable error and a working retry', async () => {
  mockPluginPublicationWithRelease()
  vi.mocked(window.codeAwareness.downloadAcademyOpenAiPackage)
    .mockRejectedValueOnce(new Error('Disco indisponível'))
    .mockResolvedValue(openAiRelease)
  render(<AcademyView />)
  const region = await screen.findByRole('region', { name: 'Plugin ChatGPT' })
  const button = within(region).getByRole('button', { name: 'Baixar ZIP' })

  fireEvent.click(button)
  await waitFor(() => expect(within(region).getByText('Disco indisponível')).toBeTruthy())
  expect(button.getAttribute('aria-busy')).toBeNull()
  expect(button.hasAttribute('disabled')).toBe(false)

  fireEvent.click(button)
  await waitFor(() => expect(window.codeAwareness.downloadAcademyOpenAiPackage).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(button.getAttribute('aria-busy')).toBeNull())
})

it('shows pending feedback on the Gemini download CTA and does not duplicate the export', async () => {
  let finish!: (value: Awaited<ReturnType<typeof window.codeAwareness.downloadAcademyGeminiExport>>) => void
  vi.mocked(window.codeAwareness.downloadAcademyGeminiExport).mockReturnValue(new Promise((resolve) => { finish = resolve }))
  render(<AcademyView />)
  await openGeminiSurface()
  const region = await screen.findByRole('region', { name: 'Exportação Gemini' })
  const button = within(region).getAllByRole('button', { name: 'Baixar pacote' })[0]

  fireEvent.click(button)
  await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('true'))
  fireEvent.click(button)
  expect(window.codeAwareness.downloadAcademyGeminiExport).toHaveBeenCalledTimes(1)

  finish(await window.codeAwareness.getAcademyGeminiExportState())
  await waitFor(() => expect(button.getAttribute('aria-busy')).toBeNull())
})
