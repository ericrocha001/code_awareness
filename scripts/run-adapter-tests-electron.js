/*
-T ---
*/

const assert = require('assert')
const { mkdtempSync, rmSync, existsSync } = require('fs')
const { join } = require('path')
const { tmpdir } = require('os')
const esbuild = require('esbuild')

// Compila o BetterSqlite3DatabaseAdapter de TypeScript para CommonJS em memória
function loadAdapterClass() {
  const adapterPath = join(__dirname, '../src/main/core/better-sqlite3-database-adapter.ts')
  const buildResult = esbuild.buildSync({
    entryPoints: [adapterPath],
    bundle: false,
    format: 'cjs',
    platform: 'node',
    write: false
  })
  const code = buildResult.outputFiles[0].text
  const moduleObj = { exports: {} }
  const wrapper = new Function('module', 'exports', 'require', '__dirname', '__filename', code)
  wrapper(moduleObj, moduleObj.exports, require, join(__dirname, '../src/main/core'), adapterPath)
  return moduleObj.exports.BetterSqlite3DatabaseAdapter
}

const BetterSqlite3DatabaseAdapter = loadAdapterClass()

console.log('=== [Code Awareness] Electron Adapter Persistence Test Suite ===')
console.log(`Runtime: Electron v${process.versions.electron || 'N/A'} (Node v${process.versions.node}, ABI ${process.versions.modules})\n`)

let passedCount = 0
let failedCount = 0

function runScenario(name, fn) {
  const tempDir = mkdtempSync(join(tmpdir(), 'electron_db_adapter_test_'))
  const adapter = new BetterSqlite3DatabaseAdapter()
  try {
    fn(tempDir, adapter)
    console.log(`  ✓ ${name} — PASS`)
    passedCount++
  } catch (error) {
    console.error(`  ✗ ${name} — FAIL`)
    console.error(error)
    failedCount++
  } finally {
    try {
      adapter.closeAll()
    } catch (_) {}
    try {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true })
      }
    } catch (_) {}
  }
}

// ─── Cenário 1 ──────────────────────────────────────────────────────────────
runScenario('Cenário 1 — Inicialização de diretório e schema sob demanda', (tempDir, adapter) => {
  const actions = adapter.getActions(tempDir)
  assert.deepStrictEqual(actions, [], 'A lista inicial de ações deve ser vazia')

  const dbFilePath = join(tempDir, 'code_awareness', 'code_checkpoints.db')
  assert.ok(existsSync(dbFilePath), 'O arquivo de banco SQLite deve ser criado em code_awareness/code_checkpoints.db')
})

// ─── Cenário 2 ──────────────────────────────────────────────────────────────
runScenario('Cenário 2 — ActionLogPort: inserção, ordenação temporal e filtros', (tempDir, adapter) => {
  const now = Date.now()
  adapter.insertAction({
    actionType: 'checkpoint_created',
    timestamp: now - 2000,
    checkpointId: 'cp_1',
    checkpointName: 'Primeiro',
    details: 'Criado com sucesso',
    repoPath: tempDir,
    operationId: 'op_1'
  })

  adapter.insertAction({
    actionType: 'checkpoint_restored',
    timestamp: now - 1000,
    checkpointId: 'cp_1',
    checkpointName: 'Primeiro',
    details: 'Restaurado',
    repoPath: tempDir,
    operationId: 'op_2'
  })

  const actions = adapter.getActions(tempDir)
  assert.strictEqual(actions.length, 2, 'Devem existir 2 ações')
  assert.strictEqual(actions[0].actionType, 'checkpoint_restored', 'Ação mais recente deve vir primeiro')
  assert.strictEqual(actions[1].actionType, 'checkpoint_created', 'Ação mais antiga deve vir depois')
  assert.strictEqual(actions[0].operationId, 'op_2', 'operationId deve ser preservado')

  // Limite
  const limited = adapter.getActions(tempDir, 1)
  assert.strictEqual(limited.length, 1, 'Limit deve restringir a contagem')
  assert.strictEqual(limited[0].actionType, 'checkpoint_restored')

  // Intervalo de data
  const range = adapter.getActionsByDateRange(tempDir, now - 1500, now)
  assert.strictEqual(range.length, 1, 'Intervalo de datas deve filtrar corretamente')
  assert.strictEqual(range[0].actionType, 'checkpoint_restored')
})

