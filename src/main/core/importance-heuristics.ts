/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Classificar arquivos como ruído arquitetural (low) baseado em extensão, nome e caminho.
2. Calcular pontuação numérica de importância baseada em padrões estruturais de nome e caminho.
3. Extrair sinais de qualidade arquitetural do conteúdo do arquivo (comentários, tamanho, débito técnico).
4. Consolidar pontuações das camadas anteriores e mapear para o nível final de importância.

Mapa de Relacionamentos do Script

1. importance-service.ts (futuro)
   - Tipo: Fluxo de Dados
   - Relação: Será consumido por serviço de classificação que aplica múltiplas camadas de heurísticas.
   - Criticidade: Alta

2. shared/types.ts
   - Tipo: Dependência Direta
   - Relação: Importa o tipo ImportanceLevel para tipagem do retorno.
   - Criticidade: Média

Invariantes do Script

1. As funções classifyByExtensionAndPath e scoreByNameAndPath devem ser puras — sem side effects, sem I/O, sem estado externo.
2. O retorno deve ser deterministico: mesma entrada sempre produz a mesma saída.
3. Arquivos que não são ruído devem retornar null na Camada 1, nunca um nível de importância diferente de low.
4. scoreByContent deve ler o arquivo apenas uma vez para otimizar performance.
5. consolidateScore deve ser pura — sem side effects, sem I/O, sem estado externo.
6. O filtro de exclusão (Camada 1) sempre vence: se retorna 'low', o nível final é 'low'.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { extname, join } from 'path'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { ImportanceLevel } from '../../shared/types'

// ─── Listas de padrões ─────────────────────────────────────────────────────
// Usamos Set para garantir performance O(1) nas verificações.

/** Extensões de arquivo que são ruído arquitetural certo. */
const NOISE_EXTENSIONS = new Set([
  // Imagens
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp',
  // Vídeos e áudio
  '.mp4', '.mp3', '.wav', '.ogg', '.avi', '.mov',
  // Archives
  '.zip', '.tar', '.gz', '.rar', '.7z',
  // Binários
  '.exe', '.dll', '.so', '.bin', '.wasm', '.pdf',
  // Lockfiles (qualquer arquivo .lock)
  '.lock',
  // Build artifacts
  '.tsbuildinfo', '.map', '.min.js', '.min.css'
])

/** Nomes de arquivo específicos que são ruído arquitetural certo. */
const NOISE_FILENAMES = new Set([
  // Lockfiles de gerenciadores de pacote
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock',
  'Gemfile.lock', 'Cargo.lock', 'composer.lock', 'poetry.lock',
  // Arquivos de sistema
  '.DS_Store', 'Thumbs.db', 'desktop.ini'
])

/** Nomes de diretório que indicam que qualquer arquivo dentro é ruído. */
const NOISE_DIRECTORIES = new Set([
  'node_modules', 'dist', 'build', 'out', '.git', '.next', '.nuxt',
  'coverage', '__pycache__', '.cache', '.svelte-kit', '.angular'
])

// ─── Camada 1: Filtro de Exclusão Automática ────────────────────────────────

/**
 * Classifica um arquivo como ruído arquitetural (low) baseado em sua extensão,
 * nome ou caminho.
 *
 * Esta é a primeira camada do sistema de classificação de importância.
 * Ela filtra arquivos que claramente não têm valor arquitetural, como imagens,
 * binários, lockfiles, artefatos de build e arquivos dentro de pastas de
 * dependências.
 *
 * @param relativePath - Caminho relativo do arquivo (ex: "src/main.ts")
 * @returns 'low' se o arquivo é ruído, ou null se não é (deve passar para
 *          próxima camada de classificação).
 */
