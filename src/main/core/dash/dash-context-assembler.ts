/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Compor o documento XML canônico estruturado com metadados, falhas parciais e nós de código do Code Dash.
2. Encapsular com segurança conteúdos de arquivos em seções CDATA prevenindo corrupção por caracteres especiais.

Mapa de Relacionamentos do Script

1. src/shared/types/dash-types.ts
   - Tipo: Contrato / Interface
   - Relação: Consome DashContextPlan e tipos associados para montagem do XML.
   - Criticidade: Alta

2. src/shared/utils/dash-protocol.ts
   - Tipo: Dependência Direta
   - Relação: Fornece DASH_PROTOCOL_VERSION para atribuição de versão no nó raiz.
   - Criticidade: Alta

Invariantes do Script

1. Operar puramente em memória como função determinística sem efeitos colaterais ou I/O.
2. Todo conteúdo de item deve ser encapsulado em CDATA com tratamento para ocorrências de ']]>'.
3. A ordenação dos nós <item> deve coincidir estritamente com a ordem estabelecida em DashContextPlan.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import type { DashContextPlan } from '../../../shared/types/dash-types'
import { DASH_PROTOCOL_VERSION } from '../../../shared/utils/dash-protocol'

function escapeXmlAttr(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Monta o documento XML canônico a partir do plano de contexto e do mapa de conteúdos gerados.
 */
export function assembleContext(
  plan: DashContextPlan,
  results: Map<number, string>,
  generatedAt?: string
): string {
  const timestamp = generatedAt ?? new Date().toISOString()

  const failuresXml =
    plan.failures.length === 0
      ? '  <failures>\n  </failures>'
      : '  <failures>\n' +
        plan.failures
          .map(
            (f) =>
              `    <failure index="${f.index}" path="${escapeXmlAttr(f.path)}" reason="${escapeXmlAttr(f.reason)}" />`
          )
          .join('\n') +
        '\n  </failures>'

  const itemsXml =
    plan.plannedItems.length === 0
      ? '  <items>\n  </items>'
      : '  <items>\n' +
        plan.plannedItems
          .map((item) => {
            const rawContent = results.get(item.index) ?? ''
            const safeContent = rawContent.replace(/]]>/g, ']]]]><![CDATA[>')
            return `    <item index="${item.index}" path="${escapeXmlAttr(item.path)}" representation="${escapeXmlAttr(item.representation)}">\n<![CDATA[\n${safeContent}\n]]>\n    </item>`
          })
          .join('\n') +
        '\n  </items>'

  return `<?xml version="1.0" encoding="UTF-8"?>
<code-dash-context version="${DASH_PROTOCOL_VERSION}" generated-at="${escapeXmlAttr(timestamp)}">
  <metadata>
    <requested-count>${plan.metadata.requestedCount}</requested-count>
    <resolved-count>${plan.metadata.resolvedCount}</resolved-count>
    <failed-count>${plan.metadata.failedCount}</failed-count>
  </metadata>
${failuresXml}
${itemsXml}
</code-dash-context>`
}
