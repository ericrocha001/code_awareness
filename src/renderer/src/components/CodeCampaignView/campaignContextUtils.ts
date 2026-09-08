/*
-T ---
*/

import { Campaign, CheckpointSummary } from '../../../../shared/types'

export type CampaignContextMode = 'instructions' | 'results' | 'both'

/**
 * Encaixota conteúdo textual numa cerca de código Markdown à prova de colisão.
 *
 * A cerca usa sempre uma crase a mais que o maior bloco de crases existente
 * no próprio conteúdo (mínimo 3), garantindo que o conteúdo nunca feche
 * a caixa antes da hora. Sem info string — só crases — para evitar qualquer
 * risco de quebra por caracteres extras.
 *
 * INVARIANT: O conteúdo é recebido já aparado pelo chamador; esta função
 * não altera nem aparar o conteúdo — apenas envolve-o.
 */
function wrapInFence(content: string): string {
  // Conta o maior bloco consecutivo de crases no conteúdo
  const tickMatches = content.match(/`+/g)
  // R1 (auditoria): reduce em vez de spread — evita RangeError em arrays enormes
  const maxTicks = tickMatches ? tickMatches.reduce((max, t) => Math.max(max, t.length), 0) : 0
  const fenceLength = Math.max(3, maxTicks + 1)
  const fence = '`'.repeat(fenceLength)

  return `${fence}\n${content}\n${fence}\n\n`
}

export function buildCampaignContextDocument(
  campaigns: Campaign[],
  checkpoints: CheckpointSummary[],
  mode: CampaignContextMode,
  campaignId?: string | null,
  projectName: string = 'Projeto'
): string {
  const isGeneral = campaignId === undefined || campaignId === null

  // BUGFIX: Comparador defensivo — new Date().getTime() retorna NaN para datas
  // inválidas, e ordenar com NaN tem comportamento indefinido. Trata NaN como 0,
  // espelhando a proteção existente no getRelativeDate do checkpointUtils.
  const compareByCreatedAt = (a: { createdAt: string }, b: { createdAt: string }): number => {
    const aTime = new Date(a.createdAt).getTime()
    const bTime = new Date(b.createdAt).getTime()
    return (Number.isNaN(aTime) ? 0 : aTime) - (Number.isNaN(bTime) ? 0 : bTime)
  }

  // Filtra e ordena as campanhas (mais antigo primeiro)
  const activeCampaigns = isGeneral 
    ? [...campaigns].sort(compareByCreatedAt)
    : campaigns.filter(c => c.id === campaignId)

  // Ordena todos os checkpoints recebidos do banco (mais antigo primeiro)
  const sortedCheckpoints = [...checkpoints].sort(compareByCreatedAt)

  let doc = ''

  if (isGeneral) {
    doc += `# Contexto Geral do Projeto: ${projectName}\n`
    doc += `Data de geração: ${new Date().toLocaleString('pt-BR')}\n\n`
  } else {
    const campaign = activeCampaigns[0]
    const campaignName = campaign ? campaign.name : 'Desconhecida'
    doc += `# Contexto da Campanha: ${campaignName}\n`
    doc += `Projeto: ${projectName}\n`
    doc += `Data de geração: ${new Date().toLocaleString('pt-BR')}\n\n`
  }

  // Agrupar checkpoints por campanha
  const checkpointsByCampaign = new Map<string | null, CheckpointSummary[]>()
  
  // No contexto geral, mapeia campanhas + sem campanha
  if (isGeneral) {
    activeCampaigns.forEach(c => checkpointsByCampaign.set(c.id, []))
    checkpointsByCampaign.set(null, [])
    
    sortedCheckpoints.forEach(cp => {
      // Fallback para dados antigos (sem campaignIds)
      const ids = cp.campaignIds ?? (cp.campaignId ? [cp.campaignId] : [])
      
      if (ids.length === 0) {
        // Sem vínculos → "Sem campanha"
        checkpointsByCampaign.get(null)!.push(cp)
        return
      }
      
      let hasOrphan = false
      for (const id of ids) {
        if (checkpointsByCampaign.has(id)) {
          checkpointsByCampaign.get(id)!.push(cp)
        } else {
          hasOrphan = true
        }
      }
      
      // Se houver órfãos, o checkpoint vai para "Sem campanha" uma vez
      if (hasOrphan) {
        checkpointsByCampaign.get(null)!.push(cp)
      }
    })
  } else {
    // Contexto específico
    checkpointsByCampaign.set(campaignId as string, sortedCheckpoints.filter(cp => {
      const ids = cp.campaignIds ?? (cp.campaignId ? [cp.campaignId] : [])
      return ids.includes(campaignId as string)
    }))
  }

  const renderCheckpoint = (cp: CheckpointSummary, baseHeading: string) => {
    const cpDate = new Date(cp.createdAt).toLocaleString('pt-BR')
    let output = `${baseHeading} Implementação: "${cp.name}" (${cpDate})\n\n`

    const instructionHeading = `${baseHeading}# Instruções`
    const resultHeading = `${baseHeading}# Resultados`

    const renderInstructions = () => {
      output += `${instructionHeading}\n`
      if (cp.instructions && cp.instructions.trim().length > 0) {
        output += wrapInFence(cp.instructions.trim())
      } else {
        output += `*(sem instruções registradas)*\n\n`
      }
    }

    const renderResults = () => {
      output += `${resultHeading}\n`
      if (cp.agentSummary && cp.agentSummary.trim().length > 0) {
        output += wrapInFence(cp.agentSummary.trim())
      } else {
        output += `*(sem resultado registrado)*\n\n`
      }
    }

    if (mode === 'instructions') {
      renderInstructions()
    } else if (mode === 'results') {
      renderResults()
    } else {
      renderInstructions()
      renderResults()
    }

    return output
  }

  if (isGeneral) {
    // Renderiza cada campanha (ordenada cronologicamente)
    activeCampaigns.forEach(campaign => {
      const cps = checkpointsByCampaign.get(campaign.id) || []
      if (cps.length === 0) return
      
      doc += `## Campanha: "${campaign.name}"\n\n`
      cps.forEach(cp => {
        doc += renderCheckpoint(cp, '###')
      })
    })

    // Renderiza "Sem campanha"
    const orphans = checkpointsByCampaign.get(null) || []
    if (orphans.length > 0) {
      doc += `## Sem campanha\n\n`
      orphans.forEach(cp => {
        doc += renderCheckpoint(cp, '###')
      })
    }
  } else {
    // Renderiza checkpoints da campanha específica (contexto de campanha)
    const cps = checkpointsByCampaign.get(campaignId as string) || []
    if (cps.length === 0) {
      doc += `*(nenhuma implementação encontrada para esta campanha)*\n\n`
    } else {
      cps.forEach(cp => {
        doc += renderCheckpoint(cp, '##')
      })
    }
  }

  return doc.trim() + '\n'
}