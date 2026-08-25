/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Prover implementações em memória das portas de persistência para uso exclusivo em testes de domínio (Node/Vitest).

Mapa de Relacionamentos do Script

1. database-ports.ts
   - Tipo: Contrato / Interface
   - Relação: Implementa ActionLogPort, CheckpointCatalogPort e CampaignPort.
   - Criticidade: Alta

2. checkpoint-service.test.ts
   - Tipo: Dependência Inversa
   - Relação: Injeta FakeCheckpointCatalogPort no CheckpointService para testes sem SQLite.
   - Criticidade: Alta

3. restore-service.test.ts
   - Tipo: Dependência Inversa
   - Relação: Injeta FakeActionLogPort no RestoreService para testes sem SQLite.
   - Criticidade: Alta

Invariantes do Script

1. Nenhuma dependência de better-sqlite3 — este arquivo deve poder ser importado pelo runner Node/Vitest sem ABI nativo.
2. O estado em memória é por instância — cada teste deve criar sua própria instância para isolamento.
3. As implementações são fiéis ao contrato: filtram por repoPath onde aplicável, ordenam como o banco SQLite real.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import type { ActionLogPort, CheckpointCatalogPort, CampaignPort } from './database-ports'
import type { ActionLog, CheckpointCatalogRecord, Campaign } from '../../shared/types'

export class FakeActionLogPort implements ActionLogPort {
  readonly actions: ActionLog[] = []

  insertAction(action: Omit<ActionLog, 'id'>): void {
    this.actions.push({
      ...action,
      id: `fake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    })
  }

  getActions(repoPath: string, limit?: number): ActionLog[] {
    const filtered = this.actions
      .filter(a => a.repoPath === repoPath)
      .slice()
      .sort((a, b) => b.timestamp - a.timestamp)
    return limit !== undefined ? filtered.slice(0, limit) : filtered
  }

  getActionsByDateRange(repoPath: string, startDate: number, endDate: number): ActionLog[] {
    return this.actions
      .filter(a => a.repoPath === repoPath && a.timestamp >= startDate && a.timestamp <= endDate)
      .slice()
      .sort((a, b) => b.timestamp - a.timestamp)
  }
}

export class FakeCheckpointCatalogPort implements CheckpointCatalogPort {
  readonly catalog: CheckpointCatalogRecord[] = []
  // checkpoint_campaigns: { checkpointId, campaignId, position }[]
  private readonly links: Array<{ checkpointId: string; campaignId: string; position: number }> = []

  insertCheckpointCatalog(repoPath: string, record: Omit<CheckpointCatalogRecord, 'repoPath'>): void {
    const existing = this.catalog.findIndex(r => r.id === record.id && r.repoPath === repoPath)
    const full: CheckpointCatalogRecord = { ...record, repoPath }
    if (existing >= 0) {
      this.catalog[existing] = full
    } else {
      this.catalog.push(full)
    }
  }

  getCheckpointsCatalog(repoPath: string): CheckpointCatalogRecord[] {
    return this.catalog
      .filter(r => r.repoPath === repoPath)
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  getCheckpointCatalog(repoPath: string, checkpointId: string): CheckpointCatalogRecord | null {
    return this.catalog.find(r => r.id === checkpointId && r.repoPath === repoPath) ?? null
  }

  updateCheckpointCatalog(
    repoPath: string,
    checkpointId: string,
    patch: Partial<Omit<CheckpointCatalogRecord, 'id' | 'repoPath'>>
  ): void {
    const idx = this.catalog.findIndex(r => r.id === checkpointId && r.repoPath === repoPath)
    if (idx < 0) return
    this.catalog[idx] = { ...this.catalog[idx], ...patch }
  }

  deleteCheckpointCatalog(repoPath: string, checkpointId: string): void {
    const idx = this.catalog.findIndex(r => r.id === checkpointId && r.repoPath === repoPath)
    if (idx >= 0) this.catalog.splice(idx, 1)
    // cascade: remove links
    const toRemove = this.links.filter(l => l.checkpointId === checkpointId)
    for (const l of toRemove) {
      const li = this.links.indexOf(l)
      if (li >= 0) this.links.splice(li, 1)
    }
  }

  getContentCheckpoints(repoPath: string): CheckpointCatalogRecord[] {
    return this.catalog
      .filter(r => r.repoPath === repoPath && r.hasContent)
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  archiveCheckpointCatalog(repoPath: string, checkpointId: string): void {
    const idx = this.catalog.findIndex(r => r.id === checkpointId && r.repoPath === repoPath)
    if (idx >= 0) this.catalog[idx] = { ...this.catalog[idx], hasContent: false }
  }

  setCheckpointCampaignLinks(repoPath: string, checkpointId: string, campaignIds: string[]): void {
    // Remove existing links for this checkpoint
    let i = this.links.length
    while (i--) {
      if (this.links[i].checkpointId === checkpointId) this.links.splice(i, 1)
    }
    for (let pos = 0; pos < campaignIds.length; pos++) {
      this.links.push({ checkpointId, campaignId: campaignIds[pos], position: pos })
    }
  }

  getCheckpointCampaignIds(repoPath: string, checkpointId: string): string[] {
    return this.links
      .filter(l => l.checkpointId === checkpointId)
      .sort((a, b) => a.position - b.position || a.campaignId.localeCompare(b.campaignId))
      .map(l => l.campaignId)
  }

  getCheckpointCampaignIdsMap(repoPath: string): Record<string, string[]> {
    const map: Record<string, string[]> = {}
    const sorted = this.links
      .slice()
      .sort((a, b) => a.checkpointId.localeCompare(b.checkpointId) || a.position - b.position || a.campaignId.localeCompare(b.campaignId))
    for (const link of sorted) {
      if (!map[link.checkpointId]) map[link.checkpointId] = []
      map[link.checkpointId].push(link.campaignId)
    }
    return map
  }

  getCampaignCheckpointIds(repoPath: string, campaignId: string): string[] {
    return this.links.filter(l => l.campaignId === campaignId).map(l => l.checkpointId)
  }
}

export class FakeCampaignPort implements CampaignPort {
  // Armazena campanhas junto ao repoPath para permitir isolamento por repositório.
  private readonly store: Array<{ repoPath: string; campaign: Campaign }> = []

  // Exposição somente-leitura para inspeção nos testes.
  get campaigns(): Campaign[] {
    return this.store.map(e => e.campaign)
  }

  insertCampaign(repoPath: string, campaign: Campaign): void {
    const existing = this.store.findIndex(e => e.repoPath === repoPath && e.campaign.id === campaign.id)
    if (existing >= 0) {
      this.store[existing] = { repoPath, campaign }
    } else {
      this.store.push({ repoPath, campaign })
    }
  }

  getCampaigns(repoPath: string): Campaign[] {
    return this.store
      .filter(e => e.repoPath === repoPath)
      .map(e => e.campaign)
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  getCampaign(repoPath: string, campaignId: string): Campaign | null {
    return this.store.find(e => e.repoPath === repoPath && e.campaign.id === campaignId)?.campaign ?? null
  }

  getCampaignBySlug(repoPath: string, slug: string): Campaign | null {
    return this.store.find(e => e.repoPath === repoPath && e.campaign.slug === slug)?.campaign ?? null
  }

  updateCampaign(repoPath: string, campaignId: string, patch: Partial<Omit<Campaign, 'id'>>): void {
    const idx = this.store.findIndex(e => e.repoPath === repoPath && e.campaign.id === campaignId)
    if (idx < 0) return
    this.store[idx] = { repoPath, campaign: { ...this.store[idx].campaign, ...patch } }
  }
}

