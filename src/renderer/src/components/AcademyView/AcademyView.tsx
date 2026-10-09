import React, { useEffect, useMemo, useState } from 'react'
import type {
  AcademyConflictReview,
  AcademyConflictBatch,
  AcademyDistributionHealth,
  AcademyDistributionState,
  AcademyGitStatusProjection,
  AcademyOpenAiPublicationState,
  AcademyPackage,
  AcademyPackageDistributionState,
  AcademySkillDetail,
  AcademySkillScope,
  AcademySnapshot,
  AcademySkillVersion
} from '../../../../shared/types/academy-types'
import type { RepositoryRecord } from '../../../../shared/types/repository-catalog-types'
import {
  AcademyHeader,
  ArtifactEditor,
  ConfirmationDialog,
  DestinationManager,
  OperationsRail,
  SkillCatalog,
  SkillWorkspace,
  type AcademyTab
} from './AcademyPanels'
import './AcademyView.css'
import { AcademyConflictInspector } from './AcademyConflicts'

const emptyPackage: AcademyPackage = {
  skillMd: '---\nname: new-skill\ndescription: Describe when this skill should be used.\n---\n\n# New skill\n',
  artifacts: {}
}

type ArtifactDraft = { mode: 'create' | 'edit'; originalPath: string | null; path: string; content: string }
type Confirmation = { title: string; description: string; confirmLabel: string; destructive?: boolean; action: () => Promise<void> | void }

