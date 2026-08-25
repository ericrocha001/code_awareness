/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Materializar o Invariante Central como uma função-verificável comparando banco e disco.
2. Isolar o ciclo de vida de repositórios temporários para testes (criação, escrita, indexação e limpeza).
3. Fornecer fixtures TypeScript reutilizáveis para as Sprints de teste subsequentes.

Mapa de Relacionamentos do Script

1. repository-model.ts
   - Tipo: Dependência Direta
   - Relação: Consome a API pública para consultar arquivos, elementos, relacionamentos e status.
   - Criticidade: Alta

2. repository-scanner.ts
   - Tipo: Dependência Direta
   - Relação: Consome scanRepository para descobrir arquivos elegíveis no disco.
   - Criticidade: Alta

3. repository-database.ts
   - Tipo: Dependência Direta
   - Relação: Consome closeRepositoryDatabase para fechar conexões na limpeza.
   - Criticidade: Média

Invariantes do Script

1. A Função-Oráculo nunca lança exceção — erros internos viram violações do tipo internal_error.
2. Uma falha de leitura de um arquivo gera violação hash_unreadable local e nunca interrompe as demais dimensões.
3. O hash é sempre calculado com createHash('sha256') sobre o conteúdo em utf-8 e saída em hex.
4. contentHash nulo nunca é tratado como erro de leitura, apenas como violação hash_missing.
5. Arquivos com status modified nunca geram hash_mismatch; hash divergente é o estado esperado e hash coincidente é violação stale_modified.
6. Diretórios temporários são sempre únicos via mkdtempSync com prefixo codemap_test_.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { RepositoryModel } from './repository-model'
import { scanRepository } from './repository-scanner'
import { closeRepositoryDatabase } from './repository-database'

// ─── Bloco 1 — Tipos e Função-Oráculo ──────────────────────────────────────

export interface InvariantViolation {
  type: string
  description: string
  target: string
}

export interface InvariantResult {
  passed: boolean
  violations: InvariantViolation[]
}

export interface VerifyInvariantOptions {
  expectFullySynced?: boolean
}

/**
 * Função-Oráculo do Invariante Central: verifica se o estado persistido no banco
 * espelha o estado do disco naquele momento, em 7 dimensões independentes.
 * Nunca lança exceção — todo erro interno é convertido em violação internal_error.
 */
