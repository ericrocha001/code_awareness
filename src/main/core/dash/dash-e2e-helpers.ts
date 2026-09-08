/*
-T ---
*/

import type {
  DashPlannedItem,
  DashRepresentation
} from '../../../shared/types/dash-types'
import { DASH_PROTOCOL_VERSION } from '../../../shared/utils/dash-protocol'
import type {
  ContextProvider,
  DashExecutionOptions,
  DashProviderFailure,
  DashProviderResult
} from './providers/context-provider'
import { DashFileResolver } from './dash-file-resolver'
import { DashService } from './dash-service'

export {
  createTempGitRepo,
  cleanupTempRepo,
  writeFile,
  deleteFile,
  stageAll,
  commit
} from '../git-test-helpers'

/** Constrói o texto bruto de uma requisição Code Dash a partir dos itens. */
export function buildDashInput(
  items: Array<{ path: string; representation: DashRepresentation }>
): string {
  const request = {
    protocol: DASH_PROTOCOL_VERSION,
    output: { format: 'xml' as const },
    items
  }
  return JSON.stringify(request)
}

/**
 * Provedor espião que registra todas as invocações e produz conteúdo determinístico.
 * Permite injetar falhas por índice, delay e rejeição em cancelamento (AbortSignal).
 */
export class SpyContextProvider implements ContextProvider {
  /** Itens recebidos em cada invocação de provide(). */
  public readonly calls: DashPlannedItem[][] = []
  /** Acumulado linear de todos os índices recebidos (facilita asserções). */
  public readonly receivedIndexes: number[] = []
  /** Profiles recebidos por item em cada chamada. */
  public readonly receivedProfiles: Array<Array<string | undefined>> = []

  private failAtIndexes = new Map<number, string>()
  private contentFor: (item: DashPlannedItem) => string = () => ''
  private delayMs = 0
  private throwOnAborted = true

  setFailures(failures: Record<number, string>): void {
    this.failAtIndexes = new Map(Object.entries(failures).map(([k, v]) => [Number(k), v]))
  }

  clearFailures(): void {
    this.failAtIndexes.clear()
  }

  setContentFactory(factory: (item: DashPlannedItem) => string): void {
    this.contentFor = factory
  }

  setDelay(ms: number): void {
    this.delayMs = ms
  }

  setThrowOnAborted(v: boolean): void {
    this.throwOnAborted = v
  }

  reset(): void {
    this.calls.length = 0
    this.receivedIndexes.length = 0
    this.receivedProfiles.length = 0
  }

  async provide(
    items: DashPlannedItem[],
    options: DashExecutionOptions
  ): Promise<DashProviderResult> {
    this.calls.push(items)
    this.receivedProfiles.push(items.map((it) => it.profile))
    for (const it of items) {
      this.receivedIndexes.push(it.index)
    }

    // Sleep em incrementos checando abort, simulando trabalho real cancelável.
    if (this.delayMs > 0) {
      const step = 50
      let elapsed = 0
      while (elapsed < this.delayMs) {
        if (options.signal?.aborted && this.throwOnAborted) {
          throw new Error('Operação cancelada pelo usuário')
        }
        await new Promise((r) => setTimeout(r, Math.min(step, this.delayMs - elapsed)))
        elapsed += step
      }
    }

    if (options.signal?.aborted && this.throwOnAborted) {
      throw new Error('Operação cancelada pelo usuário')
    }

    const contents = new Map<number, string>()
    const failures: DashProviderFailure[] = []
    for (const item of items) {
      const failReason = this.failAtIndexes.get(item.index)
      if (failReason !== undefined) {
        failures.push({ index: item.index, reason: failReason })
        continue
      }
      contents.set(item.index, this.contentFor(item))
    }
    return { contents, failures }
  }
}

/**
 * Monta um DashService REAL (parser/validator/planner/assembler reais) com
 * DashFileResolver real por repoPath e provedores espiões injetados.
 */
export function makeRealDashService(
  sourceProvider: ContextProvider,
  compressionProvider: ContextProvider
): DashService {
  return new DashService(
    (repoPath: string) => new DashFileResolver(repoPath),
    sourceProvider,
    compressionProvider
  )
}

/** Extrai o conteúdo do primeiro CDATA de um <item> pelo atributo index. */
export function extractItemCdata(xml: string, index: number): string | null {
  const regex = new RegExp(
    `<item index="${index}"[^>]*>\\s*<!\\[CDATA\\[\\n([\\s\\S]*?)\\n\\]\\]>\\s*</item>`
  )
  const match = xml.match(regex)
  return match ? match[1] : null
}

/** Lista de pares (index, path, representation) na ordem em que aparecem no XML. */
export function extractItemAttributes(
  xml: string
): Array<{ index: number; path: string; representation: string }> {
  const items: Array<{ index: number; path: string; representation: string }> = []
  const regex = /<item index="(\d+)" path="([^"]*)" representation="([^"]*)">/g
  let m: RegExpExecArray | null
  while ((m = regex.exec(xml)) !== null) {
    items.push({ index: Number(m[1]), path: m[2], representation: m[3] })
  }
  return items
}

export interface WellFormedCheck {
  ok: boolean
  problems: string[]
}

/**
 * Verificação sintática do XML canônico do Code Dash sem parser externo:
 * cabeçalho, nó raiz, metadados, balanceamento de <item>/CDATA e <failure>.
 */
export function checkWellFormedDashXml(xml: string): WellFormedCheck {
  const problems: string[] = []
  if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) {
    problems.push('cabeçalho XML ausente')
  }
  if (!xml.includes('<code-dash-context ')) problems.push('raiz code-dash-context ausente')
  if (!xml.trimEnd().endsWith('</code-dash-context>')) {
    problems.push('fechamento da raiz ausente')
  }
  for (const node of ['metadata', 'requested-count', 'resolved-count', 'failed-count', 'items', 'failures']) {
    if (!xml.includes(`<${node}`)) problems.push(`nó <${node}> ausente`)
  }
  const openItems = (xml.match(/<item /g) ?? []).length
  const closeItems = (xml.match(/<\/item>/g) ?? []).length
  if (openItems !== closeItems) {
    problems.push(`<item> desbalanceado: ${openItems} abertos vs ${closeItems} fechados`)
  }
  const openCdata = (xml.match(/<!\[CDATA\[/g) ?? []).length
  const closeCdata = (xml.match(/\]\]>/g) ?? []).length
  if (openCdata !== closeCdata) {
    problems.push(`CDATA desbalanceado: ${openCdata} vs ${closeCdata}`)
  }
  return { ok: problems.length === 0, problems }
}

/** Remove o timestamp generated-at para comparação determinística entre execuções. */
export function stripGeneratedAt(xml: string): string {
  return xml.replace(/generated-at="[^"]*"/g, 'generated-at="STRIPPED"')
}
