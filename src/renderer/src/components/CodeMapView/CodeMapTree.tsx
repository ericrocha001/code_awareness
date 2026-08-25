/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar árvore de navegação de pastas e arquivos do repositório.
2. Implementar lazy loading (expandir sob demanda).
3. Exibir indicador de estado por arquivo (apenas Modified).
4. Exibir chip com contagem de elementos por arquivo.
5. Navegar por teclado: ↑/↓ movem foco, → expande, ← colapsa, Enter seleciona, / foca busca.
6. Destacar arquivos relacionados ao arquivo selecionado (derivados fora do componente).
7. Persistir estado de expansão via props controladas (persistedExpanded/onToggle).
8. Alinhar a geometria ao padrão VS Code: fonte única de indentação por container aninhado, linha-guia centralizada na setinha.

Mapa de Relacionamentos do Script

1. CodeMapView.tsx
   - Tipo: Dependência Inversa
   - Relação: É instanciado pelo orquestrador, que fornece persistedExpanded, onToggle, relatedFileIds e elementCounts.
   - Criticidade: Alta

2. ../../../../shared/types
   - Tipo: Contrato / Interface
   - Relação: Fornece o tipo CodeMapFile.
   - Criticidade: Alta

3. file-icon-mapper.ts
   - Tipo: Dependência Direta
   - Relação: Fornece getFileIconClass para o ícone do arquivo.
   - Criticidade: Média

Invariantes do Script

1. A árvore é construída em memória apenas a partir de files.
2. Diretórios são nós virtuais (não existem como entidades no banco).
3. Arquivos são sempre folhas — nunca possuem filhos.
4. O lazy loading é implementado via estado de nós expandidos.
5. O indicador de estado exibe ● apenas para Modified; indexed não renderiza nada.
6. A navegação por teclado só opera em nós visíveis (ramos expandidos).
7. O listener global de teclado ignora eventos quando o foco está em input/textarea.
8. O destaque de relacionados usa nome em azul adaptado ao tema (escuro no claro, claro no escuro), sem opacidade e sem fundo.
9. A expansão é controlada pelo pai (persistedExpanded) — nunca estado interno.
10. O componente não calcula o grafo de relacionamentos — recebe relatedFileIds pronto.
11. A linha-guia é desenhada pelo container de filhos (cmv-tree-children), não pelo nó — atravessa a altura do bloco do pai até o centro do último filho.
12. As constantes de geometria (INDENT_PER_LEVEL, CHEVRON_SIZE, ICON_SIZE, LINE_OFFSET_FROM_LEFT) definem o alinhamento VS Code (indentação exclusiva via container).

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import type { CodeMapFile } from '../../../../shared/types'
import { ChevronRight } from 'lucide-react'
import { getFileIconClass } from '../../utils/file-icon-mapper'

// ─── Geometria VS Code ─────────────────────────────────────────────────────
// Recuo compacto por nível, larguras fixas de chevron/ícone e posição da
// linha-guia centralizada na setinha — padrão do File Explorer do VS Code.
const INDENT_PER_LEVEL = 12 // recuo por nível (compacto, padrão VS Code)
const CHEVRON_SIZE = 16 // largura fixa da área do chevron
const ICON_SIZE = 16 // largura fixa do ícone
const LINE_OFFSET_FROM_LEFT = 7 // posição horizontal da linha-guia (centralizada na setinha)

interface TreeNode {
  id: string
  name: string
  type: 'directory' | 'file'
  path?: string
  file?: CodeMapFile
  children: TreeNode[]
}

interface CodeMapTreeProps {
  files: CodeMapFile[]
  selectedFileId: string | null
  onSelectFile: (file: CodeMapFile) => void
  expandedNodesOverride?: Set<string>
  relatedFileIds?: Set<string>
  elementCounts?: Map<string, number>
  onSearchFocus?: () => void
  persistedExpanded?: Set<string>
  onToggle?: (nodeId: string) => void
}