export function classifyByExtensionAndPath(relativePath: string): ImportanceLevel | null {
  // Normaliza separadores para forward slash, garantindo consistência
  // independente do sistema operacional
  const normalized = relativePath.replace(/\\/g, '/')

  // Divide o caminho em partes para análise individual
  const pathParts = normalized.split('/')
  const filename = pathParts[pathParts.length - 1] || ''

  // 1. Verifica se o arquivo está dentro de uma pasta de ruído
  //    Ex: node_modules/react/index.js → low
  //    Ex: dist/bundle.js → low
  if (pathParts.some(part => NOISE_DIRECTORIES.has(part))) {
    return 'low'
  }

  // 2. Verifica se o nome do arquivo corresponde a um padrão conhecido de ruído
  //    Ex: package-lock.json → low
  //    Ex: .DS_Store → low
  if (NOISE_FILENAMES.has(filename)) {
    return 'low'
  }

  // 3. Verifica padrões especiais de nome que não cabem em Set simples
  //    Ex: .env.local, .env.production.local → low
  if (filename.startsWith('.env.') && filename.endsWith('.local')) {
    return 'low'
  }

  // 4. Verifica a extensão do arquivo usando extname (mais idiomático que cálculo manual)
  //    Ex: logo.png → low
  //    Ex: bundle.js.map → low
  const ext = extname(filename).toLowerCase()
  if (ext && NOISE_EXTENSIONS.has(ext)) {
    return 'low'
  }

  // 5. Não é ruído reconhecido — passa para a próxima camada de classificação
  return null
}

// ─── Camada 2: Heurísticas de Nome e Caminho ────────────────────────────────

/**
 * Conjuntos de padrões para detecção de entry points.
 * Arquivos com esses nomes (sem extensão) marcam o ponto de entrada do sistema.
 */
const ENTRY_POINTS = new Set(['main', 'index', 'app', 'server', 'bootstrap'])

/**
 * Conjuntos de padrões para detecção de roteadores.
 * Arquivos com esses nomes (sem extensão) definem rotas da aplicação.
 */
const ROUTERS = new Set(['router', 'routes'])

/**
 * Padrões de diretório de arquitetura alta (camadas de domínio/entidades).
 */
const ARCH_CORE_DIRS = ['/core/', '/domain/', '/entities/']

/**
 * Padrões de diretório de serviço (camada de lógica de negócio).
 */
const ARCH_SERVICE_DIRS = ['/services/', '/usecases/', '/application/']

/**
 * Padrões de diretório de controle (camada de endpoints/eventos).
 */
const ARCH_CONTROLLER_DIRS = ['/controllers/', '/handlers/']

/**
 * Padrões de diretório compartilhado (utilitários reutilizáveis).
 */
const ARCH_SHARED_DIRS = ['/shared/', '/common/', '/utils/']

/**
 * Calcula pontuação baseada em padrões de nome e caminho.
 *
 * Esta é a segunda camada do sistema de classificação de importância.
 * Ela analisa o nome do arquivo e o caminho para identificar padrões
 * arquiteturais conhecidos (entry points, camadas de domínio, contratos, etc.)
 * e atribuir uma pontuação numérica.
 *
 * A função é pura e determinística: mesma entrada sempre produz a mesma saída.
 *
 * Tabela de pontuação resumida:
 * - Entry points (main, index, app, server, bootstrap): +40
 * - Routers (router, routes): +35
 * - Camada core/domain/entities (no caminho): +30
 * - Types/interfaces/schemas: +30
 * - Camada services/usecases/application: +25
 * - Camada controllers/handlers: +20
 * - Config/constants: +15
 * - Raiz do projeto: +15
 * - Um nível de profundidade: +10
 * - Caminho shared/common/utils: +10
 * - Caminho components/pages/views: +5
 * - Estilo (.css, .scss, etc.): -10
 * - Testes no nome: -15
 * - Testes no caminho: -10
 * - Cinco ou mais níveis de profundidade: -5
 *
 * @example
 * scoreByNameAndPath('main.ts')           // → 55 (40 entry + 15 raiz)
 * scoreByNameAndPath('src/core/auth.ts')   // → 40 (30 core + 10 um nível)
 * scoreByNameAndPath('src/shared/types.ts') // → 40 (10 shared + 30 types)
 *
 * @param relativePath - Caminho relativo do arquivo (ex: "src/main.ts")
 * @returns Pontuação numérica (pode ser negativa)
 */