export const AcademyView: React.FC = () => {
  const [snapshot, setSnapshot] = useState<AcademySnapshot>({ skills: [], destinations: [], conflicts: [] })
  const [selected, setSelected] = useState<AcademySkillDetail | null>(null)
  const [history, setHistory] = useState<AcademySkillVersion[]>([])
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'ALL' | 'ACTIVE' | 'ARCHIVED'>('ALL')
  const [scope, setScope] = useState<AcademySkillScope>('GLOBAL')
  const [projectIds, setProjectIds] = useState<string[]>([])
  const [skillMd, setSkillMd] = useState(emptyPackage.skillMd)
  const [artifacts, setArtifacts] = useState<Record<string, string>>({})
  const [message, setMessage] = useState<{ text: string; kind: 'success' | 'error' } | null>(null)
  const [distribution, setDistribution] = useState<AcademyDistributionHealth>({ targets: [] })
  const [skillDistribution, setSkillDistribution] = useState<AcademyDistributionState[]>([])
  const [openAiPublication, setOpenAiPublication] = useState<AcademyOpenAiPublicationState | null>(null)
  const [packageDistribution, setPackageDistribution] = useState<AcademyPackageDistributionState | null>(null)
  const [gitStatus, setGitStatus] = useState<AcademyGitStatusProjection | null>(null)
  const [eligibleRepos, setEligibleRepos] = useState<RepositoryRecord[]>([])
  const [selectedRepoId, setSelectedRepoId] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [activeTab, setActiveTab] = useState<AcademyTab>('skill')
  const [artifactDraft, setArtifactDraft] = useState<ArtifactDraft | null>(null)
  const [destinationsOpen, setDestinationsOpen] = useState(false)
  const [operationsOpen, setOperationsOpen] = useState(false)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [conflictReview, setConflictReview] = useState<AcademyConflictReview | null>(null)
  const [conflictBatch, setConflictBatch] = useState<AcademyConflictBatch | null>(null)
  const [conflictBusy, setConflictBusy] = useState(false)

  const showMessage = (text: string, kind: 'success' | 'error' = 'success') => setMessage({ text, kind })
  const reportError = (error: unknown) => showMessage(error instanceof Error ? error.message : String(error), 'error')

  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(null), 4500)
    return () => window.clearTimeout(timer)
  }, [message])

  const loadSkill = async (id: string) => {
    const detail = await window.codeAwareness.getAcademySkill(id)
    setSelected(detail)
    setSkillMd(detail.current.package.skillMd)
    setArtifacts(detail.current.package.artifacts)
    setScope(detail.scope)
    setProjectIds(detail.projectIds)
    setHistory(await window.codeAwareness.getAcademyHistory(id))
    setSkillDistribution(await window.codeAwareness.listAcademyDistributionStates(id))
    return detail
  }

  const refresh = async (selectId?: string) => {
    const next = await window.codeAwareness.getAcademySnapshot()
    setSnapshot(next)
    setDistribution(await window.codeAwareness.getAcademyDistributionHealth())
    if (window.codeAwareness.getAcademyOpenAiPublicationState) setOpenAiPublication(await window.codeAwareness.getAcademyOpenAiPublicationState())
    if (window.codeAwareness.getAcademyPackageDistributionState) setPackageDistribution(await window.codeAwareness.getAcademyPackageDistributionState())
    if (window.codeAwareness.getAcademyGitStatus) setGitStatus(await window.codeAwareness.getAcademyGitStatus())
    const id = selectId ?? selected?.id
    if (id) await loadSkill(id)
    else setSkillDistribution([])
  }

  useEffect(() => {
    void refresh().catch(reportError)
    if (window.codeAwareness.listAcademyGitEligibleRepositories) {
      void window.codeAwareness.listAcademyGitEligibleRepositories().then((repos) => {
        setEligibleRepos(repos)
        if (repos.length > 0) setSelectedRepoId(repos[0].id)
      }).catch(reportError)
    }
  }, [])

  const visible = useMemo(() => snapshot.skills.filter((skill) =>
    (status === 'ALL' || skill.status === status)
    && `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase())
  ), [snapshot.skills, status, query])

  const choose = async (id: string) => {
    try {
      await loadSkill(id)
      setIsEditing(false)
      setActiveTab('skill')
      setCatalogOpen(false)
      setMessage(null)
    } catch (error) { reportError(error) }
  }

  const createNew = () => {
    setSelected(null)
    setHistory([])
    setSkillDistribution([])
    setSkillMd(emptyPackage.skillMd)
    setArtifacts({})
    setScope('GLOBAL')
    setProjectIds([])
    setIsEditing(true)
    setActiveTab('skill')
    setCatalogOpen(false)
    setMessage(null)
  }

  const cancelEditing = () => {
    if (selected) {
      setSkillMd(selected.current.package.skillMd)
      setArtifacts(selected.current.package.artifacts)
      setScope(selected.scope)
      setProjectIds(selected.projectIds)
      setIsEditing(false)
      return
    }
    setSkillMd(emptyPackage.skillMd)
    setArtifacts({})
    setScope('GLOBAL')
    setProjectIds([])
    setIsEditing(false)
  }

  const save = async () => {
    try {
      const detail = selected
        ? await window.codeAwareness.updateAcademySkill({ skillId: selected.id, expectedVersion: selected.currentVersion, package: { skillMd, artifacts }, scope, projectIds })
        : await window.codeAwareness.createAcademySkill({ package: { skillMd, artifacts }, scope, projectIds })
      setIsEditing(false)
      showMessage(`Versão ${detail.currentVersion} salva.`)
      await refresh(detail.id)
    } catch (error) { reportError(error) }
  }

  const toggleArchive = async () => {
    if (!selected) return
    try {
      const detail = selected.status === 'ACTIVE'
        ? await window.codeAwareness.archiveAcademySkill(selected.id, selected.currentVersion)
        : await window.codeAwareness.restoreAcademySkill(selected.id, selected.currentVersion)
      showMessage(detail.status === 'ACTIVE' ? 'Skill restaurada.' : 'Skill arquivada.')
      await refresh(detail.id)
    } catch (error) { reportError(error) }
  }

  const openArtifact = (path: string) => {
    if (path === 'SKILL.md') {
      setActiveTab('skill')
      return
    }
    setArtifactDraft({ mode: 'edit', originalPath: path, path, content: artifacts[path] })
  }

  const saveArtifactDraft = () => {
    if (!artifactDraft) return
    const path = artifactDraft.path.trim()
    if (!path) return
    if (artifactDraft.mode === 'create' && path in artifacts) {
      showMessage(`O artefato ${path} já existe.`, 'error')
      return
    }
    const next = { ...artifacts }
    if (artifactDraft.originalPath && artifactDraft.originalPath !== path) delete next[artifactDraft.originalPath]
    next[path] = artifactDraft.content
    setArtifacts(next)
    setArtifactDraft(null)
    setIsEditing(true)
    showMessage('Artefato atualizado no draft.')
  }

  const requestRemoveArtifact = () => {
    if (!artifactDraft?.originalPath) return
    const path = artifactDraft.originalPath
    setConfirmation({
      title: 'Remover artefato?',
      description: `${path} será removido do draft. A alteração só será persistida quando a Skill for salva.`,
      confirmLabel: 'Remover',
      destructive: true,
      action: () => {
        const next = { ...artifacts }
        delete next[path]
        setArtifacts(next)
        setArtifactDraft(null)
        setIsEditing(true)
      }
    })
  }

  const prepareOpenAiRelease = async () => {
    try {
      const release = await window.codeAwareness.prepareAcademyOpenAiRelease()
      showMessage(`Release ${release.pluginVersion}: ${release.status}`)
      await refresh(selected?.id)
    } catch (error) { reportError(error) }
  }

  const requestConfirmOpenAiUpload = () => {
    const release = openAiPublication?.selectedRelease
    if (!release?.artifactHash || release.status !== 'READY_TO_UPLOAD') return
    setConfirmation({
      title: 'Confirmar upload manual?',
      description: `Confirme somente depois de enviar o ZIP ${release.pluginVersion} (${release.artifactHash.slice(0, 12)}…).`,
      confirmLabel: 'Confirmar upload',
      action: async () => {
        try {
          await window.codeAwareness.confirmAcademyOpenAiUpload(release.id, release.artifactHash!)
          showMessage('Upload manual registrado como UPLOADED_UNVERIFIED.')
          await refresh(selected?.id)
        } catch (error) { reportError(error) }
      }
    })
  }

  const handleConfirmation = async () => {
    const action = confirmation?.action
    setConfirmation(null)
    if (action) await action()
  }

  const requestConflictResolution = (resolution: 'CANONICAL' | 'DIVERGENT') => {
    if (!conflictReview) return
    const review = conflictReview
    setConfirmation({
      title: resolution === 'CANONICAL' ? 'Manter versão canônica?' : 'Adotar divergência como versão canônica?',
      description: resolution === 'CANONICAL' ? `Manter v${review.currentVersion} de ${review.conflict.skillName} e sincronizar ${review.conflict.projectionPath ?? 'os destinos aplicáveis'}. O conteúdo local revisado será substituído.` : `O conteúdo divergente inspecionado se tornará uma nova versão canônica de ${review.conflict.skillName} e será distribuído aos destinos aplicáveis.`,
      confirmLabel: resolution === 'CANONICAL' ? 'Confirmar canônica' : 'Confirmar adoção',
      destructive: resolution === 'DIVERGENT',
      action: async () => {
        setConflictBusy(true)
        try {
          const detail = await window.codeAwareness.resolveAcademyConflict(review.conflict.id, resolution, undefined, { token: review.token, confirmed: true })
          setConflictReview(null)
          await refresh(resolution === 'DIVERGENT' ? detail.id : undefined)
        } catch (error) { reportError(error) } finally { setConflictBusy(false) }
      }
    })
  }

  const requestBatchResolution = () => {
    if (!conflictBatch) return
    const batch = conflictBatch
    setConfirmation({ title: 'Confirmar saneamento seguro?', description: `Manter as versões canônicas e resolver ${batch.entries.length} ocorrências certificadas. ${batch.excluded} ocorrências permanecerão para revisão individual.`, confirmLabel: 'Confirmar lote', action: async () => {
      setConflictBusy(true)
      try {
        const result = await window.codeAwareness.resolveAcademyConflictBatch(batch.token, true)
        showMessage(`${result.resolved} registros resolvidos; ${result.remaining} ocorrências restantes.`)
        setConflictBatch(null); await refresh()
      } catch (error) { reportError(error) } finally { setConflictBusy(false) }
    } })
  }

  return <section className="academy-view">
    <AcademyHeader query={query} status={status} conflictCount={snapshot.conflicts.length} onQueryChange={setQuery} onStatusChange={setStatus} onCreate={createNew} onOpenCatalog={() => setCatalogOpen(true)} onOpenOperations={() => setOperationsOpen(true)} />
    <div className="academy-layout">
      <SkillCatalog skills={visible} selectedId={selected?.id ?? null} open={catalogOpen} onClose={() => setCatalogOpen(false)} onSelect={(id) => void choose(id)} />
      <SkillWorkspace selected={selected} isEditing={isEditing} activeTab={activeTab} skillMd={skillMd} scope={scope} projectIds={projectIds} destinations={snapshot.destinations} history={history} distribution={skillDistribution} onTabChange={setActiveTab} onSkillMdChange={setSkillMd} onScopeChange={setScope} onProjectIdsChange={setProjectIds} onEdit={() => setIsEditing(true)} onSave={() => void save()} onCancel={cancelEditing} onToggleArchive={() => void toggleArchive()} />
      <OperationsRail
        open={operationsOpen} destinations={snapshot.destinations} artifacts={artifacts} conflicts={snapshot.conflicts} distribution={distribution} packageDistribution={packageDistribution} openAiPublication={openAiPublication} gitStatus={gitStatus} eligibleRepos={eligibleRepos} selectedRepoId={selectedRepoId} onSelectedRepoChange={setSelectedRepoId} onClose={() => setOperationsOpen(false)} onOpenDestinations={() => setDestinationsOpen(true)} onOpenArtifact={openArtifact} onAddArtifact={() => { setArtifactDraft({ mode: 'create', originalPath: null, path: '', content: '' }); setIsEditing(true) }}
        onReconcile={() => void (async () => { try { await window.codeAwareness.reconcileAcademyDistribution(); showMessage('Distribuição reconciliada.'); await refresh(selected?.id) } catch (error) { reportError(error) } })()}
        onPrepareRelease={() => void prepareOpenAiRelease()}
        onBootstrapPlugin={() => void (async () => { try { await window.codeAwareness.bootstrapAcademyOpenAiPlugin(); await refresh(selected?.id) } catch (error) { reportError(error) } })()}
        onRevealRelease={() => { const release = openAiPublication?.selectedRelease; if (release) void window.codeAwareness.revealAcademyOpenAiPackage(release.id) }}
        onConfirmUpload={requestConfirmOpenAiUpload}
        onBindRepository={() => void (async () => { try { setGitStatus(await window.codeAwareness.bindAcademyGitRepository(selectedRepoId)) } catch (error) { reportError(error) } })()}
        onSyncGit={() => void (async () => { try { setGitStatus(await window.codeAwareness.syncAcademyGitNow()); showMessage('Git sincronizado.') } catch (error) { reportError(error) } })()}
        onOpenGit={() => void window.codeAwareness.openAcademyGitRepository()}
        onReviewConflict={(id) => void (async () => { try { setConflictReview(await window.codeAwareness.reviewAcademyConflict(id)); setConflictBatch(null) } catch (error) { reportError(error) } })()}
        onPreviewConflictBatch={() => void (async () => { try { setConflictBatch(await window.codeAwareness.previewAcademyConflictBatch()); setConflictReview(null) } catch (error) { reportError(error) } })()}
      />
    </div>

    {(conflictReview || conflictBatch) && <AcademyConflictInspector review={conflictReview} batch={conflictBatch} busy={conflictBusy} onClose={() => { setConflictReview(null); setConflictBatch(null) }} onResolve={requestConflictResolution} onResolveBatch={requestBatchResolution} />}
    {message && <div className={`academy-toast ${message.kind}`} role="status"><span>{message.kind === 'success' ? '✓' : '!'}</span>{message.text}<button aria-label="Fechar mensagem" onClick={() => setMessage(null)}>×</button></div>}
    {artifactDraft && <ArtifactEditor mode={artifactDraft.mode} path={artifactDraft.path} content={artifactDraft.content} onPathChange={(path) => setArtifactDraft({ ...artifactDraft, path })} onContentChange={(content) => setArtifactDraft({ ...artifactDraft, content })} onSave={saveArtifactDraft} onRequestRemove={requestRemoveArtifact} onClose={() => setArtifactDraft(null)} />}
    {destinationsOpen && <DestinationManager destinations={snapshot.destinations} onClose={() => setDestinationsOpen(false)} onToggle={(id, enabled) => void (async () => { try { await window.codeAwareness.setAcademyDestinationEnabled(id, enabled); await refresh(selected?.id) } catch (error) { reportError(error) } })()} onImport={(id) => void (async () => { try { const result = await window.codeAwareness.importAcademyDestination(id); showMessage(`Importação: ${result.filter((item) => item.result === 'IMPORTED').length} importadas, ${result.filter((item) => item.result === 'INVALID').length} inválidas.`); await refresh(selected?.id) } catch (error) { reportError(error) } })()} />}
    {confirmation && <ConfirmationDialog title={confirmation.title} description={confirmation.description} confirmLabel={confirmation.confirmLabel} destructive={confirmation.destructive} onCancel={() => setConfirmation(null)} onConfirm={() => void handleConfirmation()} />}
  </section>
}
