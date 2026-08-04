/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Orquestrar o estado da aba Code Campaign (lista de campanhas, modal de criar/editar, loading).
2. Carregar campanhas via IPC ao montar ou trocar de projeto.
3. Gerenciar a abertura do modal de criar/editar com os dados da campanha selecionada.
4. Delegar a renderização para CampaignList e CampaignFormModal.
5. Orquestrar dois caminhos de contexto por campanha e para o geral — copiar (área de transferência) e exportar (Downloads) — ambos montados pelo mesmo builder puro.
6. Filtrar as campanhas por nome no topo da aba, com contagem ao vivo, repassando ao CampaignList a lista já filtrada mais o total real.
7. Orquestrar a ação de copiar o link da campanha, montando o cartão Markdown via buildCampaignLinkMarkdown e copiando para a área de transferência.
8. Abrir o painel de recursos da campanha resolvida por deep link (via prop resolvedCampaignId).

Mapa de Relacionamentos do Script

1. CampaignList.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza a listagem de campanhas.
   - Criticidade: Alta

2. CampaignFormModal.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza o modal de criar/editar.
   - Criticidade: Alta

3. window.codeAwareness.*
   - Tipo: Dependência Inversa
   - Relação: Invoca as APIs IPC de campaign e saveToDownloads.
   - Criticidade: Alta

4. ../../../../shared/types
   - Tipo: Contrato / Interface
   - Relação: Fornece os tipos Campaign e CampaignStatus.
   - Criticidade: Alta

5. CodeCampaignView.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos do container (prefixo ccv-).
   - Criticidade: Alta

Invariantes do Script

1. A lista de campanhas deve ser recarregada ao trocar de projeto.
2. O estado de loading deve ser exibido enquanto as campanhas são carregadas.
3. O modal de criar/editar deve ser fechado ao trocar de projeto.
4. Após criar ou editar uma campanha, a lista deve ser recarregada.
5. O orquestrador não renderiza elementos visuais próprios — apenas compõe CampaignList, CampaignFormModal e CampaignResourcePanel.
6. handleCopyContext copia para a área de transferência; handleExportContext salva um arquivo via saveToDownloads; os nomes nunca se cruzam.
7. A busca filtra apenas por nome, sem ligar para maiúsculas, sem disparar IPC e sem mutar os dados; o CampaignList recebe a lista já filtrada mais o total real para distinguir o vazio real do vazio por filtro.
8. handleCopyLink copia o cartão Markdown para a área de transferência (não salva arquivo); se activeProject for null ou a campanha não for encontrada, retorna sem fazer nada.
9. Se resolvedCampaignId for fornecido e a campanha não existir na lista, o painel não abre e um erro é exibido.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Campaign, CampaignStatus, CheckpointSummary } from '../../../../shared/types'
import { CampaignList } from './CampaignList'
import { CampaignFormModal } from './CampaignFormModal'
import { ViewToolbar } from '../shared/ViewToolbar/ViewToolbar'
import { ActionBar } from '../shared/ActionBar/ActionBar'
import { ActionMenu } from '../shared/ActionMenu/ActionMenu'
import { ActionMenuItem } from '../shared/ActionMenu/ActionMenuItem'
import { ActionMenuSeparator } from '../shared/ActionMenu/ActionMenuSeparator'
import { Copy, Download, FolderOpen } from 'lucide-react'
import { buildCampaignContextDocument, CampaignContextMode } from './campaignContextUtils'
import { buildCampaignLinkMarkdown } from '../../utils/campaign-reference'
import { CampaignResourcePanel } from './CampaignResourcePanel'
import './CodeCampaignView.css'

interface CodeCampaignViewProps {
  activeProject: { path: string; name: string } | null
  onSelectProject: (project: { path: string; name: string } | null) => void
  onStatusMessage: (message: string, isError?: boolean) => void
  resolvedCampaignId?: string | null
  onResolvedCampaignConsumed?: () => void
}