export function scoreByNameAndPath(relativePath: string): number {
  // Normaliza separadores para forward slash, garantindo consistência
  // independente do sistema operacional
  const normalized = relativePath.replace(/\\/g, '/')

  // Divide em partes para análise
  const pathParts = normalized.split('/')
  const filename = pathParts[pathParts.length - 1] || ''

  // Extrai o nome sem extensão para análise de entry points e contratos
  const dotIndex = filename.lastIndexOf('.')
  const nameWithoutExt = dotIndex !== -1 ? filename.slice(0, dotIndex) : filename

  const ext = extname(filename).toLowerCase()
  const nameLower = nameWithoutExt.toLowerCase()
  const filenameLower = filename.toLowerCase()
  const pathLower = normalized.toLowerCase()

  let score = 0

  // ── 1. Nomes de Entry Point ──────────────────────────────────────────────
  // Arquivos que são o ponto de entrada do sistema ganham pontuação alta
  if (ENTRY_POINTS.has(nameLower)) {
    score += 40
  }

  if (ROUTERS.has(nameLower)) {
    score += 35
  }

  // ── 2. Caminhos de Arquitetura ───────────────────────────────────────────
  // As regras acumulam: se o caminho contém 'core' e 'services', ambos os
  // bônus são aplicados
  if (ARCH_CORE_DIRS.some(dir => pathLower.includes(dir))) {
    score += 30
  }

  if (ARCH_SERVICE_DIRS.some(dir => pathLower.includes(dir))) {
    score += 25
  }

  if (ARCH_CONTROLLER_DIRS.some(dir => pathLower.includes(dir))) {
    score += 20
  }

  if (ARCH_SHARED_DIRS.some(dir => pathLower.includes(dir))) {
    score += 10
  }

  // ── 3. Arquivos de Contrato ──────────────────────────────────────────────
  // Arquivos que definem contratos, tipos, interfaces ou esquemas

  // Verifica se o nome do arquivo (sem extensão) é um dos padrões de contrato
  const CONTRACT_NAMES = ['types', 'interfaces', 'schemas', 'contracts']
  if (CONTRACT_NAMES.some(pattern => nameLower === pattern)) {
    score += 30
  }

  // Verifica se o nome do arquivo (sem extensão) é um padrão de configuração
  const CONFIG_NAMES = ['constants', 'config']
  if (CONFIG_NAMES.some(pattern => nameLower === pattern)) {
    score += 15
  }

  // ── 4. Arquivos de UI ────────────────────────────────────────────────────
  if (pathLower.includes('/components/') || pathLower.includes('/pages/') || pathLower.includes('/views/')) {
    score += 5
  }

  // Arquivos de estilo ganham penalidade (são importante baixa)
  const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.sass', '.less'])
  if (STYLE_EXTENSIONS.has(ext)) {
    score -= 10
  }

  // ── 5. Profundidade do Caminho ────────────────────────────────────────────
  const depth = pathParts.length - 1 // número de segmentos antes do nome do arquivo
  if (depth === 0) {
    score += 15 // Arquivo na raiz do projeto
  } else if (depth === 1) {
    score += 10 // Arquivo em subpasta direta
  } else if (depth >= 5) {
    score -= 5 // Muito aninhado (ruído estrutural)
  }

  // ── 6. Padrões de Teste ──────────────────────────────────────────────────
  // Arquivos de teste perdem pontos (não são arquiteturais)
  const TEST_PATTERNS = ['.test.', '.spec.', '_test.']
  if (TEST_PATTERNS.some(pattern => filenameLower.includes(pattern))) {
    score -= 15
  }

  const TEST_DIRS = ['/tests/', '/__tests__/', '/spec/']
  if (TEST_DIRS.some(dir => pathLower.includes(dir))) {
    score -= 10
  }

  return score
}

// ─── Camada 3: Heurísticas de Conteúdo ──────────────────────────────────────

/** Limite de primeiras linhas lidas para análise de comentários no topo. */
const CONTENT_LINE_LIMIT = 30

/** Regex para detectar blocos de comentário estruturado (JSDoc, C-style: /* ... * /). */
const STRUCTURED_COMMENT_REGEX = /\/\*\*[\s\S]*?\*\//m