export async function verifyInvariant(
  model: RepositoryModel,
  repoPath: string,
  options: VerifyInvariantOptions = {}
): Promise<InvariantResult> {
  const violations: InvariantViolation[] = []
  const expectFullySynced = options.expectFullySynced !== false

  try {
    // Dimensão 1 — Arquivos do banco (indexados) existem no disco.
    const files = model.getFiles()
    for (const file of files) {
      if (file.status !== 'indexed') continue
      if (!existsSync(join(repoPath, file.relativePath))) {
        violations.push({
          type: 'file_missing_on_disk',
          description: `Arquivo indexado no banco não existe no disco: ${file.relativePath}`,
          target: file.relativePath
        })
      }
    }

    // Dimensão 2 — Arquivos do disco existem no banco.
    const diskFiles = await scanRepository(repoPath)
    const dbPaths = new Set(files.map((file) => file.relativePath))
    for (const diskFile of diskFiles) {
      if (!dbPaths.has(diskFile.relativePath)) {
        violations.push({
          type: 'file_missing_in_db',
          description: `Arquivo no disco ausente no banco: ${diskFile.relativePath}`,
          target: diskFile.relativePath
        })
      }
    }

    // Dimensão 3 — Hash do banco corresponde ao conteúdo atual do disco, por status.
    // Arquivos 'modified' divergem do hash indexado POR DEFINIÇÃO; apenas 'indexed'
    // devem casar. Um 'modified' cujo hash coincide com o índice é um stale_modified
    // (inconsistência semântica que reconcileWithDisk curaria).
    for (const file of files) {
      const fullPath = join(repoPath, file.relativePath)
      if (!existsSync(fullPath)) continue

      if (file.contentHash == null) {
        violations.push({
          type: 'hash_missing',
          description: `Arquivo legado sem contentHash no banco: ${file.relativePath}`,
          target: file.relativePath
        })
        continue
      }

      let content: string
      try {
        content = readFileSync(fullPath, 'utf-8')
      } catch (readError) {
        // I/O error em um arquivo não pode derrubar as demais dimensões do oráculo.
        violations.push({
          type: 'hash_unreadable',
          description: `Arquivo existe mas não pôde ser lido: ${readError instanceof Error ? readError.message : String(readError)}`,
          target: file.relativePath
        })
        continue
      }

      const diskHash = createHash('sha256').update(content, 'utf-8').digest('hex')

      if (file.status === 'indexed') {
        // Arquivo indexed DEVE ter hash correspondente; divergência é inconsistência real.
        if (diskHash !== file.contentHash) {
          violations.push({
            type: 'hash_mismatch',
            description: `Hash do disco diverge do hash indexado em arquivo indexed: ${file.relativePath}`,
            target: file.relativePath
          })
        }
      } else if (file.status === 'modified') {
        // 'modified' cujo hash coincide com o índice é stale — deveria ter sido curado.
        if (diskHash === file.contentHash) {
          violations.push({
            type: 'stale_modified',
            description: `Arquivo marcado como modified mas cujo conteúdo corresponde ao índice: ${file.relativePath}`,
            target: file.relativePath
          })
        }
        // 'modified' com hash divergente é o estado transitório esperado — não reportar.
      }
    }

    // Dimensão 4 — Status correto após sincronização completa.
    if (expectFullySynced) {
      for (const file of files) {
        if (file.status !== 'indexed') {
          violations.push({
            type: 'status_not_indexed',
            description: `Arquivo com status inesperado após sincronização: ${file.relativePath} (${file.status})`,
            target: file.relativePath
          })
        }
      }
    }

    // Dimensão 5 — Elementos pertencem a arquivos válidos.
    const fileIds = new Set(files.map((file) => file.id))
    const elements = model.getElementsByRepository()
    for (const element of elements) {
      if (!fileIds.has(element.fileId)) {
        violations.push({
          type: 'orphan_element',
          description: `Elemento órfão referencia arquivo inexistente`,
          target: `${element.name} (${element.kind})`
        })
      }
    }

    // Dimensão 6 — Relacionamentos apontam para entidades existentes.
    const validIds = new Set([...fileIds, ...elements.map((element) => element.id)])
    const relationships = model.getRelationships()
    for (const relationship of relationships) {
      if (!validIds.has(relationship.sourceId) || !validIds.has(relationship.targetId)) {
        violations.push({
          type: 'invalid_relationship',
          description: `Relacionamento referência entidade inexistente`,
          target: relationship.id
        })
      }
    }

    // Dimensão 7 — Contagens do status de sincronização são consistentes.
    const syncStatus = model.getSyncStatus()
    if (syncStatus.totalFiles !== files.length) {
      violations.push({
        type: 'count_mismatch',
        description: `totalFiles do status (${syncStatus.totalFiles}) difere do número de arquivos (${files.length})`,
        target: 'sync-status'
      })
    }
    if (syncStatus.totalElements !== elements.length) {
      violations.push({
        type: 'count_mismatch',
        description: `totalElements do status (${syncStatus.totalElements}) difere do número de elementos (${elements.length})`,
        target: 'sync-status'
      })
    }
  } catch (error) {
    violations.push({
      type: 'internal_error',
      description: `Falha interna durante a verificação do invariante: ${error instanceof Error ? error.message : String(error)}`,
      target: 'verifyInvariant'
    })
  }

  return { passed: violations.length === 0, violations }
}

// ─── Bloco 2 — Helpers de Setup e Teardown ─────────────────────────────────

/** Cria um diretório temporário único e isolado para testes. */
export function createTempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'codemap_test_'))
}