/** Constrói a árvore hierárquica em memória a partir de files. O(n) para arquivos. */
function buildTree(files: CodeMapFile[]): TreeNode[] {
  const root: TreeNode = {
    id: 'root',
    name: '',
    type: 'directory',
    children: []
  }

  // Mapa de diretórios: chave = caminho do diretório, valor = nó
  const dirMap = new Map<string, TreeNode>()
  dirMap.set('', root)

  for (const file of files) {
    const parts = file.relativePath.split('/')
    const fileName = parts.pop() ?? file.relativePath
    const dirPath = parts.join('/')

    // Garante que todos os diretórios ancestrais existem
    let currentPath = ''
    let currentDir = root
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part
      let dirNode = dirMap.get(currentPath)
      if (!dirNode) {
        dirNode = {
          id: `dir:${currentPath}`,
          name: part,
          type: 'directory',
          path: currentPath,
          children: []
        }
        dirMap.set(currentPath, dirNode)
        currentDir.children.push(dirNode)
      }
      currentDir = dirNode
    }

    const fileNode: TreeNode = {
      id: `file:${file.id}`,
      name: fileName,
      type: 'file',
      path: file.relativePath,
      file,
      children: []
    }

    currentDir.children.push(fileNode)
  }

  // Ordena: diretórios primeiro, depois arquivos, ambos alfabeticamente
  const sortNodes = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1
      if (a.type !== 'directory' && b.type === 'directory') return 1
      return a.name.localeCompare(b.name)
    })
    for (const node of nodes) {
      if (node.children.length > 0) {
        sortNodes(node.children)
      }
    }
  }
  sortNodes(root.children)

  return root.children
}

