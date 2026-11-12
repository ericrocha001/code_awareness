import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { AcademyPersistedPublication } from '../../../../shared/types/academy-bootstrap-types'
import type {
  AcademyConflictBatch,
  AcademyConflictReview,
  AcademyDistributionHealth,
  AcademyDistributionState,
  AcademyDraftReceipt,
  AcademyGitConflictReview,
  AcademyGitStatusProjection,
  AcademyOpenAiPublicationState,
  AcademyOpenAiRelease,
  AcademyPackage,
  AcademyPackageDistributionState,
  AcademyPublicationPreference,
  AcademySkillDetail,
  AcademySkillScope,
  AcademySkillVersion,
  AcademySnapshot,
  AcademyGeminiExportState
} from '../../../../shared/types/academy-types'
import type { AcademyManifestPreview } from '../../../../shared/types/academy-publication-types'
import type { RepositoryRecord } from '../../../../shared/types/repository-catalog-types'
import {
  AcademyHeader,
  AcademySettingsDrawer,
  type AcademySurface,
  type AcademyTab,
  ArtifactEditor,
  ConfirmationDialog,
  DestinationManager,
  PluginOverviewSurface,
  PluginReviewModal,
  GeminiOverviewSurface,
  GeminiReviewModal,
  SkillCatalog,
  SkillWorkspace
} from './AcademyPanels'
import './AcademyView.css'
import { AcademyConflictInspector } from './AcademyConflicts'
import { useAcademyFocus } from './useAcademyFocus'

export type AcademyNavigationGuard = (proceed: () => void) => void

interface ArtifactDraft {
  mode: 'create' | 'edit'
  originalPath: string | null
  path: string
  content: string
}

interface Confirmation {
  title: string
  description: string
  confirmLabel: string
  destructive?: boolean
  onConfirm: () => Promise<void>
}

const emptyPackage: AcademyPackage = {
  skillMd: '---\nname: nova-skill\ndescription: Descreva quando usar esta Skill\n---\n\n# Nova Skill\n',
  artifacts: {}
}

