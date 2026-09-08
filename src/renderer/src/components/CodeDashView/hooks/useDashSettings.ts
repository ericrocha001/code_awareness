import { useEffect, useRef, useState } from 'react'
import type { AppSettings, DashSettings } from '../../../../../shared/types'
import { normalizeDashSettings } from '../../../../../shared/utils/dash-settings'

const DEBOUNCE_MS = 300

export interface UseDashSettingsReturn {
  settings: DashSettings
  updateSettings: (patch: Partial<DashSettings>) => void
}

export function useDashSettings(): UseDashSettingsReturn {
  const [settings, setSettings] = useState<DashSettings>(() =>
    normalizeDashSettings(undefined)
  )
  const isInitialMount = useRef(true)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Carrega as configurações persistidas no mount e normaliza com defaults seguros.
  useEffect(() => {
    window.codeAwareness
      .loadSettings()
      .then((appSettings) => {
        setSettings(normalizeDashSettings(appSettings?.dashSettings))
      })
      .catch((err) => {
        console.error('Falha ao carregar dashSettings:', err)
      })
  }, [])

  // Persistência automática com debounce no padrão load-modify-save.
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false
      return
    }

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    debounceTimerRef.current = setTimeout(async () => {
      try {
        const currentSettings = await window.codeAwareness.loadSettings()
        const updatedSettings: AppSettings = {
          ...currentSettings,
          dashSettings: settings
        }
        await window.codeAwareness.saveSettings(updatedSettings)
      } catch (err) {
        console.error('Falha ao persistir dashSettings:', err)
      }
    }, DEBOUNCE_MS)

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [settings])

  const updateSettings = (patch: Partial<DashSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }))
  }

  return { settings, updateSettings }
}