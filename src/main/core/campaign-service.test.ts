/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar o CampaignService isoladamente via Provas de Aceitação usando FakeCampaignPort em memória.
2. Provar a criação de campanhas, geração de slug, validação de unicidade e persistência.
3. Provar a listagem e busca por ID de campanhas.
4. Provar a atualização de metadados e renomeação com regeneração e validação de unicidade de slug.
5. Provar o isolamento por repositório: campanhas de repoPath distintos não se contaminam.

Mapa de Relacionamentos do Script

1. campaign-service.ts
   - Tipo: Dependência Direta
   - Relação: Instancia e valida o contrato público do CampaignService.
   - Criticidade: Alta

2. fake-ports.ts
   - Tipo: Dependência Direta
   - Relação: Injeta FakeCampaignPort no CampaignService para testes sem SQLite.
   - Criticidade: Alta

3. ../../shared/types
   - Tipo: Contrato / Interface
   - Relação: Fornece os tipos Campaign e CampaignStatus.
   - Criticidade: Média

Invariantes do Script

1. Nenhuma dependência direta de better-sqlite3 ou SQLite nativo — isolamento total.
2. Cada teste instancia seu próprio FakeCampaignPort para isolamento de estado.
3. Validação rigorosa de nomes vazios e unicidade de slugs.
4. Campanhas de repoPath distintos nunca se misturam — isolamento garantido pelo FakeCampaignPort.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, it, expect, beforeEach } from 'vitest'
import { CampaignService } from './campaign-service'
import { FakeCampaignPort } from './fake-ports'

describe('CampaignService — Testes de Domínio', () => {
  let fakeCampaignPort: FakeCampaignPort
  let service: CampaignService
  const repoPath = '/test/repo'

  beforeEach(() => {
    fakeCampaignPort = new FakeCampaignPort()
    service = new CampaignService(fakeCampaignPort)
  })

  it('Cenário A — Cria campanha com sucesso e gera slug derivado', () => {
    const campaign = service.createCampaign(repoPath, {
      name: 'Sprint 10: Persistência & ABI',
      description: 'Isolamento de persistência'
    })

    expect(campaign.id).toBeDefined()
    expect(campaign.name).toBe('Sprint 10: Persistência & ABI')
    expect(campaign.slug).toBe('sprint-10-persistencia-abi')
    expect(campaign.description).toBe('Isolamento de persistência')
    expect(campaign.status).toBe('active')
    expect(campaign.createdAt).toBeDefined()

    const list = service.listCampaigns(repoPath)
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(campaign.id)
  })

  it('Cenário B — Rejeita nome de campanha vazio', () => {
    expect(() => {
      service.createCampaign(repoPath, { name: '   ' })
    }).toThrow(/não pode estar vazio/)
  })

  it('Cenário C — Rejeita slug duplicado', () => {
    service.createCampaign(repoPath, { name: 'Minha Campanha' })
    expect(() => {
      service.createCampaign(repoPath, { name: 'Minha Campanha' })
    }).toThrow(/Já existe uma campanha com o slug/)
  })

  it('Cenário D — Busca campanha por ID', () => {
    const created = service.createCampaign(repoPath, { name: 'Buscar Por ID' })
    const found = service.getCampaign(repoPath, created.id)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(created.id)
    expect(found!.name).toBe('Buscar Por ID')

    const notFound = service.getCampaign(repoPath, 'id_inexistente')
    expect(notFound).toBeNull()
  })

  it('Cenário E — Atualiza nome regenerando slug e validando duplicata', () => {
    const c1 = service.createCampaign(repoPath, { name: 'Campanha Um' })
    const c2 = service.createCampaign(repoPath, { name: 'Campanha Dois' })

    // Atualiza nome de c1 para novo slug
    const updated = service.updateCampaign(repoPath, c1.id, { name: 'Campanha Um Modificada' })
    expect(updated.name).toBe('Campanha Um Modificada')
    expect(updated.slug).toBe('campanha-um-modificada')

    // Tentar atualizar c1 para o mesmo slug de c2 deve falhar
    expect(() => {
      service.updateCampaign(repoPath, c1.id, { name: 'Campanha Dois' })
    }).toThrow(/Já existe uma campanha com o slug/)

    // Atualizar apenas descrição ou status preserva o slug
    const updatedStatus = service.updateCampaign(repoPath, c2.id, { status: 'completed', description: 'desc' })
    expect(updatedStatus.status).toBe('completed')
    expect(updatedStatus.description).toBe('desc')
    expect(updatedStatus.slug).toBe('campanha-dois')
  })

  it('Cenário F — Isolamento por repositório', () => {
    const repoA = '/repo/a'
    const repoB = '/repo/b'

    const serviceA = new CampaignService(fakeCampaignPort)
    const serviceB = new CampaignService(fakeCampaignPort)

    // Cria campanhas em repositórios distintos, incluindo slug idêntico
    const cA = serviceA.createCampaign(repoA, { name: 'Campanha Compartilhada' })
    const cB = serviceB.createCampaign(repoB, { name: 'Campanha Compartilhada' })

    // Listagem de cada repositório retorna apenas suas próprias campanhas
    const listA = serviceA.listCampaigns(repoA)
    const listB = serviceB.listCampaigns(repoB)
    expect(listA).toHaveLength(1)
    expect(listB).toHaveLength(1)
    expect(listA[0].id).toBe(cA.id)
    expect(listB[0].id).toBe(cB.id)

    // getCampaignBySlug no repoA não encontra campanha do repoB
    const foundA = fakeCampaignPort.getCampaignBySlug(repoA, cB.slug)
    expect(foundA?.id).toBe(cA.id)

    // getCampaign do repoA não encontra ID do repoB
    const notFound = fakeCampaignPort.getCampaign(repoA, cB.id)
    expect(notFound).toBeNull()
  })
})

