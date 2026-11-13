import React from 'react'
import { gitPresentation, releasePresentation } from './academy-presentation'
import { Button } from '../shared/Button/Button'
import { ContextHelp } from '../shared/ContextHelp/ContextHelp'
import type {
  AcademyConflictSummary,
  AcademyDestination,
  AcademyDistributionHealth,
  AcademyDistributionState,
  AcademyDistributionTarget,
  AcademyDistributionTargetHealth,
  AcademyGitStatusProjection,
  AcademyOpenAiPublicationState,
  AcademyOpenAiRelease,
  AcademyPackageDistributionState,
  AcademyPluginExcludedSkill,
  AcademyPublicationPreference,
  AcademySkillDetail,
  AcademySkillScope,
  AcademySkillSummary,
  AcademySkillVersion,
  AcademyGeminiExcludedSkill,
  AcademyGeminiExportMode,
  AcademyGeminiExportReceipt,
  AcademyGeminiExportState,
  AcademyGeminiPendingReason,
  AcademyImportConfirmationMode,
  AcademyImportConfirmationOrigin,
  AcademyImportConfirmationPreference
} from '../../../../shared/types/academy-types'
import type { AcademyPersistedPublication } from '../../../../shared/types/academy-bootstrap-types'
import type { RepositoryRecord } from '../../../../shared/types/repository-catalog-types'
import { AcademyConflicts } from './AcademyConflicts'

export type AcademySurface = 'PLUGIN' | 'GEMINI' | 'SKILLS'
export type AcademyTab = 'skill' | 'history'

function resolveCurrentRelease(publication: AcademyOpenAiPublicationState | null): AcademyOpenAiRelease | null {
  return publication?.selectedRelease ?? publication?.latestPrepared ?? null
}

function isPublicationStale(publication: AcademyOpenAiPublicationState | null, release: AcademyOpenAiRelease | null): boolean {
  return Boolean(publication?.drifted || release?.status === 'STALE')
}

function describeTarget(target: AcademyDistributionTarget): string {
  if (target === 'FILESYSTEM_NATIVE') return 'Filesystem local'
  if (target === 'CLAUDE_CODE') return 'Claude Code'
  return 'Antigravity'
}

function describePackageDelivery(state: AcademyDistributionState): { label: string; tone: 'success' | 'warning' | 'danger' } {
  if (state.status === 'CURRENT') return { label: `Atualizado (v${state.canonicalVersion})`, tone: 'success' }
  if (state.status === 'ERROR') return { label: state.errorMessage ?? 'Erro de distribuição', tone: 'danger' }
  return { label: `Reconciliação pendente (${state.status.toLowerCase()})`, tone: 'warning' }
}

function describeReconciliation(target: AcademyDistributionTargetHealth): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  const total = target.current + target.pending + target.drifted + target.missing + target.error
  if (total === 0) return { label: 'Sem destinos aplicáveis', tone: 'neutral' }
  if (target.error > 0) return { label: `${target.error} com erro · ${target.current}/${total}`, tone: 'danger' }
  if (target.convergence === 'CONVERGED') return { label: `${target.current}/${total} atualizado`, tone: 'success' }
  return { label: `${target.current}/${total} convergente`, tone: 'warning' }
}

export function skillPluginStatus(
  skill: AcademySkillSummary,
  openAiPublication: AcademyOpenAiPublicationState | null
): { label: string; tone: 'included' | 'pending' | 'private' | 'disabled' | 'neutral' } {
  if (skill.scope !== 'GLOBAL') return { label: 'Não aplicável', tone: 'neutral' }
  if (skill.status !== 'ACTIVE') return { label: 'Fora do plugin · Desativada', tone: 'disabled' }
  if (skill.publicationEligibility === 'PRIVATE') return { label: 'Privada · Fora do plugin', tone: 'private' }
  if (skill.publicationEligibility === 'APPROVED') {
    const release = resolveCurrentRelease(openAiPublication)
    const stale = isPublicationStale(openAiPublication, release)
    const inLastZip = Boolean(
      release &&
      !stale &&
      openAiPublication?.artifactAvailable &&
      release.snapshot.some(entry => entry.skillId === skill.id && entry.academyVersion === skill.currentVersion)
    )
    if (release && !stale && release.snapshot.some(entry => entry.skillId === skill.id && entry.academyVersion === skill.currentVersion)) {
      return { label: inLastZip ? 'Incluída no plugin' : 'Incluída (ZIP pendente)', tone: 'included' }
    }
    return { label: 'Aguardando geração do ZIP', tone: 'pending' }
  }
  return skill.source?.state === 'CONFIRMED'
    ? { label: 'Incluída via Git', tone: 'included' }
    : { label: 'Aguardando cutover/aprovação', tone: 'pending' }
}

interface AcademyHeaderProps {
  surface: AcademySurface
  onSurfaceChange: (next: AcademySurface) => void
  gitHasAlert: boolean
  onOpenSettings: () => void
  onOpenCatalog: () => void
}

export const AcademyHeader: React.FC<AcademyHeaderProps> = ({
  surface,
  onSurfaceChange,
  gitHasAlert,
  onOpenSettings,
  onOpenCatalog
}) => (
  <header className="academy-header">
    <div className="academy-header-brand">
      <div>
        <h2>Academy</h2>
        <p className="academy-header-subtitle">Empacote e mantenha suas Skills</p>
      </div>
      <nav className="academy-surface-nav" aria-label="Navegação da Academy">
        <button
          type="button"
          className={`academy-surface-tab${surface === 'PLUGIN' ? ' active' : ''}`}
          aria-pressed={surface === 'PLUGIN'}
          onClick={() => onSurfaceChange('PLUGIN')}
        >
          Plugin ChatGPT
        </button>
        <button
          type="button"
          className={`academy-surface-tab${surface === 'GEMINI' ? ' active' : ''}`}
          aria-pressed={surface === 'GEMINI'}
          onClick={() => onSurfaceChange('GEMINI')}
        >
          Gemini
        </button>
        <button
          type="button"
          className={`academy-surface-tab${surface === 'SKILLS' ? ' active' : ''}`}
          aria-pressed={surface === 'SKILLS'}
          onClick={() => onSurfaceChange('SKILLS')}
        >
          Skills
        </button>
      </nav>
    </div>
    <div className="academy-header-actions">
      {surface === 'SKILLS' && (
        <button type="button" className="academy-compact-trigger" onClick={onOpenCatalog}>
          Catálogo
        </button>
      )}
      <button
        type="button"
        className={`academy-settings-trigger${gitHasAlert ? ' has-alert' : ''}`}
        aria-label="Configurações"
        onClick={onOpenSettings}
      >
        <span>Configurações</span>
        {gitHasAlert && <span className="academy-settings-dot" aria-hidden="true" />}
      </button>
    </div>
  </header>
)

interface PluginOverviewSurfaceProps {
  hydration: 'LOADING' | 'READY' | 'ERROR'
  openAiPublication: AcademyOpenAiPublicationState | null
  preference: AcademyPublicationPreference | null
  skillCount: number
  preparing: boolean
  pluginError: string | null
  onPrepareRelease: () => void
  onRevealRelease: (release: AcademyOpenAiRelease) => void
  onDownloadRelease: (release: AcademyOpenAiRelease) => void
  onConfirmUpload: (release: AcademyOpenAiRelease) => void
  onRevokeUpload: (release: AcademyOpenAiRelease) => void
  onOpenReview: () => void
  onOpenSettings: () => void
  onOpenSkills: () => void
}