/** Regex para detectar docstrings Python no topo do arquivo. */
const PYTHON_DOCSTRING_REGEX = /^("""[\s\S]*?"""|'''[\s\S]*?''')/m

/** Regex para detectar markers de débito técnico. */
const TECH_DEBT_REGEX = /\b(TODO|FIXME|HACK|XXX)\b/gi

/**
 * Extrai sinais da tríade de documentação arquitetural (gancho para futuro).
 *
 * Esta função está preparada para quando os arquivos do projeto começarem
 * a seguir a convenção da tríade (Responsabilidades, Relacionamentos, Invariantes).
 * Por enquanto, retorna 0 pois a tríade ainda não existe nos arquivos.
 *
 * No futuro, detectará delimitadores "--- ARQUITETURA DO SCRIPT ---" e
 * "--- FIM ARQUITETURA DO SCRIPT ---", analisará a completude da tríade
 * (Responsabilidades, Mapa de Relacionamentos, Invariantes) e retornará
 * uma pontuação baseada na qualidade da documentação.
 *
 * @param _content - Conteúdo do arquivo (primeiras linhas)
 * @returns Pontuação baseada na tríade (sempre 0 por enquanto)
 */
export function extractTriadSignals(_content: string): number {
  // TODO: Implementar quando a tríade estiver sendo aplicada nos arquivos
  return 0
}

/**
 * Calcula pontuação baseada no conteúdo do arquivo.
 *
 * Esta é a terceira camada do sistema de classificação de importância.
 * Ela lê o arquivo uma única vez e analisa:
 * - Presença de comentários estruturados (JSDoc, C-style) no topo
 * - Presença de docstrings Python no topo
 * - Quantidade de markers de débito técnico (TODO, FIXME, HACK)
 * - Tamanho total do arquivo em linhas
 *
 * A função é assíncrona porque faz I/O (leitura de arquivo), mas é
 * determinística: mesma entrada sempre produz a mesma saída.
 *
 * Otimização: o arquivo é lido apenas uma vez. Todas as análises
 * compartilham o mesmo conteúdo em memória.
 *
 * @example
 * // Arquivo com JSDoc no topo, 200 linhas
 * await scoreByContent('/project', 'src/main.ts')
 * // Retorna: 10 (+5 JSDoc + 5 tamanho saudável)
 *
 * // Arquivo sem comentários, 6 linhas (muito pequeno)
 * await scoreByContent('/project', 'src/stub.ts')
 * // Retorna: -5 (arquivo muito pequeno)
 *
 * // Arquivo não existe
 * await scoreByContent('/project', 'src/missing.ts')
 * // Retorna: 0 (não lança erro)
 *
 * @param repoPath - Caminho absoluto para a raiz do repositório
 * @param relativePath - Caminho relativo do arquivo (ex: "src/main.ts")
 * @returns Pontuação numérica (pode ser negativa)
 */
export async function scoreByContent(repoPath: string, relativePath: string): Promise<number> {
  const filePath = join(repoPath, relativePath)

  // Se o arquivo não existe, retorna 0 silenciosamente (não lança erro)
  if (!existsSync(filePath)) {
    return 0
  }

  // Lê o arquivo completo uma única vez para todas as análises
  let fullContent: string
  try {
    fullContent = await readFile(filePath, { encoding: 'utf-8' })
  } catch {
    // Se falhar ao ler (permissão, binário, etc.), retorna 0
    return 0
  }

  // Extrai as primeiras N linhas para análise de comentários no topo
  const lines = fullContent.split('\n')
  const firstLines = lines.slice(0, CONTENT_LINE_LIMIT).join('\n')
  const lineCount = lines.length

  let score = 0

  // 1. Detecta blocos de comentário estruturado (JSDoc, C-style) no topo
  //    Ex: /** ... */ ou /* ... */
  if (STRUCTURED_COMMENT_REGEX.test(firstLines)) {
    score += 5
  }

  // 2. Detecta docstrings Python no topo
  //    Ex: """ ... """ ou ''' ... '''
  if (PYTHON_DOCSTRING_REGEX.test(firstLines)) {
    score += 5
  }

  // 3. Conta markers de débito técnico (TODO, FIXME, HACK, XXX)
  //    Penalidade apenas se houver mais de 3 ocorrências
  const techDebtMatches = firstLines.match(TECH_DEBT_REGEX)
  if (techDebtMatches && techDebtMatches.length > 3) {
    score -= 3
  }

  // 4. Analisa tamanho total do arquivo (linhas)
  if (lineCount < 10) {
    score -= 5 // Arquivo muito pequeno (stub, placeholder)
  } else if (lineCount >= 100 && lineCount <= 500) {
    score += 5 // Tamanho saudável (coeso, focado)
  } else if (lineCount > 1000) {
    score -= 5 // Arquivo muito grande (possível monólito)
  }

  // 5. Gancho para tríade (retorna 0 por enquanto)
  score += extractTriadSignals(firstLines)

  return score
}

