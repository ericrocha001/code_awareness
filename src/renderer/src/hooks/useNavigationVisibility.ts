import { useEffect, useRef, useState } from 'react'
import { normalizeHiddenNavigationItems, visibleNavigationItems, type NavId } from '../config/navigation'
import { updateSettings } from '../utils/update-settings'

export function useNavigationVisibility() {
  const [hidden, setHidden] = useState<NavId[]>([])
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const persisted = useRef<NavId[]>([])
  const current = useRef<NavId[]>([])
  const revision = useRef(0)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    let active = true
    window.codeAwareness.loadSettings().then(settings => {
      if (!active) return
      persisted.current = current.current = normalizeHiddenNavigationItems(settings.hiddenNavigationItems)
      setHidden(current.current)
      setReady(true)
    }).catch(() => {
      if (active) setError('Não foi possível carregar as configurações. Feche e reabra o aplicativo para tentar novamente.')
    })
    return () => { active = false; mounted.current = false }
  }, [])

  const change = (apply: (ids: NavId[]) => NavId[]) => {
    if (!ready) return
    const request = ++revision.current
    current.current = apply(current.current)
    setHidden(current.current)
    setSaving(true)
    setError(null)
    updateSettings(settings => ({
      ...settings,
      hiddenNavigationItems: apply(normalizeHiddenNavigationItems(settings.hiddenNavigationItems))
    })).then(settings => {
      persisted.current = normalizeHiddenNavigationItems(settings.hiddenNavigationItems)
      if (mounted.current && request === revision.current) {
        current.current = persisted.current
        setHidden(current.current)
      }
    }).catch(() => {
      if (!mounted.current) return
      setError('Não foi possível salvar a visibilidade. A última configuração salva foi mantida.')
      if (request === revision.current) {
        current.current = persisted.current
        setHidden(current.current)
      }
    }).finally(() => {
      if (mounted.current && request === revision.current) setSaving(false)
    })
  }

  return {
    hidden, ready, saving, error, items: visibleNavigationItems(hidden),
    setVisible: (id: NavId, visible: boolean) => change(ids => normalizeHiddenNavigationItems(visible ? ids.filter(item => item !== id) : [...ids, id])),
    restoreDefaults: () => change(() => [])
  }
}
