import { useEffect, useRef, useState } from 'react'
import { Settings, X } from 'lucide-react'
import { NAV_ITEMS, type NavId } from '../../config/navigation'
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
  useEffect(() => {
    let current = true
    window.codeAwareness.loadSettings().then(settings => { if (current) setAutomaticFetch(settings.gitManagement?.automaticFetch !== false) })
      .catch(() => { if (current) setGitError('Não foi possível ler a configuração Git.') })
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
    <div className="settings-intro">
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
