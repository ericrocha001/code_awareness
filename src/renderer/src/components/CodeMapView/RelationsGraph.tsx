/*
-T ---
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
    const nodeColor = isDark ? '#26283e' : '#f2f0fb'
    const nodeBorder = isDark ? '#57506d' : '#c6bfdd'
    const edgeColor = isDark ? '#65618c' : '#9e94bd'
    const labelColor = isDark ? '#e5e7eb' : '#374151'
    const accentColor = isDark ? '#a78bfa' : '#7852ee'

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
            'background-color': (ele: cytoscape.NodeSingular) => ele.data('isCentral') ? accentColor : nodeColor,
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
            'curve-style': 'bezier',
            opacity: 0.7
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

    if (cy.zoom() > 1.5) {
      cy.zoom(1.5)
      cy.center()
    }

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