export const CodeCampaignView: React.FC<CodeCampaignViewProps> = ({ activeProject, onSelectProject, onStatusMessage, resolvedCampaignId, onResolvedCampaignConsumed }) => {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingCampaign, setEditingCampaign] = useState<Campaign | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [isResourcePanelOpen, setIsResourcePanelOpen] = useState(false)
  const [resolvedCampaign, setResolvedCampaign] = useState<Campaign | null>(null)

  // Lista filtrada por nome (ignora maiúsculas); termo só de espaços não filtra nada
  const filtrado = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return campaigns
    return campaigns.filter(c => c.name.toLowerCase().includes(q))
  }, [campaigns, searchQuery])

  // Resumo da contagem: "N campanhas" sem filtro, "X de N campanhas" com filtro
  const textoDeContagem = useMemo(() => {
    const n = campaigns.length
    if (n === 0) return '0 campanhas'
    const palavra = n === 1 ? 'campanha' : 'campanhas'
    if (!searchQuery.trim()) return `${n} ${palavra}`
    return `${filtrado.length} de ${n} ${palavra}`
  }, [campaigns, filtrado, searchQuery])

  const loadCampaigns = useCallback(async () => {
    if (!activeProject) return
    setIsLoading(true)
    try {
      const response = await window.codeAwareness.listCampaigns(activeProject.path)
      if (response.success && response.data) {
        setCampaigns(response.data)
      } else {
        onStatusMessage(response.error || 'Erro ao carregar campanhas', true)
      }
      
      const cpResponse = await window.codeAwareness.listCheckpoints(activeProject.path)
      if (cpResponse.success && cpResponse.data) {
        setCheckpoints(cpResponse.data)
      } else {
        setCheckpoints([])
      }
    } catch (error: any) {
      onStatusMessage('Erro ao carregar campanhas', true)
      console.error('[CodeCampaignView] Erro ao carregar campanhas:', error)
    } finally {
      setIsLoading(false)
    }
  }, [activeProject, onStatusMessage])

  // Carrega campanhas ao montar ou trocar de projeto
  useEffect(() => {
    setCampaigns([])
    setCheckpoints([])
    setIsModalOpen(false)
    setEditingCampaign(null)
    loadCampaigns()
  }, [loadCampaigns])

  // Abre o painel de recursos quando uma campanha é resolvida via deep link.
  // Após abrir, avisa o App para limpar o resolvedCampaignId — impede reabertura automática
  // quando a lista de campanhas recarregar ou o usuário trocar de projeto e voltar.
  useEffect(() => {
    if (!resolvedCampaignId) return
    const campaign = campaigns.find(c => c.id === resolvedCampaignId)
    if (!campaign) {
      onStatusMessage(`A campanha ${resolvedCampaignId} não existe`, true)
      onResolvedCampaignConsumed?.()
      return
    }
    setResolvedCampaign(campaign)
    setIsResourcePanelOpen(true)
    onResolvedCampaignConsumed?.()
  }, [resolvedCampaignId, campaigns, onStatusMessage, onResolvedCampaignConsumed])

  const handleCreate = () => {
    setEditingCampaign(null)
    setIsModalOpen(true)
  }

  const handleEdit = (campaign: Campaign) => {
    setEditingCampaign(campaign)
    setIsModalOpen(true)
  }

  const handleModalConfirm = async (data: { name: string; description: string; status: CampaignStatus }) => {
    if (!activeProject) return

    try {
      if (editingCampaign) {
        const response = await window.codeAwareness.updateCampaign(activeProject.path, editingCampaign.id, data)
        if (!response.success) {
          onStatusMessage(response.error || 'Erro ao editar campanha', true)
          return
        }
        onStatusMessage('Campanha editada com sucesso')
      } else {
        const response = await window.codeAwareness.createCampaign(activeProject.path, data)
        if (!response.success) {
          onStatusMessage(response.error || 'Erro ao criar campanha', true)
          return
        }
        onStatusMessage('Campanha criada com sucesso')
      }

      setIsModalOpen(false)
      setEditingCampaign(null)
      await loadCampaigns()
    } catch (error: any) {
      onStatusMessage('Erro ao salvar campanha', true)
      console.error('[CodeCampaignView] Erro ao salvar campanha:', error)
    }
  }

  const handleStatusChange = async (campaignId: string, status: CampaignStatus) => {
    if (!activeProject) return

    try {
      const response = await window.codeAwareness.updateCampaign(activeProject.path, campaignId, { status })
      if (!response.success) {
        onStatusMessage(response.error || 'Erro ao alterar status', true)
        return
      }
      onStatusMessage(status === 'completed' ? 'Campanha concluída' : 'Campanha reaberta')
      await loadCampaigns()
    } catch (error: any) {
      onStatusMessage('Erro ao alterar status', true)
      console.error('[CodeCampaignView] Erro ao alterar status:', error)
    }
  }

  // Copia o contexto (instruções/resultados) para a área de transferência
  const handleCopyContext = useCallback(async (campaignId: string | null, mode: CampaignContextMode) => {
    if (!activeProject) return
    try {
      const doc = buildCampaignContextDocument(campaigns, checkpoints, mode, campaignId, activeProject.name)
      await navigator.clipboard.writeText(doc)
      const label = mode === 'instructions' ? 'Instruções' : mode === 'results' ? 'Resultados' : 'Instruções + Resultados'
      onStatusMessage(`✓ Contexto (${label}) copiado!`)
    } catch {
      onStatusMessage('Erro ao copiar contexto', true)
    }
  }, [activeProject, campaigns, checkpoints, onStatusMessage])

  // Exporta o contexto (instruções/resultados) salvando um arquivo .md em Downloads
  const handleExportContext = useCallback(async (campaignId: string | null, mode: CampaignContextMode) => {
    if (!activeProject) return
    try {
      const doc = buildCampaignContextDocument(campaigns, checkpoints, mode, campaignId, activeProject.name)
      const sufixo = mode === 'instructions' ? 'instrucoes' : mode === 'results' ? 'resultados' : 'instrucoes-resultados'
      const label = mode === 'instructions' ? 'Instruções' : mode === 'results' ? 'Resultados' : 'Instruções + Resultados'

      let fileName: string
      if (campaignId) {
        const campaign = campaigns.find(c => c.id === campaignId)
        const base = campaign?.slug ?? activeProject.name.replace(/[^a-zA-Z0-9_-]/g, '_')
        fileName = `campanha-${base}-${sufixo}`
      } else {
        const safeName = activeProject.name.replace(/[^a-zA-Z0-9_-]/g, '_')
        fileName = `contexto-geral-${safeName}-${sufixo}`
      }

      const result = await window.codeAwareness.saveToDownloads(doc, fileName)
      if (result.success) {
        onStatusMessage(`✓ Contexto (${label}) exportado!`)
      } else {
        onStatusMessage(result.error || 'Erro ao exportar contexto', true)
      }
    } catch {
      onStatusMessage('Erro ao exportar contexto', true)
    }
  }, [activeProject, campaigns, checkpoints, onStatusMessage])

  // Copia o cartão Markdown com o link da campanha para a área de transferência
  const handleCopyLink = useCallback(async (campaignId: string) => {
    if (!activeProject) return
    const campaign = campaigns.find(c => c.id === campaignId)
    if (!campaign) return
    try {
      const markdown = buildCampaignLinkMarkdown(campaign.name, activeProject.path, campaign.id)
      await navigator.clipboard.writeText(markdown)
      onStatusMessage('✓ Link da campanha copiado!')
    } catch {
      onStatusMessage('Erro ao copiar link', true)
    }
  }, [activeProject, campaigns, onStatusMessage])

  const handleModalClose = () => {
    setIsModalOpen(false)
    setEditingCampaign(null)
  }

  if (!activeProject) {
    return (
      <div className="ccv-container">
        <div className="ccv-empty">
          <span>Selecione um projeto para gerenciar campanhas</span>
        </div>
      </div>
    )
  }

  return (
    <div className="ccv-container">
      <ViewToolbar
        searchValue={searchQuery}
        onSearchChange={setSearchQuery}
        searchPlaceholder="Buscar campanha..."
        summary={<span>{textoDeContagem}</span>}
      />
      <ActionBar
        right={
          <div className="ccv-bar-right">
            <ActionMenu
              icon={<FolderOpen size={15} strokeWidth={2} />}
              label="Contexto Geral"
            >
              <ActionMenuItem icon={<Copy size={17} strokeWidth={2} />} onClick={() => handleCopyContext(null, 'instructions')}>
                Copiar Instruções
              </ActionMenuItem>
              <ActionMenuItem icon={<Copy size={17} strokeWidth={2} />} onClick={() => handleCopyContext(null, 'results')}>
                Copiar Resultados
              </ActionMenuItem>
              <ActionMenuItem icon={<Copy size={17} strokeWidth={2} />} onClick={() => handleCopyContext(null, 'both')}>
                Copiar Instruções + Resultados
              </ActionMenuItem>
              <ActionMenuSeparator />
              <ActionMenuItem icon={<Download size={17} strokeWidth={2} />} onClick={() => handleExportContext(null, 'instructions')}>
                Exportar Instruções
              </ActionMenuItem>
              <ActionMenuItem icon={<Download size={17} strokeWidth={2} />} onClick={() => handleExportContext(null, 'results')}>
                Exportar Resultados
              </ActionMenuItem>
              <ActionMenuItem icon={<Download size={17} strokeWidth={2} />} onClick={() => handleExportContext(null, 'both')}>
                Exportar Instruções + Resultados
              </ActionMenuItem>
            </ActionMenu>
          </div>
        }
      />
      <CampaignList
        campaigns={filtrado}
        totalCampaigns={campaigns.length}
        searchQuery={searchQuery}
        onClearSearch={() => setSearchQuery('')}
        isLoading={isLoading}
        onCreate={handleCreate}
        onEdit={handleEdit}
        onStatusChange={handleStatusChange}
        onCopyContext={handleCopyContext}
        onExportContext={handleExportContext}
        onCopyLink={handleCopyLink}
      />
      <CampaignFormModal
        isOpen={isModalOpen}
        onClose={handleModalClose}
        onConfirm={handleModalConfirm}
        editingCampaign={editingCampaign}
      />
      {resolvedCampaign && (
        <CampaignResourcePanel
          isOpen={isResourcePanelOpen}
          onClose={() => setIsResourcePanelOpen(false)}
          campaign={resolvedCampaign}
          onCopyContext={handleCopyContext}
          onExportContext={handleExportContext}
        />
      )}
    </div>
  )
}
