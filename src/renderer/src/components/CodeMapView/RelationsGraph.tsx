/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar o grafo de relacionamentos do arquivo selecionado com Cytoscape.
2. Consumir o adaptador puro (buildCytoscapeElements) para alimentar a instância.
3. Renderizar nós circulares com tamanho proporcional ao grau de conexões.
4. Exibir setas visíveis na direção do import (importador → importado).
5. Navegar entre arquivos ao clicar em nós periféricos.

Mapa de Relacionamentos do Script

1. CodeMapDetailPanel.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome este componente na seção "Grafo de Relacionamentos".
   - Criticidade: Alta

2. relationsGraphAdapter.ts
   - Tipo: Dependência Direta
   - Relação: Fornece buildCytoscapeElements com nós/arestas deduplicados.
   - Criticidade: Alta

3. fileRelationships.ts
   - Tipo: Fluxo de Dados
   - Relação: Fornece FileGraph com imports/importedBy já derivados.
   - Criticidade: Alta

4. useTheme.ts
   - Tipo: Dependência Direta
   - Relação: Fornece effectiveTheme para escolher cores concretas do grafo (canvas não resolve variáveis CSS).
   - Criticidade: Alta

5. cytoscape
   - Tipo: Dependência Direta
   - Relação: Renderiza nós, arestas, layout, zoom e pan.
   - Criticidade: Alta

6. RelationsGraph.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos do container (prefixo rg-).
   - Criticidade: Alta

Invariantes do Script

1. O componente nunca faz chamadas IPC — apenas deriva do FileGraph via adaptador.
2. A instância Cytoscape é destruída no cleanup (cy.destroy()) — sem vazamento.
3. Arestas apontam na direção do import (importador → importado).
4. O arquivo selecionado é sempre o nó central com borda accent.
5. Clique no nó periférico navega; clique no nó central é ignorado.
6. O container tem altura fixa para não quebrar o layout do painel.
7. As cores são concretas por tema (não variáveis CSS) porque o Cytoscape desenha num canvas que não resolve var(--nome).
8. O grafo redesenha automaticamente ao trocar de tema — effectiveTheme está nas dependências do useEffect.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useRef, useEffect } from 'react'
import cytoscape from 'cytoscape'
import { useTheme } from '../../hooks/useTheme'
import type { CodeMapFile } from '../../../../shared/types'
import type { FileGraph } from './fileRelationships'
import { buildCytoscapeElements } from './relationsGraphAdapter'
import './RelationsGraph.css'

interface RelationsGraphProps {
  file: CodeMapFile
  fileGraph: FileGraph
  files: CodeMapFile[]
  onNavigateToFile: (fileId: string) => void
}

/** Deriva o tamanho do nó (diâmetro) a partir do grau de conexões. */
function nodeSize(degree: number): number {
  return Math.min(26 + degree * 4, 48)
}

export const RelationsGraph: React.FC<RelationsGraphProps> = ({
  file,
  fileGraph,
  files,
  onNavigateToFile
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const { effectiveTheme } = useTheme()

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const elements = buildCytoscapeElements(file, fileGraph, files)
    if (elements.nodes.length === 0) return

    // Cores concretas por tema — o Cytoscape desenha num canvas que NÃO resolve variáveis CSS.
    // No tema escuro, var(--text-primary) cairia no preto padrão e os rótulos sumiriam.
    const isDark = effectiveTheme === 'dark'
    const nodeColor = isDark ? '#1f2937' : '#f3f4f6'
    const nodeBorder = isDark ? '#4b5563' : '#d1d5db'
    const edgeColor = isDark ? '#6b7280' : '#9ca3af'
    const labelColor = isDark ? '#e5e7eb' : '#374151'
    const accentColor = isDark ? '#60a5fa' : '#3b82f6'

    const cy = cytoscape({
      container,
      elements: {
        nodes: elements.nodes.map((n) => ({
          data: n.data,
          style: {
            width: `${nodeSize(n.data.degree)}px`,
            height: `${nodeSize(n.data.degree)}px`
          }
        })),
        edges: elements.edges
      },
      style: [
        {
          selector: 'node',
          style: {
            'background-color': nodeColor,
            'border-color': (ele: cytoscape.NodeSingular) =>
              ele.data('isCentral') ? accentColor : nodeBorder,
            'border-width': (ele: cytoscape.NodeSingular) =>
              ele.data('isCentral') ? '3' : '1',
            label: 'data(label)',
            'text-halign': 'right',
            'text-valign': 'center',
            'text-margin-x': 8,
            color: labelColor,
            'font-size': 11,
            'font-family': 'Inter, system-ui, sans-serif',
            'text-wrap': 'ellipsis',
            'text-max-width': '140'
          }
        },
        {
          selector: 'edge',
          style: {
            width: '1.5px',
            'line-color': edgeColor,
            'target-arrow-color': edgeColor,
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier'
          }
        }
      ],
      // Layout 'cose' (Compound Spring Embedder) é o layout force-directed padrão do Cytoscape.
      // Diferente do dagre (hierárquico), o 'cose' organiza nós por forças de repulsão/atração,
      // resultando em grafos mais orgânicos. Para grafos pequenos (<50 nós) como o de relacionamentos
      // de arquivo, o 'cose' é suficiente e não requer dependência adicional.
      layout: {
        name: 'cose',
        animate: false,
        fit: true,
        padding: 16
      }
    })

    // Navega ao clicar em nós periféricos; ignora o nó central
    cy.on('tap', 'node', (evt) => {
      const nodeId = evt.target.id()
      if (nodeId !== file.id) {
        onNavigateToFile(nodeId)
      }
    })

    return () => {
      cy.destroy()
    }
  }, [file, fileGraph, files, onNavigateToFile, effectiveTheme])

  return <div className="rg-root" data-theme={effectiveTheme} ref={containerRef} />
}