import { useEffect, useRef, useState } from 'react'
import { Settings, X } from 'lucide-react'
import { NAV_ITEMS, type NavId } from '../../config/navigation'
import type { AntigravityUserHooksStatus, CodexUserHooksStatus } from '../../../../shared/types/codex-hooks-types'
import { ToggleSwitch } from '../ToggleSwitch/ToggleSwitch'
import { updateSettings } from '../../utils/update-settings'
import './SettingsModal.css'

interface SettingsModalProps {
  hidden: NavId[]
  ready: boolean
  saving: boolean
  error: string | null
  onSetVisible: (id: NavId, visible: boolean) => void
  onRestore: () => void
  onClose: () => void
}

export function SettingsModal({ hidden, ready, saving, error, onSetVisible, onRestore, onClose }: SettingsModalProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [automaticFetch, setAutomaticFetch] = useState<boolean | null>(null)
  const [gitSaving, setGitSaving] = useState(false)
  const [gitError, setGitError] = useState('')
  const [importConfirmationMode, setImportConfirmationMode] = useState<'MANUAL' | 'AUTOMATIC' | null>(null)
  const [downloadsSaving, setDownloadsSaving] = useState(false)
  const [downloadsError, setDownloadsError] = useState('')
  const [autoEnrollCodex, setAutoEnrollCodex] = useState<boolean | null>(null)
  const [cutoverLegacy, setCutoverLegacy] = useState(true)
  const [codexStatus, setCodexStatus] = useState<CodexUserHooksStatus | null>(null)
  const [codexSaving, setCodexSaving] = useState(false)
  const [codexError, setCodexError] = useState('')
  const [codexNotice, setCodexNotice] = useState('')
  const [autoEnrollAntigravity, setAutoEnrollAntigravity] = useState<boolean | null>(null)
  const [cutoverAntigravityLegacy, setCutoverAntigravityLegacy] = useState(true)
  const [antigravityStatus, setAntigravityStatus] = useState<AntigravityUserHooksStatus | null>(null)
  const [antigravitySaving, setAntigravitySaving] = useState(false)
  const [antigravityError, setAntigravityError] = useState('')
  const [antigravityNotice, setAntigravityNotice] = useState('')
  useEffect(() => {
    let current = true
    window.codeAwareness.loadSettings().then(settings => {
      if (!current) return
      setAutomaticFetch(settings.gitManagement?.automaticFetch !== false)
      setImportConfirmationMode(settings.downloads?.importConfirmationMode === 'AUTOMATIC' ? 'AUTOMATIC' : 'MANUAL')
      setAutoEnrollCodex(settings.codexCapture?.autoEnrollNewProjects === true)
      setAutoEnrollAntigravity(settings.antigravityCapture?.autoEnrollNewProjects === true)
    })
      .catch(() => { if (current) setGitError('Não foi possível ler a configuração Git.') })
    window.codeAwareness.codexUserHooks?.status().then(status => {
      if (!current) return
      setCodexStatus(status)
    }).catch(() => {
      if (current) setCodexError('Não foi possível ler o estado dos hooks do Codex no perfil.')
    })
    window.codeAwareness.antigravityUserHooks?.status().then(status => {
      if (!current) return
      setAntigravityStatus(status)
    }).catch(() => {
      if (current) setAntigravityError('Não foi possível ler o estado dos hooks do Antigravity no perfil.')
    })
    return () => { current = false }
  }, [])
  const changeAutomaticFetch = async (enabled: boolean) => {
    setGitSaving(true); setGitError('')
    try {
      await updateSettings(settings => ({ ...settings, gitManagement: { ...settings.gitManagement, automaticFetch: enabled } }))
      setAutomaticFetch(enabled)
    } catch { setGitError('Não foi possível salvar a configuração Git.') }
    finally { setGitSaving(false) }
  }
  const changeImportConfirmationMode = async (mode: 'MANUAL' | 'AUTOMATIC') => {
    setDownloadsSaving(true); setDownloadsError('')
    try {
      await updateSettings(settings => ({ ...settings, downloads: { ...settings.downloads, importConfirmationMode: mode } }))
      await window.codeAwareness.setAcademyImportConfirmationPreference?.(mode)
      setImportConfirmationMode(mode)
    } catch { setDownloadsError('Não foi possível salvar a configuração de Downloads.') }
    finally { setDownloadsSaving(false) }
  }
  const changeAutoEnrollCodex = async (enabled: boolean) => {
    setCodexSaving(true); setCodexError(''); setCodexNotice('')
    try {
      await updateSettings(settings => ({ ...settings, codexCapture: { ...settings.codexCapture, autoEnrollNewProjects: enabled } }))
      setAutoEnrollCodex(enabled)
      if (codexStatus?.profileEnabled && window.codeAwareness.codexUserHooks) {
        const res = await window.codeAwareness.codexUserHooks.install({ codexHome: codexStatus.codexHome, autoEnrollNewProjects: enabled })
        setCodexStatus(res.status)
      }
    } catch { setCodexError('Não foi possível salvar a preferência de inscrição automática do Codex.') }
    finally { setCodexSaving(false) }
  }
  const toggleProfileCodexHooks = async () => {
    if (!window.codeAwareness.codexUserHooks) return
    setCodexSaving(true); setCodexError(''); setCodexNotice('')
    try {
      const configured = codexStatus?.profileEnabled && codexStatus.installation.state === 'CONFIGURED'
      if (configured) {
        const res = await window.codeAwareness.codexUserHooks.disable(codexStatus?.codexHome)
        setCodexStatus(res.status)
        setCodexNotice('Hooks do Codex desativados no perfil do usuário.')
      } else {
        const preferredClient = codexStatus?.clients.find(client => client.qualified)?.path
        const res = await window.codeAwareness.codexUserHooks.install({
          codexHome: codexStatus?.codexHome,
          clientPath: preferredClient,
          autoEnrollNewProjects: autoEnrollCodex === true,
          enrollActiveRepositories: true,
          cutoverLegacy
        })
        setCodexStatus(res.status)
        setCodexNotice(res.trust === 'REVIEW_REQUIRED'
          ? 'Hooks instalados no perfil do usuário. Aprove a confiança nativamente no Codex na próxima execução.'
          : 'Hooks do Codex atualizados no perfil do usuário.')
      }
    } catch (err) {
      setCodexError(err instanceof Error ? `Falha ao atualizar hooks do Codex: ${err.message}` : 'Não foi possível atualizar hooks do Codex.')
    } finally {
      setCodexSaving(false)
    }
  }
  const changeAutoEnrollAntigravity = async (enabled: boolean) => {
    setAntigravitySaving(true); setAntigravityError(''); setAntigravityNotice('')
    try {
      await updateSettings(settings => ({ ...settings, antigravityCapture: { ...settings.antigravityCapture, autoEnrollNewProjects: enabled } }))
      setAutoEnrollAntigravity(enabled)
      if (antigravityStatus?.profileEnabled && window.codeAwareness.antigravityUserHooks) {
        const res = await window.codeAwareness.antigravityUserHooks.install({ configHome: antigravityStatus.configHome, autoEnrollNewProjects: enabled })
        setAntigravityStatus(res.status)
      }
    } catch { setAntigravityError('Não foi possível salvar a preferência de inscrição automática do Antigravity.') }
    finally { setAntigravitySaving(false) }
  }
  const toggleProfileAntigravityHooks = async () => {
    if (!window.codeAwareness.antigravityUserHooks) return
    setAntigravitySaving(true); setAntigravityError(''); setAntigravityNotice('')
    try {
      const configured = antigravityStatus?.profileEnabled && antigravityStatus.installation.state === 'CONFIGURED'
      if (configured) {
        const res = await window.codeAwareness.antigravityUserHooks.disable(antigravityStatus?.configHome)
        setAntigravityStatus(res.status)
        setAntigravityNotice('Hooks do Antigravity desativados no perfil do usuário.')
      } else {
        const preferredClient = antigravityStatus?.clients.find(client => client.qualified)?.path
        const res = await window.codeAwareness.antigravityUserHooks.install({
          configHome: antigravityStatus?.configHome,
          clientPath: preferredClient,
          autoEnrollNewProjects: autoEnrollAntigravity === true,
          enrollActiveRepositories: true,
          cutoverLegacy: cutoverAntigravityLegacy
        })
        setAntigravityStatus(res.status)
        setAntigravityNotice('Hooks do Antigravity instalados em ~/.gemini/config/hooks.json (confiança do cliente não suportada nativamente).')
      }
    } catch (err) {
      setAntigravityError(err instanceof Error ? `Falha ao atualizar hooks do Antigravity: ${err.message}` : 'Não foi possível atualizar hooks do Antigravity.')
    } finally {
      setAntigravitySaving(false)
    }
  }
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    return () => { dialog.current?.close(); previousFocus?.focus() }
  }, [])

  return <dialog ref={dialog} className="settings-modal" aria-labelledby="settings-title" aria-describedby="settings-description"
    onCancel={event => { event.preventDefault(); onClose() }}>
    <header className="settings-header">
      <span className="settings-icon" aria-hidden="true"><Settings size={25} /></span>
      <h2 id="settings-title">Configurações</h2>
      <button type="button" className="settings-close" aria-label="Fechar configurações" onClick={onClose} autoFocus><X size={20} /></button>
    </header>
    <div className="settings-body"><div className="settings-intro">
      <h3>Barra lateral</h3>
      <p id="settings-description">Escolha quais recursos aparecem na navegação. Suas escolhas valem para todos os projetos.</p>
    </div>
    <div className="settings-list" aria-label="Visibilidade dos recursos">
      {NAV_ITEMS.filter(item => item.id !== 'home').map(item => {
        const Icon = item.lucideIcon
        const visible = !hidden.includes(item.id)
        return <div className="settings-row" key={item.id}>
          <Icon size={18} aria-hidden="true" />
          <span className="settings-row-label">{item.label}</span>
          <span className="settings-row-state" aria-hidden="true">{visible ? 'Mostrar' : 'Ocultar'}</span>
          <ToggleSwitch aria-label={`Mostrar ${item.label}`} checked={visible} disabled={!ready} onChange={value => onSetVisible(item.id, value)} />
        </div>
      })}
    </div>
    <div className="settings-intro"><h3>Git Management</h3><p>Buscar objetos e referências quando uma mudança no upstream for confirmada. O checkout só avança por ação sua.</p></div>
    <div className="settings-list"><div className="settings-row">
      <span className="settings-row-label">Fetch automático condicionado ao remoto</span>
      <ToggleSwitch aria-label="Fetch automático condicionado ao remoto" checked={automaticFetch === true} disabled={automaticFetch === null || gitSaving} onChange={value => void changeAutomaticFetch(value)} />
    </div>{gitError && <p role="alert">{gitError}</p>}</div>
    <div className="settings-intro">
      <h3>Downloads</h3>
      <p>Aplicável ao Gemini e ao Plugin ChatGPT. No modo automático, a versão é marcada como presumidamente importada apenas após download bem-sucedido do pacote.</p>
    </div>
    <div className="settings-list">
      <div className="settings-row">
        <label className="settings-row-label" htmlFor="settings-import-confirmation-mode">Confirmação de importação</label>
        <select
          id="settings-import-confirmation-mode"
          aria-label="Confirmação de importação"
          className="settings-select"
          value={importConfirmationMode ?? 'MANUAL'}
          disabled={importConfirmationMode === null || downloadsSaving}
          onChange={event => void changeImportConfirmationMode(event.target.value === 'AUTOMATIC' ? 'AUTOMATIC' : 'MANUAL')}
        >
          <option value="MANUAL">Manual</option>
          <option value="AUTOMATIC">Automática</option>
        </select>
      </div>
      {downloadsError && <p role="alert">{downloadsError}</p>}
    </div>
    <div className="settings-intro">
      <h3>Captura Codex (Perfil do usuário)</h3>
      <p>Instala um conjunto único de hooks em $CODEX_HOME/hooks.json. A revisão de confiança ocorre nativamente no Codex, e a captura permanece autorizada por repositório.</p>
    </div>
    <div className="settings-list">
      <div className="settings-row">
        <span className="settings-row-label">Inscrever novos repositórios automaticamente</span>
        <ToggleSwitch aria-label="Inscrever novos repositórios automaticamente" checked={autoEnrollCodex === true} disabled={autoEnrollCodex === null || codexSaving} onChange={value => void changeAutoEnrollCodex(value)} />
      </div>
      {codexStatus && (
        <div className="settings-codex">
          <p>
            Estado: <strong>{codexStatus.installation.state}</strong> ({codexStatus.installation.installed}/{codexStatus.installation.total}) · {codexStatus.configPath}
          </p>
          <p>
            Repositórios inscritos: {codexStatus.enrolledRepositoryIds.length} · Clientes Codex qualificados: {codexStatus.clients.filter(client => client.qualified).length}
          </p>
          {!(codexStatus.profileEnabled && codexStatus.installation.state === 'CONFIGURED') && (
            <label>
              <input type="checkbox" checked={cutoverLegacy} onChange={event => setCutoverLegacy(event.target.checked)} disabled={codexSaving} />
              {' '}Limpar hooks antigos do Codex por repositório (cutover seguro)
            </label>
          )}
          <button type="button" onClick={() => void toggleProfileCodexHooks()} disabled={codexSaving}>
            {codexStatus.profileEnabled && codexStatus.installation.state === 'CONFIGURED'
              ? 'Desativar hooks no perfil'
              : codexStatus.installation.state === 'NOT_INSTALLED' ? 'Ativar no perfil do usuário' : 'Reparar hooks no perfil'}
          </button>
        </div>
      )}
      {codexNotice && <p role="status">{codexNotice}</p>}
      {codexError && <p role="alert">{codexError}</p>}
    </div>
    <div className="settings-intro">
      <h3>Captura Antigravity (Perfil do usuário)</h3>
      <p>Instala o grupo code-awareness-session-context em ~/.gemini/config/hooks.json. A revisão de confiança do cliente permanece não suportada (CLIENT_TRUST_UNSUPPORTED).</p>
    </div>
    <div className="settings-list">
      <div className="settings-row">
        <span className="settings-row-label">Inscrever novos repositórios automaticamente no Antigravity</span>
        <ToggleSwitch aria-label="Inscrever novos repositórios automaticamente no Antigravity" checked={autoEnrollAntigravity === true} disabled={autoEnrollAntigravity === null || antigravitySaving} onChange={value => void changeAutoEnrollAntigravity(value)} />
      </div>
      {antigravityStatus && (
        <div className="settings-codex">
          <p>
            Estado: <strong>{antigravityStatus.installation.state}</strong> ({antigravityStatus.installation.installed}/{antigravityStatus.installation.expected ?? antigravityStatus.installation.total ?? 6}) · {antigravityStatus.configPath}
          </p>
          <p>
            Repositórios inscritos: {antigravityStatus.enrolledRepositoryIds.length} · Clientes Antigravity qualificados: {antigravityStatus.clients.filter(client => client.qualified).length} · Confiança: {antigravityStatus.trust}
          </p>
          {!(antigravityStatus.profileEnabled && antigravityStatus.installation.state === 'CONFIGURED') && (
            <label>
              <input type="checkbox" checked={cutoverAntigravityLegacy} onChange={event => setCutoverAntigravityLegacy(event.target.checked)} disabled={antigravitySaving} />
              {' '}Limpar hooks antigos do Antigravity por repositório (.agents/hooks.json)
            </label>
          )}
          <button type="button" onClick={() => void toggleProfileAntigravityHooks()} disabled={antigravitySaving}>
            {antigravityStatus.profileEnabled && antigravityStatus.installation.state === 'CONFIGURED'
              ? 'Desativar hooks Antigravity no perfil'
              : antigravityStatus.installation.state === 'NOT_INSTALLED' || antigravityStatus.installation.state === 'MISSING'
                ? 'Ativar Antigravity no perfil do usuário'
                : 'Reparar hooks Antigravity no perfil'}
          </button>
        </div>
      )}
      {antigravityNotice && <p role="status">{antigravityNotice}</p>}
      {antigravityError && <p role="alert">{antigravityError}</p>}
    </div>
    </div>
    <footer className="settings-footer">
      <p>Home e Configurações ficam sempre disponíveis.</p>
      {error && <p role="alert" className="settings-error">{error}</p>}
      <div className="settings-actions">
        <span role="status">{saving ? 'Salvando…' : !ready && !error ? 'Carregando…' : ''}</span>
        <button type="button" onClick={onRestore} disabled={!ready || hidden.length === 0}>Restaurar padrão</button>
      </div>
    </footer>
  </dialog>
}