export const PluginOverviewSurface: React.FC<PluginOverviewSurfaceProps> = ({
  hydration,
  openAiPublication,
  preference,
  skillCount,
  preparing,
  pluginError,
  onPrepareRelease,
  onRevealRelease,
  onDownloadRelease,
  onConfirmUpload,
  onRevokeUpload,
  onOpenReview,
  onOpenSettings,
  onOpenSkills
}) => {
  const release = resolveCurrentRelease(openAiPublication)
  const stale = isPublicationStale(openAiPublication, release)
  const coverage = openAiPublication?.coverage ?? null
  const excluded = coverage?.excluded ?? []
  const privateCount = excluded.filter(item => item.reason === 'PRIVATE').length
  const disabledCount = excluded.filter(item => item.reason === 'DISABLED').length
  const removedCount = excluded.filter(item => item.reason === 'REMOVED').length
  const currentZipReady = Boolean(release && !stale && openAiPublication?.artifactAvailable)
  const releaseSignal = releasePresentation(release, Boolean(openAiPublication?.drifted))

  const exclusionParts: string[] = []
  if (privateCount > 0) exclusionParts.push(`${privateCount} privada${privateCount > 1 ? 's' : ''}`)
  if (disabledCount > 0) exclusionParts.push(`${disabledCount} desativada${disabledCount > 1 ? 's' : ''}`)
  if (removedCount > 0) exclusionParts.push(`${removedCount} removida${removedCount > 1 ? 's' : ''}`)

  const eligibleCount = coverage?.eligible ?? skillCount
  const catalogCount = coverage?.catalog ?? skillCount
  const notApplicableCount = coverage?.notApplicable ?? 0
  const awaitingZipCount = coverage?.awaitingZip ?? 0

  const headline = preparing
    ? 'Gerando ZIP do plugin ChatGPT…'
    : currentZipReady
      ? 'Plugin ChatGPT pronto para abrir'
      : release
        ? 'Atualização pronta para novo ZIP'
        : 'Empacote suas Skills em um clique'

  const nextStepText = currentZipReady
    ? 'Envie o ZIP manualmente em ChatGPT → Configurações → Plugins quando quiser publicar.'
    : awaitingZipCount > 0
      ? 'Gere o ZIP atualizado para incluir todas as Skills aprovadas no arquivo.'
      : 'Gere o pacote local a qualquer momento; edição de Skills continua na aba secundária.'

  return (
    <section className="academy-plugin-shell" aria-label="Plugin ChatGPT">
      <div className="academy-plugin-stage">
        <div className="academy-plugin-action">
          <div className="academy-plugin-eyebrow-row">
            <span className="academy-plugin-eyebrow">Plugin ChatGPT</span>
            <ContextHelp label="Como funciona o Plugin ChatGPT" hint="Inclusão automática e segurança">
              Apenas Skills com escopo GLOBAL ativas e autorizadas entram no ZIP local do plugin. Skills de projeto, privadas ou desativadas ficam fora do pacote.
            </ContextHelp>
          </div>
          <h3 className="academy-plugin-title">{headline}</h3>
          <p className="academy-plugin-coverage-summary" data-testid="academy-coverage-summary">
            <strong>{hydration === 'LOADING' ? 'Carregando catálogo…' : `${eligibleCount} ${eligibleCount === 1 ? 'Skill global' : 'Skills globais'} no plugin`}</strong>
            {hydration !== 'LOADING' && (
              <span>
                {' '}· {catalogCount} no catálogo{notApplicableCount > 0 ? ` · ${notApplicableCount} de projeto (não aplicável)` : ''}
              </span>
            )}
          </p>

          {excluded.length > 0 && (
            <div className="academy-excluded-notice" data-ui-state="warning">
              <div className="academy-excluded-copy">
                <strong>
                  {excluded.length} {excluded.length === 1 ? 'Skill fora do plugin' : 'Skills fora do plugin'}
                </strong>
                <span> ({exclusionParts.join(' · ')})</span>
              </div>
              <Button variant="outline" intent="neutral" size="compact" onClick={onOpenReview}>
                Revisar
              </Button>
            </div>
          )}

          <p className="academy-policy-caption">
            {preference?.autoIncludeGlobal
              ? 'Autorização única ativa: novas Skills globais (UI e MCP) entram automaticamente no plugin.'
              : 'Política segura: novas Skills globais nascem privadas até aprovação explícita.'}{' '}
            <button type="button" className="academy-inline-link" onClick={onOpenReview}>
              Gerenciar autorização
            </button>
          </p>

          <div className="academy-plugin-cta-row">
            {preparing ? (
              <Button variant="solid" intent="primary" size="comfortable" disabled>
                Gerando plugin…
              </Button>
            ) : currentZipReady && release ? (
              <>
                <Button variant="solid" intent="primary" size="comfortable" onClick={() => onRevealRelease(release)}>
                  Abrir ZIP
                </Button>
                <Button variant="ghost" intent="neutral" size="compact" onClick={onPrepareRelease}>
                  Regerar ZIP
                </Button>
              </>
            ) : (
              <Button variant="solid" intent="primary" size="comfortable" onClick={onPrepareRelease}>
                {release ? 'Gerar ZIP atualizado' : 'Gerar plugin'}
              </Button>
            )}
          </div>

          {(pluginError || openAiPublication?.sourceError || openAiPublication?.operation?.error || release?.blockedReason) && (
            <div className="academy-plugin-diagnostic" data-ui-state="error" role="status">
              {pluginError || openAiPublication?.sourceError || openAiPublication?.operation?.error || release?.blockedReason}
            </div>
          )}
        </div>

        <aside className="academy-plugin-result" aria-label="Resultado do pacote local">
          <div className="academy-plugin-result-header">
            <span>Pacote local</span>
            {release && <span className={`academy-signal ${releaseSignal.tone}`}>{releaseSignal.label}</span>}
          </div>
          {release ? (
            <div className="academy-plugin-result-body">
              <div className="academy-plugin-version-row">
                <strong className="academy-plugin-version">v{release.pluginVersion}</strong>
                <span>{release.snapshot.length} {release.snapshot.length === 1 ? 'Skill empacotada' : 'Skills empacotadas'}</span>
              </div>
              <p className="academy-plugin-freshness">
                {awaitingZipCount > 0
                  ? `${awaitingZipCount} ${awaitingZipCount === 1 ? 'alteração aprovada aguarda' : 'alterações aprovadas aguardam'} novo ZIP.`
                  : openAiPublication?.artifactAvailable
                    ? 'Arquivo ZIP gerado no computador e pronto para envio manual.'
                    : 'Arquivo ZIP não encontrado no disco. Clique para gerar novamente.'}
              </p>
              {release.status === 'UPLOADED_UNVERIFIED' && release.uploadConfirmation && (
                <p className="academy-provenance-note" data-testid="openai-upload-provenance">
                  {release.uploadConfirmation.origin === 'ASSUMED_ON_DOWNLOAD' ||
                  release.uploadConfirmation.method === 'ASSUMED_ON_DOWNLOAD'
                    ? 'Importação assumida após download'
                    : 'Importação declarada manualmente'}
                </p>
              )}
              <div className="academy-plugin-result-actions">
                {openAiPublication?.artifactAvailable && (
                  <>
                    <Button variant="outline" intent="neutral" size="compact" onClick={() => onRevealRelease(release)}>
                      Mostrar ZIP
                    </Button>
                    <Button variant="outline" intent="neutral" size="compact" onClick={() => onDownloadRelease(release)}>
                      Baixar ZIP
                    </Button>
                  </>
                )}
                {release.status === 'READY_TO_UPLOAD' && release.artifactHash && (
                  <Button variant="subtle" intent="neutral" size="compact" onClick={() => onConfirmUpload(release)}>
                    Confirmar envio ao ChatGPT
                  </Button>
                )}
                {release.status === 'UPLOADED_UNVERIFIED' && !release.baseline && (
                  <Button variant="outline" intent="neutral" size="compact" onClick={() => onRevokeUpload(release)}>
                    Desfazer confirmação
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="academy-plugin-empty">
              <strong>Nenhum ZIP gerado ainda</strong>
              <p>Use um clique para empacotar as Skills globais autorizadas em um arquivo ZIP local.</p>
            </div>
          )}
        </aside>
      </div>

      <footer className="academy-plugin-footer">
        <span>{nextStepText}</span>
        <div className="academy-plugin-footer-actions">
          <button type="button" className="academy-inline-link" onClick={onOpenSkills}>
            Editar ou criar Skills
          </button>
          <button type="button" className="academy-inline-link" onClick={onOpenSettings}>
            Opções avançadas
          </button>
        </div>
      </footer>
    </section>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
  } catch {
    return iso
  }
}

function geminiModeLabel(mode: AcademyGeminiExportMode): string {
  if (mode === 'INCREMENTAL') return 'Incremental'
  if (mode === 'MCP_TRIGGERS') return 'Gatilhos MCP'
  return 'Completo'
}

function importOriginLabel(origin: AcademyImportConfirmationOrigin): string {
  return origin === 'ASSUMED_ON_DOWNLOAD'
    ? 'Importação assumida após download'
    : 'Importação declarada manualmente'
}

function pendingReasonLabel(reason: AcademyGeminiPendingReason): string {
  switch (reason) {
    case 'NEW_SKILL':
      return 'Nova'
    case 'VERSION_CHANGED':
    case 'CONTENT_CHANGED':
      return 'Alterada'
    case 'RENAMED':
      return 'Renomeada'
    case 'METADATA_CHANGED':
      return 'Metadados alterados'
    case 'PROFILE_CHANGED':
      return 'Perfil atualizado'
  }
}

interface GeminiOverviewSurfaceProps {
  hydration: 'LOADING' | 'READY' | 'ERROR'
  geminiExport: AcademyGeminiExportState | null
  preparing: boolean
  busy?: boolean
  geminiError: string | null
  onPrepareExport: () => void
  onRevealExport: () => void
  onDownloadExport: () => void
  onConfirmImport: (skillIds?: string[]) => void
  onRevokeImport: (skillIds?: string[]) => void
  onEstablishBaseline: () => void
  onAcknowledgeManualAction: (skillId: string) => void
  onOpenModeModal: () => void
  onOpenReview: () => void
  onOpenSkills: () => void
}

export const GeminiOverviewSurface: React.FC<GeminiOverviewSurfaceProps> = ({
  hydration,
  geminiExport,
  preparing,
  busy = false,
  geminiError,
  onPrepareExport,
  onRevealExport,
  onDownloadExport,
  onConfirmImport,
  onRevokeImport,
  onEstablishBaseline,
  onAcknowledgeManualAction,
  onOpenModeModal,
  onOpenReview,
  onOpenSkills
}) => {
  const mode: AcademyGeminiExportMode = geminiExport?.mode ?? 'FULL'
  const isDifferential = mode !== 'FULL'
  const coverage = geminiExport?.coverage
  const eligibleCount = coverage?.eligible ?? 0
  const catalogCount = coverage?.catalog ?? 0
  const notApplicableCount = coverage?.notApplicable ?? 0
  const adaptedCount = coverage?.adaptedCount ?? 0
  const excluded = coverage?.excluded ?? []
  const awaitingCount = coverage?.awaitingZip ?? 0
  const latest = geminiExport?.latestExport ?? null
  const artifactAvailable = Boolean(geminiExport?.artifactAvailable)
  const drifted = Boolean(geminiExport?.drifted)
  const pendingSkills = geminiExport?.pendingSkills ?? []
  const importedSkills = geminiExport?.importedSkills ?? []
  const manualActions = geminiExport?.manualActions ?? []
  const fullImportConfirmation = geminiExport?.fullImportConfirmation ?? null
  const importPref = geminiExport?.importConfirmationPreference ?? null

  const hasDifferentialLists =
    isDifferential && (pendingSkills.length > 0 || importedSkills.length > 0 || manualActions.length > 0)

  const headline = isDifferential
    ? mode === 'MCP_TRIGGERS'
      ? pendingSkills.length === 0 && importedSkills.length > 0
        ? 'Gatilhos MCP atualizados para o Gemini Web'
        : 'Exporte stubs leves de acionamento via MCP'
      : pendingSkills.length === 0 && importedSkills.length > 0
        ? 'Skills incrementais em dia com o Gemini Web'
        : 'Exporte apenas Skills novas ou alteradas'
    : !latest
      ? 'Exporte suas Skills para o Gemini Web com um clique'
      : drifted
        ? 'Alterações recentes aguardam novo pacote Gemini'
        : 'Pacote Gemini pronto para importação'

  const exclusionCounts = {
    PRIVATE: excluded.filter((item) => item.reason === 'PRIVATE').length,
    DISABLED: excluded.filter((item) => item.reason === 'DISABLED').length,
    INCOMPATIBLE: excluded.filter((item) => item.reason === 'INCOMPATIBLE').length,
    REMOVED: excluded.filter((item) => item.reason === 'REMOVED').length
  }
  const exclusionParts: string[] = []
  if (exclusionCounts.INCOMPATIBLE > 0) {
    exclusionParts.push(
      `${exclusionCounts.INCOMPATIBLE} ${exclusionCounts.INCOMPATIBLE === 1 ? 'incompatível' : 'incompatíveis'}`
    )
  }
  if (exclusionCounts.PRIVATE > 0) {
    exclusionParts.push(`${exclusionCounts.PRIVATE} ${exclusionCounts.PRIVATE === 1 ? 'privada' : 'privadas'}`)
  }
  if (exclusionCounts.DISABLED > 0) {
    exclusionParts.push(`${exclusionCounts.DISABLED} ${exclusionCounts.DISABLED === 1 ? 'desativada' : 'desativadas'}`)
  }
  if (exclusionCounts.REMOVED > 0) {
    exclusionParts.push(`${exclusionCounts.REMOVED} ${exclusionCounts.REMOVED === 1 ? 'removida' : 'removidas'}`)
  }

  const exportSignal = isDifferential
    ? pendingSkills.length === 0
      ? { tone: 'published' as const, label: 'Em dia' }
      : artifactAvailable && !drifted
        ? { tone: 'published' as const, label: 'Lote pronto' }
        : { tone: 'stale' as const, label: `${pendingSkills.length} pendentes` }
    : !latest
      ? { tone: 'draft' as const, label: 'Aguardando geração' }
      : drifted
        ? { tone: 'stale' as const, label: 'Desatualizado' }
        : { tone: 'published' as const, label: 'Pronto' }

  const nextStepText =
    mode === 'MCP_TRIGGERS'
      ? 'Cada Skill vira um ZIP stub mínimo. Configure o MCP do Code Awareness no Gemini Web para carregar instruções completas sob demanda.'
      : mode === 'INCREMENTAL'
        ? 'Importe os ZIPs individuais da pasta incremental no Gemini Web e confirme a importação para atualizar a base local.'
        : artifactAvailable
          ? 'Extraia o arquivo academy-gemini.zip para obter os ZIPs individuais e importe-os no Gemini Apps Web.'
          : awaitingCount > 0
            ? 'Gere o pacote mestre atualizado para incluir todas as Skills compatíveis.'
            : 'Gere o pacote Gemini a qualquer momento; edição de Skills continua na aba secundária.'

  const fullConfirmedForLatest = Boolean(
    latest && fullImportConfirmation && fullImportConfirmation.artifactHash === latest.artifactHash
  )
  const preparedSkillIds = new Set((latest?.skills ?? []).map((s) => s.skillId).filter(Boolean))

  return (
    <section
      className={`academy-plugin-shell${hasDifferentialLists ? ' has-lists' : ''}`}
      aria-label="Exportação Gemini"
    >
      <div className="academy-plugin-stage">
        <div className="academy-plugin-action">
          <div className="academy-plugin-eyebrow-row">
            <span className="academy-plugin-eyebrow">Gemini Apps Web</span>
            <span className="academy-badge scope" data-testid="gemini-active-mode">
              {geminiModeLabel(mode)}
            </span>
            {mode === 'MCP_TRIGGERS' && (
              <span className="academy-badge warning">Requer MCP no Gemini Web</span>
            )}
            <Button variant="outline" intent="neutral" size="compact" onClick={onOpenModeModal}>
              Configurar modo
            </Button>
            <ContextHelp label="Como funciona a exportação Gemini" hint="Três modos de distribuição para Gemini Web">
              Escolha entre pacote Completo (academy-gemini.zip), Incremental (apenas novas e alteradas) ou Gatilhos MCP (stubs mínimos com consulta ao vivo via MCP).
            </ContextHelp>
          </div>
          <h3 className="academy-plugin-title">{headline}</h3>
          <p className="academy-plugin-coverage-summary" data-testid="academy-gemini-coverage-summary">
            <strong>
              {hydration === 'LOADING'
                ? 'Carregando catálogo…'
                : isDifferential
                  ? `${eligibleCount} ${eligibleCount === 1 ? 'Skill elegível' : 'Skills elegíveis'} · ${pendingSkills.length} ${pendingSkills.length === 1 ? 'pendente' : 'pendentes'} · ${importedSkills.length} importadas em dia`
                  : `${eligibleCount} ${eligibleCount === 1 ? 'Skill compatível' : 'Skills compatíveis'} para Gemini`}
            </strong>
            {hydration !== 'LOADING' && (
              <span>
                {' '}· {catalogCount} no catálogo
                {notApplicableCount > 0 ? ` · ${notApplicableCount} de projeto (não aplicável)` : ''}
                {!isDifferential && adaptedCount > 0 ? ` · ${adaptedCount} com scripts adaptados` : ''}
                {isDifferential && manualActions.length > 0
                  ? ` · ${manualActions.length} ${manualActions.length === 1 ? 'ação manual' : 'ações manuais'}`
                  : ''}
              </span>
            )}
          </p>

          {excluded.length > 0 && (
            <div className="academy-excluded-notice" data-ui-state="warning">
              <div className="academy-excluded-copy">
                <strong>
                  {excluded.length} {excluded.length === 1 ? 'Skill fora do pacote' : 'Skills fora do pacote'}
                </strong>
                <span> ({exclusionParts.join(' · ')})</span>
              </div>
              <Button variant="outline" intent="neutral" size="compact" onClick={onOpenReview}>
                Revisar
              </Button>
            </div>
          )}

          <p className="academy-policy-caption">
            {mode === 'MCP_TRIGGERS'
              ? 'Modo Gatilhos MCP: envia apenas frontmatter (name/description) e chamada MCP, aceitando Skills com scripts ou mais de 100MB.'
              : 'Requisitos do Gemini Web: identificador kebab-case, tamanho até 100MB e extensões suportadas. Scripts incompatíveis são convertidos em referências textuais não executáveis.'}
            {importPref && (
              <span>
                {' '}· Confirmação de importação: <strong>{importPref.mode === 'AUTOMATIC' ? 'Automática ao baixar' : 'Manual'}</strong>.
              </span>
            )}
          </p>

          <div className="academy-plugin-cta-row">
            {preparing ? (
              <Button variant="solid" intent="primary" size="comfortable" disabled>
                Gerando pacote Gemini…
              </Button>
            ) : isDifferential ? (
              pendingSkills.length === 0 ? (
                <Button variant="solid" intent="primary" size="comfortable" disabled>
                  Nenhuma Skill pendente
                </Button>
              ) : artifactAvailable && !drifted && latest ? (
                <>
                  <Button variant="solid" intent="primary" size="comfortable" onClick={onRevealExport}>
                    Abrir pasta
                  </Button>
                  <Button variant="outline" intent="neutral" size="compact" disabled={busy} onClick={onDownloadExport}>
                    Baixar pacote
                  </Button>
                  <Button variant="subtle" intent="neutral" size="compact" disabled={busy} onClick={() => onConfirmImport()}>
                    Confirmar importação
                  </Button>
                  <Button variant="ghost" intent="neutral" size="compact" onClick={onPrepareExport}>
                    Regerar pacote
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="solid" intent="primary" size="comfortable" onClick={onPrepareExport}>
                    {mode === 'MCP_TRIGGERS' ? 'Gerar gatilhos MCP' : 'Gerar pacote incremental'}
                  </Button>
                  {artifactAvailable && latest && (
                    <Button variant="ghost" intent="neutral" size="compact" onClick={onRevealExport}>
                      Abrir pasta anterior
                    </Button>
                  )}
                  {importedSkills.length === 0 && (
                    <Button variant="outline" intent="neutral" size="compact" disabled={busy} onClick={onEstablishBaseline}>
                      Já importei antes (estabelecer base)
                    </Button>
                  )}
                </>
              )
            ) : artifactAvailable && !drifted && latest ? (
              <>
                <Button variant="solid" intent="primary" size="comfortable" onClick={onRevealExport}>
                  Abrir ZIP
                </Button>
                <Button variant="outline" intent="neutral" size="compact" disabled={busy} onClick={onDownloadExport}>
                  Baixar pacote
                </Button>
                <Button variant="ghost" intent="neutral" size="compact" onClick={onPrepareExport}>
                  Regerar ZIP
                </Button>
              </>
            ) : artifactAvailable && drifted && latest ? (
              <>
                <Button variant="solid" intent="primary" size="comfortable" onClick={onPrepareExport}>
                  Gerar ZIP atualizado
                </Button>
                <Button variant="ghost" intent="neutral" size="compact" onClick={onRevealExport}>
                  Abrir ZIP anterior
                </Button>
              </>
            ) : (
              <Button variant="solid" intent="primary" size="comfortable" onClick={onPrepareExport}>
                Gerar pacote Gemini
              </Button>
            )}
          </div>

          {(geminiError || geminiExport?.lastError) && (
            <div className="academy-plugin-diagnostic" data-ui-state="error" role="status">
              {geminiError || geminiExport?.lastError}
            </div>
          )}
        </div>

        <aside className="academy-plugin-result" aria-label="Resultado do pacote Gemini">
          <div className="academy-plugin-result-header">
            <span>{isDifferential ? `Pasta ${geminiModeLabel(mode)}` : 'Pacote Gemini'}</span>
            <span className={`academy-signal ${exportSignal.tone}`}>{exportSignal.label}</span>
          </div>
          {latest ? (
            <div className="academy-plugin-result-body">
              <div className="academy-plugin-version-row">
                <strong className="academy-plugin-version">
                  {isDifferential ? (mode === 'MCP_TRIGGERS' ? 'mcp-triggers/' : 'incremental/') : 'academy-gemini.zip'}
                </strong>
                <span>
                  {latest.skillCount} {latest.skillCount === 1 ? 'Skill individual' : 'Skills individuais'}
                  {latest.convertedCount && latest.convertedCount > 0 ? ` (${latest.convertedCount} com scripts adaptados)` : ''}
                </span>
              </div>
              <p className="academy-plugin-freshness">
                {drifted
                  ? isDifferential
                    ? `${pendingSkills.length} ${pendingSkills.length === 1 ? 'Skill aguarda' : 'Skills aguardam'} nova geração neste modo.`
                    : `${awaitingCount} ${awaitingCount === 1 ? 'alteração aguarda' : 'alterações aguardam'} novo pacote.`
                  : artifactAvailable
                    ? `Gerado em ${formatDate(latest.exportedAt)} (${formatBytes(latest.totalBytes)}). Pronto para importação.`
                    : 'Pacote não encontrado no disco. Clique para gerar novamente.'}
              </p>
              {!isDifferential && fullConfirmedForLatest && fullImportConfirmation && (
                <p className="academy-provenance-note" data-testid="gemini-full-provenance">
                  {importOriginLabel(fullImportConfirmation.origin)}
                </p>
              )}
              <div className="academy-plugin-result-actions">
                {artifactAvailable && (
                  <>
                    <Button variant="outline" intent="neutral" size="compact" onClick={onRevealExport}>
                      {isDifferential ? 'Mostrar pasta' : 'Mostrar ZIP'}
                    </Button>
                    <Button variant="outline" intent="neutral" size="compact" disabled={busy} onClick={onDownloadExport}>
                      Baixar pacote
                    </Button>
                  </>
                )}
                {!isDifferential && artifactAvailable && !fullConfirmedForLatest && (
                  <Button variant="subtle" intent="neutral" size="compact" disabled={busy} onClick={() => onConfirmImport()}>
                    Confirmar importação
                  </Button>
                )}
                {!isDifferential && fullImportConfirmation && (
                  <Button variant="outline" intent="neutral" size="compact" disabled={busy} onClick={() => onRevokeImport()}>
                    Desfazer confirmação
                  </Button>
                )}
                {isDifferential && importedSkills.length > 0 && (
                  <Button variant="outline" intent="neutral" size="compact" disabled={busy} onClick={() => onRevokeImport()}>
                    Desfazer confirmação
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="academy-plugin-empty">
              <strong>
                {isDifferential && pendingSkills.length === 0
                  ? 'Tudo importado e atualizado'
                  : 'Nenhum pacote Gemini gerado ainda'}
              </strong>
              <p>
                {isDifferential
                  ? pendingSkills.length === 0
                    ? 'Nenhuma Skill pendente neste modo. Novas ou editadas aparecerão aqui automaticamente.'
                    : `Existem ${pendingSkills.length} Skills pendentes neste modo para gerar em lote.`
                  : 'Gere um arquivo mestre com todas as Skills globais e compatíveis para o Gemini Web.'}
              </p>
              {isDifferential && importedSkills.length > 0 && (
                <div className="academy-plugin-result-actions">
                  <Button variant="outline" intent="neutral" size="compact" disabled={busy} onClick={() => onRevokeImport()}>
                    Desfazer confirmação
                  </Button>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>

      {hasDifferentialLists && (
        <div className="academy-gemini-differential-grid">
          {pendingSkills.length > 0 && (
            <section className="academy-gemini-list-card" aria-label="Skills pendentes para Gemini">
              <div className="academy-settings-row-header">
                <h4>Pendentes de envio ({pendingSkills.length})</h4>
              </div>
              <div className="academy-gemini-list-items">
                {pendingSkills.map((item) => {
                  const isPreparedInCurrentBatch = Boolean(
                    artifactAvailable && !drifted && preparedSkillIds.has(item.skillId)
                  )
                  return (
                    <div key={item.skillId} className="academy-gemini-list-row">
                      <div className="academy-gemini-list-meta">
                        <strong>{item.name}</strong>
                        <span className="academy-badge scope">{pendingReasonLabel(item.reason)}</span>
                        <span>v{item.academyVersion}</span>
                        {item.previousName && <span>(antes: {item.previousName})</span>}
                      </div>
                      {isPreparedInCurrentBatch && (
                        <Button
                          variant="outline"
                          intent="neutral"
                          size="compact"
                          disabled={busy}
                          onClick={() => onConfirmImport([item.skillId])}
                        >
                          Confirmar
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {importedSkills.length > 0 && (
            <section className="academy-gemini-list-card" aria-label="Skills importadas no Gemini">
              <div className="academy-settings-row-header">
                <h4>Importadas em dia ({importedSkills.length})</h4>
              </div>
              <div className="academy-gemini-list-items">
                {importedSkills.map((item) => (
                  <div key={item.skillId} className="academy-gemini-list-row">
                    <div className="academy-gemini-list-meta">
                      <strong>{item.name}</strong>
                      <span>v{item.academyVersion}</span>
                      <span className="academy-provenance-tag">{importOriginLabel(item.origin)}</span>
                    </div>
                    <Button
                      variant="ghost"
                      intent="neutral"
                      size="compact"
                      disabled={busy}
                      onClick={() => onRevokeImport([item.skillId])}
                    >
                      Desfazer
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {manualActions.length > 0 && (
            <section className="academy-gemini-list-card warning" aria-label="Ações manuais no Gemini">
              <div className="academy-settings-row-header">
                <h4>Ações manuais no Gemini ({manualActions.length})</h4>
              </div>
              <div className="academy-gemini-list-items">
                {manualActions.map((item) => (
                  <div key={item.skillId} className="academy-gemini-list-row">
                    <div className="academy-gemini-list-meta">
                      <strong>{item.currentName ?? item.previousName}</strong>
                      <span className="academy-gemini-action-details">{item.reason}</span>
                    </div>
                    <Button
                      variant="outline"
                      intent="neutral"
                      size="compact"
                      disabled={busy}
                      onClick={() => onAcknowledgeManualAction(item.skillId)}
                    >
                      Já removi no Gemini
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <footer className="academy-plugin-footer">
        <span>{nextStepText}</span>
        <div className="academy-plugin-footer-actions">
          <button type="button" className="academy-inline-link" onClick={onOpenSkills}>
            Ver catálogo de Skills
          </button>
        </div>
      </footer>
    </section>
  )
}

interface GeminiModeModalProps {
  currentMode: AcademyGeminiExportMode
  busy: boolean
  onSelectMode: (mode: AcademyGeminiExportMode) => void
  onClose: () => void
}

export const GeminiModeModal: React.FC<GeminiModeModalProps> = ({
  currentMode,
  busy,
  onSelectMode,
  onClose
}) => {
  const [selected, setSelected] = React.useState<AcademyGeminiExportMode>(currentMode)

  const options: Array<{
    mode: AcademyGeminiExportMode
    title: string
    badge?: string
    description: string
    consequence: string
  }> = [
    {
      mode: 'FULL',
      title: 'Completo',
      description: 'Gera um único arquivo academy-gemini.zip contendo um ZIP individual por Skill ativa compatível.',
      consequence: 'Indicado para backup total ou primeira importação em massa.'
    },
    {
      mode: 'INCREMENTAL',
      title: 'Incremental',
      description: 'Exporta uma pasta contendo apenas as Skills novas ou alteradas desde a última importação confirmada.',
      consequence: 'Preserva o histórico local de cada Skill e evita reenviar Skills já em dia.'
    },
    {
      mode: 'MCP_TRIGGERS',
      title: 'Gatilhos MCP',
      badge: 'Requer MCP no Gemini Web',
      description: 'Exporta stubs leves contendo apenas name, description e acionamento via MCP em tempo real.',
      consequence: 'Requer servidor MCP conectado no Gemini Web; aceita Skills com binários ou acima de 100MB.'
    }
  ]

  return (
    <div className="academy-modal-backdrop" role="dialog" aria-modal="true" aria-label="Modo de exportação Gemini">
      <div className="academy-modal academy-modal-wide">
        <div className="academy-drawer-header">
          <div>
            <h3>Modo de exportação Gemini</h3>
            <p className="academy-modal-subcopy">
              Alternar o modo preserva os checkpoints salvos nos demais modos e recalcula imediatamente as Skills pendentes.
            </p>
          </div>
          <Button variant="ghost" intent="neutral" size="compact" onClick={onClose}>
            Fechar
          </Button>
        </div>

        <div className="academy-mode-options" role="radiogroup" aria-label="Escolha o modo de exportação Gemini">
          {options.map((option) => (
            <label
              key={option.mode}
              className={`academy-mode-option${selected === option.mode ? ' selected' : ''}`}
            >
              <input
                type="radio"
                name="gemini-export-mode"
                value={option.mode}
                checked={selected === option.mode}
                onChange={() => setSelected(option.mode)}
              />
              <div className="academy-mode-option-copy">
                <div className="academy-mode-option-header">
                  <strong>{option.title}</strong>
                  {option.badge && <span className="academy-badge warning">{option.badge}</span>}
                </div>
                <p>{option.description}</p>
                <span className="academy-mode-consequence">{option.consequence}</span>
              </div>
            </label>
          ))}
        </div>

        <div className="academy-modal-actions">
          <Button variant="outline" intent="neutral" size="compact" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="solid"
            intent="primary"
            size="compact"
            disabled={busy || selected === currentMode}
            onClick={() => onSelectMode(selected)}
          >
            Aplicar modo
          </Button>
        </div>
      </div>
    </div>
  )
}

interface PluginReviewModalProps {
  excluded: AcademyPluginExcludedSkill[]
  notApplicableCount: number
  selectedIds: string[]
  preference: AcademyPublicationPreference | null
  busy: boolean
  onToggleSelected: (skillId: string) => void
  onApproveSingle: (skillId: string, expectedVersion: number) => void
  onApproveBatch: () => void
  onEnableSkill: (skillId: string) => void
  onOpenSkill: (skillId: string) => void
  onRequestToggleAutoInclude: (nextEnabled: boolean) => void
  onClose: () => void
}

export const PluginReviewModal: React.FC<PluginReviewModalProps> = ({
  excluded,
  notApplicableCount,
  selectedIds,
  preference,
  busy,
  onToggleSelected,
  onApproveSingle,
  onApproveBatch,
  onEnableSkill,
  onOpenSkill,
  onRequestToggleAutoInclude,
  onClose
}) => {
  const privateItems = excluded.filter(item => item.reason === 'PRIVATE')
  const reasonLabel = (reason: AcademyPluginExcludedSkill['reason']) =>
    reason === 'PRIVATE' ? 'Privada · Fora do plugin' : reason === 'DISABLED' ? 'Desativada' : 'Removida localmente'

  return (
    <div className="academy-modal-backdrop" role="dialog" aria-modal="true" aria-label="Revisar Skills fora do plugin">
      <div className="academy-modal academy-modal-wide">
        <div className="academy-drawer-header">
          <div>
            <h3>Skills fora do plugin ChatGPT</h3>
            <p className="academy-modal-subcopy">
              {excluded.length > 0
                ? 'Veja o motivo de cada exclusão e inclua somente o que desejar publicar.'
                : 'Todas as Skills globais ativas estão autorizadas para o plugin.'}
              {notApplicableCount > 0 ? ` (${notApplicableCount} com escopo PROJECT nunca entram no plugin.)` : ''}
            </p>
          </div>
          <Button variant="ghost" intent="neutral" size="compact" onClick={onClose}>
            Fechar
          </Button>
        </div>

        <div className="academy-preference-card">
          <div className="academy-preference-copy">
            <strong>Incluir automaticamente novas Skills globais no plugin ChatGPT</strong>
            <p>
              {preference?.autoIncludeGlobal
                ? `Autorização única ativa (revisão ${preference.revision}). Novas Skills globais criadas na UI ou via MCP entram automaticamente, exceto quando marcadas como privadas.`
                : 'Desativada por segurança. Novas Skills globais criadas na UI ou via MCP permanecem privadas até aprovação explícita.'}
            </p>
          </div>
          {preference?.autoIncludeGlobal ? (
            <Button variant="outline" intent="neutral" size="compact" disabled={busy} onClick={() => onRequestToggleAutoInclude(false)}>
              Revogar autorização automática
            </Button>
          ) : (
            <Button variant="solid" intent="primary" size="compact" disabled={busy} onClick={() => onRequestToggleAutoInclude(true)}>
              Autorizar inclusão automática
            </Button>
          )}
        </div>

        <div className="academy-review-list">
          {excluded.length === 0 ? (
            <p className="academy-empty-note">Nenhuma Skill global excluída no momento.</p>
          ) : (
            excluded.map(item => (
              <div key={item.skillId} className="academy-review-row">
                <div className="academy-review-info">
                  {item.reason === 'PRIVATE' && (
                    <input
                      type="checkbox"
                      aria-label={`Selecionar ${item.name} para inclusão`}
                      checked={selectedIds.includes(item.skillId)}
                      onChange={() => onToggleSelected(item.skillId)}
                    />
                  )}
                  <div>
                    <strong>{item.name}</strong>
                    <div className="academy-review-reason">
                      <span className="academy-badge scope">{reasonLabel(item.reason)}</span>
                      <span>v{item.version}</span>
                    </div>
                  </div>
                </div>
                <div className="academy-review-actions">
                  {item.reason === 'PRIVATE' && (
                    <Button
                      variant="solid"
                      intent="primary"
                      size="compact"
                      disabled={busy}
                      onClick={() => onApproveSingle(item.skillId, item.version)}
                    >
                      Incluir no plugin
                    </Button>
                  )}
                  {item.reason === 'DISABLED' && (
                    <Button
                      variant="outline"
                      intent="neutral"
                      size="compact"
                      disabled={busy}
                      onClick={() => onEnableSkill(item.skillId)}
                    >
                      Reativar Skill
                    </Button>
                  )}
                  <Button variant="ghost" intent="neutral" size="compact" onClick={() => onOpenSkill(item.skillId)}>
                    Ver em Skills
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>

        {privateItems.length > 0 && (
          <div className="academy-modal-actions">
            <Button
              variant="solid"
              intent="primary"
              size="comfortable"
              disabled={busy || selectedIds.length === 0}
              onClick={onApproveBatch}
            >
              Incluir selecionadas no plugin ({selectedIds.length})
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

interface GeminiReviewModalProps {
  excluded: AcademyGeminiExcludedSkill[]
  notApplicableCount: number
  selectedIds: string[]
  busy: boolean
  onToggleSelected: (skillId: string) => void
  onApproveSingle: (skillId: string, expectedVersion: number) => void
  onApproveBatch: () => void
  onEnableSkill: (skillId: string) => void
  onOpenSkill: (skillId: string) => void
  onClose: () => void
}

export const GeminiReviewModal: React.FC<GeminiReviewModalProps> = ({
  excluded,
  notApplicableCount,
  selectedIds,
  busy,
  onToggleSelected,
  onApproveSingle,
  onApproveBatch,
  onEnableSkill,
  onOpenSkill,
  onClose
}) => {
  const privateItems = excluded.filter((item) => item.reason === 'PRIVATE')
  const reasonLabel = (reason: AcademyGeminiExcludedSkill['reason']) => {
    switch (reason) {
      case 'PRIVATE':
        return 'Privada · Requer aprovação'
      case 'DISABLED':
        return 'Desativada'
      case 'INCOMPATIBLE':
        return 'Incompatível com Gemini'
      case 'REMOVED':
        return 'Removida localmente'
    }
  }

  return (
    <div className="academy-modal-backdrop" role="dialog" aria-modal="true" aria-label="Revisar Skills fora do pacote Gemini">
      <div className="academy-modal academy-modal-wide">
        <div className="academy-drawer-header">
          <div>
            <h3>Skills fora do pacote Gemini</h3>
            <p className="academy-modal-subcopy">
              {excluded.length > 0
                ? 'Veja o motivo pelo qual estas Skills não foram incluídas no pacote Gemini.'
                : 'Todas as Skills globais ativas são compatíveis e estão incluídas.'}
              {notApplicableCount > 0 ? ` (${notApplicableCount} com escopo PROJECT não entram no pacote.)` : ''}
            </p>
          </div>
          <Button variant="ghost" intent="neutral" size="compact" onClick={onClose}>
            Fechar
          </Button>
        </div>

        <div className="academy-review-list">
          {excluded.length === 0 ? (
            <p className="academy-empty-note">Nenhuma Skill excluída no momento.</p>
          ) : (
            excluded.map((item) => (
              <div key={item.skillId} className="academy-review-row">
                <div className="academy-review-info">
                  {item.reason === 'PRIVATE' && (
                    <input
                      type="checkbox"
                      aria-label={`Selecionar ${item.name} para inclusão`}
                      checked={selectedIds.includes(item.skillId)}
                      onChange={() => onToggleSelected(item.skillId)}
                    />
                  )}
                  <div>
                    <strong>{item.name}</strong>
                    <div className="academy-review-reason">
                      <span className={`academy-badge ${item.reason === 'INCOMPATIBLE' ? 'warning' : 'scope'}`}>
                        {reasonLabel(item.reason)}
                      </span>
                      <span>v{item.version}</span>
                    </div>
                    {item.details && <p className="academy-review-details">{item.details}</p>}
                  </div>
                </div>
                <div className="academy-review-actions">
                  {item.reason === 'PRIVATE' && (
                    <Button
                      variant="solid"
                      intent="primary"
                      size="compact"
                      disabled={busy}
                      onClick={() => onApproveSingle(item.skillId, item.version)}
                    >
                      Aprovar publicação
                    </Button>
                  )}
                  {item.reason === 'DISABLED' && (
                    <Button
                      variant="outline"
                      intent="neutral"
                      size="compact"
                      disabled={busy}
                      onClick={() => onEnableSkill(item.skillId)}
                    >
                      Habilitar
                    </Button>
                  )}
                  {item.reason === 'INCOMPATIBLE' && (
                    <Button
                      variant="outline"
                      intent="neutral"
                      size="compact"
                      onClick={() => onOpenSkill(item.skillId)}
                    >
                      Ver Skill
                    </Button>
                  )}
                  {item.reason === 'REMOVED' && (
                    <Button
                      variant="outline"
                      intent="neutral"
                      size="compact"
                      onClick={() => onOpenSkill(item.skillId)}
                    >
                      Ver detalhes
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {privateItems.length > 0 && (
          <div className="academy-modal-actions">
            <Button
              variant="solid"
              intent="primary"
              size="comfortable"
              disabled={busy || selectedIds.length === 0}
              onClick={onApproveBatch}
            >
              Aprovar selecionadas ({selectedIds.length})
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

interface SkillCatalogProps {
  query: string
  status: 'ALL' | 'ACTIVE' | 'DISABLED'
  scopeFilter: 'ALL' | AcademySkillScope
  onQueryChange: (value: string) => void
  onStatusChange: (value: 'ALL' | 'ACTIVE' | 'DISABLED') => void
  onScopeFilterChange: (value: 'ALL' | AcademySkillScope) => void
  onCreate: () => void
  skills: AcademySkillSummary[]
  openAiPublication: AcademyOpenAiPublicationState | null
  selectedId: string | null
  open: boolean
  onClose: () => void
  onSelect: (id: string) => void
}

export const SkillCatalog: React.FC<SkillCatalogProps> = ({
  query,
  status,
  scopeFilter,
  onQueryChange,
  onStatusChange,
  onScopeFilterChange,
  onCreate,
  skills,
  openAiPublication,
  selectedId,
  open,
  onClose,
  onSelect
}) => (
  <aside className={`academy-catalog${open ? ' open' : ''}`} aria-label="Catálogo de Skills">
    <div className="academy-catalog-controls">
      <div className="academy-catalog-top">
        <Button variant="solid" intent="primary" size="compact" className="academy-grow-button" onClick={onCreate}>
          Nova Skill
        </Button>
        {open && (
          <button type="button" className="academy-drawer-close" onClick={onClose}>
            Fechar
          </button>
        )}
      </div>
      <input
        type="search"
        aria-label="Buscar Skills"
        value={query}
        onChange={event => onQueryChange(event.target.value)}
        placeholder="Buscar por nome ou descrição"
      />
      <div className="academy-catalog-filters">
        <select
          aria-label="Filtrar por status"
          value={status}
          onChange={event => onStatusChange(event.target.value as SkillCatalogProps['status'])}
        >
          <option value="ALL">Todos status</option>
          <option value="ACTIVE">Ativas</option>
          <option value="DISABLED">Desativadas</option>
        </select>
        <select
          aria-label="Filtrar por escopo"
          value={scopeFilter}
          onChange={event => onScopeFilterChange(event.target.value as SkillCatalogProps['scopeFilter'])}
        >
          <option value="ALL">Todos escopos</option>
          <option value="GLOBAL">GLOBAL</option>
          <option value="PROJECT">PROJECT</option>
        </select>
      </div>
    </div>
    <div className="academy-skill-list">
      {skills.length === 0 ? (
        <p className="academy-empty-list">Nenhuma Skill corresponde aos filtros.</p>
      ) : (
        skills.map(skill => {
          const pluginState = skillPluginStatus(skill, openAiPublication)
          return (
            <button
              type="button"
              key={skill.id}
              className={`academy-skill-item${selectedId === skill.id ? ' selected' : ''}`}
              onClick={() => onSelect(skill.id)}
            >
              <div className="academy-skill-row">
                <strong>{skill.name}</strong>
                <span>v{skill.currentVersion}</span>
              </div>
              <div className="academy-skill-badges">
                <span className="academy-badge scope">{skill.scope}</span>
                <span className={`academy-badge plugin-${pluginState.tone}`}>{pluginState.label}</span>
              </div>
            </button>
          )
        })
      )}
    </div>
  </aside>
)

interface SkillWorkspaceProps {
  selected: AcademySkillDetail | null
  openAiPublication: AcademyOpenAiPublicationState | null
  autoIncludeGlobal: boolean
  keepPrivate: boolean
  onKeepPrivateChange: (value: boolean) => void
  isEditing: boolean
  activeTab: AcademyTab
  skillMd: string
  scope: AcademySkillScope
  projectIds: string[]
  destinations: AcademyDestination[]
  history: AcademySkillVersion[]
  distribution: AcademyDistributionState[]
  onTabChange: (tab: AcademyTab) => void
  onSkillMdChange: (value: string) => void
  onScopeChange: (scope: AcademySkillScope) => void
  onProjectIdsChange: (projectIds: string[]) => void
  onEdit: () => void
  onSave: () => void
  onCancel: () => void
  activationPending: boolean
  onSetEnabled: () => void
  onRemoveFromGit: () => void
  onApprovePublic: () => void
  onRequestDeleteGlobal: () => void
  artifacts: Record<string, string>
  onOpenArtifact: (path: string) => void
  onAddArtifact: () => void
  dirty: boolean
  saving: boolean
}

export const SkillWorkspace: React.FC<SkillWorkspaceProps> = ({
  selected,
  openAiPublication,
  autoIncludeGlobal,
  keepPrivate,
  onKeepPrivateChange,
  isEditing,
  activeTab,
  skillMd,
  scope,
  projectIds,
  destinations,
  history,
  distribution,
  onTabChange,
  onSkillMdChange,
  onScopeChange,
  onProjectIdsChange,
  onEdit,
  onSave,
  onCancel,
  activationPending,
  onSetEnabled,
  onRemoveFromGit,
  onApprovePublic,
  onRequestDeleteGlobal,
  artifacts,
  onOpenArtifact,
  onAddArtifact,
  dirty,
  saving
}) => {
  const pluginState = selected ? skillPluginStatus(selected, openAiPublication) : null

  return (
    <main className="academy-workspace" aria-label="Editor de Skill">
      {!selected && !isEditing ? (
        <div className="academy-workspace-empty">
          <h3>Selecione uma Skill para visualizar ou editar</h3>
          <p>Ou crie uma nova Skill com o botão "Nova Skill" no catálogo.</p>
        </div>
      ) : (
        <>
          <div className="academy-workspace-header">
            <div className="academy-workspace-title-block">
              <h3>{selected ? selected.name : 'Nova Skill'}</h3>
              <span className="academy-workspace-meta">
                {selected ? `v${selected.currentVersion} · ` : ''}
                {isEditing ? scope : selected?.scope}
                {selected ? ` · ${selected.status === 'ACTIVE' ? 'Ativa' : 'Desativada'}` : ''}
                {dirty ? ' · rascunho não salvo' : ''}
              </span>
            </div>
            <div className="academy-actions">
              {selected && !isEditing && (
                <>
                  <Button variant="solid" intent="primary" size="compact" onClick={onEdit}>
                    Editar
                  </Button>
                  <Button
                    variant="outline"
                    intent="neutral"
                    size="compact"
                    disabled={activationPending}
                    onClick={onSetEnabled}
                  >
                    {activationPending ? 'Atualizando…' : selected.status === 'ACTIVE' ? 'Desativar' : 'Ativar'}
                  </Button>
                  {selected.scope === 'GLOBAL' && selected.source?.state === 'CONFIRMED' && (
                    <Button variant="outline" intent="danger" size="compact" onClick={onRemoveFromGit}>
                      Remover do Git
                    </Button>
                  )}
                  {selected.catalogRevision !== undefined && selected.scope === 'GLOBAL' && (
                    <Button variant="outline" intent="danger" size="compact" onClick={onRequestDeleteGlobal}>
                      Excluir global
                    </Button>
                  )}
                </>
              )}
              {isEditing && (
                <>
                  <Button variant="solid" intent="primary" size="compact" disabled={saving || (Boolean(selected) && !dirty)} onClick={onSave}>
                    {saving ? 'Salvando…' : 'Salvar'}
                  </Button>
                  <Button variant="outline" intent="neutral" size="compact" disabled={saving} onClick={onCancel}>
                    Cancelar
                  </Button>
                </>
              )}
            </div>
          </div>

          {selected && !isEditing && pluginState && (
            <div className="academy-skill-plugin-bar" data-plugin-tone={pluginState.tone}>
              <div className="academy-skill-plugin-copy">
                <strong>Plugin ChatGPT: {pluginState.label}</strong>
                {selected.scope === 'PROJECT' && <span> · Skills de projeto não são publicadas no plugin.</span>}
                {selected.scope === 'GLOBAL' && selected.publicationEligibility === 'PRIVATE' && (
                  <span> · Requer autorização explícita para entrar no ZIP e no Git.</span>
                )}
              </div>
              {selected.scope === 'GLOBAL' && selected.publicationEligibility === 'PRIVATE' && (
                <Button variant="solid" intent="primary" size="compact" onClick={onApprovePublic}>
                  Incluir no plugin
                </Button>
              )}
            </div>
          )}

          <div className="academy-tabs">
            <button type="button" className={activeTab === 'skill' ? 'active' : ''} onClick={() => onTabChange('skill')}>
              SKILL.md
            </button>
            <button type="button" className={activeTab === 'history' ? 'active' : ''} onClick={() => onTabChange('history')}>
              Histórico ({history.length})
            </button>
          </div>

          {activeTab === 'skill' && (
            <div className="academy-skill-tab">
              {isEditing && (
                <div className="academy-scope-box">
                  <div className="academy-scope-controls">
                    <label htmlFor="academy-scope-select">Escopo</label>
                    <select
                      id="academy-scope-select"
                      value={scope}
                      onChange={event => onScopeChange(event.target.value as AcademySkillScope)}
                    >
                      <option value="GLOBAL">GLOBAL (todos os destinos)</option>
                      <option value="PROJECT">PROJECT (projetos selecionados)</option>
                    </select>
                  </div>
                  {!selected && scope === 'GLOBAL' && (
                    <label className="academy-keep-private-toggle">
                      <input
                        type="checkbox"
                        checked={keepPrivate}
                        onChange={event => onKeepPrivateChange(event.target.checked)}
                      />
                      <span>
                        {autoIncludeGlobal
                          ? 'Manter privada (não incluir automaticamente no plugin ChatGPT)'
                          : 'Nasce privada por padrão (não incluir automaticamente no plugin)'}
                      </span>
                    </label>
                  )}
                  {scope === 'PROJECT' && (
                    <div className="academy-project-checks">
                      {destinations.map(destination => (
                        <label key={destination.id} className="academy-check-row">
                          <input
                            type="checkbox"
                            checked={projectIds.includes(destination.id)}
                            onChange={event =>
                              onProjectIdsChange(
                                event.target.checked
                                  ? [...projectIds, destination.id]
                                  : projectIds.filter(item => item !== destination.id)
                              )
                            }
                          />
                          <span>{destination.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {isEditing ? (
                <textarea
                  className="academy-editor-textarea"
                  aria-label="Conteúdo do SKILL.md"
                  value={skillMd}
                  onChange={event => onSkillMdChange(event.target.value)}
                  rows={16}
                />
              ) : (
                <pre className="academy-readonly-skill">{selected?.current.package.skillMd ?? ''}</pre>
              )}

              <section className="academy-artifacts" aria-label="Artefatos da Skill">
                <div className="academy-subhead">
                  <h4>Artefatos</h4>
                  <Button variant="outline" intent="neutral" size="compact" onClick={onAddArtifact}>
                    Adicionar artefato
                  </Button>
                </div>
                {Object.keys(artifacts).length === 0 ? (
                  <p className="academy-empty-note">Nenhum artefato complementar.</p>
                ) : (
                  <div className="academy-artifact-list">
                    {Object.keys(artifacts).sort().map(path => (
                      <button
                        type="button"
                        key={path}
                        className="academy-artifact-chip"
                        onClick={() => onOpenArtifact(path)}
                      >
                        {path}
                      </button>
                    ))}
                  </div>
                )}
              </section>

              {selected && !isEditing && distribution.length > 0 && (
                <section className="academy-skill-delivery-list">
                  <h4>Destinos locais</h4>
                  {distribution.map(state => {
                    const text = describePackageDelivery(state)
                    return (
                      <div key={state.destinationId + state.target} className="academy-inline-delivery-row">
                        <span>{state.exposureName} ({describeTarget(state.target)})</span>
                        <span className={`academy-signal ${text.tone}`}>{text.label}</span>
                      </div>
                    )
                  })}
                </section>
              )}
            </div>
          )}

          {activeTab === 'history' && (
            <div className="academy-history-list">
              {history.map(version => (
                <div key={version.version} className="academy-history-item">
                  <div className="academy-history-header">
                    <strong>v{version.version}</strong>
                    <span>{version.origin} · {new Date(version.createdAt).toLocaleString()}</span>
                  </div>
                  <pre>{version.package.skillMd}</pre>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </main>
  )
}

interface AcademySettingsDrawerProps {
  hydration: 'LOADING' | 'READY' | 'ERROR'
  openAiPublication: AcademyOpenAiPublicationState | null
  openAiReleases: AcademyOpenAiRelease[]
  preference: AcademyPublicationPreference | null
  importConfirmationPreference?: AcademyImportConfirmationPreference | null
  packageDistribution: AcademyPackageDistributionState | null
  gitStatus: AcademyGitStatusProjection | null
  eligibleRepos: RepositoryRecord[]
  selectedRepoId: string
  destinations: AcademyDestination[]
  conflicts: AcademyConflictSummary[]
  distribution: AcademyDistributionHealth
  knownPublication?: AcademyPersistedPublication | null
  busy: boolean
  onSelectedRepoChange: (id: string) => void
  onRequestToggleAutoInclude: (nextEnabled: boolean) => void
  onSetImportConfirmationMode?: (mode: AcademyImportConfirmationMode) => void
  onBootstrapPlugin: () => void
  onConfirmUpload: (release: AcademyOpenAiRelease) => void
  onRebuildRelease: (release: AcademyOpenAiRelease) => void
  onPrepareManifestVersion: (kind: 'PATCH' | 'MINOR' | 'MAJOR') => void
  onBindRepository: () => void
  onSyncGit: () => void
  onPublishGit: () => void
  onPublishCandidate: () => void
  onLocalCutover: () => void
  onGitAutomation: (next: { autoPublish: boolean; autoUpdate: boolean }) => void
  onOpenGit: () => void
  onReviewGitConflict: (path: string) => void
  onReviewConflict: (id: string) => void
  onPreviewConflictBatch: () => void
  onOpenDestinations: () => void
  onReconcile: () => void
  onClose: () => void
}

export const AcademySettingsDrawer: React.FC<AcademySettingsDrawerProps> = ({
  hydration,
  openAiPublication,
  openAiReleases,
  preference,
  importConfirmationPreference,
  packageDistribution,
  gitStatus,
  eligibleRepos,
  selectedRepoId,
  destinations,
  conflicts,
  distribution,
  knownPublication,
  busy,
  onSelectedRepoChange,
  onRequestToggleAutoInclude,
  onSetImportConfirmationMode,
  onBootstrapPlugin,
  onConfirmUpload,
  onRebuildRelease,
  onPrepareManifestVersion,
  onBindRepository,
  onSyncGit,
  onPublishGit,
  onPublishCandidate,
  onLocalCutover,
  onGitAutomation,
  onOpenGit,
  onReviewGitConflict,
  onReviewConflict,
  onPreviewConflictBatch,
  onOpenDestinations,
  onReconcile,
  onClose
}) => {
  const git = gitPresentation(gitStatus, hydration)
  const release = resolveCurrentRelease(openAiPublication)
  const recentReleases = openAiReleases.slice(0, 5)
  const gitErrorDescription =
    gitStatus?.lastError === 'WORKSPACE_EXTERNAL_CHANGES_REVIEW_REQUIRED'
      ? 'Alterações externas detectadas no workspace privado do Git; nenhum arquivo externo foi sobrescrito.'
      : gitStatus?.lastError === 'WORKSPACE_UNCOMMITTED_RECOVERY_REQUIRED'
        ? 'O workspace privado tem arquivos pendentes de recuperação antes de prosseguir com o Git.'
        : gitStatus?.lastError

  return (
    <div className="academy-modal-backdrop" role="dialog" aria-modal="true" aria-label="Configurações da Academy">
      <div className="academy-settings-drawer">
        <div className="academy-drawer-header">
          <div>
            <h3>Configurações</h3>
            <p className="academy-modal-subcopy">Política do plugin, sincronização Git e destinos locais.</p>
          </div>
          <Button variant="ghost" intent="neutral" size="compact" onClick={onClose}>
            Fechar
          </Button>
        </div>

        <div className="academy-settings-sections">
          <section className="academy-settings-section" aria-label="Política e pacote OpenAI">
            <h4>Plugin ChatGPT e autorização</h4>
            <div className="academy-preference-card">
              <div className="academy-preference-copy">
                <strong>Incluir automaticamente novas Skills globais no plugin ChatGPT</strong>
                <p>
                  {preference?.autoIncludeGlobal
                    ? `Autorização ativa (revisão ${preference.revision}). Novas Skills globais criadas na UI ou via MCP ficam elegíveis automaticamente, salvo se marcadas como privadas.`
                    : 'Desativada. Novas Skills globais permanecem privadas até aprovação explícita. Skills PROJECT nunca são publicadas.'}
                </p>
              </div>
              {preference?.autoIncludeGlobal ? (
                <Button variant="outline" intent="neutral" size="compact" disabled={busy} onClick={() => onRequestToggleAutoInclude(false)}>
                  Revogar
                </Button>
              ) : (
                <Button variant="solid" intent="primary" size="compact" disabled={busy} onClick={() => onRequestToggleAutoInclude(true)}>
                  Ativar autorização
                </Button>
              )}
            </div>

            <div className="academy-settings-actions-row">
              {!openAiPublication?.profile && (
                <Button variant="outline" intent="neutral" size="compact" onClick={onBootstrapPlugin}>
                  Configurar manifesto OpenAI
                </Button>
              )}
              {release?.status === 'READY_TO_UPLOAD' && release.artifactHash && (
                <Button variant="outline" intent="neutral" size="compact" onClick={() => onConfirmUpload(release)}>
                  Confirmar envio manual (v{release.pluginVersion})
                </Button>
              )}
              {gitStatus?.repository && (
                <Button variant="ghost" intent="neutral" size="compact" onClick={() => onPrepareManifestVersion('PATCH')}>
                  Atualizar versão do manifesto (Git)
                </Button>
              )}
            </div>

            {packageDistribution && packageDistribution.hosted.status !== 'UNCONFIGURED' && (
              <p className="academy-settings-note">
                Distribuição de pacote hospedado: {packageDistribution.hosted.status}
                {packageDistribution.hosted.version ? ` (v${packageDistribution.hosted.version})` : ''}
              </p>
            )}

            {recentReleases.length > 0 && (
              <div className="academy-settings-releases">
                <strong>Releases locais recentes</strong>
                {recentReleases.map(item => {
                  const statusLabel = releasePresentation(item, false)
                  return (
                    <div key={item.id} className="academy-settings-release-row">
                      <span>v{item.pluginVersion} · {item.snapshot.length} Skills</span>
                      <div className="academy-settings-release-right">
                        <span className={`academy-signal ${statusLabel.tone}`}>{statusLabel.label}</span>
                        {item.source?.sourceCommitSha && (
                          <Button variant="ghost" intent="neutral" size="compact" onClick={() => onRebuildRelease(item)}>
                            Reconstruir commit
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <section className="academy-settings-section" aria-label="Sincronização Git">
            <div className="academy-settings-row-header">
              <h4>Sincronização Git (secundário)</h4>
              <span className={`academy-signal ${git.tone}`}>{git.label}</span>
            </div>
            {gitErrorDescription && (
              <div className="academy-settings-alert" data-ui-state="warning">
                {gitErrorDescription}
              </div>
            )}
            {gitStatus?.remoteCheck?.state === 'FAILED' && gitStatus.remoteCheck.error && (
              <div className="academy-settings-alert" data-ui-state="warning">
                Falha ao verificar GitHub: {gitStatus.remoteCheck.error}
              </div>
            )}
            {knownPublication && gitStatus?.syncState === 'UNKNOWN' && (
              <p className="academy-settings-note">
                Último estado conhecido: {gitStatus.lastKnown ? `${gitStatus.lastKnown.repositoryId} (${gitStatus.lastKnown.branch})` : knownPublication.publishedVersion ? `v${knownPublication.publishedVersion}` : 'local'}
              </p>
            )}
            <div className="academy-settings-git-bind">
              <label htmlFor="academy-settings-repo">Repositório</label>
              <div className="academy-settings-git-select-row">
                <select
                  id="academy-settings-repo"
                  value={selectedRepoId}
                  onChange={event => onSelectedRepoChange(event.target.value)}
                >
                  <option value="">Selecionar repositório GitHub</option>
                  {eligibleRepos.map(repo => (
                    <option key={repo.id} value={repo.id}>
                      {repo.github?.fullName ?? repo.name}
                    </option>
                  ))}
                </select>
                <Button variant="outline" intent="neutral" size="compact" disabled={!selectedRepoId} onClick={onBindRepository}>
                  Conectar
                </Button>
              </div>
            </div>

            {gitStatus?.repository && (
              <div className="academy-settings-actions-row">
                <Button variant="outline" intent="neutral" size="compact" onClick={onSyncGit}>
                  Sincronizar
                </Button>
                <Button variant="outline" intent="neutral" size="compact" onClick={onPublishGit}>
                  Publicar no Git
                </Button>
                <Button variant="ghost" intent="neutral" size="compact" onClick={onPublishCandidate}>
                  Publicar candidato PR
                </Button>
                <Button variant="ghost" intent="neutral" size="compact" onClick={onOpenGit}>
                  Abrir repositório
                </Button>
                {gitStatus.convergence?.cutover === 'PENDING' && (
                  <Button variant="solid" intent="primary" size="compact" onClick={onLocalCutover}>
                    Concluir cutover local
                  </Button>
                )}
              </div>
            )}

            {gitStatus?.publication && (
              <div className="academy-settings-automation">
                <label className="academy-check-row">
                  <input
                    type="checkbox"
                    checked={Boolean(gitStatus.publication.autoPublish)}
                    onChange={event =>
                      onGitAutomation({
                        autoPublish: event.target.checked,
                        autoUpdate: Boolean(gitStatus.publication?.autoUpdate)
                      })
                    }
                  />
                  <span>Publicar automaticamente alterações aprovadas no Git</span>
                </label>
                <label className="academy-check-row">
                  <input
                    type="checkbox"
                    checked={Boolean(gitStatus.publication.autoUpdate)}
                    onChange={event =>
                      onGitAutomation({
                        autoPublish: Boolean(gitStatus.publication?.autoPublish),
                        autoUpdate: event.target.checked
                      })
                    }
                  />
                  <span>Atualizar automaticamente quando o remoto avançar</span>
                </label>
              </div>
            )}

            {gitStatus?.publication?.conflictPaths && gitStatus.publication.conflictPaths.length > 0 && (
              <div className="academy-settings-conflicts">
                <strong>Conflitos de merge Git</strong>
                {gitStatus.publication.conflictPaths.map(path => (
                  <div key={path} className="academy-inline-delivery-row">
                    <span>{path}</span>
                    <Button variant="outline" intent="neutral" size="compact" onClick={() => onReviewGitConflict(path)}>
                      Revisar
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <AcademyConflicts
              conflicts={conflicts}
              destinations={destinations}
              onReview={onReviewConflict}
              onPreviewBatch={onPreviewConflictBatch}
            />
          </section>

          <section className="academy-settings-section" aria-label="Destinos locais">
            <div className="academy-settings-row-header">
              <h4>Destinos locais</h4>
              <span>{destinations.length} cadastrados</span>
            </div>
            {distribution.targets.length > 0 && (
              <div className="academy-settings-targets">
                {distribution.targets.map(target => {
                  const summary = describeReconciliation(target)
                  return (
                    <div key={target.target} className="academy-inline-delivery-row">
                      <span>{describeTarget(target.target)}</span>
                      <span className={`academy-signal ${summary.tone}`}>{summary.label}</span>
                    </div>
                  )
                })}
              </div>
            )}
            <div className="academy-settings-actions-row">
              <Button variant="outline" intent="neutral" size="compact" onClick={onOpenDestinations}>
                Gerenciar destinos e importar
              </Button>
              <Button variant="ghost" intent="neutral" size="compact" onClick={onReconcile}>
                Reconciliar destinos
              </Button>
            </div>
          </section>

          <section className="academy-settings-section" aria-label="Downloads">
            <div className="academy-settings-row-header">
              <h4>Downloads</h4>
            </div>
            <div className="academy-preference-card">
              <div className="academy-preference-copy">
                <strong>Confirmação de importação (Gemini e Plugin ChatGPT)</strong>
                <p>
                  No modo Automático, a versão é marcada como presumidamente importada somente após download bem-sucedido do pacote, nunca pela geração ou abertura da pasta.
                </p>
              </div>
              <select
                aria-label="Confirmação de importação"
                value={importConfirmationPreference?.mode ?? 'MANUAL'}
                disabled={busy || !onSetImportConfirmationMode}
                onChange={(event) =>
                  onSetImportConfirmationMode?.(
                    event.target.value === 'AUTOMATIC' ? 'AUTOMATIC' : 'MANUAL'
                  )
                }
              >
                <option value="MANUAL">Manual</option>
                <option value="AUTOMATIC">Automática</option>
              </select>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

interface ArtifactEditorProps {
  mode: 'create' | 'edit'
  path: string
  content: string
  onPathChange: (value: string) => void
  onContentChange: (value: string) => void
  onSave: () => void
  onRequestRemove: () => void
  onClose: () => void
}

export const ArtifactEditor: React.FC<ArtifactEditorProps> = ({
  mode,
  path,
  content,
  onPathChange,
  onContentChange,
  onSave,
  onRequestRemove,
  onClose
}) => (
  <div className="academy-modal-backdrop" role="dialog" aria-modal="true" aria-label="Artefato">
    <div className="academy-modal">
      <div className="academy-drawer-header">
        <h3>{mode === 'create' ? 'Novo artefato' : path}</h3>
        <button type="button" className="academy-drawer-close" onClick={onClose}>
          Fechar
        </button>
      </div>
      <label className="academy-field">
        <span>Caminho relativo</span>
        <input
          value={path}
          onChange={event => onPathChange(event.target.value)}
          placeholder="references/guide.md"
        />
      </label>
      <label className="academy-field">
        <span>Conteúdo</span>
        <textarea value={content} onChange={event => onContentChange(event.target.value)} rows={12} />
      </label>
      <div className="academy-modal-actions">
        {mode === 'edit' && (
          <Button variant="outline" intent="danger" size="compact" onClick={onRequestRemove}>
            Remover
          </Button>
        )}
        <Button variant="solid" intent="primary" size="compact" onClick={onSave}>
          Aplicar no rascunho
        </Button>
      </div>
    </div>
  </div>
)

interface DestinationManagerProps {
  destinations: AcademyDestination[]
  onToggle: (id: string, enabled: boolean) => void
  onImport: (id: string) => void
  onClose: () => void
}

export const DestinationManager: React.FC<DestinationManagerProps> = ({
  destinations,
  onToggle,
  onImport,
  onClose
}) => (
  <div className="academy-modal-backdrop" role="dialog" aria-modal="true" aria-label="Destinos Academy">
    <div className="academy-modal">
      <div className="academy-drawer-header">
        <h3>Destinos registrados</h3>
        <button type="button" className="academy-drawer-close" onClick={onClose}>
          Fechar
        </button>
      </div>
      <div className="academy-destination-list">
        {destinations.length === 0 ? (
          <p className="academy-empty-note">Nenhum destino registrado.</p>
        ) : (
          destinations.map(destination => (
            <div key={destination.id} className="academy-destination-row">
              <div>
                <strong>{destination.name}</strong>
                <span>{destination.path}</span>
              </div>
              <div className="academy-destination-actions">
                <Button variant="outline" intent="neutral" size="compact" onClick={() => onImport(destination.id)}>
                  Importar .skills
                </Button>
                <Button
                  variant="outline"
                  intent="neutral"
                  size="compact"
                  onClick={() => onToggle(destination.id, !destination.enabled)}
                >
                  {destination.enabled ? 'Desabilitar' : 'Habilitar'}
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  </div>
)

interface ConfirmationDialogProps {
  title: string
  description: string
  confirmLabel: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export const ConfirmationDialog: React.FC<ConfirmationDialogProps> = ({
  title,
  description,
  confirmLabel,
  destructive,
  onConfirm,
  onCancel
}) => (
  <div className="academy-modal-backdrop" role={destructive ? 'alertdialog' : 'dialog'} aria-modal="true" aria-label={title}>
    <div className="academy-modal academy-confirm-modal">
      <h3>{title}</h3>
      <p>{description}</p>
      <div className="academy-modal-actions">
        <Button variant="outline" intent="neutral" size="compact" onClick={onCancel}>
          Cancelar
        </Button>
        {destructive ? (
          <Button variant="solid" intent="danger" size="compact" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        ) : (
          <Button variant="solid" intent="primary" size="compact" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        )}
      </div>
    </div>
  </div>
)
