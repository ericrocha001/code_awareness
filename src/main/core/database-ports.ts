/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Definir os contratos de persistência segregados por domínio (ActionLogPort, CheckpointCatalogPort, CampaignPort).

Mapa de Relacionamentos do Script

1. better-sqlite3-database-adapter.ts
   - Tipo: Dependência Inversa
   - Relação: Implementa os três contratos definidos aqui.
   - Criticidade: Alta

2. checkpoint-service.ts
   - Tipo: Contrato / Interface
   - Relação: Consome CheckpointCatalogPort via injeção de dependência.
   - Criticidade: Alta

3. campaign-service.ts
   - Tipo: Contrato / Interface
   - Relação: Consome CampaignPort via injeção de dependência.
   - Criticidade: Alta

4. restore-service.ts
   - Tipo: Contrato / Interface
   - Relação: Consome ActionLogPort via injeção de dependência.
   - Criticidade: Alta

Invariantes do Script

1. Os contratos são segregados por responsabilidade de domínio — nenhuma porta deve expor operações fora do seu domínio.
2. Nenhuma implementação concreta (SQLite, Fake, etc.) é referenciada aqui.
3. As assinaturas dos métodos espelham exatamente as funções do database-service.ts original para compatibilidade de implementação.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import type { ActionLog, CheckpointCatalogRecord, Campaign } from '../../shared/types'

export interface ActionLogPort {
  insertAction(action: Omit<ActionLog, 'id'>): void
  getActions(repoPath: string, limit?: number): ActionLog[]
  getActionsByDateRange(repoPath: string, startDate: number, endDate: number): ActionLog[]
}

export interface CheckpointCatalogPort {
  insertCheckpointCatalog(repoPath: string, record: Omit<CheckpointCatalogRecord, 'repoPath'>): void
  getCheckpointsCatalog(repoPath: string): CheckpointCatalogRecord[]
  getCheckpointCatalog(repoPath: string, checkpointId: string): CheckpointCatalogRecord | null
  updateCheckpointCatalog(
    repoPath: string,
    checkpointId: string,
    patch: Partial<Omit<CheckpointCatalogRecord, 'id' | 'repoPath'>>
  ): void
  deleteCheckpointCatalog(repoPath: string, checkpointId: string): void
  getContentCheckpoints(repoPath: string): CheckpointCatalogRecord[]
  archiveCheckpointCatalog(repoPath: string, checkpointId: string): void
  setCheckpointCampaignLinks(repoPath: string, checkpointId: string, campaignIds: string[]): void
  getCheckpointCampaignIds(repoPath: string, checkpointId: string): string[]
  getCheckpointCampaignIdsMap(repoPath: string): Record<string, string[]>
  getCampaignCheckpointIds(repoPath: string, campaignId: string): string[]
}

export interface CampaignPort {
  insertCampaign(repoPath: string, campaign: Campaign): void
  getCampaigns(repoPath: string): Campaign[]
  getCampaign(repoPath: string, campaignId: string): Campaign | null
  getCampaignBySlug(repoPath: string, slug: string): Campaign | null
  updateCampaign(repoPath: string, campaignId: string, patch: Partial<Omit<Campaign, 'id'>>): void
}