// ─── Camada 4: Consolidação e Mapeamento ────────────────────────────────────

/**
 * Limites de pontuação para cada nível de importância.
 *
 * A pontuação total (namePathScore + contentScore) é mapeada para um nível:
 * - >= 50: critical (arquivos sem os quais o sistema não funciona)
 * - 25-49: high (importantes para entender a lógica de negócio)
 * - 10-24: medium (contexto útil, mas não essencial)
 * - < 10: low (ruído arquitetural)
 */
const SCORE_THRESHOLDS = {
  critical: 50,
  high: 25,
  medium: 10
}

/**
 * Consolida as pontuações das camadas anteriores e mapeia para o nível final.
 *
 * Esta é a quarta e última camada do sistema de classificação de importância.
 * Ela recebe os resultados das camadas 1, 2 e 3 e produz o nível final.
 *
 * Regras de consolidação:
 * 1. Se a Camada 1 (filtro de exclusão) retornou 'low', retorna 'low'
 *    imediatamente. O filtro de exclusão sempre vence, independente das
 *    outras pontuações.
 * 2. Caso contrário, soma as pontuações das Camadas 2 e 3.
 * 3. Mapeia a pontuação total para o nível de importância baseado nos
 *    thresholds definidos em SCORE_THRESHOLDS.
 *
 * A função é pura e determinística: mesma entrada sempre produz a mesma saída.
 *
 * @example
 * // Arquivo de ruído (filtro de exclusão venceu)
 * consolidateScore('low', 50, 10)
 * // Retorna: 'low'
 *
 * // Arquivo crítico (total: 55 >= 50)
 * consolidateScore(null, 40, 15)
 * // Retorna: 'critical'
 *
 * // Arquivo de alta importância (total: 49, entre 25-49)
 * consolidateScore(null, 34, 15)
 * // Retorna: 'high'
 *
 * // Arquivo de média importância (total: 24, entre 10-24)
 * consolidateScore(null, 14, 10)
 * // Retorna: 'medium'
 *
 * // Arquivo de baixa importância (total: 9 < 10)
 * consolidateScore(null, 5, 4)
 * // Retorna: 'low'
 *
 * @param extensionScore - Resultado da Camada 1 (filtro de exclusão).
 *                         Se for 'low', o arquivo é classificado como 'low'
 *                         imediatamente.
 * @param namePathScore - Pontuação da Camada 2 (heurísticas de nome e caminho).
 * @param contentScore - Pontuação da Camada 3 (heurísticas de conteúdo).
 * @returns Nível de importância final (critical, high, medium, ou low).
 */
export function consolidateScore(
  extensionScore: ImportanceLevel | null,
  namePathScore: number,
  contentScore: number
): ImportanceLevel {
  // 1. Filtro de exclusão sempre vence
  // Se a Camada 1 classificou como 'low', não há como superar
  if (extensionScore === 'low') {
    return 'low'
  }

  // 2. Soma as pontuações das Camadas 2 e 3
  const totalScore = namePathScore + contentScore

  // 3. Mapeia para o nível baseado nos thresholds
  if (totalScore >= SCORE_THRESHOLDS.critical) {
    return 'critical'
  }

  if (totalScore >= SCORE_THRESHOLDS.high) {
    return 'high'
  }

  if (totalScore >= SCORE_THRESHOLDS.medium) {
    return 'medium'
  }

  return 'low'
}