/** Fecha conexões abertas e remove o repositório temporário por completo. */
export async function cleanupTempRepo(repoPath: string): Promise<void> {
  closeRepositoryDatabase(repoPath)
  // BUGFIX (Windows): o lock do WAL do SQLite pode segurar um handle após fechar a
  // conexão, impedindo a remoção imediata do diretório; faz um pequeno loop de retry e,
  // se persistir, desiste silenciosamente para não abortar os testes.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      rmSync(repoPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

/** Escreve um arquivo de teste, criando diretórios intermediários se necessário. */
export function writeTestFile(repoPath: string, relativePath: string, content: string): void {
  const fullPath = join(repoPath, relativePath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content, 'utf-8')
}

/** Remove um arquivo de teste do disco, ignorando caso já não exista. */
export function deleteTestFile(repoPath: string, relativePath: string): void {
  try {
    unlinkSync(join(repoPath, relativePath))
  } catch {
    // Arquivo já ausente: nada a fazer.
  }
}

/** Cria um repositório temporário indexado a partir de um mapa caminho → conteúdo. */
export async function createAndIndexRepo(files: Record<string, string>): Promise<{
  model: RepositoryModel
  repoPath: string
  repositoryId: string
}> {
  const repoPath = createTempRepo()
  for (const [relativePath, content] of Object.entries(files)) {
    writeTestFile(repoPath, relativePath, content)
  }
  const model = new RepositoryModel(repoPath)
  await model.indexRepository()
  return { model, repoPath, repositoryId: model.getRepositoryId() }
}

/** Sobrescreve um arquivo apenas no disco, sem tocar no banco. */
export function modifyFileOnDisk(repoPath: string, relativePath: string, newContent: string): void {
  writeFileSync(join(repoPath, relativePath), newContent, 'utf-8')
}


// ─── Bloco 3 — Fixtures de TypeScript ──────────────────────────────────────

export const FIXTURE_SIMPLE_FUNCTION = `/**
 * Soma dois números.
 */
export function add(a: number, b: number): number {
  return a + b
}
`

export const FIXTURE_CLASS_WITH_METHODS = `export class Counter {
  private count: number

  constructor(initial: number) {
    this.count = initial
  }

  public increment(): number {
    this.count += 1
    return this.count
  }

  private reset(): void {
    this.count = 0
  }

  static create(): Counter {
    return new Counter(0)
  }
}
`

export const FIXTURE_INTERFACE = `export interface Shape {
  name: string
  sides: number
  color: string
  area(): number
}
`

export const FIXTURE_CLASS_EXTENDS = `export class Animal {
  protected name: string

  constructor(name: string) {
    this.name = name
  }

  speak(): string {
    return \`\${this.name} makes a sound\`
  }
}

export class Dog extends Animal {
  public speak(): string {
    return \`\${this.name} barks\`
  }

  public fetch(): string {
    return \`\${this.name} fetches the ball\`
  }
}
`

export const FIXTURE_CLASS_IMPLEMENTS = `export interface Serializable {
  serialize(): string
  deserialize(data: string): void
}

export class Config implements Serializable {
  private value: string

  constructor() {
    this.value = ''
  }

  public serialize(): string {
    return this.value
  }

  public deserialize(data: string): void {
    this.value = data
  }
}
`


// Par de fixtures de importação relativa real. Use-os juntos, por exemplo com
// chaves `'src/main.ts': FIXTURE_IMPORTER` e `'src/greet.ts': FIXTURE_IMPORTED`.
export const FIXTURE_IMPORTER = `import { greet } from './greet'

export function welcome(name: string): string {
  return greet(name)
}
`

export const FIXTURE_IMPORTED = `export function greet(name: string): string {
  return \`Hello, \${name}\`
}
`

export const FIXTURE_MULTI_ELEMENT = `export class Product {
  public name: string

  constructor(name: string) {
    this.name = name
  }
}

export function isAvailable(product: Product): boolean {
  return product.name.length > 0
}

export interface Catalog {
  items: Product[]
}

export enum Category {
  Food,
  Drink
}

export type ProductId = string

export const DEFAULT_CATEGORY = Category.Food

export let globalCount = 0
`

export const FIXTURE_CROSS_FILE: Record<string, string> = {
  'src/base.ts': `export interface HasName {
  getName(): string
}

export class BaseEntity {
  protected name: string

  constructor(name: string) {
    this.name = name
  }

  public getName(): string {
    return this.name
  }
}
`,
  'src/derived.ts': `import { BaseEntity, HasName } from './base'

export class DerivedEntity extends BaseEntity implements HasName {
  public describe(): string {
    return \`Derived: \${this.getName()}\`
  }
}
`,
  'src/consumer.ts': `import { DerivedEntity } from './derived'

export function buildDerived(name: string): DerivedEntity {
  return new DerivedEntity(name)
}
`
}

/**
 * R1 — Helper de cleanup com retry para testes.
 * Encapsula o loop de retry do BUGFIX Windows (lock do WAL do SQLite).
 * Substitui a duplicação do padrão em múltiplos afterEach.
 */
export async function cleanupTestDir(testDir: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
      }
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  // Último esforço: ignora falha para não bloquear outros testes
  console.warn(`[test-helpers] cleanupTestDir falhou após 4 tentativas: ${testDir}`)
}

/**
 * R2 — Helper de simulação de corrupção de elementos órfãos.
 * Remove o arquivo do banco mantendo os elementos (cenário que não ocorre
 * na cascata normal, mas pode ocorrer por bug externo).
 * Desabilita FK temporariamente para permitir a operação.
 */
export function simulateOrphanCorruption(model: RepositoryModel, fileId: string): void {
  // @ts-ignore - acesso direto ao db para simular corrupção
  const db = model['db'] as any
  db.db.pragma('foreign_keys = OFF')
  db.db.prepare('DELETE FROM files WHERE id = ?').run(fileId)
  db.db.pragma('foreign_keys = ON')
}

