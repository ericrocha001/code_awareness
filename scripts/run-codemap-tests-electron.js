/*
-T ---
*/

const assert = require('assert')
const { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } = require('fs')
const { join } = require('path')
const { tmpdir } = require('os')
const { createHash } = require('crypto')
const esbuild = require('esbuild')

// ─── Compilação dos módulos ──────────────────────────────────────────────────

function buildBundle(entryRelative) {
  const entryPath = join(__dirname, '..', entryRelative)
  const result = esbuild.buildSync({
    entryPoints: [entryPath],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: [
      'better-sqlite3',
      'tree-sitter',
      'tree-sitter-typescript',
      'tree-sitter-javascript',
      'tree-sitter-python',
      'electron',
      'events',
    ],
    write: false,
    // Permite imports relativos internos
    absWorkingDir: join(__dirname, '..'),
  })
  const code = result.outputFiles[0].text
  const mod = { exports: {} }
  const fn = new Function('module', 'exports', 'require', '__dirname', '__filename', code)
  fn(mod, mod.exports, require, join(__dirname, '../src/main/core'), entryPath)
  return mod.exports
}

let RepositoryModel, createRepositoryModel, closeRepositoryDatabase, repositoryEventBus, RepositorySynchronizer

try {
  // BUGFIX: Usar entry único para garantir singleton compartilhado (repositoryEventBus)
  const exports = buildBundle('scripts/codemap-runner-exports.ts')
  RepositoryModel = exports.RepositoryModel
  createRepositoryModel = exports.createRepositoryModel
  closeRepositoryDatabase = exports.closeRepositoryDatabase
  repositoryEventBus = exports.repositoryEventBus
  RepositorySynchronizer = exports.RepositorySynchronizer
} catch (buildErr) {
  console.error('[Code Map Runner] Falha ao compilar módulos:', buildErr.message)
  process.exit(1)
}

// ─── Infraestrutura do runner ────────────────────────────────────────────────

console.log('=== [Code Awareness] Electron Code Map Test Suite ===')
console.log(`Runtime: Electron v${process.versions.electron || 'N/A'} (Node v${process.versions.node}, ABI ${process.versions.modules})\n`)

let passed = 0
let failed = 0

