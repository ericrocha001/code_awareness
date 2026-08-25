/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Gerenciar o CRUD de campanhas por repositório.
2. Gerar slug automaticamente a partir do nome.
3. Validar unicidade de slug por repositório.
4. Gerar id único (timestamp + sufixo aleatório, mesmo padrão dos checkpoints).

Mapa de Relacionamentos do Script

1. database-ports.ts
   - Tipo: Contrato / Interface
   - Relação: Consome CampaignPort via injeção de dependência para operações de persistência.
   - Criticidade: Alta

2. ../../shared/types
   - Tipo: Contrato / Interface
   - Relação: Fornece os tipos Campaign e CampaignStatus.
   - Criticidade: Alta

Invariantes do Script

1. O slug é sempre derivado do nome — nunca fornecido pelo usuário.
2. O slug é regenerado quando o nome muda.
3. A unicidade do slug é validada por repositório antes de inserir ou atualizar o nome.
4. O id é único — usa timestamp + sufixo aleatório.
5. O serviço não depende de nenhum outro serviço de feature (checkpoint, diff, compression).
6. Nenhuma dependência direta de banco de dados ou SQLite — persiste exclusivamente via CampaignPort.
7. Nenhuma lógica de UI — o serviço é puro backend.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import type { CampaignPort } from './database-ports'
import { Campaign, CampaignStatus } from '../../shared/types'

export class CampaignService {
  private readonly campaignPort: CampaignPort

  constructor(campaignPort: CampaignPort) {
    this.campaignPort = campaignPort
  }

  /**
   * Cria uma nova campanha.
   * Valida nome, gera slug e id, verifica unicidade de slug, persiste no banco.
   */
  createCampaign(repoPath: string, data: { name: string; description?: string }): Campaign {
    const name = data.name.trim()
    if (!name) {
      throw new Error('O nome da campanha não pode estar vazio')
    }

    const id = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`
    const slug = this.slugify(name)
    const now = new Date().toISOString()

    // Valida unicidade do slug
    const existing = this.campaignPort.getCampaignBySlug(repoPath, slug)
    if (existing) {
      throw new Error(`Já existe uma campanha com o slug "${slug}" (derivado do nome "${name}")`)
    }

    const campaign: Campaign = {
      id,
      slug,
      name,
      description: data.description ?? '',
      status: 'active',
      createdAt: now,
      updatedAt: now
    }

    this.campaignPort.insertCampaign(repoPath, campaign)
    return campaign
  }

  /**
   * Lista todas as campanhas de um repositório.
   */
  listCampaigns(repoPath: string): Campaign[] {
    return this.campaignPort.getCampaigns(repoPath)
  }

  /**
   * Busca uma campanha por ID.
   */
  getCampaign(repoPath: string, campaignId: string): Campaign | null {
    return this.campaignPort.getCampaign(repoPath, campaignId)
  }

  /**
   * Atualiza uma campanha existente.
   * Se o nome mudar, regenera o slug e valida unicidade do novo slug.
   */
  updateCampaign(repoPath: string, campaignId: string, patch: { name?: string; description?: string; status?: CampaignStatus }): Campaign {
    const existing = this.campaignPort.getCampaign(repoPath, campaignId)
    if (!existing) {
      throw new Error(`Campanha não encontrada: ${campaignId}`)
    }

    const updatePatch: Partial<Omit<Campaign, 'id'>> = {}

    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (!name) {
        throw new Error('O nome da campanha não pode estar vazio')
      }
      updatePatch.name = name

      // Regenera o slug a partir do novo nome
      const newSlug = this.slugify(name)
      updatePatch.slug = newSlug

      // Valida unicidade do novo slug, excluindo a própria campanha
      if (newSlug !== existing.slug) {
        const slugExists = this.campaignPort.getCampaignBySlug(repoPath, newSlug)
        if (slugExists && slugExists.id !== campaignId) {
          throw new Error(`Já existe uma campanha com o slug "${newSlug}" (derivado do nome "${name}")`)
        }
      }
    }

    if (patch.description !== undefined) {
      updatePatch.description = patch.description
    }

    if (patch.status !== undefined) {
      updatePatch.status = patch.status
    }

    updatePatch.updatedAt = new Date().toISOString()

    this.campaignPort.updateCampaign(repoPath, campaignId, updatePatch)

    // Retorna a campanha atualizada
    const updated = this.campaignPort.getCampaign(repoPath, campaignId)
    if (!updated) {
      throw new Error(`Erro ao recuperar campanha atualizada: ${campaignId}`)
    }
    return updated
  }

  /**
   * Converte um nome para slug.
   * Minúsculas, sem acentos, espaços viram hífen, apenas alfanumérico e hífen.
   */
  private slugify(name: string): string {
    let slug = name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')  // Remove diacríticos (acentos)
      .replace(/[\s_]+/g, '-')           // Espaços e underscores viram hífen
      .replace(/[^a-z0-9-]/g, '')        // Remove caracteres não alfanuméricos nem hífen
      .replace(/-+/g, '-')               // Colapsa hífens consecutivos
      .replace(/^-+|-+$/g, '')           // Remove hífens no início e no final

    if (!slug) {
      slug = 'campanha'
    }

    return slug
  }
}