export const CodeMapTree: React.FC<CodeMapTreeProps> = ({
  files,
  selectedFileId,
  onSelectFile,
  expandedNodesOverride,
  relatedFileIds,
  elementCounts,
  onSearchFocus,
  persistedExpanded = new Set<string>(),
  onToggle
}) => {
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)

  // Combina expansão persistida com override de busca
  const effectiveExpanded = useMemo(() => {
    if (!expandedNodesOverride || expandedNodesOverride.size === 0) {
      return persistedExpanded
    }
    const combined = new Set(persistedExpanded)
    for (const nodeId of expandedNodesOverride) {
      combined.add(nodeId)
    }
    return combined
  }, [persistedExpanded, expandedNodesOverride])

  const tree = useMemo(() => buildTree(files), [files])

  const toggleNode = useCallback(
    (nodeId: string) => {
      onToggle?.(nodeId)
    },
    [onToggle]
  )

  // Lista plana de nós visíveis (apenas nós em ramos expandidos)
  const visibleNodes = useMemo(() => {
    const result: TreeNode[] = []

    const traverse = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        result.push(node)
        if (node.children.length > 0 && effectiveExpanded.has(node.id)) {
          traverse(node.children)
        }
      }
    }

    traverse(tree)
    return result
  }, [tree, effectiveExpanded])

  // Handler global de teclado para navegação na árvore
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignora se o foco está em input/textarea (exceto para ESC)
      const activeElement = document.activeElement
      const isInputFocused =
        activeElement &&
        (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')

      if (e.key === '/' && !isInputFocused) {
        e.preventDefault()
        onSearchFocus?.()
        return
      }

      if (isInputFocused) return

      // BUGFIX: guarda inerte até a Sprint 2 — o painel de leitura nascerá com a
      // classe .cmd-panel; até lá não há drawer para proteger. Mantém o seletor
      // atualizado para quando o painel existir.
      const isInsidePanel = activeElement?.closest('.cmd-panel')
      if (isInsidePanel) return

      const currentIndex = visibleNodes.findIndex((n) => n.id === focusedNodeId)

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const nextIndex = currentIndex < visibleNodes.length - 1 ? currentIndex + 1 : 0
        setFocusedNodeId(visibleNodes[nextIndex].id)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : visibleNodes.length - 1
        setFocusedNodeId(visibleNodes[prevIndex].id)
      } else if (e.key === 'ArrowRight' && focusedNodeId) {
        e.preventDefault()
        const node = visibleNodes.find((n) => n.id === focusedNodeId)
        if (node && node.children.length > 0 && !effectiveExpanded.has(node.id)) {
          toggleNode(node.id)
        }
      } else if (e.key === 'ArrowLeft' && focusedNodeId) {
        e.preventDefault()
        const node = visibleNodes.find((n) => n.id === focusedNodeId)
        if (node && effectiveExpanded.has(node.id)) {
          toggleNode(node.id)
        }
      } else if (e.key === 'Enter' && focusedNodeId) {
        e.preventDefault()
        const node = visibleNodes.find((n) => n.id === focusedNodeId)
        if (node?.type === 'file' && node.file) {
          onSelectFile(node.file)
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [visibleNodes, focusedNodeId, effectiveExpanded, onSelectFile, onSearchFocus, toggleNode])

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const isExpanded = effectiveExpanded.has(node.id)
    const hasChildren = node.children.length > 0
    const isFocused = node.id === focusedNodeId
    const isRelated = node.type === 'file' && relatedFileIds?.has(node.file?.id ?? '')

    const handleClick = () => {
      if (node.type === 'file') {
        if (node.file) {
          onSelectFile(node.file)
        }
      } else if (hasChildren) {
        toggleNode(node.id)
      }
    }

    let icon: React.ReactNode
    let statusIndicator: React.ReactNode = null
    let countBadge: React.ReactNode = null

    if (node.type === 'directory') {
      icon = <i className="codicon codicon-folder" style={{ fontSize: 14 }} />
      countBadge = <span className="cmv-tree-count">{node.children.length}</span>
    } else {
      const iconClass = getFileIconClass(node.name)
      icon = <i className={iconClass} style={{ fontSize: 14 }} />
      if (node.file) {
        // Status: apenas Modified renderiza badge (● âmbar); indexed não exibe nada
        if (node.file.status === 'modified') {
          statusIndicator = <span className="cmv-tree-status cmv-tree-status--modified">●</span>
        }
        // Chip de contagem de itens de informação estrutural do arquivo
        const elementCount = elementCounts?.get(node.file.id) ?? 0
        if (elementCount > 0) {
          countBadge = (
            <span className="cmv-tree-count" title={`${elementCount} item(ns) de informação estrutural`}>
              {elementCount}
            </span>
          )
        }
      }
    }

    const isSelected = node.type === 'file' && node.file?.id === selectedFileId

    return (
      <div key={node.id} style={{ position: 'relative' }}>
        <div
          className={[
            'cmv-tree-node',
            isSelected && 'cmv-tree-node--selected',
            isFocused && 'cmv-tree-node--focused',
            isRelated && 'cmv-tree-node--related'
          ].filter(Boolean).join(' ')}
          data-type={node.type}
          onClick={handleClick}
          tabIndex={-1}
          ref={isFocused ? (el) => el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) : undefined}
        >
          {hasChildren ? (
            <span
              className={`cmv-tree-chevron${isExpanded ? ' cmv-tree-chevron--open' : ''}`}
              style={{ width: CHEVRON_SIZE, height: CHEVRON_SIZE }}
            >
              <ChevronRight size={14} />
            </span>
          ) : (
            <span className="cmv-tree-chevron" style={{ width: CHEVRON_SIZE, height: CHEVRON_SIZE }} />
          )}
          <span className="cmv-tree-icon" style={{ width: ICON_SIZE, height: ICON_SIZE }}>{icon}</span>
          <span className="cmv-tree-name">{node.name}</span>
          {statusIndicator}
          {countBadge}
        </div>
        {hasChildren && isExpanded && (
          <div className="cmv-tree-children" style={{ position: 'relative', paddingLeft: INDENT_PER_LEVEL }}>
            {/* Linha-guia vertical deste nível — atravessa o centro da setinha do pai. */}
            <div
              className="cmv-tree-guide"
              style={{ left: LINE_OFFSET_FROM_LEFT }}
            />
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  if (tree.length === 0) {
    return (
      <div className="cmv-tree" ref={treeRef}>
        <p style={{ color: 'var(--text-secondary)', padding: 16, fontSize: 13 }}>
          Nenhum arquivo indexado. Use o botão no topo para indexar ou sincronizar o repositório.
        </p>
      </div>
    )
  }

  return (
    <div className="cmv-tree" ref={treeRef}>
      {tree.map((node) => renderNode(node, 0))}
    </div>
  )
}