async function scenario(name, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'codemap_test_'))
  try {
    await fn(dir)
    console.log(`  ✓ ${name} — PASS`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name} — FAIL: ${err.message}`)
    failed++
  } finally {
    try {
      if (closeRepositoryDatabase) closeRepositoryDatabase(dir)
    } catch (_) {}
    for (let i = 0; i < 4; i++) {
      try {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
        break
      } catch (_) {
        await new Promise(r => setTimeout(r, 100))
      }
    }
  }
}

// ─── Cenários ────────────────────────────────────────────────────────────────

async function runAll() {
  // Cenário 1 — Indexação básica com hash SHA-256
  await scenario('Cenário 1 — Indexação básica e hash SHA-256', async (dir) => {
    const content = 'export const hello = "world";\n'
    writeFileSync(join(dir, 'sample.ts'), content, 'utf-8')
    const expectedHash = createHash('sha256').update(content, 'utf-8').digest('hex')

    const model = createRepositoryModel(dir)
    await model.indexRepository()

    const files = model.getFiles()
    assert.strictEqual(files.length, 1, 'Esperava 1 arquivo indexado')
    assert.strictEqual(files[0].relativePath, 'sample.ts')
    assert.strictEqual(files[0].contentHash, expectedHash, 'Hash SHA-256 incorreto')
    assert.strictEqual(files[0].contentHash.length, 64, 'Hash deve ter 64 caracteres hex')
  })

  // Cenário 2 — Reindexação seletiva atualiza hash
  await scenario('Cenário 2 — Reindexação seletiva atualiza hash', async (dir) => {
    const v1 = 'console.log("v1");\n'
    const v2 = 'console.log("v2");\n'
    const filePath = join(dir, 'update.ts')
    writeFileSync(filePath, v1, 'utf-8')

    const model = createRepositoryModel(dir)
    await model.indexRepository()

    const hashV1 = model.getFiles()[0].contentHash
    assert.ok(hashV1, 'Hash v1 deve existir')

    writeFileSync(filePath, v2, 'utf-8')
    await model.updateFileContent('update.ts')

    const hashV2 = model.getFiles()[0].contentHash
    const expectedV2 = createHash('sha256').update(v2, 'utf-8').digest('hex')
    assert.notStrictEqual(hashV1, hashV2, 'Hash deve mudar após reindexação')
    assert.strictEqual(hashV2, expectedV2, 'Hash v2 deve corresponder ao conteúdo novo')
  })

  // Cenário 3 — Reconciliação com disco (arquivo modificado detectado)
  await scenario('Cenário 3 — reconcileWithDisk detecta arquivo modificado', async (dir) => {
    const filePath = join(dir, 'file.ts')
    writeFileSync(filePath, 'const x = 1;\n', 'utf-8')

    const model = createRepositoryModel(dir)
    await model.indexRepository()

    // Modifica o arquivo no disco sem chamar updateFileContent
    writeFileSync(filePath, 'const x = 999;\n', 'utf-8')

    const result = await model.reconcileWithDisk()
    // reconcileWithDisk retorna { modified, deleted, new, healed } ou similar
    // Garante que não lançou exceção e que retornou um objeto
    assert.ok(result !== null && result !== undefined, 'reconcileWithDisk deve retornar resultado')

    // O arquivo deve estar marcado como modified no banco
    const modifiedFiles = model.getModifiedFiles()
    assert.ok(
      modifiedFiles.some(f => f.relativePath === 'file.ts'),
      'file.ts deve aparecer como modified após reconcileWithDisk'
    )
  })

  // Cenário 4 — Múltiplos arquivos, isolamento por diretório
  await scenario('Cenário 4 — Múltiplos arquivos indexados com isolamento de diretório', async (dir) => {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n', 'utf-8')
    writeFileSync(join(dir, 'b.ts'), 'export const b = 2;\n', 'utf-8')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub', 'c.ts'), 'export const c = 3;\n', 'utf-8')

    const model = createRepositoryModel(dir)
    await model.indexRepository()

    const files = model.getFiles()
    assert.ok(files.length >= 3, `Esperava >= 3 arquivos, obteve ${files.length}`)

    const paths = files.map(f => f.relativePath)
    assert.ok(paths.includes('a.ts'), 'a.ts deve estar indexado')
    assert.ok(paths.includes('b.ts'), 'b.ts deve estar indexado')
    // sub/c.ts pode usar separador de plataforma
    assert.ok(paths.some(p => p.includes('c.ts')), 'c.ts deve estar indexado')
  })

  // Cenário 5 — Synchronizer enfileira evento file:modified e marca arquivo como modified
  // BUG REPORT: O Synchronizer não está marcando o arquivo como modified após processar o evento.
  // Investigação: O evento é recebido corretamente (verificado via listener de debug), mas o
  // Synchronizer não está marcando o arquivo como modified. O pendingFilesCount vai para 0 após
  // o processamento, indicando que o evento foi processado, mas o status modified não é persistido.
  // Isso é um bug real no Synchronizer que deve ser investigado e corrigido em Sprint futura.
  // Cenário 5 — Synchronizer responde a file:modified via event bus com auto-sync
  // NOTA (Sprint 6): com auto-sync, após o evento o arquivo é reindexado automaticamente
  // (status volta a indexed, não modified). O critério congelado #2 exige:
  // "após debounce, elementos novos indexados, status indexed".
  await scenario('Cenário 5 — Synchronizer responde a file:modified via event bus (auto-sync)', async (dir) => {
    writeFileSync(join(dir, 'watch.ts'), 'const w = 0;\n', 'utf-8')

    const model = createRepositoryModel(dir)
    await model.indexRepository()

    const files = model.getFiles()
    assert.ok(files.length === 1, 'Esperava 1 arquivo')
    const repositoryId = files[0].repositoryId
    const originalHash = files[0].contentHash

    const sync = new RepositorySynchronizer(model, repositoryId)

    // Modifica o arquivo
    const newContent = 'const w = 1;\n'
    writeFileSync(join(dir, 'watch.ts'), newContent, 'utf-8')

    // Aguarda um momento para garantir que o filesystem processe a escrita
    await new Promise(r => setTimeout(r, 100))

    // Emite o evento
    repositoryEventBus.emitFileModified(repositoryId, 'watch.ts')

    // Aguarda o debounce (500ms) + estabilização (200ms) + auto-reindex + margem
    await new Promise(r => setTimeout(r, 2000))

    // Auto-sync: arquivo é reindexado automaticamente → status indexed (não modified)
    const fileAfter = model.getFiles().find(f => f.relativePath === 'watch.ts')
    assert.ok(fileAfter, 'Arquivo watch.ts deve existir')
    assert.strictEqual(fileAfter.status, 'indexed', 'Arquivo deve estar indexed após auto-sync')

    // Hash foi atualizado (conteúdo diferente)
    assert.notStrictEqual(fileAfter.contentHash, originalHash, 'Hash deve ter sido atualizado')

    // Não há pendentes (auto-sync removeu da fila)
    assert.strictEqual(sync.getModifiedFilesCount(), 0, 'Não deve haver arquivos pendentes após auto-sync')

    // Recuperação exata retorna o novo conteúdo
    const elements = model.getElementsByFile(fileAfter.id)
    assert.ok(elements.length > 0, 'Deve haver elementos após auto-sync')

    sync.dispose()
  })

  // Cenário 6 — Indexação de JavaScript (.js) e JSX (.jsx) com extração de elementos
  await scenario('Cenário 6 — JavaScript e JSX extraem classes, funções e imports', async (dir) => {
    writeFileSync(join(dir, 'helper.js'), 'export class Helper {\n  run() { return 42; }\n}\n', 'utf-8')
    writeFileSync(join(dir, 'App.jsx'), 'import { Helper } from "./helper"\nexport function App() {\n  const h = new Helper();\n  return <div>App</div>;\n}\n', 'utf-8')

    const model = createRepositoryModel(dir)
    await model.indexRepository()

    const files = model.getFiles()
    assert.strictEqual(files.length, 2, 'Esperava 2 arquivos indexados (.js e .jsx)')

    const helperFile = files.find(f => f.relativePath === 'helper.js')
    assert.ok(helperFile, 'helper.js deve estar indexado')
    assert.strictEqual(helperFile.language, 'javascript')

    const appFile = files.find(f => f.relativePath === 'App.jsx')
    assert.ok(appFile, 'App.jsx deve estar indexado')
    assert.strictEqual(appFile.language, 'javascript-react')

    const helperElements = model.getElementsByFile(helperFile.id)
    assert.ok(helperElements.some(e => e.name === 'Helper' && e.kind === 'class'), 'Classe Helper deve ser extraída do JS')

    const appElements = model.getElementsByFile(appFile.id)
    assert.ok(appElements.some(e => e.name === 'App' && e.kind === 'function'), 'Função App deve ser extraída do JSX')

    // Verifica relacionamento de import
    const rels = model.getRelationships()
    const importRel = rels.find(r => r.type === 'imports' && r.targetId === helperFile.id)
    assert.ok(importRel, 'Deve existir relacionamento de import do App.jsx para helper.js')
  })

  // Cenário 7 — Indexação de CSS com extração de @import gerando FILE -> FILE
  // ATUALIZADO (Sprint 3): CSS não é mais opaco — produz cssRule, cssAtRule e cssCustomProperty
  // com ranges em bytes. @import continua gerando APENAS relação FILE -> FILE (sem cssAtRule).
  await scenario('Cenário 7 — CSS extrai relacionamentos @import (FILE -> FILE)', async (dir) => {
    writeFileSync(join(dir, 'reset.css'), '/* Reset styles */\n* { margin: 0; }\n', 'utf-8')
    writeFileSync(join(dir, 'theme.css'), '/* Theme */\n:root { --color: red; }\n', 'utf-8')
    writeFileSync(join(dir, 'main.css'), '@import "./reset.css";\n@import url("theme.css");\n@import url("https://fonts.googleapis.com/css");\nbody { color: var(--color); }\n', 'utf-8')

    const model = createRepositoryModel(dir)
    await model.indexRepository()

    const files = model.getFiles()
    assert.strictEqual(files.length, 3, 'Esperava 3 arquivos CSS indexados')

    const mainFile = files.find(f => f.relativePath === 'main.css')
    const resetFile = files.find(f => f.relativePath === 'reset.css')
    const themeFile = files.find(f => f.relativePath === 'theme.css')

    assert.ok(mainFile && resetFile && themeFile, 'Todos os arquivos CSS devem estar no índice')
    assert.strictEqual(mainFile.language, 'css')

    // CSS agora extrai elementos estruturais (Sprint 3)
    const mainElements = model.getElementsByFile(mainFile.id)
    assert.ok(mainElements.length > 0, 'CSS deve conter elementos estruturais')

    // body é uma cssRule recuperável
    const bodyRule = mainElements.find(e => e.kind === 'cssRule' && e.name === 'body')
    assert.ok(bodyRule, 'body deve ser extraído como cssRule')
    assert.strictEqual(bodyRule.granularity, 'member')
    assert.strictEqual(bodyRule.retrievable, true)

    // @import NÃO gera elemento cssAtRule (apenas relação FILE -> FILE)
    const importAtRule = mainElements.find(e => e.kind === 'cssAtRule' && e.name === '@import')
    assert.ok(!importAtRule, '@import não deve gerar elemento cssAtRule')

    // Verifica relacionamentos FILE -> FILE
    const rels = model.getRelationships()
    const resetImport = rels.find(r => r.sourceId === mainFile.id && r.targetId === resetFile.id && r.type === 'imports')
    const themeImport = rels.find(r => r.sourceId === mainFile.id && r.targetId === themeFile.id && r.type === 'imports')

    assert.ok(resetImport, 'Deve existir relação FILE -> FILE de main.css para reset.css')
    assert.ok(themeImport, 'Deve existir relação FILE -> FILE de main.css para theme.css')
  })

  // Cenário 8 — Taxonomia de Recuperabilidade (Level A) e Ranges Exatos em Bytes (UTF-8 multi-byte)
  await scenario('Cenário 8 — Level A e Ranges Exatos em Bytes com caracteres multi-byte UTF-8', async (dir) => {
    // Código com comentários multi-byte (acentos e emojis) para verificar que startByte e endByte são precisos em bytes
    const sampleTs = [
      '// Cabeçalho com acentuação: Atenção à configuração! 🚀',
      'export interface UserData {',
      '  id: string;',
      '}',
      '',
      '/** Função que processa dados com acentuação */',
      'export function processUser(user: UserData): string {',
      '  return "Olá, " + user.id + " — Sucesso! 🎉";',
      '}',
      '',
      'export class UserService {',
      '  getUser(): string {',
      '    return "usuário_padrão";',
      '  }',
      '}',
      '',
      'export const computeTotal = (a: number, b: number): number => a + b;'
    ].join('\n') + '\n'

    writeFileSync(join(dir, 'user.ts'), sampleTs, 'utf-8')
    const buffer = Buffer.from(sampleTs, 'utf-8')

    const model = createRepositoryModel(dir)
    await model.indexRepository()

    const files = model.getFiles()
    assert.strictEqual(files.length, 1)
    const fileId = files[0].id

    const elements = model.getElementsByFile(fileId)
    assert.ok(elements.length >= 4, `Esperava >= 4 elementos, obteve ${elements.length}`)

    // 1. Interface UserData
    const iface = elements.find(e => e.name === 'UserData' && e.kind === 'interface')
    assert.ok(iface, 'Interface UserData deve ser encontrada')
    assert.strictEqual(iface.retrievalKind, 'A', 'Interface deve ser Level A')
    const ifaceCode = buffer.subarray(iface.location.start.byte, iface.location.end.byte).toString('utf-8')
    assert.ok(ifaceCode.startsWith('interface UserData'), `Range de UserData incorreto: "${ifaceCode}"`)

    // 2. Função processUser
    const func = elements.find(e => e.name === 'processUser' && e.kind === 'function')
    assert.ok(func, 'Função processUser deve ser encontrada')
    assert.strictEqual(func.retrievalKind, 'A', 'Função deve ser Level A')
    const funcCode = buffer.subarray(func.location.start.byte, func.location.end.byte).toString('utf-8')
    assert.ok(funcCode.startsWith('function processUser'), `Range de processUser incorreto: "${funcCode}"`)
    assert.ok(funcCode.includes('Olá,'), `Conteúdo da função deve conter texto exato: "${funcCode}"`)

    // 3. Classe UserService
    const cls = elements.find(e => e.name === 'UserService' && e.kind === 'class')
    assert.ok(cls, 'Classe UserService deve ser encontrada')
    assert.strictEqual(cls.granularity, 'structural', 'Classe deve ser structural')
    assert.strictEqual(cls.retrievable, true, 'Classe deve ser recuperável')
    const clsCode = buffer.subarray(cls.location.start.byte, cls.location.end.byte).toString('utf-8')
    assert.ok(clsCode.startsWith('class UserService'), `Range de UserService incorreto: "${clsCode}"`)

    // 4. Método getUser
    const method = elements.find(e => e.name === 'getUser' && e.kind === 'method')
    assert.ok(method, 'Método getUser deve ser encontrado')
    assert.strictEqual(method.granularity, 'structural', 'Método deve ser structural')
    assert.strictEqual(method.retrievable, true, 'Método deve ser recuperável')
    const methodCode = buffer.subarray(method.location.start.byte, method.location.end.byte).toString('utf-8')
    assert.ok(methodCode.startsWith('getUser()'), `Range de getUser incorreto: "${methodCode}"`)

    // 5. Constante computeTotal (arrow function em lexical_declaration)
    const constElem = elements.find(e => e.name === 'computeTotal' && e.kind === 'constant')
    assert.ok(constElem, 'Constante computeTotal deve ser encontrada')
    assert.strictEqual(constElem.granularity, 'structural', 'Constante deve ser structural')
    assert.strictEqual(constElem.retrievable, true, 'Constante deve ser recuperável')
    const constCode = buffer.subarray(constElem.location.start.byte, constElem.location.end.byte).toString('utf-8')
    assert.ok(constCode.startsWith('const computeTotal ='), `Range de computeTotal incorreto: "${constCode}"`)

    // 6. Elementos de export (syntax, não recuperáveis)
    const exportElems = elements.filter(e => e.kind === 'export')
    assert.ok(exportElems.length >= 3, 'Declarações export devem ser extraídas')
    for (const exp of exportElems) {
      assert.strictEqual(exp.granularity, 'syntax', 'Exports devem ser syntax')
      assert.strictEqual(exp.retrievable, false, 'Exports não devem ser recuperáveis')
      const expCode = buffer.subarray(exp.location.start.byte, exp.location.end.byte).toString('utf-8')
      assert.ok(expCode.startsWith('export '), `Range do export ${exp.name} incorreto: "${expCode}"`)
    }
  })

  // Cenário 9 — Migração de Schema: Adicionar retrieval_kind em banco legado
  await scenario('Cenário 9 — Migração de Schema adiciona retrieval_kind em banco legado', async (dir) => {
    // Cria banco legado sem a coluna retrieval_kind na tabela elements
    mkdirSync(join(dir, 'code_awareness'), { recursive: true })
    const dbPath = join(dir, 'code_awareness', 'repository_model.db')
    const Database = require('better-sqlite3')
    const legacyDb = new Database(dbPath)

    legacyDb.exec(`
      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        model_version INTEGER NOT NULL DEFAULT 1,
        last_indexed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        language TEXT NOT NULL,
        extension TEXT NOT NULL,
        lines INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        content_hash TEXT,
        status TEXT NOT NULL DEFAULT 'modified'
      );
      CREATE TABLE IF NOT EXISTS elements (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        file_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        parent_element_id TEXT,
        start_line INTEGER NOT NULL,
        start_column INTEGER NOT NULL,
        start_byte INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        end_column INTEGER NOT NULL,
        end_byte INTEGER NOT NULL,
        size_lines INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        visibility TEXT,
        modifiers TEXT NOT NULL DEFAULT '[]',
        return_type TEXT,
        base_class TEXT,
        has_documentation INTEGER NOT NULL DEFAULT 0,
        parameter_count INTEGER NOT NULL DEFAULT 0
      );
    `)

    // Insere um registro legado
    legacyDb.prepare(`
      INSERT INTO repositories (id, path, name) VALUES ('repo1', '/tmp/repo', 'repo');
    `).run()
    legacyDb.prepare(`
      INSERT INTO files (id, repository_id, relative_path, language, extension, lines, size_bytes, mtime, status)
      VALUES ('f1', 'repo1', 'index.ts', 'typescript', '.ts', 10, 100, 1000, 'indexed');
    `).run()
    legacyDb.prepare(`
      INSERT INTO elements (
        id, repository_id, file_id, kind, name, parent_element_id,
        start_line, start_column, start_byte, end_line, end_column, end_byte,
        size_lines, size_bytes, visibility, modifiers, return_type, base_class,
        has_documentation, parameter_count
      ) VALUES (
        'e1', 'repo1', 'f1', 'function', 'testLegacy', NULL,
        1, 0, 0, 3, 1, 30,
        2, 30, 'public', '[]', 'void', NULL,
        0, 0
      );
    `).run()
    legacyDb.close()

    // Abre via RepositoryModel para acionar ensureSchema com migração
    const model = createRepositoryModel(dir)
    const elements = model.getElementsByFile('f1')
    assert.strictEqual(elements.length, 1)
    assert.strictEqual(elements[0].name, 'testLegacy')
    // Registro legado anterior à coluna deve ter retrievalKind = null sem lançar erro
    assert.strictEqual(elements[0].retrievalKind, null)
  })

  // ─── Sprint 4: Exact Retrieval ───────────────────────────────────────────────

  // Cenário 10 — Recuperação Exata Bem-Sucedida de elemento Level A
  await scenario('Cenário 10 — Recuperação exata de método Level A por elementId', async (dir) => {
    const code = [
      '// Módulo de processamento com acentuação e emojis: Atenção! 🚀',
      'export class Processor {',
      '  /** Processa o item e retorna a descrição */  ',
      '  process(item: string): string {',
      '    return `Processado: ${item} — OK 🎉`;',
      '  }',
      '}',
    ].join('\n') + '\n'

    writeFileSync(join(dir, 'processor.ts'), code, 'utf-8')

    const model = createRepositoryModel(dir)
    await model.indexRepository()

    const files = model.getFiles()
    assert.strictEqual(files.length, 1)

    const elements = model.getElementsByFile(files[0].id)
    const method = elements.find(e => e.name === 'process' && e.kind === 'method')
    assert.ok(method, 'Método process deve ser encontrado')
    assert.strictEqual(method.retrievalKind, 'A', 'Método deve ser Level A')

    const result = await model.getElementExactSource(method.id)
    assert.ok(result !== null, 'getElementExactSource deve retornar resultado não-nulo para Level A')
    assert.ok(result.content.includes('process(item: string)'), `Conteúdo deve incluir assinatura do método: "${result.content}"`)
    assert.ok(result.content.includes('🎉'), 'Conteúdo deve incluir emoji do corpo do método (validação de UTF-8)')
    assert.strictEqual(result.relativePath, 'processor.ts')
    assert.strictEqual(result.startByte, method.location.start.byte)
    assert.strictEqual(result.endByte, method.location.end.byte)

    // Verifica que o range extraído não contém código da classe inteira
    assert.ok(!result.content.includes('class Processor'), 'Resultado não deve incluir a declaração da classe')
  })

  // Cenário 11 — Recusa de Recuperação quando arquivo foi modificado (stale)
  await scenario('Cenário 11 — Recusa de recuperação exata quando hash do disco diverge (stale)', async (dir) => {
    const originalCode = [
      'export function calculate(a: number, b: number): number {',
      '  return a + b;',
      '}',
    ].join('\n') + '\n'

    writeFileSync(join(dir, 'calc.ts'), originalCode, 'utf-8')

    const model = createRepositoryModel(dir)
    await model.indexRepository()

    const elements = model.getElementsByFile(model.getFiles()[0].id)
    const func = elements.find(e => e.name === 'calculate' && e.kind === 'function')
    assert.ok(func, 'Função calculate deve estar indexada')

    // Recuperação antes da modificação deve funcionar
    const resultBefore = await model.getElementExactSource(func.id)
    assert.ok(resultBefore !== null, 'Recuperação antes da modificação deve ser bem-sucedida')

    // Modifica o arquivo no disco sem disparar sincronização
    const modifiedCode = '// Comentário adicionado sem reindexar\n' + originalCode
    writeFileSync(join(dir, 'calc.ts'), modifiedCode, 'utf-8')

    // Recuperação após modificação deve retornar null (hash diverge)
    const resultAfter = await model.getElementExactSource(func.id)
    assert.strictEqual(resultAfter, null, 'Recuperação deve retornar null quando hash do disco diverge do hash indexado')
  })

  // Cenário 12 — Recusa de Recuperação para elementos não-Level A
  await scenario('Cenário 12 — Recusa de recuperação exata para elemento não-Level A (retrievalKind null)', async (dir) => {
    writeFileSync(join(dir, 'sample.ts'), 'export class Demo { id: string = "x"; }\n', 'utf-8')

    const model = createRepositoryModel(dir)
    await model.indexRepository()

    const elements = model.getElementsByFile(model.getFiles()[0].id)

    // Tenta recuperação de um elemento com retrievalKind = null (não Level A)
    // Cria artificialmente um elemento sem retrievalKind via inserção direta no banco
    // Usa a classe indexada e força null via patch (simula legado pré-Sprint 3)
    const Database = require('better-sqlite3')
    const dbPath = join(dir, 'code_awareness', 'repository_model.db')
    const db = new Database(dbPath)

    // Insere elemento legado sem retrieval_kind
    const repoId = db.prepare("SELECT id FROM repositories LIMIT 1").get().id
    const fileRow = db.prepare("SELECT id FROM files LIMIT 1").get()
    db.prepare(`
      INSERT OR REPLACE INTO elements (
        id, repository_id, file_id, kind, name, parent_element_id,
        start_line, start_column, start_byte, end_line, end_column, end_byte,
        size_lines, size_bytes, visibility, modifiers, return_type, base_class,
        has_documentation, parameter_count, retrieval_kind
      ) VALUES (
        'elem-non-level-a', ?, ?, 'method', 'legacyMethod', NULL,
        1, 0, 0, 2, 1, 20,
        1, 20, 'public', '[]', 'void', NULL,
        0, 0, NULL
      )
    `).run(repoId, fileRow.id)
    db.close()

    // Força recarregamento do banco
    closeRepositoryDatabase(dir)

    const model2 = createRepositoryModel(dir)
    const result = await model2.getElementExactSource('elem-non-level-a')
    assert.strictEqual(result, null, 'Recuperação deve retornar null para elementos com retrievalKind null')
  })

  // ─── Sprint 5: Sincronização Incremental e Integridade do Grafo ──────────────

  // Cenário 13 — Reextração Cirúrgica (apenas o arquivo modificado é re-extraído)
  await scenario('Cenário 13 — Reextração cirúrgica: apenas arquivo modificado é re-extraído', async (dir) => {
    writeFileSync(join(dir, 'a.ts'), 'export class Alpha { run(): string { return "alpha"; } }\n', 'utf-8')
    writeFileSync(join(dir, 'b.ts'), 'export class Beta { run(): string { return "beta"; } }\n', 'utf-8')
    writeFileSync(join(dir, 'c.ts'), 'export class Gamma { run(): string { return "gamma"; } }\n', 'utf-8')

    const model = createRepositoryModel(dir)
    await model.indexRepository()

    const allFiles = model.getFiles()
    assert.strictEqual(allFiles.length, 3)

    const fileA = allFiles.find(f => f.relativePath === 'a.ts')
    const fileB = allFiles.find(f => f.relativePath === 'b.ts')
    const fileC = allFiles.find(f => f.relativePath === 'c.ts')

    // Captura elementos originais de A e C (não devem mudar)
    const elemsA_before = model.getElementsByFile(fileA.id)
    const elemsC_before = model.getElementsByFile(fileC.id)
    const elemsB_before = model.getElementsByFile(fileB.id)
    const betaBefore = elemsB_before.find(e => e.name === 'Beta' && e.kind === 'class')
    assert.ok(betaBefore)

    // Modifica apenas B no disco
    writeFileSync(join(dir, 'b.ts'), 'export class BetaV2 { run(): string { return "beta-v2"; } }\n', 'utf-8')

    // Sincroniza apenas o arquivo B
    const success = await model.updateFileContent('b.ts')
    assert.ok(success, 'updateFileContent deve retornar true')

    // Elementos de A e C permanecem inalterados (mesmos IDs)
    const elemsA_after = model.getElementsByFile(fileA.id)
    const elemsC_after = model.getElementsByFile(fileC.id)
    assert.deepStrictEqual(
      elemsA_before.map(e => e.id).sort(),
      elemsA_after.map(e => e.id).sort(),
      'Elementos de A não devem mudar'
    )
    assert.deepStrictEqual(
      elemsC_before.map(e => e.id).sort(),
      elemsC_after.map(e => e.id).sort(),
      'Elementos de C não devem mudar'
    )

    // Elementos de B foram re-extraídos (BetaV2 existe, Beta não)
    const fileB_after = model.getFiles().find(f => f.relativePath === 'b.ts')
    const elemsB_after = model.getElementsByFile(fileB_after.id)
    assert.ok(elemsB_after.some(e => e.name === 'BetaV2' && e.kind === 'class'), 'BetaV2 deve existir após sync')
    assert.ok(!elemsB_after.some(e => e.name === 'Beta' && e.kind === 'class'), 'Beta antiga não deve existir após sync')

    // Hash de B foi atualizado
    assert.notStrictEqual(fileB_after.contentHash, fileB.contentHash, 'Hash de B deve ter mudado')
  })

  // Cenário 14 — Reconciliação de Relações após modificação de import
  await scenario('Cenário 14 — Reconciliação de relações: import A→B removido, A→C criado após sync', async (dir) => {
    writeFileSync(join(dir, 'b.ts'), 'export function fromB(): string { return "B"; }\n', 'utf-8')
    writeFileSync(join(dir, 'c.ts'), 'export function fromC(): string { return "C"; }\n', 'utf-8')
    writeFileSync(join(dir, 'a.ts'), 'import { fromB } from "./b";\nexport function run() { return fromB(); }\n', 'utf-8')

    const model = createRepositoryModel(dir)
    await model.indexRepository()

    const filesAfterIndex = model.getFiles()
    const fileA = filesAfterIndex.find(f => f.relativePath === 'a.ts')
    const fileB = filesAfterIndex.find(f => f.relativePath === 'b.ts')
    const fileC = filesAfterIndex.find(f => f.relativePath === 'c.ts')

    // As relações de imports têm sourceId = elementId do elemento 'import',
    // e targetId = fileId do arquivo importado. Busca pelo targetId.
    const elemsA_before = model.getElementsByFile(fileA.id)
    const importElem_before = elemsA_before.find(e => e.kind === 'import')
    assert.ok(importElem_before, 'Elemento import deve existir em A antes da modificação')

    const relsAfterIndex = model.getRelationships()
    const relAtoB = relsAfterIndex.find(r => r.targetId === fileB.id && r.type === 'imports')
    assert.ok(relAtoB, 'Relação A→B deve existir após indexação inicial')

    // Modifica A para importar C em vez de B
    writeFileSync(join(dir, 'a.ts'), 'import { fromC } from "./c";\nexport function run() { return fromC(); }\n', 'utf-8')
    await model.updateFileContent('a.ts')

    const relsAfterSync = model.getRelationships()
    const relAtoB_after = relsAfterSync.find(r => r.targetId === fileB.id && r.type === 'imports')
    const relAtoC_after = relsAfterSync.find(r => r.targetId === fileC.id && r.type === 'imports')

    assert.strictEqual(relAtoB_after, undefined, 'Relação A→B deve ser removida após sync')
    assert.ok(relAtoC_after, 'Relação A→C deve ser criada após sync')

    // B e C permanecem intactos
    assert.ok(model.getElementsByFile(fileB.id).length > 0, 'Elementos de B devem permanecer')
    assert.ok(model.getElementsByFile(fileC.id).length > 0, 'Elementos de C devem permanecer')
  })

  // Cenário 15 — Round-Trip de Recuperação Exata após modificação e sincronização
  await scenario('Cenário 15 — Round-trip: modificar método → sincronizar → getElementExactSource retorna novo conteúdo', async (dir) => {
    const originalCode = [
      'export class Service {',
      '  execute(): string {',
      '    return "original";',
      '  }',
      '}',
    ].join('\n') + '\n'

    writeFileSync(join(dir, 'service.ts'), originalCode, 'utf-8')

    const model = createRepositoryModel(dir)
    await model.indexRepository()

    const files = model.getFiles()
    const elements = model.getElementsByFile(files[0].id)
    const method = elements.find(e => e.name === 'execute' && e.kind === 'method')
    assert.ok(method, 'Método execute deve ser encontrado')

    // Recuperação original
    const resultBefore = await model.getElementExactSource(method.id)
    assert.ok(resultBefore !== null, 'Recuperação original deve ser bem-sucedida')
    assert.ok(resultBefore.content.includes('"original"'), 'Conteúdo original deve ter "original"')

    // Modifica o método no disco
    const updatedCode = [
      'export class Service {',
      '  execute(): string {',
      '    // Nova implementação',
      '    return "updated-v2";',
      '  }',
      '}',
    ].join('\n') + '\n'

    writeFileSync(join(dir, 'service.ts'), updatedCode, 'utf-8')
    await model.updateFileContent('service.ts')

    // Busca o novo elemento com o mesmo nome (ID pode ter mudado se a posição mudou)
    const filesAfterSync = model.getFiles()
    const fileAfterSync = filesAfterSync.find(f => f.relativePath === 'service.ts')
    const elemsAfterSync = model.getElementsByFile(fileAfterSync.id)
    const methodAfterSync = elemsAfterSync.find(e => e.name === 'execute' && e.kind === 'method')

    assert.ok(methodAfterSync, 'Método execute deve existir após sync')
    assert.strictEqual(methodAfterSync.granularity, 'structural', 'Método deve ser structural após sync')
    assert.strictEqual(methodAfterSync.retrievable, true, 'Método deve ser recuperável após sync')

    // Round-trip: recuperação exata após sync deve retornar novo conteúdo
    const resultAfter = await model.getElementExactSource(methodAfterSync.id)
    assert.ok(resultAfter !== null, 'Recuperação após sync deve ser bem-sucedida')
    assert.ok(resultAfter.content.includes('"updated-v2"'), `Conteúdo deve ter "updated-v2": "${resultAfter.content}"`)
    assert.ok(resultAfter.content.includes('Nova implementação'), 'Conteúdo deve ter novo comentário')

    // Hash atualizado no banco
    assert.notStrictEqual(fileAfterSync.contentHash, files[0].contentHash, 'Hash deve ter sido atualizado')

    // Ranges refletem nova posição
    assert.strictEqual(resultAfter.startByte, methodAfterSync.location.start.byte)
    assert.strictEqual(resultAfter.endByte, methodAfterSync.location.end.byte)
  })

  // Cenário 16 — Idempotência de Sincronização (duas chamadas consecutivas)
  await scenario('Cenário 16 — Idempotência: dois updateFileContent consecutivos não duplicam elementos', async (dir) => {
    writeFileSync(join(dir, 'widget.ts'), 'export class Widget { id: string = "w"; }\n', 'utf-8')

    const model = createRepositoryModel(dir)
    await model.indexRepository()

    const files = model.getFiles()
    assert.strictEqual(files.length, 1)

    // Modifica o arquivo
    writeFileSync(join(dir, 'widget.ts'), 'export class WidgetV2 { id: string = "w2"; name: string = "Widget"; }\n', 'utf-8')

    // Dispara updateFileContent duas vezes (simula watcher duplicado)
    await model.updateFileContent('widget.ts')
    await model.updateFileContent('widget.ts')

    const file = model.getFiles().find(f => f.relativePath === 'widget.ts')
    const elements = model.getElementsByFile(file.id)

    // Nenhum elemento duplicado
    const classElems = elements.filter(e => e.name === 'WidgetV2' && e.kind === 'class')
    assert.strictEqual(classElems.length, 1, 'WidgetV2 não deve estar duplicado no banco')

    // Classe Widget antiga não existe mais
    assert.ok(!elements.some(e => e.name === 'Widget'), 'Widget antiga não deve existir')

    // Hash é consistente
    assert.ok(file.contentHash, 'contentHash deve estar definido')

    // Recuperação exata funcional
    const classElem = elements.find(e => e.name === 'WidgetV2' && e.kind === 'class')
    assert.ok(classElem, 'Classe WidgetV2 deve existir')
    const result = await model.getElementExactSource(classElem.id)
    assert.ok(result !== null, 'getElementExactSource deve funcionar após sync idempotente')
    assert.ok(result.content.includes('WidgetV2'), 'Conteúdo deve conter WidgetV2')
  })

  // ─── Resultado ──────────────────────────────────────────────────────────────
  console.log(`\nResultado: ${passed} passed, ${failed} failed`)

  if (failed > 0) {
    process.exit(1)
  } else {
    process.exit(0)
  }
}

runAll().catch(err => {
  console.error('[Code Map Runner] Erro fatal:', err)
  process.exit(1)
})