export const AcademyView: React.FC<{ onNavigationGuardChange?: (guard: AcademyNavigationGuard | null) => void }> = ({
  onNavigationGuardChange
}) => {
  const [surface, setSurface] = useState<AcademySurface>('PLUGIN')
  const [snapshot, setSnapshot] = useState<AcademySnapshot>({ skills: [], destinations: [], conflicts: [] })
  const [selected, setSelected] = useState<AcademySkillDetail | null>(null)
  const [history, setHistory] = useState<AcademySkillVersion[]>([])
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'ALL' | 'ACTIVE' | 'DISABLED'>('ALL')
  const [scopeFilter, setScopeFilter] = useState<'ALL' | AcademySkillScope>('ALL')
  const [activationPending, setActivationPending] = useState<string | null>(null)
  const [packagePending, setPackagePending] = useState(false)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [pluginError, setPluginError] = useState<string | null>(null)
  const [scope, setScope] = useState<AcademySkillScope>('GLOBAL')
  const [keepPrivate, setKeepPrivate] = useState(false)
  const [projectIds, setProjectIds] = useState<string[]>([])
  const [skillMd, setSkillMd] = useState(emptyPackage.skillMd)
  const [artifacts, setArtifacts] = useState<Record<string, string>>({})
  const [message, setMessage] = useState<{ text: string; kind: 'success' | 'error' } | null>(null)
  const [distribution, setDistribution] = useState<AcademyDistributionHealth>({ targets: [] })
  const [skillDistribution, setSkillDistribution] = useState<AcademyDistributionState[]>([])
  const [openAiPublication, setOpenAiPublication] = useState<AcademyOpenAiPublicationState | null>(null)
  const [openAiReleases, setOpenAiReleases] = useState<AcademyOpenAiRelease[]>([])
  const [packageDistribution, setPackageDistribution] = useState<AcademyPackageDistributionState | null>(null)
  const [publicationPreference, setPublicationPreference] = useState<AcademyPublicationPreference | null>(null)
  const [gitStatus, setGitStatus] = useState<AcademyGitStatusProjection | null>(null)
  const [hydration, setHydration] = useState<'LOADING' | 'READY' | 'ERROR'>('LOADING')
  const [knownPublication, setKnownPublication] = useState<AcademyPersistedPublication | null>(null)
  const [initializationId] = useState(() => crypto.randomUUID())
  const startedAt = useRef(performance.now())
  const mounted = useRef(false)
  const painted = useRef(false)
  const sequences = useRef<Record<string, number>>({})
  const remoteFlight = useRef<Promise<void> | null>(null)
  const firstRemote = useRef(false)
  const latestSelection = useRef({ id: selected?.id, isEditing: false })
  const [eligibleRepos, setEligibleRepos] = useState<RepositoryRecord[]>([])
  const [selectedRepoId, setSelectedRepoId] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editBaseline, setEditBaseline] = useState('')
  const [draftCommit, setDraftCommit] = useState<string>()
  const [gitReview, setGitReview] = useState<AcademyGitConflictReview | null>(null)
  const [gitResolution, setGitResolution] = useState('')
  const [manifestPreview, setManifestPreview] = useState<AcademyManifestPreview | null>(null)
  const [activeTab, setActiveTab] = useState<AcademyTab>('skill')
  const [artifactDraft, setArtifactDraft] = useState<ArtifactDraft | null>(null)
  const [destinationsOpen, setDestinationsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [selectedReviewIds, setSelectedReviewIds] = useState<string[]>([])
  const [geminiExport, setGeminiExport] = useState<AcademyGeminiExportState | null>(null)
  const [geminiPreparing, setGeminiPreparing] = useState(false)
  const [geminiError, setGeminiError] = useState<string | null>(null)
  const [geminiReviewOpen, setGeminiReviewOpen] = useState(false)
  const [geminiSelectedReviewIds, setGeminiSelectedReviewIds] = useState<string[]>([])
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [conflictReview, setConflictReview] = useState<AcademyConflictReview | null>(null)
  const [conflictBatch, setConflictBatch] = useState<AcademyConflictBatch | null>(null)
  const [conflictBusy, setConflictBusy] = useState(false)

  const draftValue = JSON.stringify({ skillMd, artifacts, scope, projectIds })
  const dirty = isEditing && draftValue !== editBaseline
  const artifactDirty = Boolean(
    artifactDraft &&
    (artifactDraft.path !== (artifactDraft.originalPath ?? '') ||
      artifactDraft.content !== (artifactDraft.originalPath ? artifacts[artifactDraft.originalPath] : ''))
  )

  const closeArtifact = () => {
    if (!artifactDirty) { setArtifactDraft(null); return }
    setConfirmation({
      title: 'Descartar alterações do artefato?',
      description: 'O artefato editado tem alterações não aplicadas.',
      confirmLabel: 'Descartar',
      destructive: true,
      onConfirm: async () => setArtifactDraft(null)
    })
  }

  const modalKey = confirmation
    ? 'confirm'
    : artifactDraft
      ? 'artifact'
      : destinationsOpen
        ? 'destinations'
        : manifestPreview
          ? 'manifest'
          : gitReview
            ? 'git'
            : conflictReview || conflictBatch
              ? 'conflict'
              : reviewOpen
                ? 'review'
                : settingsOpen
                  ? 'settings'
                  : catalogOpen
                    ? 'catalog'
                    : ''

  useAcademyFocus(modalKey, 'input, textarea, select, button', () => {
    if (confirmation) { setConfirmation(null); return }
    if (artifactDraft) { closeArtifact(); return }
    if (destinationsOpen) { setDestinationsOpen(false); return }
    if (manifestPreview) { setManifestPreview(null); return }
    if (gitReview) { setGitReview(null); return }
    if (conflictReview || conflictBatch) { setConflictReview(null); setConflictBatch(null); return }
    if (reviewOpen) { setReviewOpen(false); return }
    if (settingsOpen) { setSettingsOpen(false); return }
    if (catalogOpen) setCatalogOpen(false)
  })

  const guardDraft = (proceed: () => void) => {
    if (!dirty && !artifactDirty) { proceed(); return }
    setConfirmation({
      title: 'Descartar alterações não salvas?',
      description: 'As alterações no rascunho atual serão perdidas.',
      confirmLabel: 'Descartar',
      destructive: true,
      onConfirm: async () => { setArtifactDraft(null); setIsEditing(false); proceed() }
    })
  }

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty || artifactDirty || saving) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty, artifactDirty, saving])

  const showMessage = (text: string, kind: 'success' | 'error' = 'success') => setMessage({ text, kind })
  const reportError = (error: unknown) => showMessage(error instanceof Error ? error.message : String(error), 'error')

  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(null), 4500)
    return () => window.clearTimeout(timer)
  }, [message])

  const applyGit = (next: AcademyGitStatusProjection) => setGitStatus(current => {
    const cur = current?.remoteCheck, nxt = next.remoteCheck
    if (cur && nxt && nxt.generation < cur.generation) return current
    if (cur && nxt && nxt.generation === cur.generation && cur.state === 'FAILED' && nxt.state === 'CHECKING') return current
    return next
  })

  const readProjection = async <T,>(key: string, read: () => Promise<T>, apply: (value: T) => void) => {
    const sequence = sequences.current[key] = (sequences.current[key] ?? 0) + 1
    try {
      const value = await read()
      if (mounted.current && sequences.current[key] === sequence) apply(value)
    } catch {}
  }

  const loadSkill = async (id: string, preserveEdits = false) => {
    const sequence = sequences.current.detail = (sequences.current.detail ?? 0) + 1
    const detail = await window.codeAwareness.getAcademySkill(id)
    if (!mounted.current || sequences.current.detail !== sequence) return
    setSelected(detail)
    if (!preserveEdits && !latestSelection.current.isEditing) {
      setScope(detail.scope)
      setProjectIds(detail.projectIds)
      setSkillMd(detail.current.package.skillMd)
      setArtifacts(detail.current.package.artifacts)
      setIsEditing(false)
    }
    const [versions, states] = await Promise.all([
      window.codeAwareness.getAcademyHistory(id),
      window.codeAwareness.listAcademyDistributionStates(id)
    ])
    if (!mounted.current || sequences.current.detail !== sequence) return
    setHistory(versions)
    setSkillDistribution(states)
  }

  const readSecondaryProjections = (loadReleases = false) => {
    void readProjection('distribution', () => window.codeAwareness.getAcademyDistributionHealth(), setDistribution)
    void readProjection('openAi', () => window.codeAwareness.getAcademyOpenAiPublicationState(), setOpenAiPublication)
    void readProjection('package', () => window.codeAwareness.getAcademyPackageDistributionState(), setPackageDistribution)
    if (window.codeAwareness.getAcademyPublicationPreference) {
      void readProjection('preference', () => window.codeAwareness.getAcademyPublicationPreference(), setPublicationPreference)
    }
    if (window.codeAwareness.getAcademyGeminiExportState) {
      void readProjection('gemini', () => window.codeAwareness.getAcademyGeminiExportState(), setGeminiExport)
    }
    if (loadReleases || settingsOpen) {
      void readProjection('releases', () => window.codeAwareness.listAcademyOpenAiReleases(), setOpenAiReleases)
    }
  }

  const refresh = async (selectId?: string) => {
    const sequence = sequences.current.snapshot = (sequences.current.snapshot ?? 0) + 1
    const [nextSnapshot, nextGit, nextRepos] = await Promise.all([
      window.codeAwareness.getAcademySnapshot(),
      window.codeAwareness.getAcademyGitStatus().catch(() => null),
      window.codeAwareness.listAcademyGitEligibleRepositories().catch(() => [])
    ])
    if (!mounted.current || sequences.current.snapshot !== sequence) return
    setSnapshot(nextSnapshot)
    if (nextGit) {
      applyGit(nextGit)
      if (!selectedRepoId && nextGit.repository?.id) setSelectedRepoId(nextGit.repository.id)
    }
    setEligibleRepos(nextRepos)
    const id = selectId ?? latestSelection.current.id
    if (id && nextSnapshot.skills.some(item => item.id === id)) {
      await loadSkill(id, latestSelection.current.isEditing && !selectId)
    } else if (!latestSelection.current.isEditing) {
      setSelected(null); setHistory([]); setSkillDistribution([])
    }
    readSecondaryProjections()
  }

  const observe = () => {
    if (remoteFlight.current) return
    remoteFlight.current = (async () => {
      try {
        const next = await window.codeAwareness.checkAcademyGit()
        if (mounted.current && next) applyGit(next)
        if (!firstRemote.current) {
          firstRemote.current = true
          console.info('[Academy hydration]', JSON.stringify({
            initializationId,
            milestone: 'REMOTE_CHECK_COMPLETE',
            elapsedMs: performance.now() - startedAt.current,
            state: next?.remoteCheck?.state ?? next?.syncState,
            requestId: next?.remoteCheck?.requestId ?? null
          }))
          window.dispatchEvent(new CustomEvent('academy:perf', {
            detail: { phase: 'first-remote-status', durationMs: performance.now() - startedAt.current }
          }))
        }
      } catch (error) {
        if (!firstRemote.current) {
          firstRemote.current = true
          console.info('[Academy hydration]', JSON.stringify({
            initializationId,
            milestone: 'REMOTE_CHECK_COMPLETE',
            elapsedMs: performance.now() - startedAt.current,
            state: 'FAILED',
            error: String(error)
          }))
        }
      } finally {
        remoteFlight.current = null
      }
    })()
  }

  useEffect(() => {
    mounted.current = true
    const sequence = sequences.current.bootstrap = (sequences.current.bootstrap ?? 0) + 1
    void (async () => {
      try {
        const boot = await window.codeAwareness.getAcademyBootstrapState(initializationId)
        if (!mounted.current || sequences.current.bootstrap !== sequence) return
        setSnapshot(boot.snapshot)
        setKnownPublication(boot.publication)
        applyGit(boot.git)
        if (boot.git?.repository?.id) setSelectedRepoId(boot.git.repository.id)
        setHydration('READY')
        console.info('[Academy hydration]', JSON.stringify({
          initializationId,
          milestone: 'STORE_RESPONSE',
          elapsedMs: performance.now() - startedAt.current,
          storeDurationMs: boot.storeDurationMs,
          provenance: boot.provenance
        }))
        const firstId = boot.snapshot.skills[0]?.id
        if (firstId) void loadSkill(firstId)
        void readProjection('repositories', () => window.codeAwareness.listAcademyGitEligibleRepositories(), repos => {
          setEligibleRepos(repos)
          setSelectedRepoId(cur => cur || repos[0]?.id || '')
        })
        readSecondaryProjections()
        observe()
      } catch (error) {
        if (!mounted.current) return
        setHydration('ERROR')
        reportError(error)
      }
    })()

    window.addEventListener('focus', observe)
    window.addEventListener('online', observe)
    const unsubscribe = window.codeAwareness.onAcademyChanged?.(event => {
      if (!event || event.kind === 'git') void readProjection('git', () => window.codeAwareness.getAcademyGitStatus(), applyGit)
      if (!event || event.kind === 'publication') {
        void readProjection('openAi', () => window.codeAwareness.getAcademyOpenAiPublicationState(), setOpenAiPublication)
        void readProjection('package', () => window.codeAwareness.getAcademyPackageDistributionState(), setPackageDistribution)
        if (window.codeAwareness.getAcademyPublicationPreference) {
          void readProjection('preference', () => window.codeAwareness.getAcademyPublicationPreference(), setPublicationPreference)
        }
        void readProjection('releases', () => window.codeAwareness.listAcademyOpenAiReleases(), setOpenAiReleases)
        if (window.codeAwareness.getAcademyGeminiExportState) {
          void readProjection('gemini', () => window.codeAwareness.getAcademyGeminiExportState(), setGeminiExport)
        }
      }
      if (!event || event.kind === 'distribution') {
        void readProjection('distribution', () => window.codeAwareness.getAcademyDistributionHealth(), setDistribution)
        if (latestSelection.current.id) {
          void readProjection('skillDistribution', () => window.codeAwareness.listAcademyDistributionStates(latestSelection.current.id), setSkillDistribution)
        }
      }
      if (!event || event.kind === 'catalog') {
        const sequenceSnapshot = sequences.current.snapshot = (sequences.current.snapshot ?? 0) + 1
        void window.codeAwareness.getAcademySnapshot().then(nextSnapshot => {
          if (!mounted.current || sequences.current.snapshot !== sequenceSnapshot) return
          setSnapshot(nextSnapshot)
          const id = latestSelection.current.id
          if (id && !latestSelection.current.isEditing && nextSnapshot.skills.some(item => item.id === id)) void loadSkill(id)
        }).catch(() => {})
        void readProjection('openAi', () => window.codeAwareness.getAcademyOpenAiPublicationState(), setOpenAiPublication)
        if (window.codeAwareness.getAcademyGeminiExportState) {
          void readProjection('gemini', () => window.codeAwareness.getAcademyGeminiExportState(), setGeminiExport)
        }
      }
    })
    return () => {
      mounted.current = false
      window.removeEventListener('focus', observe)
      window.removeEventListener('online', observe)
      unsubscribe?.()
    }
  }, [initializationId])

  useEffect(() => { latestSelection.current = { id: selected?.id, isEditing } }, [selected?.id, isEditing])
  useEffect(() => {
    if (hydration !== 'READY' || painted.current) return
    painted.current = true
    console.info('[Academy hydration]', JSON.stringify({
      initializationId,
      milestone: 'FIRST_USEFUL_PAINT',
      elapsedMs: performance.now() - startedAt.current
    }))
    window.dispatchEvent(new CustomEvent('academy:perf', {
      detail: { phase: 'first-paint', durationMs: performance.now() - startedAt.current }
    }))
  }, [hydration, initializationId])

  useEffect(() => {
    onNavigationGuardChange?.(dirty || artifactDirty ? guardDraft : null)
    return () => onNavigationGuardChange?.(null)
  }, [dirty, artifactDirty, onNavigationGuardChange])

  useEffect(() => {
    if (settingsOpen) {
      void readProjection('releases', () => window.codeAwareness.listAcademyOpenAiReleases(), setOpenAiReleases)
    }
  }, [settingsOpen])

  useEffect(() => {
    const excludedIds = new Set((openAiPublication?.coverage?.excluded ?? []).filter(item => item.reason === 'PRIVATE').map(item => item.skillId))
    setSelectedReviewIds(current => current.filter(id => excludedIds.has(id)))
  }, [openAiPublication?.coverage?.excluded])

  const visible = useMemo(
    () => snapshot.skills.filter(skill =>
      (status === 'ALL' || skill.status === status) &&
      (scopeFilter === 'ALL' || skill.scope === scopeFilter) &&
      (!query.trim() || skill.name.toLowerCase().includes(query.toLowerCase()) || skill.description.toLowerCase().includes(query.toLowerCase()))
    ),
    [snapshot.skills, status, scopeFilter, query]
  )

  const choose = async (id: string) => {
    setCatalogOpen(false)
    setActiveTab('skill')
    setDraftCommit(undefined)
    await loadSkill(id)
  }

  const createNew = () => {
    setSurface('SKILLS')
    setCatalogOpen(false)
    setSelected(null)
    setHistory([])
    setSkillDistribution([])
    setActiveTab('skill')
    setScope('GLOBAL')
    setKeepPrivate(false)
    setProjectIds([])
    setSkillMd(emptyPackage.skillMd)
    setArtifacts({})
    setEditBaseline(JSON.stringify({ skillMd: emptyPackage.skillMd, artifacts: {}, scope: 'GLOBAL', projectIds: [] }))
    setDraftCommit(undefined)
    setIsEditing(true)
  }

  const editSkill = async () => {
    if (!selected) return
    const gitMode = Boolean(gitStatus?.repository && gitStatus.convergence?.cutover !== 'LOCAL' && selected.scope === 'GLOBAL')
    if (gitMode) {
      try {
        const draft = await window.codeAwareness.getAcademyDraft(selected.name)
        const pkg = draft.package ?? selected.current.package
        setScope(selected.scope); setProjectIds(selected.projectIds)
        setSkillMd(pkg.skillMd); setArtifacts(pkg.artifacts)
        setEditBaseline(JSON.stringify({ skillMd: pkg.skillMd, artifacts: pkg.artifacts, scope: selected.scope, projectIds: selected.projectIds }))
        setDraftCommit(draft.workspaceCommitSha); setIsEditing(true); return
      } catch (error) { reportError(error); return }
    }
    setScope(selected.scope)
    setProjectIds(selected.projectIds)
    setSkillMd(selected.current.package.skillMd)
    setArtifacts(selected.current.package.artifacts)
    setEditBaseline(JSON.stringify({
      skillMd: selected.current.package.skillMd,
      artifacts: selected.current.package.artifacts,
      scope: selected.scope,
      projectIds: selected.projectIds
    }))
    setDraftCommit(undefined)
    setIsEditing(true)
  }

  const cancelEditing = () => {
    if (selected) {
      setScope(selected.scope)
      setProjectIds(selected.projectIds)
      setSkillMd(selected.current.package.skillMd)
      setArtifacts(selected.current.package.artifacts)
    }
    setDraftCommit(undefined)
    setIsEditing(false)
  }

  const save = async () => {
    if (saving || (selected && !dirty)) return
    setSaving(true)
    try {
      const result = selected
        ? await window.codeAwareness.updateAcademySkill({
          skillId: selected.id,
          expectedVersion: selected.currentVersion,
          expectedDraftCommitSha: draftCommit,
          package: { skillMd, artifacts },
          scope,
          projectIds: scope === 'PROJECT' ? projectIds : []
        })
        : await window.codeAwareness.createAcademySkill({
          package: { skillMd, artifacts },
          scope,
          projectIds: scope === 'PROJECT' ? projectIds : [],
          ...(scope === 'GLOBAL' && keepPrivate ? { keepPrivate: true } : {})
        })
      setIsEditing(false); setDraftCommit(undefined)
      if ((result as AcademyDraftReceipt).state === 'DRAFT_SAVED') {
        const receipt = result as AcademyDraftReceipt
        showMessage(`Rascunho salvo em revisão no Git (${receipt.workspaceCommitSha.slice(0, 7)}). Versão canônica permanece em v${selected?.currentVersion ?? 1}.`)
        await refresh(selected?.id)
        return
      }
      const detail = result as AcademySkillDetail
      await refresh(detail.id)
      const deliveryText =
        detail.publicationEligibility === 'APPROVED'
          ? 'Incluída para o plugin ChatGPT.'
          : detail.publicationEligibility === 'PRIVATE'
            ? 'Salva como privada (fora do plugin até aprovação).'
            : 'Salva no escopo de projeto.'
      showMessage(`Versão ${detail.currentVersion} salva. ${deliveryText}`)
    } catch (error) { reportError(error) }
    finally { setSaving(false) }
  }

  const setEnabled = async (item: AcademySkillDetail, expected = item.stateRevision) => {
    if (activationPending) return
    setActivationPending(item.id)
    const next = item.status !== 'ACTIVE'
    try {
      const updated = await window.codeAwareness.setAcademySkillEnabled(item.id, next, expected)
      setSelected(updated)
      showMessage(next ? 'Skill ativada.' : 'Skill desativada.')
      await refresh(item.id)
    } catch (error) {
      reportError(error)
      if (String(error).includes('STATE_REVISION_CONFLICT')) await refresh(item.id)
    } finally { setActivationPending(null) }
  }

  const applyArtifact = () => {
    if (!artifactDraft) return
    const nextPath = artifactDraft.path.trim().replaceAll('\\', '/')
    if (!nextPath) { showMessage('Informe o caminho do artefato.', 'error'); return }
    const next = { ...artifacts }
    if (artifactDraft.originalPath && artifactDraft.originalPath !== nextPath) delete next[artifactDraft.originalPath]
    next[nextPath] = artifactDraft.content
    setArtifacts(next); setArtifactDraft(null); setIsEditing(true)
  }

  const requestRemoveArtifact = () => {
    if (!artifactDraft?.originalPath) return
    const target = artifactDraft.originalPath
    setConfirmation({
      title: 'Remover artefato?',
      description: `O artefato "${target}" será removido do rascunho ao salvar.`,
      confirmLabel: 'Remover',
      destructive: true,
      onConfirm: async () => {
        const next = { ...artifacts }
        delete next[target]
        setArtifacts(next); setArtifactDraft(null); setIsEditing(true)
      }
    })
  }

  const requestGitRemoval = () => {
    if (!selected || !gitStatus?.publication?.workspacePath) return
    const target = selected
    setConfirmation({
      title: 'Propor remoção no Git?',
      description: `Cria um draft removendo ${target.name}. O repositório remoto só muda após publish explícito e versões históricas permanecem preservadas.`,
      confirmLabel: 'Propor remoção',
      destructive: true,
      onConfirm: async () => {
        const draft = await window.codeAwareness.getAcademyDraft(target.name)
        const next = await window.codeAwareness.deleteAcademyGitDraft({
          skillId: target.id,
          expectedVersion: target.currentVersion,
          expectedDraftCommitSha: draft.workspaceCommitSha,
          confirmed: true
        })
        applyGit(next)
        await refresh(target.id)
        showMessage('Remoção proposta no workspace Git.')
      }
    })
  }

  const requestPublicApproval = () => {
    if (!selected) return
    const target = selected
    setConfirmation({
      title: 'Incluir Skill no plugin ChatGPT?',
      description: `${target.name} v${target.currentVersion} passará a entrar no ZIP do plugin ChatGPT (e na publicação pública caso o Git esteja conectado).`,
      confirmLabel: 'Incluir no plugin',
      onConfirm: async () => {
        await window.codeAwareness.approveAcademyPublicSkill(target.id, target.currentVersion, true)
        await refresh(target.id)
        showMessage(`${target.name} incluída no plugin ChatGPT.`)
      }
    })
  }

  const approveSingleFromReview = async (skillId: string, expectedVersion: number) => {
    setReviewBusy(true)
    try {
      await window.codeAwareness.approveAcademyPublicSkill(skillId, expectedVersion, true)
      await refresh(selected?.id)
      showMessage('Skill incluída no plugin ChatGPT.')
    } catch (error) { reportError(error) }
    finally { setReviewBusy(false) }
  }

  const approveBatchFromReview = () => {
    const excluded = openAiPublication?.coverage?.excluded ?? []
    const items = excluded
      .filter(item => item.reason === 'PRIVATE' && selectedReviewIds.includes(item.skillId))
      .map(item => ({ skillId: item.skillId, expectedVersion: item.version }))
    if (!items.length || !window.codeAwareness.approveAcademyPublicSkills) return
    setConfirmation({
      title: `Incluir ${items.length} Skills no plugin?`,
      description: 'As Skills selecionadas ficarão elegíveis para o ZIP do plugin ChatGPT e para o catálogo público.',
      confirmLabel: 'Incluir selecionadas',
      onConfirm: async () => {
        setReviewBusy(true)
        try {
          await window.codeAwareness.approveAcademyPublicSkills(items, true)
          setSelectedReviewIds([])
          await refresh(selected?.id)
          showMessage(`${items.length} Skills incluídas no plugin ChatGPT.`)
        } finally { setReviewBusy(false) }
      }
    })
  }

  const enableSkillFromReview = async (skillId: string) => {
    const stateRevision = snapshot.skills.find(item => item.id === skillId)?.stateRevision ?? 1
    setReviewBusy(true)
    try {
      await window.codeAwareness.setAcademySkillEnabled(skillId, true, stateRevision)
      await refresh(selected?.id)
      showMessage('Skill reativada.')
    } catch (error) { reportError(error) }
    finally { setReviewBusy(false) }
  }

  const requestToggleAutoInclude = (nextEnabled: boolean) => {
    setConfirmation({
      title: nextEnabled ? 'Autorizar inclusão automática de novas Skills globais?' : 'Revogar inclusão automática?',
      description: nextEnabled
        ? 'Ao confirmar, novas Skills GLOBAL criadas pela UI ou via MCP entrarão automaticamente no plugin ChatGPT (e no catálogo público do Git), exceto se marcadas como privadas. Skills PROJECT permanecem sempre locais. Você pode revogar quando quiser.'
        : 'Novas Skills globais voltarão a nascer privadas até aprovação individual. Skills já aprovadas continuam incluídas.',
      confirmLabel: nextEnabled ? 'Ativar autorização única' : 'Revogar autorização',
      onConfirm: async () => {
        setReviewBusy(true)
        try {
          const updated = await window.codeAwareness.setAcademyPublicationPreference(nextEnabled, true)
          setPublicationPreference(updated)
          await refresh(selected?.id)
          showMessage(nextEnabled ? 'Inclusão automática ativada (UI e MCP).' : 'Inclusão automática revogada.')
        } finally { setReviewBusy(false) }
      }
    })
  }

  const requestDeleteGlobal = () => {
    if (!selected) return
    const target = selected
    setConfirmation({
      title: 'Excluir Skill global?',
      description: `Exclui ${target.name} v${target.currentVersion} do catálogo ativo (histórico imutável permanece preservado).`,
      confirmLabel: 'Excluir',
      destructive: true,
      onConfirm: async () => {
        await window.codeAwareness.deleteAcademyGlobalSkill(target.id, target.currentVersion, true)
        setSelected(null)
        await refresh()
        showMessage(`${target.name} removida do catálogo global.`)
      }
    })
  }

  const handleConfirmation = async () => {
    const action = confirmation
    setConfirmation(null)
    if (!action) return
    try { await action.onConfirm() } catch (error) { reportError(error) }
  }

  const runPluginAction = async (action: () => Promise<void>) => {
    setPackagePending(true)
    setPluginError(null)
    try {
      await action()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      setPluginError(msg)
      reportError(error)
    } finally { setPackagePending(false) }
  }

  const preparePluginRelease = () => void runPluginAction(async () => {
    const release = await window.codeAwareness.prepareAcademyOpenAiRelease(
      gitStatus?.repository ? { mode: 'LATEST', force: true } : undefined
    )
    readSecondaryProjections(true)
    showMessage(`ZIP do plugin v${release.pluginVersion} pronto (${release.snapshot.length} Skills).`)
  })

  const revealPluginRelease = (release: AcademyOpenAiRelease) => void (async () => {
    try {
      await window.codeAwareness.revealAcademyOpenAiPackage(release.id)
    } catch (error) { reportError(error) }
  })()

  const confirmPluginUpload = (release: AcademyOpenAiRelease) => {
    if (!release.artifactHash) return
    setConfirmation({
      title: 'Confirmar envio manual ao ChatGPT?',
      description: `Marca a release v${release.pluginVersion} como enviada após você ter feito o upload manual no ChatGPT.`,
      confirmLabel: 'Confirmar envio',
      onConfirm: async () => {
        await window.codeAwareness.confirmAcademyOpenAiUpload(release.id, release.artifactHash!)
        readSecondaryProjections(true)
        showMessage(`Envio manual v${release.pluginVersion} registrado (aguardando verificação).`)
      }
    })
  }

  const rebuildRelease = (release: AcademyOpenAiRelease) => {
    if (!release.source?.sourceCommitSha) return
    setConfirmation({
      title: `Reconstruir pacote do commit ${release.source.sourceCommitSha.slice(0, 7)}?`,
      description: 'Usa o snapshot histórico verificado offline sem mover o catálogo principal.',
      confirmLabel: 'Reconstruir ZIP',
      onConfirm: async () => {
        await runPluginAction(async () => {
          const rebuilt = await window.codeAwareness.prepareAcademyOpenAiRelease({
            mode: 'REBUILD',
            sourceCommitSha: release.source!.sourceCommitSha
          })
          readSecondaryProjections(true)
          showMessage(`Pacote v${rebuilt.pluginVersion} reconstruído (${rebuilt.artifactHash?.slice(0, 8)}).`)
        })
      }
    })
  }

  const prepareGeminiExport = () => {
    guardDraft(async () => {
      setGeminiPreparing(true)
      setGeminiError(null)
      try {
        const receipt = await window.codeAwareness.prepareAcademyGeminiExport()
        readSecondaryProjections(false)
        showMessage(`Pacote Gemini pronto (${receipt.skillCount} Skills).`)
      } catch (err) {
        setGeminiError(err instanceof Error ? err.message : String(err))
      } finally {
        setGeminiPreparing(false)
      }
    })
  }

  const revealGeminiExport = () => void (async () => {
    try {
      await window.codeAwareness.revealAcademyGeminiExport()
    } catch (err) {
      reportError(err)
    }
  })()

  const approveBatchFromGeminiReview = () => {
    const excluded = geminiExport?.coverage?.excluded ?? []
    const items = excluded
      .filter(item => item.reason === 'PRIVATE' && geminiSelectedReviewIds.includes(item.skillId))
      .map(item => ({ skillId: item.skillId, expectedVersion: item.version }))
    if (!items.length || !window.codeAwareness.approveAcademyPublicSkills) return
    setConfirmation({
      title: `Aprovar ${items.length} Skills para publicação?`,
      description: 'As Skills selecionadas ficarão elegíveis para o pacote Gemini e para o catálogo público.',
      confirmLabel: 'Aprovar selecionadas',
      onConfirm: async () => {
        setReviewBusy(true)
        try {
          await window.codeAwareness.approveAcademyPublicSkills(items, true)
          setGeminiSelectedReviewIds([])
          await refresh(selected?.id)
          showMessage(`${items.length} Skills aprovadas para publicação.`)
        } finally {
          setReviewBusy(false)
        }
      }
    })
  }

  const gitHasAlert = Boolean(
    snapshot.conflicts.length > 0 ||
    gitStatus?.lastError ||
    gitStatus?.syncState === 'CONFLICT' ||
    gitStatus?.syncState === 'ERROR' ||
    (gitStatus?.publication?.conflictPaths?.length ?? 0) > 0
  )

  return (
    <div className="academy-view">
      <AcademyHeader
        surface={surface}
        onSurfaceChange={next => {
          if (next === surface) return
          guardDraft(() => setSurface(next))
        }}
        gitHasAlert={gitHasAlert}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenCatalog={() => setCatalogOpen(true)}
      />

      {message && <div className={`academy-feedback ${message.kind}`} role="status">{message.text}</div>}

      {surface === 'PLUGIN' ? (
        <PluginOverviewSurface
          hydration={hydration}
          openAiPublication={openAiPublication}
          preference={publicationPreference}
          skillCount={snapshot.skills.filter(item => item.scope === 'GLOBAL' && item.status === 'ACTIVE').length}
          preparing={packagePending}
          pluginError={pluginError}
          onPrepareRelease={preparePluginRelease}
          onRevealRelease={revealPluginRelease}
          onConfirmUpload={confirmPluginUpload}
          onOpenReview={() => setReviewOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenSkills={() => setSurface('SKILLS')}
        />
      ) : surface === 'GEMINI' ? (
        <GeminiOverviewSurface
          hydration={hydration}
          geminiExport={geminiExport}
          preparing={geminiPreparing}
          geminiError={geminiError}
          onPrepareExport={prepareGeminiExport}
          onRevealExport={revealGeminiExport}
          onOpenReview={() => setGeminiReviewOpen(true)}
          onOpenSkills={() => guardDraft(() => setSurface('SKILLS'))}
        />
      ) : (
        <div className="academy-body">
          <SkillCatalog
            query={query}
            status={status}
            scopeFilter={scopeFilter}
            onQueryChange={setQuery}
            onStatusChange={setStatus}
            onScopeFilterChange={setScopeFilter}
            onCreate={() => guardDraft(createNew)}
            skills={visible}
            openAiPublication={openAiPublication}
            selectedId={selected?.id ?? null}
            open={catalogOpen}
            onClose={() => setCatalogOpen(false)}
            onSelect={id => { if (id !== selected?.id) guardDraft(() => void choose(id)) }}
          />
          <SkillWorkspace
            selected={selected}
            openAiPublication={openAiPublication}
            autoIncludeGlobal={Boolean(publicationPreference?.autoIncludeGlobal)}
            keepPrivate={keepPrivate}
            onKeepPrivateChange={setKeepPrivate}
            isEditing={isEditing}
            activeTab={activeTab}
            skillMd={skillMd}
            scope={scope}
            projectIds={projectIds}
            destinations={snapshot.destinations}
            history={history}
            distribution={skillDistribution}
            onTabChange={setActiveTab}
            onSkillMdChange={setSkillMd}
            onScopeChange={setScope}
            onProjectIdsChange={setProjectIds}
            onEdit={() => void editSkill()}
            onSave={() => void save()}
            onCancel={() => guardDraft(cancelEditing)}
            activationPending={activationPending !== null}
            onSetEnabled={() => selected && void setEnabled(selected)}
            onRemoveFromGit={requestGitRemoval}
            onApprovePublic={requestPublicApproval}
            onRequestDeleteGlobal={requestDeleteGlobal}
            artifacts={artifacts}
            onOpenArtifact={path => {
              if (!isEditing) setEditBaseline(draftValue)
              setArtifactDraft({ mode: 'edit', originalPath: path, path, content: artifacts[path] ?? '' })
            }}
            onAddArtifact={() => {
              if (!isEditing) setEditBaseline(draftValue)
              setArtifactDraft({ mode: 'create', originalPath: null, path: '', content: '' })
            }}
            dirty={dirty}
            saving={saving}
          />
        </div>
      )}

      {reviewOpen && (
        <PluginReviewModal
          excluded={openAiPublication?.coverage?.excluded ?? []}
          notApplicableCount={openAiPublication?.coverage?.notApplicable ?? 0}
          selectedIds={selectedReviewIds}
          preference={publicationPreference}
          busy={reviewBusy}
          onToggleSelected={id =>
            setSelectedReviewIds(cur => cur.includes(id) ? cur.filter(item => item !== id) : [...cur, id])
          }
          onApproveSingle={(id, ver) => void approveSingleFromReview(id, ver)}
          onApproveBatch={approveBatchFromReview}
          onEnableSkill={id => void enableSkillFromReview(id)}
          onOpenSkill={id => {
            setReviewOpen(false)
            setSurface('SKILLS')
            guardDraft(() => void choose(id))
          }}
          onRequestToggleAutoInclude={requestToggleAutoInclude}
          onClose={() => setReviewOpen(false)}
        />
      )}

      {geminiReviewOpen && (
        <GeminiReviewModal
          excluded={geminiExport?.coverage?.excluded ?? []}
          notApplicableCount={geminiExport?.coverage?.notApplicable ?? 0}
          selectedIds={geminiSelectedReviewIds}
          busy={reviewBusy}
          onToggleSelected={id =>
            setGeminiSelectedReviewIds(cur => cur.includes(id) ? cur.filter(item => item !== id) : [...cur, id])
          }
          onApproveSingle={(id, ver) => void approveSingleFromReview(id, ver)}
          onApproveBatch={approveBatchFromGeminiReview}
          onEnableSkill={id => void enableSkillFromReview(id)}
          onOpenSkill={id => {
            setGeminiReviewOpen(false)
            setSurface('SKILLS')
            guardDraft(() => void choose(id))
          }}
          onClose={() => setGeminiReviewOpen(false)}
        />
      )}

      {settingsOpen && (
        <AcademySettingsDrawer
          hydration={hydration}
          openAiPublication={openAiPublication}
          openAiReleases={openAiReleases}
          preference={publicationPreference}
          packageDistribution={packageDistribution}
          gitStatus={gitStatus}
          eligibleRepos={eligibleRepos}
          selectedRepoId={selectedRepoId}
          destinations={snapshot.destinations}
          conflicts={snapshot.conflicts}
          distribution={distribution}
          knownPublication={knownPublication}
          busy={packagePending || reviewBusy}
          onSelectedRepoChange={setSelectedRepoId}
          onRequestToggleAutoInclude={requestToggleAutoInclude}
          onBootstrapPlugin={() => void (async () => {
            try { await window.codeAwareness.bootstrapAcademyOpenAiPlugin(); readSecondaryProjections(true); showMessage('Manifesto OpenAI inicializado.') }
            catch (error) { reportError(error) }
          })()}
          onConfirmUpload={confirmPluginUpload}
          onRebuildRelease={rebuildRelease}
          onPrepareManifestVersion={kind => void (async () => {
            try { setManifestPreview(await window.codeAwareness.previewAcademyManifestVersion(kind)) }
            catch (error) { reportError(error) }
          })()}
          onBindRepository={() => void (async () => {
            if (!selectedRepoId) return
            try { applyGit(await window.codeAwareness.bindAcademyGitRepository(selectedRepoId)); await refresh(selected?.id); showMessage('Repositório conectado.') }
            catch (error) { reportError(error) }
          })()}
          onSyncGit={() => void (async () => {
            try { applyGit(await window.codeAwareness.syncAcademyGitNow()); await refresh(selected?.id); showMessage('Sincronização Git concluída.') }
            catch (error) { reportError(error) }
          })()}
          onPublishGit={() => void (async () => {
            const localHead = gitStatus?.publication?.localHead
            if (!localHead) return
            try { applyGit(await window.codeAwareness.publishAcademyGit({ localHead, remoteHead: gitStatus?.publication?.remoteHead ?? null })); await refresh(selected?.id); showMessage('Alterações publicadas no Git.') }
            catch (error) { reportError(error) }
          })()}
          onPublishCandidate={() => void (async () => {
            const expectedHead = gitStatus?.publication?.localHead
            if (!expectedHead) return
            setConfirmation({
              title: 'Publicar candidato para Pull Request?',
              description: 'Envia um branch separado para revisão por Pull Request sem modificar o branch principal.',
              confirmLabel: 'Publicar candidato',
              onConfirm: async () => {
                applyGit(await window.codeAwareness.publishAcademyGitCandidate({ branch: `academy/review-${Date.now()}`, expectedHead, confirmed: true }))
                await refresh(selected?.id)
                showMessage('Branch candidato publicado.')
              }
            })
          })()}
          onLocalCutover={() => setConfirmation({
            title: 'Concluir cutover para autoridade SQLite?',
            description: 'Move edições futuras de Skills globais para aprovação explícita local preservando histórico imutável do Git.',
            confirmLabel: 'Concluir cutover',
            onConfirm: async () => {
              applyGit(await window.codeAwareness.completeAcademyLocalCutover(true))
              await refresh(selected?.id)
              showMessage('Cutover local concluído.')
            }
          })}
          onGitAutomation={next => {
            const repoId = gitStatus?.repository?.id, branch = gitStatus?.repository?.branch
            if (!repoId || !branch) return
            void (async () => {
              try {
                applyGit(await window.codeAwareness.configureAcademyGitAutomation({
                  ...next, confirmed: true, expectedRepositoryId: repoId, expectedBranch: branch
                }))
                showMessage('Automação Git atualizada.')
              } catch (error) { reportError(error) }
            })()
          }}
          onOpenGit={() => void window.codeAwareness.openAcademyGitRepository()}
          onReviewGitConflict={path => void (async () => {
            try { const review = await window.codeAwareness.reviewAcademyGitConflict(path); setGitReview(review); setGitResolution(review.local ?? '') }
            catch (error) { reportError(error) }
          })()}
          onReviewConflict={id => void (async () => {
            try { setConflictReview(await window.codeAwareness.reviewAcademyConflict(id)) }
            catch (error) { reportError(error) }
          })()}
          onPreviewConflictBatch={() => void (async () => {
            try { setConflictBatch(await window.codeAwareness.previewAcademyConflictBatch()) }
            catch (error) { reportError(error) }
          })()}
          onOpenDestinations={() => setDestinationsOpen(true)}
          onReconcile={() => void (async () => {
            try {
              const res = await window.codeAwareness.reconcileAcademyDistribution()
              setDistribution(res.health)
              if (selected) setSkillDistribution(res.states.filter(item => item.skillId === selected.id))
              await refresh(selected?.id)
              showMessage('Destinos reconciliados.')
            } catch (error) { reportError(error) }
          })()}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {artifactDraft && (
        <ArtifactEditor
          mode={artifactDraft.mode}
          path={artifactDraft.path}
          content={artifactDraft.content}
          onPathChange={path => setArtifactDraft({ ...artifactDraft, path })}
          onContentChange={content => setArtifactDraft({ ...artifactDraft, content })}
          onSave={applyArtifact}
          onRequestRemove={requestRemoveArtifact}
          onClose={closeArtifact}
        />
      )}

      {destinationsOpen && (
        <DestinationManager
          destinations={snapshot.destinations}
          onClose={() => setDestinationsOpen(false)}
          onToggle={(id, enabled) => void (async () => {
            try { await window.codeAwareness.setAcademyDestinationEnabled(id, enabled); await refresh(selected?.id) }
            catch (error) { reportError(error) }
          })()}
          onImport={id => void (async () => {
            try {
              const result = await window.codeAwareness.importAcademyDestination(id)
              showMessage(`Importação: ${result.filter(item => item.result === 'IMPORTED').length} importadas, ${result.filter(item => item.result === 'INVALID').length} inválidas.`)
              await refresh(selected?.id)
            } catch (error) { reportError(error) }
          })()}
        />
      )}

      {manifestPreview && (
        <ConfirmationDialog
          title={`Atualizar versão para ${manifestPreview.newVersion}?`}
          description={`Registra versão ${manifestPreview.newVersion} (${manifestPreview.previousVersion} → ${manifestPreview.newVersion}) no rascunho de manifesto (${manifestPreview.branch}).`}
          confirmLabel="Salvar revisão"
          onCancel={() => setManifestPreview(null)}
          onConfirm={() => void (async () => {
            const preview = manifestPreview
            setManifestPreview(null)
            try {
              applyGit(await window.codeAwareness.saveAcademyManifestVersion({ preview, confirmed: true }))
              showMessage(`Revisão de manifesto ${preview.newVersion} salva.`)
            } catch (error) { reportError(error) }
          })()}
        />
      )}

      {gitReview && (
        <div className="academy-modal-backdrop" role="dialog" aria-modal="true" aria-label={`Conflito ${gitReview.path}`}>
          <div className="academy-modal">
            <div className="academy-drawer-header">
              <h3>Revisar conflito: {gitReview.path}</h3>
              <button type="button" className="academy-drawer-close" onClick={() => setGitReview(null)}>
                Fechar
              </button>
            </div>
            <label className="academy-field">
              <span>Conteúdo resolvido</span>
              <textarea value={gitResolution} onChange={event => setGitResolution(event.target.value)} rows={12} />
            </label>
            <div className="academy-modal-actions">
              <button type="button" className="academy-secondary-button" onClick={() => setGitReview(null)}>
                Cancelar
              </button>
              <button
                type="button"
                className="academy-primary-button"
                onClick={() => void (async () => {
                  try {
                    applyGit(await window.codeAwareness.resolveAcademyGitConflictPath({
                      path: gitReview.path, head: gitReview.head, revision: gitReview.revision, content: gitResolution, confirmed: true
                    }))
                    setGitReview(null)
                    await refresh(selected?.id)
                    showMessage('Conflito resolvido no workspace Git.')
                  } catch (error) { reportError(error) }
                })()}
              >
                Aplicar resolução
              </button>
            </div>
          </div>
        </div>
      )}

      {(conflictReview || conflictBatch) && (
        <AcademyConflictInspector
          review={conflictReview}
          batch={conflictBatch}
          busy={conflictBusy}
          onClose={() => { setConflictReview(null); setConflictBatch(null) }}
          onResolve={resolution => {
            if (!conflictReview) return
            setConflictBusy(true)
            void window.codeAwareness.resolveAcademyConflict(
              conflictReview.conflict.id, resolution, undefined, { token: conflictReview.token, confirmed: true }
            ).then(async () => {
              setConflictReview(null)
              await refresh(selected?.id)
              showMessage('Conflito resolvido.')
            }).catch(reportError).finally(() => setConflictBusy(false))
          }}
          onResolveBatch={() => {
            if (!conflictBatch) return
            setConflictBusy(true)
            void window.codeAwareness.resolveAcademyConflictBatch(conflictBatch.token, true)
              .then(async res => {
                setConflictBatch(null)
                await refresh(selected?.id)
                showMessage(`${res.resolved} conflitos resolvidos.`)
              }).catch(reportError).finally(() => setConflictBusy(false))
          }}
        />
      )}

      {confirmation && (
        <ConfirmationDialog
          title={confirmation.title}
          description={confirmation.description}
          confirmLabel={confirmation.confirmLabel}
          destructive={confirmation.destructive}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => void handleConfirmation()}
        />
      )}
    </div>
  )
}
