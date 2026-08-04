/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Carregar implementações e campanhas via IPC ao montar ou trocar de projeto.
2. Manter o estado da lista de implementações, campanhas, loading, busca e filtro de período.
3. Filtrar a lista de implementações por busca textual e período.
4. Notificar o orquestrador sobre troca de projeto e carregamento inicial via callbacks.

Mapa de Relacionamentos do Script

1. CodeJourneyView.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome os estados e a lista filtrada fornecidos por este hook.
   - Criticidade: Alta

2. ../../../../../shared/types
   - Tipo: Contrato / Interface
   - Relação: Consome Campaign e CheckpointSummary.
   - Criticidade: Alta

3. window.codeAwareness.*
   - Tipo: Dependência Inversa
   - Relação: Invoca initializeDatabase, listCheckpoints e listCampaigns.
   - Criticidade: Alta

Invariantes do Script

1. A lista de campanhas nunca deve ser limpa quando não há projeto ativo (preservar comportamento).
2. A guarda de desmontagem (isMounted) deve impedir atualizações de estado após desmontar.
3. O callback onProjectChange deve ser chamado no início de todo carregamento, antes de qualquer branch.
4. O callback onCheckpointsLoaded deve ser chamado apenas quando a lista carregada é não vazia.
5. Os callbacks são armazenados em refs atualizadas a cada render para que o efeito sempre use as versões mais recentes sem precisar reiniciar.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { useEffect, useMemo, useRef, useState } from 'react'
import { Campaign, CheckpointSummary } from '../../../../../shared/types'

export type TimeFilter = 'all' | '7days' | '30days' | 'year'

interface UseJourneyLoaderParams {
  activeProject: { path: string; name: string } | null
  onProjectChange: () => void
  onCheckpointsLoaded: (checkpoints: CheckpointSummary[]) => void
}

export function useJourneyLoader({ activeProject, onProjectChange, onCheckpointsLoaded }: UseJourneyLoaderParams) {
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all')

  // ─── Refs dos callbacks ──────────────────────────────────────────────────
  // Armazena os callbacks em refs atualizadas a cada render para que o efeito
  // de carregamento sempre use as versões mais recentes sem reiniciar.
  const onProjectChangeRef = useRef(onProjectChange)
  const onCheckpointsLoadedRef = useRef(onCheckpointsLoaded)

  useEffect(() => {
    onProjectChangeRef.current = onProjectChange
    onCheckpointsLoadedRef.current = onCheckpointsLoaded
  })

  // ─── Filtro combinado: busca textual + período ────────────────────────────

  const filteredCheckpoints = useMemo(() => {
    const now = Date.now()
    const DAY_MS = 24 * 60 * 60 * 1000
    const currentYear = new Date().getFullYear()
    const currentYearStr = currentYear.toString()

    const enriched = checkpoints.map(cp => ({
      cp,
      timestamp: new Date(cp.createdAt).getTime(),
      year: cp.createdAt.startsWith(currentYearStr) ? currentYear : new Date(cp.createdAt).getFullYear()
    }))

    let filtered = enriched

    // Filtro por busca textual (nome do checkpoint)
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      filtered = filtered.filter(({ cp }) =>
        cp.name.toLowerCase().includes(query)
      )
    }

    // Filtro por período
    switch (timeFilter) {
      case '7days':
        filtered = filtered.filter(({ timestamp }) => now - timestamp <= 7 * DAY_MS)
        break
      case '30days':
        filtered = filtered.filter(({ timestamp }) => now - timestamp <= 30 * DAY_MS)
        break
      case 'year':
        filtered = filtered.filter(({ year }) => year === currentYear)
        break
    }

    return filtered.map(({ cp }) => cp)
  }, [checkpoints, searchQuery, timeFilter])

  // ─── Efeito: carregar checkpoints ao montar ou trocar de projeto ──────────

  useEffect(() => {
    let isMounted = true

    const load = async () => {
      // Notifica o orquestrador para resetar seleção, dados, preview e drawer
      onProjectChangeRef.current()

      if (!activeProject) {
        if (isMounted) {
          setCheckpoints([])
          // BUGFIX: A lista de campanhas NÃO é limpa neste caso (preservar comportamento).
        }
        return
      }

      setIsLoading(true)

      try {
        try {
          await window.codeAwareness.initializeDatabase(activeProject.path)
        } catch (e) {
          console.warn('[useJourneyLoader] Falha ao inicializar o banco:', e)
        }

        const result = await window.codeAwareness.listCheckpoints(activeProject.path)
        if (!isMounted) return

        if (result.success && result.data) {
          setCheckpoints(result.data)
          if (result.data.length > 0) {
            onCheckpointsLoadedRef.current(result.data)
          }
        }

        // Carrega as campanhas disponíveis (best-effort — falha mantém lista vazia)
        try {
          const campaignsResult = await window.codeAwareness.listCampaigns(activeProject.path)
          if (!isMounted) return
          if (campaignsResult.success && campaignsResult.data) {
            setCampaigns(campaignsResult.data)
          } else {
            setCampaigns([])
          }
        } catch {
          if (isMounted) setCampaigns([])
        }
      } catch {
        // erro silencioso — o usuário verá a lista vazia
      } finally {
        if (isMounted) setIsLoading(false)
      }
    }

    load()
    return () => { isMounted = false }
  }, [activeProject])

  return {
    checkpoints,
    campaigns,
    isLoading,
    searchQuery,
    setSearchQuery,
    timeFilter,
    setTimeFilter,
    filteredCheckpoints,
    setCheckpoints,
  }
}