// ─── Cenário 3 ──────────────────────────────────────────────────────────────
runScenario('Cenário 3 — CheckpointCatalogPort: CRUD completo, links de campanha e arquivamento', (tempDir, adapter) => {
  const record = {
    id: 'cp_cat_1',
    name: 'Catálogo Teste',
    createdAt: '2026-08-18T20:00:00.000Z',
    instructions: 'Instruções',
    agentSummary: 'Resumo',
    restoredAt: null,
    fileCount: 5,
    hasContent: true
  }

  adapter.insertCheckpointCatalog(tempDir, record)

  const list = adapter.getCheckpointsCatalog(tempDir)
  assert.strictEqual(list.length, 1, 'Deve listar 1 checkpoint no catálogo')
  assert.strictEqual(list[0].id, 'cp_cat_1')
  assert.strictEqual(list[0].name, 'Catálogo Teste')
  assert.strictEqual(list[0].hasContent, true)

  const single = adapter.getCheckpointCatalog(tempDir, 'cp_cat_1')
  assert.ok(single !== null, 'Checkpoint deve ser encontrado por ID')
  assert.strictEqual(single.name, 'Catálogo Teste')

  // Update
  adapter.updateCheckpointCatalog(tempDir, 'cp_cat_1', {
    name: 'Catálogo Renomeado',
    restoredAt: '2026-08-18T21:00:00.000Z'
  })

  const updated = adapter.getCheckpointCatalog(tempDir, 'cp_cat_1')
  assert.strictEqual(updated.name, 'Catálogo Renomeado', 'Nome deve ser atualizado')
  assert.strictEqual(updated.restoredAt, '2026-08-18T21:00:00.000Z', 'restoredAt deve ser atualizado')

  // Links de campanha
  adapter.setCheckpointCampaignLinks(tempDir, 'cp_cat_1', ['camp_a', 'camp_b'])
  const campaignIds = adapter.getCheckpointCampaignIds(tempDir, 'cp_cat_1')
  assert.deepStrictEqual(campaignIds, ['camp_a', 'camp_b'], 'IDs de campanha vinculados devem ser retornados em ordem')

  const map = adapter.getCheckpointCampaignIdsMap(tempDir)
  assert.deepStrictEqual(map['cp_cat_1'], ['camp_a', 'camp_b'], 'Mapa de campanhas deve refletir o vínculo')

  const cpIdsForCampA = adapter.getCampaignCheckpointIds(tempDir, 'camp_a')
  assert.deepStrictEqual(cpIdsForCampA, ['cp_cat_1'], 'Busca de checkpoints por campanha deve retornar o ID')

  // Arquivamento
  const contentBefore = adapter.getContentCheckpoints(tempDir)
  assert.strictEqual(contentBefore.length, 1, 'Deve haver 1 checkpoint com conteúdo')
  adapter.archiveCheckpointCatalog(tempDir, 'cp_cat_1')
  const contentAfter = adapter.getContentCheckpoints(tempDir)
  assert.strictEqual(contentAfter.length, 0, 'Após arquivamento, não deve haver checkpoint com conteúdo')

  // Delete com cascade manual
  adapter.deleteCheckpointCatalog(tempDir, 'cp_cat_1')
  assert.strictEqual(adapter.getCheckpointCatalog(tempDir, 'cp_cat_1'), null, 'Checkpoint deve ser removido')
  assert.deepStrictEqual(adapter.getCheckpointCampaignIds(tempDir, 'cp_cat_1'), [], 'Vínculos de campanha devem ser removidos em cascade')
})

// ─── Cenário 4 ──────────────────────────────────────────────────────────────
runScenario('Cenário 4 — CampaignPort: CRUD de campanhas e busca por slug', (tempDir, adapter) => {
  const campaign = {
    id: 'camp_101',
    slug: 'campanha-e2e',
    name: 'Campanha E2E',
    description: 'Descrição de teste',
    status: 'active',
    createdAt: '2026-08-18T10:00:00.000Z',
    updatedAt: '2026-08-18T10:00:00.000Z'
  }

  adapter.insertCampaign(tempDir, campaign)

  const list = adapter.getCampaigns(tempDir)
  assert.strictEqual(list.length, 1, 'Deve listar 1 campanha')
  assert.strictEqual(list[0].id, 'camp_101')

  const byId = adapter.getCampaign(tempDir, 'camp_101')
  assert.ok(byId !== null, 'Campanha deve ser encontrada por ID')
  assert.strictEqual(byId.name, 'Campanha E2E')

  const bySlug = adapter.getCampaignBySlug(tempDir, 'campanha-e2e')
  assert.ok(bySlug !== null, 'Campanha deve ser encontrada por slug')
  assert.strictEqual(bySlug.id, 'camp_101')

  adapter.updateCampaign(tempDir, 'camp_101', {
    name: 'Campanha Atualizada',
    status: 'completed'
  })

  const updated = adapter.getCampaign(tempDir, 'camp_101')
  assert.strictEqual(updated.name, 'Campanha Atualizada')
  assert.strictEqual(updated.status, 'completed')
})

// ─── Cenário 5 ──────────────────────────────────────────────────────────────
runScenario('Cenário 5 — Ciclo de persistência: abrir → escrever → fechar → reabrir → validar', (tempDir, adapter) => {
  // 1. Escreve com primeira instância do adapter
  adapter.insertAction({
    actionType: 'checkpoint_created',
    timestamp: 123456789,
    repoPath: tempDir
  })

  adapter.insertCampaign(tempDir, {
    id: 'camp_persist',
    slug: 'camp-persist',
    name: 'Camp Persist',
    description: '',
    status: 'active',
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z'
  })

  // 2. Fecha todas as conexões
  adapter.closeAll()

  // 3. Cria novo adapter e reabre o mesmo diretório
  const newAdapter = new BetterSqlite3DatabaseAdapter()
  try {
    const actions = newAdapter.getActions(tempDir)
    assert.strictEqual(actions.length, 1, 'Ações devem persistir após reabertura')
    assert.strictEqual(actions[0].actionType, 'checkpoint_created')

    const campaigns = newAdapter.getCampaigns(tempDir)
    assert.strictEqual(campaigns.length, 1, 'Campanhas devem persistir após reabertura')
    assert.strictEqual(campaigns[0].id, 'camp_persist')
  } finally {
    newAdapter.closeAll()
  }
})

console.log(`\nResultado: ${passedCount} passed, ${failedCount} failed`)

if (failedCount > 0) {
  process.exit(1)
} else {
  process.exit(0)
}
