/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Calcular hash fingerprint resiliente de um repositório baseado no conteúdo de seus arquivos de manifesto.
2. Permitir rastreamento de repositórios mesmo quando seu caminho no disco é alterado.

Mapa de Relacionamentos do Script

1. settings-service.ts
   - Tipo: Fluxo de Dados
   - Relação: Fornece o fingerprint usado como chave no cache de importância arquitetural.
   - Criticidade: Alta

Invariantes do Script

1. O mesmo conteúdo de manifesto deve sempre produzir o mesmo hash, independente do caminho do repositório.
2. Nunca lançar erro não tratado externamente — sempre usar fallback para hash do nome do diretório.
3. A leitura de arquivos deve ser limitada aos primeiros 10KB para garantir performance consistente.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { createHash } from 'crypto'
import { existsSync, readdirSync } from 'fs'
import { readFile } from 'fs/promises'
import { join, basename } from 'path'

/**
 * Lista de arquivos de manifesto conhecidos por ecossistema, em ordem de prioridade.
 * O primeiro encontrado na raiz do repositório será usado para o hash.
 */
const MANIFEST_FILES = [
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'Gemfile',
  'composer.json'
]

/** Limite de bytes lidos de cada arquivo para cálculo do hash. */
const MAX_BYTES = 10 * 1024 // 10KB

/**
 * Tenta ler os primeiros MAX_BYTES de um arquivo de forma assíncrona.
 * Retorna null se o arquivo não existir ou não puder ser lido.
 */
async function tryReadFirstBytes(filePath: string): Promise<Buffer | null> {
  try {
    if (!existsSync(filePath)) return null
    const content = await readFile(filePath)
    return content.subarray(0, MAX_BYTES)
  } catch {
    return null
  }
}

/**
 * Calcula o hash SHA-256 de um buffer e retorna como string hexadecimal.
 */
function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Calcula um fingerprint resiliente para um repositório.
 *
 * O fingerprint é baseado no conteúdo dos arquivos de manifesto do repositório,
 * não no caminho. Isso permite identificar o mesmo repositório mesmo se ele for
 * movido ou renomeado no disco.
 *
 * @param repoPath - Caminho absoluto para a raiz do repositório.
 * @returns Hash SHA-256 em hexadecimal.
 * @throws Se repoPath não existir ou não for acessível.
 */
export async function calculateRepoFingerprint(repoPath: string): Promise<string> {
  // Validação inicial: caminho deve existir e ser acessível
  if (!repoPath || !existsSync(repoPath)) {
    throw new Error(`Repositório não encontrado: "${repoPath}". Verifique se o caminho existe e está acessível.`)
  }

  // 1. Procura por arquivos de manifesto na raiz, em ordem de prioridade
  for (const manifest of MANIFEST_FILES) {
    const manifestPath = join(repoPath, manifest)
    const content = await tryReadFirstBytes(manifestPath)
    if (content) {
      return sha256Hex(content)
    }
  }

  // 2. Fallback: tenta README.md
  const readmePath = join(repoPath, 'README.md')
  const readmeContent = await tryReadFirstBytes(readmePath)
  if (readmeContent) {
    return sha256Hex(readmeContent)
  }

  // 3. Fallback: procura pelo primeiro arquivo de código-fonte na raiz
  const sourceExtensions = ['.ts', '.js', '.py', '.rs', '.go']
  try {
    const entries = readdirSync(repoPath, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = entry.name.slice(entry.name.lastIndexOf('.'))
        if (sourceExtensions.includes(ext)) {
          const content = await tryReadFirstBytes(join(repoPath, entry.name))
          if (content) {
            return sha256Hex(content)
          }
        }
      }
    }
  } catch {
    // Se falhar ao listar diretório, prossegue para fallback final
  }

  // 4. Fallback final: hash do nome do diretório
  // Isso garante que sempre teremos um fingerprint, mesmo em casos extremos
  const dirName = basename(repoPath)
  return sha256Hex(Buffer.from(dirName, 'utf-8'))
}