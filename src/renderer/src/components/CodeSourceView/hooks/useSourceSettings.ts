/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Gerenciar o carregamento (hidratação) assíncrono de sourceSettings a partir de AppSettings ao abrir o modal.
2. Controlar a persistência automática com debounce de 500ms ao alterar formato ou perfil.
3. Garantir o flush imediato de alterações no fechamento do modal e evitar salvamentos indesejados durante a hidratação inicial.

Mapa de Relacionamentos do Script

1. shared/utils/source-profile.ts
   - Tipo: Dependência Direta
   - Relação: Fornece DEFAULT_SOURCE_PROFILE e normalizeSourceProfile para inicialização e validação.
   - Criticidade: Alta

2. shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Fornece SourceOutputFormat e SourceProfile.
   - Criticidade: Alta

3. window.codeAwareness.loadSettings / saveSettings
   - Tipo: Dependência Inversa
   - Relação: Carrega e persiste as configurações globais do aplicativo.
   - Criticidade: Alta

Invariantes do Script

1. A hidratação inicial nunca dispara gravação em disco (proteção via skipSaveRef).
2. A transição de aberto para fechado (isOpen: true -> false) executa flush imediato das configurações atuais.
3. A persistência preserva integralmente as demais propriedades de AppSettings, atualizando apenas sourceSettings.
4. Timers pendentes de debounce são sempre cancelados no cleanup do hook.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SourceOutputFormat, SourceProfile } from '../../../../../shared/types'
import { DEFAULT_SOURCE_PROFILE, normalizeSourceProfile } from '../../../../../shared/utils/source-profile'

const SAVE_DEBOUNCE_MS = 500

export interface UseSourceSettingsParams {
  isOpen: boolean
}

export interface UseSourceSettingsResult {
  ready: boolean
  outputFormat: SourceOutputFormat
  setOutputFormat: (format: SourceOutputFormat) => void
  profile: SourceProfile
  setProfile: (profile: SourceProfile) => void
}

/**
 * Hook que gerencia a hidratação, persistência debounced e flush
 * de configurações do Code Source.
 */
export function useSourceSettings({ isOpen }: UseSourceSettingsParams): UseSourceSettingsResult {
  const [ready, setReady] = useState(false)
  const [outputFormat, setOutputFormat] = useState<SourceOutputFormat>('markdown')
  const [profile, setProfile] = useState<SourceProfile>(DEFAULT_SOURCE_PROFILE)

  const skipSaveRef = useRef(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settingsRef = useRef({ outputFormat, profile })
  const prevIsOpenRef = useRef(isOpen)

  // Mantém a referência síncrona atualizada para os timers e flush
  useEffect(() => {
    settingsRef.current = { outputFormat, profile }
  }, [outputFormat, profile])

  /**
   * Persiste as configurações atuais do Code Source preservando o restante de AppSettings.
   */
  const persistConfig = useCallback(() => {
    const { outputFormat: of, profile: p } = settingsRef.current
    window.codeAwareness
      ?.loadSettings?.()
      .then((settings) => {
        if (!settings) return
        window.codeAwareness?.saveSettings?.({
          ...settings,
          sourceSettings: { profile: p, outputFormat: of }
        })
      })
      .catch(() => {
        /* falha silenciosa de persistência */
      })
  }, [])

  // ─── Hidratação ao abrir + Flush ao fechar ───────────────────────────────
  useEffect(() => {
    if (!isOpen) {
      if (prevIsOpenRef.current) {
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current)
          saveTimerRef.current = null
        }
        persistConfig()
      }
      prevIsOpenRef.current = false
      setReady(false)
      return
    }

    prevIsOpenRef.current = true
    let cancelled = false
    skipSaveRef.current = true

    ;(async () => {
      try {
        const settings = await window.codeAwareness.loadSettings()
        if (cancelled) return
        const ss = settings?.sourceSettings
        setOutputFormat(ss?.outputFormat === 'xml' ? 'xml' : 'markdown')
        setProfile(ss?.profile ? normalizeSourceProfile(ss.profile) : DEFAULT_SOURCE_PROFILE)
      } catch {
        if (cancelled) return
        setOutputFormat('markdown')
        setProfile(DEFAULT_SOURCE_PROFILE)
      } finally {
        if (!cancelled) setReady(true)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [isOpen, persistConfig])

  // ─── Persistência automática (debounced) ─────────────────────────────────
  useEffect(() => {
    if (!isOpen || !ready) return

    if (skipSaveRef.current) {
      skipSaveRef.current = false
      return
    }

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      persistConfig()
    }, SAVE_DEBOUNCE_MS)

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [isOpen, ready, outputFormat, profile, persistConfig])

  return {
    ready,
    outputFormat,
    setOutputFormat,
    profile,
    setProfile
  }
}
