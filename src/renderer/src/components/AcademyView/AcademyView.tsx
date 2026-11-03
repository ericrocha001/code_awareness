import React, { useEffect, useMemo, useState } from 'react'
import type {
  AcademyConflictReview,
  AcademyConflictBatch,
  AcademyDistributionHealth,
  AcademyDistributionState,
  AcademyGitStatusProjection,
  AcademyGitConflictReview,
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
  const [status, setStatus] = useState<'ALL' | 'ACTIVE' | 'DISABLED'>('ALL')
  const [activationPending, setActivationPending] = useState<string | null>(null)
  const [packagePending, setPackagePending] = useState(false)
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
  const [draftCommit, setDraftCommit] = useState<string>()
  const [gitReview, setGitReview] = useState<AcademyGitConflictReview | null>(null)
  const [gitResolution, setGitResolution] = useState('')
  const [manifestPreview, setManifestPreview] = useState<import('../../../../shared/types/academy-publication-types').AcademyManifestPreview | null>(null)
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
    const observe = () => { void window.codeAwareness.refreshAcademyGit?.().then(() => window.codeAwareness.getAcademyGitStatus()).then(setGitStatus).catch(reportError) }
    window.addEventListener('focus', observe)
    window.addEventListener('online', observe)
    const timer = window.setInterval(observe, 300000)
    if (window.codeAwareness.listAcademyGitEligibleRepositories) {
      void window.codeAwareness.listAcademyGitEligibleRepositories().then((repos) => {
        setEligibleRepos(repos)
        if (repos.length > 0) setSelectedRepoId(repos[0].id)
      }).catch(reportError)
    }
    return () => { window.removeEventListener('focus', observe); window.removeEventListener('online', observe); window.clearInterval(timer) }
  }, [])

  const visible = useMemo(() => snapshot.skills.filter((skill) =>
    (status === 'ALL' || skill.status === status)
    && `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase())
  ), [snapshot.skills, status, query])

  useEffect(() => window.codeAwareness.onAcademyChanged?.(() => {
    void (async () => {
      setSnapshot(await window.codeAwareness.getAcademySnapshot())
      setGitStatus(await window.codeAwareness.getAcademyGitStatus())
      if (window.codeAwareness.getAcademyOpenAiPublicationState) setOpenAiPublication(await window.codeAwareness.getAcademyOpenAiPublicationState())
      if (selected && !isEditing) await loadSkill(selected.id)
    })().catch(reportError)
  }), [selected?.id, isEditing])

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
    setDraftCommit(undefined)
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
        ? await window.codeAwareness.updateAcademySkill({ skillId: selected.id, expectedVersion: selected.currentVersion, expectedDraftCommitSha: draftCommit, package: { skillMd, artifacts }, scope, projectIds })
        : await window.codeAwareness.createAcademySkill({ expectedDraftCommitSha: draftCommit, package: { skillMd, artifacts }, scope, projectIds })
      if ('state' in detail && detail.state === 'DRAFT_SAVED') {
        setDraftCommit(detail.workspaceCommitSha)
        showMessage('Rascunho salvo em commit local. Publicação pendente.')
        setGitStatus(await window.codeAwareness.getAcademyGitStatus())
        return
      }
      if (!('id' in detail)) return
      setIsEditing(false)
      const delivery = await window.codeAwareness.getAcademyDeliveryStatus(detail.id, detail.currentVersion).catch(() => null)
      const deliveryText = detail.status === 'DISABLED'
        ? 'Skill desativada; reconciliação local separada'
        : delivery?.status === 'NOT_APPLICABLE'
        ? 'sem destinos aplicáveis'
        : delivery?.status === 'CONVERGED'
        ? 'distribuída'
        : 'distribuição pendente'
      showMessage(`Versão ${detail.currentVersion} salva (${deliveryText}).`)
      await refresh(detail.id)
    } catch (error) { reportError(error) }
  }

  const editSkill = async () => {
    try {
      if (selected?.scope === 'GLOBAL' && window.codeAwareness.getAcademyDraft) {
        const draft = await window.codeAwareness.getAcademyDraft(selected.name)
        setDraftCommit(draft.workspaceCommitSha)
        if (draft.package) { setSkillMd(draft.package.skillMd); setArtifacts(draft.package.artifacts) }
      }
      setIsEditing(true)
    } catch (error) { reportError(error) }
  }

  const requestGitRemoval = async () => {
    if (!selected) return
    try {
      const draft = await window.codeAwareness.getAcademyDraft(selected.name)
      setConfirmation({ title: `Preparar remoção de ${selected.name}?`, description: 'A remoção será salva como commit privado. O conteúdo oficial e o histórico permanecem até a publicação na main. A preferência de ativação local é independente.', confirmLabel: 'Salvar remoção no workspace', destructive: true, action: async () => {
        const result = await window.codeAwareness.deleteAcademyGitDraft({ skillId: selected.id, expectedVersion: selected.currentVersion, expectedDraftCommitSha: draft.workspaceCommitSha, confirmed: true })
        setGitStatus(result); showMessage(result.lastError ?? 'Remoção salva; publicação pendente.', result.lastError ? 'error' : 'success')
      } })
    } catch (error) { reportError(error) }
  }

  const setEnabled = async (skill: AcademySkillDetail | AcademySnapshot['skills'][number]) => {
    if (activationPending) return
    setActivationPending(skill.id)
    try {
      const detail = await window.codeAwareness.setAcademySkillEnabled(skill.id, skill.status !== 'ACTIVE', skill.stateRevision)
      showMessage(`Skill ${detail.status === 'ACTIVE' ? 'ativada' : 'desativada'}. Reconciliação local agendada; publicação do plugin é separada.`)
      await refresh(selected?.id)
    } catch (error) {
      await refresh(selected?.id).catch(() => {})
      reportError(error)
    } finally { setActivationPending(null) }
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

  const prepareOpenAiRelease = async (sourceCommitSha?: string, force = false) => {
    if (packagePending) return
    setPackagePending(true)
    try {
      const release = await window.codeAwareness.prepareAcademyOpenAiRelease(sourceCommitSha ? { mode: 'REBUILD', sourceCommitSha } : force ? { mode: 'LATEST', force: true } : { mode: 'LATEST' })
      showMessage(`Release ${release.pluginVersion}: ${release.status}`)
      await refresh(selected?.id)
    } catch (error) { reportError(error) }
    finally { setPackagePending(false) }
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
      <SkillCatalog skills={visible} selectedId={selected?.id ?? null} open={catalogOpen} onClose={() => setCatalogOpen(false)} onSelect={(id) => void choose(id)} activationPending={activationPending !== null || isEditing} onSetEnabled={(skill) => void setEnabled(skill)} />
      <SkillWorkspace selected={selected} isEditing={isEditing} activeTab={activeTab} skillMd={skillMd} scope={scope} projectIds={projectIds} destinations={snapshot.destinations} history={history} distribution={skillDistribution} onTabChange={setActiveTab} onSkillMdChange={setSkillMd} onScopeChange={setScope} onProjectIdsChange={setProjectIds} onEdit={() => void editSkill()} onSave={() => void save()} onCancel={cancelEditing} activationPending={activationPending !== null} onSetEnabled={() => selected && void setEnabled(selected)} onRemoveFromGit={() => void requestGitRemoval()} />
      <OperationsRail
        open={operationsOpen} destinations={snapshot.destinations} artifacts={artifacts} conflicts={snapshot.conflicts} distribution={distribution} packageDistribution={packageDistribution} openAiPublication={openAiPublication} gitStatus={gitStatus} eligibleRepos={eligibleRepos} selectedRepoId={selectedRepoId} onSelectedRepoChange={setSelectedRepoId} onClose={() => setOperationsOpen(false)} onOpenDestinations={() => setDestinationsOpen(true)} onOpenArtifact={openArtifact} onAddArtifact={() => { setArtifactDraft({ mode: 'create', originalPath: null, path: '', content: '' }); setIsEditing(true) }}
        onReconcile={() => void (async () => { try { await window.codeAwareness.reconcileAcademyDistribution(); showMessage('Distribuição reconciliada.'); await refresh(selected?.id) } catch (error) { reportError(error) } })()}
        onPrepareRelease={() => void prepareOpenAiRelease()}
        packagePending={packagePending}
        onRevalidateRelease={() => void prepareOpenAiRelease(undefined, true)}
        onRebuildRelease={() => void prepareOpenAiRelease(openAiPublication?.selectedRelease?.source?.sourceCommitSha)}
        onPrepareManifestVersion={() => void window.codeAwareness.previewAcademyManifestVersion().then(setManifestPreview).catch(reportError)}
        onBootstrapPlugin={() => void (async () => { try { await window.codeAwareness.bootstrapAcademyOpenAiPlugin(); await refresh(selected?.id) } catch (error) { reportError(error) } })()}
        onRevealRelease={() => { const release = openAiPublication?.selectedRelease; if (release) void window.codeAwareness.revealAcademyOpenAiPackage(release.id) }}
        onConfirmUpload={requestConfirmOpenAiUpload}
        onBindRepository={() => void (async () => { try { setGitStatus(await window.codeAwareness.bindAcademyGitRepository(selectedRepoId)) } catch (error) { reportError(error) } })()}
        onSyncGit={() => void (async () => { try { const result = gitStatus?.syncState === 'LOCAL_CHANGES' ? await window.codeAwareness.publishAcademyGit({ localHead: gitStatus.publication!.localHead!, remoteHead: gitStatus.publication!.remoteHead }) : await window.codeAwareness.syncAcademyGitNow(); setGitStatus(result); await refresh(selected?.id); showMessage(result.syncState === 'SYNCED' ? 'Git sincronizado.' : result.lastError ?? 'Verificação remota pendente.', result.syncState === 'SYNCED' ? 'success' : 'error') } catch (error) { reportError(error) } })()}
        onGitAutomation={(autoPublish, autoUpdate) => setConfirmation({ title: 'Autorizar sincronização automática?', description: `${gitStatus?.repository?.fullName}:${gitStatus?.profile?.branch}. Publicação de Saves: ${autoPublish ? 'habilitada' : 'desabilitada'}; atualização remota: ${autoUpdate ? 'habilitada' : 'desabilitada'}.`, confirmLabel: 'Salvar preferência', action: async () => {
          const profile = gitStatus?.profile
          if (profile) setGitStatus(await window.codeAwareness.configureAcademyGitAutomation({ autoPublish, autoUpdate, confirmed: true, expectedRepositoryId: profile.githubRepositoryId, expectedBranch: profile.branch }))
        } })}
        onOpenGit={() => void window.codeAwareness.openAcademyGitRepository()}
        onPublishCandidate={() => {
          const head = gitStatus?.publication?.localHead
          if (!head) return
          const branch = `academy/edits-${head.slice(0, 12)}`
          setConfirmation({ title: 'Publicar branch candidata?', description: `${gitStatus?.repository?.fullName}:${branch}. Esta ação publica os commits locais para revisão; não abre nem mescla um PR.`, confirmLabel: 'Publicar branch', action: async () => {
            const result = await window.codeAwareness.publishAcademyGitCandidate({ branch, expectedHead: head, confirmed: true })
            setGitStatus(result); showMessage(result.lastError ?? 'Branch publicada; revisão e PR pendentes.', result.lastError ? 'error' : 'success')
          } })
        }}
        onResolveGitConflict={() => {
          const state = gitStatus?.publication
          if (!state || state.phase !== 'CONFLICT') return
          if (state.migrationComplete) {
            void (async () => {
              try {
                const result = await window.codeAwareness.resolveAcademyGitConflict(state.remoteHead, state.localHead!)
                setGitStatus(result)
                const path = result.publication?.conflictPaths[0]
                if (path) { const review = await window.codeAwareness.reviewAcademyGitConflict(path); setGitReview(review); setGitResolution(review.working ?? '') }
              } catch (error) { reportError(error) }
            })()
            return
          }
          setConfirmation({ title: 'Confirmar main revisada?', description: `Revise as diferenças em ${state.conflictPaths.join(', ')}. Adotar main ${state.remoteHead?.slice(0, 8)} preservará todas as versões legadas e os candidatos privados.`, confirmLabel: 'Adotar main revisada', action: async () => {
            const result = await window.codeAwareness.completeAcademyGitMigration(state.remoteHead!, state.migrationCandidateHash!, true)
            setGitStatus(result)
            showMessage(result.syncState === 'SYNCED' && result.publication?.phase === 'CONFIRMED' ? 'Git sincronizado.' : result.lastError ?? 'Verificação remota pendente.', result.syncState === 'SYNCED' && result.publication?.phase === 'CONFIRMED' ? 'success' : 'error')
          } })
        }}
        onReviewConflict={(id) => void (async () => { try { setConflictReview(await window.codeAwareness.reviewAcademyConflict(id)); setConflictBatch(null) } catch (error) { reportError(error) } })()}
        onPreviewConflictBatch={() => void (async () => { try { setConflictBatch(await window.codeAwareness.previewAcademyConflictBatch()); setConflictReview(null) } catch (error) { reportError(error) } })()}
      />
    </div>

    {(conflictReview || conflictBatch) && <AcademyConflictInspector review={conflictReview} batch={conflictBatch} busy={conflictBusy} onClose={() => { setConflictReview(null); setConflictBatch(null) }} onResolve={requestConflictResolution} onResolveBatch={requestBatchResolution} />}
    {message && <div className={`academy-toast ${message.kind}`} role="status"><span>{message.kind === 'success' ? '✓' : '!'}</span>{message.text}<button aria-label="Fechar mensagem" onClick={() => setMessage(null)}>×</button></div>}
    {artifactDraft && <ArtifactEditor mode={artifactDraft.mode} path={artifactDraft.path} content={artifactDraft.content} onPathChange={(path) => setArtifactDraft({ ...artifactDraft, path })} onContentChange={(content) => setArtifactDraft({ ...artifactDraft, content })} onSave={saveArtifactDraft} onRequestRemove={requestRemoveArtifact} onClose={() => setArtifactDraft(null)} />}
    {destinationsOpen && <DestinationManager destinations={snapshot.destinations} onClose={() => setDestinationsOpen(false)} onToggle={(id, enabled) => void (async () => { try { await window.codeAwareness.setAcademyDestinationEnabled(id, enabled); await refresh(selected?.id) } catch (error) { reportError(error) } })()} onImport={(id) => void (async () => { try { const result = await window.codeAwareness.importAcademyDestination(id); showMessage(`Importação: ${result.filter((item) => item.result === 'IMPORTED').length} importadas, ${result.filter((item) => item.result === 'INVALID').length} inválidas.`); await refresh(selected?.id) } catch (error) { reportError(error) } })()} />}
    {confirmation && <ConfirmationDialog title={confirmation.title} description={confirmation.description} confirmLabel={confirmation.confirmLabel} destructive={confirmation.destructive} onCancel={() => setConfirmation(null)} onConfirm={() => void handleConfirmation()} />}
    {manifestPreview && <div className="academy-overlay"><section className="academy-drawer" role="dialog" aria-label="Revisar versão do manifesto">
      <header><h2>Manifesto {manifestPreview.previousVersion} → {manifestPreview.newVersion}</h2></header>
      <p>{manifestPreview.branch} · fonte {manifestPreview.sourceCommitSha.slice(0, 12)}. A revisão altera somente plugin.json no workspace privado. Publique e confirme o commit na branch remota antes de preparar o ZIP.</p>
      <label>Progressão semver<select aria-label="Progressão semver" defaultValue="" onChange={event => void window.codeAwareness.previewAcademyManifestVersion(event.target.value as 'PATCH' | 'MINOR' | 'MAJOR').then(setManifestPreview).catch(reportError)}><option value="" disabled>Sugestão pelo delta</option><option value="PATCH">Patch</option><option value="MINOR">Minor</option><option value="MAJOR">Major</option></select></label>
      <details><summary>Revisar antes e depois de plugin.json</summary><pre>{manifestPreview.before}</pre><pre>{manifestPreview.after}</pre></details>
      <footer><button onClick={() => setManifestPreview(null)}>Cancelar</button><button onClick={() => void (async () => {
        try { const result = await window.codeAwareness.saveAcademyManifestVersion({ preview: manifestPreview, confirmed: true }); setGitStatus(result); setManifestPreview(null); showMessage(result.lastError ?? 'Versão salva no workspace. Publique a revisão no Git antes de preparar o ZIP.', result.lastError ? 'error' : 'success') }
        catch (error) { reportError(error) }
      })()}>Salvar revisão no workspace</button></footer>
    </section></div>}
    {gitReview && <div className="academy-modal-backdrop"><section className="academy-drawer academy-git-conflict" role="dialog" aria-label="Revisar conflito Git">
      <h2>Reconciliar {gitReview.path}</h2>
      <details><summary>Base, local e remoto</summary><h3>Base</h3><pre>{gitReview.base ?? 'Arquivo ausente'}</pre><h3>Local</h3><pre>{gitReview.local ?? 'Arquivo ausente'}</pre><h3>Remoto</h3><pre>{gitReview.remote ?? 'Arquivo ausente'}</pre></details>
      <label>Conteúdo reconciliado<textarea aria-label="Conteúdo reconciliado" value={gitResolution} onChange={event => setGitResolution(event.target.value)} /></label>
      <div className="academy-inline-actions"><button onClick={() => setGitReview(null)}>Fechar</button><button onClick={() => void (async () => {
        try {
          const result = await window.codeAwareness.resolveAcademyGitConflictPath({ path: gitReview.path, head: gitReview.head, revision: gitReview.revision, content: gitResolution, confirmed: true })
          setGitStatus(result)
          const path = result.publication?.conflictPaths[0]
          if (path) { const next = await window.codeAwareness.reviewAcademyGitConflict(path); setGitReview(next); setGitResolution(next.working ?? '') }
          else { setGitReview(null); showMessage(result.lastError ?? 'Reconciliação salva; publicação pendente.', result.lastError ? 'error' : 'success') }
        } catch (error) { reportError(error) }
      })()}>Confirmar conteúdo revisado</button></div>
    </section></div>}
  </section>
}
