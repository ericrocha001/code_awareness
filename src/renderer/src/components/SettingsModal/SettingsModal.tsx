import { useEffect, useRef } from 'react'
import { Settings, X } from 'lucide-react'
import { NAV_ITEMS, type NavId } from '../../config/navigation'
import { ToggleSwitch } from '../ToggleSwitch/ToggleSwitch'
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
