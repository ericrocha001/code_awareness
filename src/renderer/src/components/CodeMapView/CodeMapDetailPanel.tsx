/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

 1. Renderizar o painel de leitura do arquivo selecionado (identidade, dependências, informação estrutural).
 2. Exibir o grafo de dependências como chips clicáveis que navegam entre arquivos.
 3. Exibir os elementos do arquivo agrupados por tipo, com expansão inline sob demanda.
 4. Carregar o trecho de código do elemento focado via IPC sob demanda.
 5. Exibir relacionamentos de classe (extends/implements) com nome da classe alvo.
 6. Renderizar blocos de código estilo ChatGPT com syntax highlighting.
 7. Orientar o usuário para a coluna de código quando o arquivo não possui informação estrutural.
 8. Expor os botões de escopo (completo e comprimido em variante fantasma) abaixo do grafo de relacionamentos para cópia e exportação, com feedback visual de loading isolado por botão durante a geração.
 9. Exibir as tags do arquivo selecionado como chips coloridos e delegar a edição ao TagPopover compartilhado.

Mapa de Relacionamentos do Script

1. CodeMapView.tsx
   - Tipo: Dependência Inversa
   - Relação: É instanciado pelo orquestrador com o arquivo selecionado e callbacks de navegação.
   - Criticidade: Alta

2. fileRelationships.ts
   - Tipo: Fluxo de Dados
   - Relação: Consome o FileGraph para derivar as listas Importa/Importado por.
   - Criticidade: Alta

3. constants.ts
   - Tipo: Dependência Direta
   - Relação: Fornece ELEMENT_GROUP_LABELS e ELEMENT_MICRO_LABELS.
   - Criticidade: Alta

 4. window.codeAwareness.getElementSnippet / openInVSCode
    - Tipo: Dependência Inversa
    - Relação: APIs IPC para buscar o trecho do elemento focado e abrir no VS Code.
    - Criticidade: Alta

5. ../../../../shared/types
   - Tipo: Contrato / Interface
   - Relação: Fornece os tipos CodeMapFile, CodeMapElement e CodeMapRelationship.
   - Criticidade: Alta

6. file-icon-mapper.ts / element-icon-mapper.ts
   - Tipo: Dependência Direta
   - Relação: Fornecem ícones de arquivo e de elemento.
   - Criticidade: Média

 7. CodeMapDetailPanel.css
    - Tipo: Relação de UI
    - Relação: Consome os estilos do painel (prefixo cmp-).
    - Criticidade: Alta

 8. CodeSnippetBlock.tsx
    - Tipo: Dependência Direta
    - Relação: Renderiza o trecho do elemento focado com syntax highlighting.
    - Criticidade: Alta

 9. CodeMapCodeView.tsx
    - Tipo: Fluxo de Dados
    - Relação: A coluna de código exibe o arquivo integral — o painel não duplica esse conteúdo.
    - Criticidade: Média

10. TagPopover.tsx (shared)
    - Tipo: Dependência Direta
    - Relação: Edita as tags do arquivo com busca, teclado e persistência via IPC.
    - Criticidade: Alta
Invariantes do Script

1. O painel nunca chama IPC de forma síncrona — o trecho é carregado sob demanda com estados de loading/error.
2. O container raiz usa a classe cmd-panel (protegida pela guarda de teclado do CodeMapTree).
3. Relacionamentos de classe só aparecem quando existem — seções vazias são regressão.
4. O chip de dependência navega pelo grafo sem disparar busca/scroll na árvore.
5. O useEffect de carregamento de snippet tem cleanup — nenhum listener duplicado.
6. Lookups por Map (O(1)) — nunca find() linear em listas grandes.
 7. O feedback "✓ Copiado" dura 2 segundos; o loading "Abrindo..." dura a chamada IPC.
 8. O painel nunca carrega o arquivo integral — isso é responsabilidade exclusiva da coluna de código.
 9. Durante a geração de escopo, apenas o botão acionado exibe ícone de rotação e texto de progresso — o outro permanece estático.
 10. As tags exibidas são derivadas de allTags e fileTagsMap recebidos do pai — este painel não persiste nem gerencia estado de tags; a edição é responsabilidade do TagPopover.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { ArrowLeft, FileText, Copy, Download, Package, Loader2 } from 'lucide-react'
import type { CodeMapElement, CodeMapFile, CodeMapRelationship, Tag } from '../../../../shared/types'
import { outputFormatToExtension } from '../../../../shared/utils/format-utils'
import { getFileIconClass } from '../../utils/file-icon-mapper'
import { getElementIconClass, getVsCodeIconClass } from '../../utils/element-icon-mapper'
import type { FileGraph } from './fileRelationships'
import { ELEMENT_GROUP_LABELS, ELEMENT_MICRO_LABELS, ELEMENT_ICON_COLORS } from './constants'
import { CodeSnippetBlock } from './CodeSnippetBlock'
import { RelationsGraph } from './RelationsGraph'
import { ActionMenu } from '../shared/ActionMenu/ActionMenu'
import { ActionMenuItem } from '../shared/ActionMenu/ActionMenuItem'
import { TagPopover } from '../shared/TagPopover/TagPopover'
import { TagChip } from '../shared/TagChip/TagChip'
import './CodeMapDetailPanel.css'

interface CodeMapDetailPanelProps {
  file: CodeMapFile
  fileGraph: FileGraph
  files: CodeMapFile[]
  elements: CodeMapElement[]
  elementsById: Map<string, CodeMapElement>
  relationships: CodeMapRelationship[]
  repoPath: string
  allTags: Tag[]
  fileTagsMap: Record<string, string[]>
  onTagsChanged?: () => void
  onOpenTagManager?: () => void
  focusedElementId: string | null
  canGoBack: boolean
  onBack: () => void
  onFocusElement: (elementId: string | null) => void
  onNavigateToFile: (fileId: string) => void
  onStatusMessage?: (message: string, isError?: boolean) => void
}

/** Formata bytes em unidade legível (ex: 1.2 KB). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Extrai o nome do arquivo a partir do caminho relativo. */
function getFileName(relativePath: string): string {
  return relativePath.split('/').pop() ?? relativePath
}

/** Monta a assinatura do elemento: visibilidade + modificadores + nome + parâmetros + retorno. */
function buildSignature(element: CodeMapElement): string {
  const parts: string[] = []
  if (element.visibility) parts.push(element.visibility)
  parts.push(...element.modifiers)
  parts.push(element.name)
  if (element.parameterCount > 0) parts.push(`(${element.parameterCount} params)`)
  if (element.returnType) parts.push(`→ ${element.returnType}`)
  return parts.join(' ')
}

export const CodeMapDetailPanel: React.FC<CodeMapDetailPanelProps> = ({
  file,
  fileGraph,
  files,
  elements,
  elementsById,
  relationships,
  repoPath,
  allTags,
  fileTagsMap,
  onTagsChanged,
  onOpenTagManager,
  focusedElementId,
  canGoBack,
  onBack,
  onFocusElement,
  onNavigateToFile,
  onStatusMessage
}) => {
  const [snippet, setSnippet] = useState<{ content: string; truncated: boolean } | null>(null)
  const [snippetLoading, setSnippetLoading] = useState(false)
  const [snippetError, setSnippetError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [openingVscode, setOpeningVscode] = useState(false)
  // Identifica qual modo de escopo está gerando ('full' | 'compressed' | null).
  // Estado separado por botão para que o spinner apareça apenas no acionado.
  const [generatingScopeMode, setGeneratingScopeMode] = useState<'full' | 'compressed' | null>(null)

  // Mapa fileId → arquivo para lookup O(1) das dependências
  const filesById = useMemo(() => {
    const map = new Map<string, CodeMapFile>()
    for (const f of files) {
      map.set(f.id, f)
    }
    return map
  }, [files])

  // Elemento focado (se existir) — lookup O(1) via elementsById
  const focusedElement = useMemo(() => {
    if (!focusedElementId) return null
    return elementsById.get(focusedElementId) ?? null
  }, [elementsById, focusedElementId])

  // Lista de arquivos importados (Importa)
  const imports = useMemo(() => {
    const ids = fileGraph.imports.get(file.id) ?? []
    return ids.map((id) => filesById.get(id)).filter((f): f is CodeMapFile => Boolean(f))
  }, [fileGraph, file.id, filesById])

  // Lista de arquivos que importam este (Importado por)
  const importedBy = useMemo(() => {
    const ids = fileGraph.importedBy.get(file.id) ?? []
    return ids.map((id) => filesById.get(id)).filter((f): f is CodeMapFile => Boolean(f))
  }, [fileGraph, file.id, filesById])

  // Elementos agrupados por kind
  const groupedElements = useMemo(() => {
    const groups = new Map<string, CodeMapElement[]>()
    for (const element of elements) {
      const list = groups.get(element.kind)
      if (list) {
        list.push(element)
      } else {
        groups.set(element.kind, [element])
      }
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [elements])

  // Relacionamentos de classe (extends/implements) — somente quando existirem
  const classRelationships = useMemo(() => {
    if (!focusedElement || focusedElement.kind !== 'class') return null
    const rels = relationships.filter(
      (r) =>
        (r.type === 'extends' || r.type === 'implements') &&
        (r.sourceId === focusedElement.id || r.targetId === focusedElement.id)
    )
    return rels.length > 0 ? rels : null
  }, [focusedElement, relationships])

  // Carrega o trecho de código sob demanda quando o elemento entra em foco
  useEffect(() => {
    if (!focusedElement) {
      setSnippet(null)
      setSnippetError(null)
      return
    }

    let cancelled = false
    setSnippetLoading(true)
    setSnippetError(null)

    window.codeAwareness
      .getElementSnippet(repoPath, focusedElement.id)
      .then((result) => {
        if (cancelled) return
        if (result.success && result.data) {
          setSnippet({ content: result.data.content, truncated: result.data.truncated })
        } else {
          setSnippetError(result.error ?? 'Não foi possível carregar o trecho.')
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setSnippetError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (!cancelled) setSnippetLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [focusedElement, repoPath])

  const handleCopySnippet = useCallback(async () => {
    if (!snippet) return
    try {
      await navigator.clipboard.writeText(snippet.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard indisponível — silencioso
    }
  }, [snippet])

  const handleOpenInVSCode = useCallback(async () => {
    if (!focusedElement || openingVscode) return
    setOpeningVscode(true)
    try {
      await window.codeAwareness.openInVSCode(repoPath, focusedElement.id)
    } finally {
      setOpeningVscode(false)
    }
  }, [focusedElement, repoPath, openingVscode])

  const handleGenerateScope = useCallback(
    async (mode: 'full' | 'compressed', action: 'copy' | 'export') => {
      if (generatingScopeMode) return
      setGeneratingScopeMode(mode)
      try {
        const res =
          mode === 'full'
            ? await window.codeAwareness.generateScope(repoPath, file.id)
            : await window.codeAwareness.generateCompressedScope(repoPath, file.id)

        if (res.success && res.markdown) {
          if (action === 'copy') {
            await navigator.clipboard.writeText(res.markdown)
            onStatusMessage?.(
              mode === 'full'
                ? 'Escopo completo copiado para a área de transferência'
                : 'Escopo comprimido copiado para a área de transferência'
            )
          } else if (action === 'export' && res.fileName) {
            // Envia o nome-base e o formato; o backend deriva a extensão (fonte única).
            const saveRes = await window.codeAwareness.saveToDownloads(res.markdown, res.fileName, 'markdown')
            if (saveRes.success) {
              onStatusMessage?.(`Escopo exportado: ${res.fileName}${outputFormatToExtension('markdown')}`)
            } else {
              onStatusMessage?.(`Erro ao salvar no Downloads: ${saveRes.error}`, true)
            }
          }
        } else {
          onStatusMessage?.(`Erro ao gerar escopo: ${res.error}`, true)
        }
      } catch (err) {
        onStatusMessage?.(`Erro ao gerar escopo: ${err instanceof Error ? err.message : String(err)}`, true)
      } finally {
        setGeneratingScopeMode(null)
      }
    },
    [repoPath, file.id, generatingScopeMode, onStatusMessage]
  )

  const handleToggleElement = useCallback(
    (elementId: string) => {
      onFocusElement(focusedElementId === elementId ? null : elementId)
    },
    [focusedElementId, onFocusElement]
  )

  const hasDependencies = imports.length > 0 || importedBy.length > 0

  // Tags do arquivo selecionado: associação real vinda do pai + metadados de cor/nome
  const fileTagIds = fileTagsMap[file.relativePath] ?? []
  const fileTags = allTags.filter((t) => fileTagIds.includes(t.id))

  return (
    <div className="cmd-panel cmp-panel">
      {/* ─── Identidade ─────────────────────────────────────────────── */}
      <div className="cmp-identity">
        <button
          className="cmp-back-btn"
          title="Voltar"
          onClick={onBack}
          disabled={!canGoBack}
        >
          <ArrowLeft size={16} />
        </button>
        <i className={`${getFileIconClass(getFileName(file.relativePath))} cmp-file-icon`} />
        <div className="cmp-identity-info">
          <h3 className="cmp-file-name">{getFileName(file.relativePath)}</h3>
          <span className="cmp-file-path">{file.relativePath}</span>
        </div>
        <div className="cmp-identity-meta">
          <span className="cmp-meta-item">{file.language}</span>
          <span className="cmp-meta-item">{file.lines} linhas</span>
          <span className="cmp-meta-item">{formatBytes(file.sizeBytes)}</span>
          {file.status === 'modified' && (
            <span className="cmp-meta-item cmp-meta-item--modified">● modificado</span>
          )}
        </div>
      </div>

      {/* ─── Tags ──────────────────────────────────────────────────── */}
      <div className="cmp-section">
        <h4 className="cmp-section-title">Tags</h4>
        <div className="cmp-tags">
          {fileTags.map((tag) => (
            <TagChip key={tag.id} tag={tag} />
          ))}
          <TagPopover
            repoPath={repoPath}
            relativePath={file.relativePath}
            allTags={allTags}
            activeTagIds={fileTagIds}
            onTagsChanged={onTagsChanged}
            onOpenTagManager={onOpenTagManager}
          />
        </div>
      </div>

      {/* ─── Dependências ───────────────────────────────────────────── */}
      <div className="cmp-section">
        <h4 className="cmp-section-title">Dependências</h4>
        {!hasDependencies ? (
          <p className="cmp-empty-text">Este arquivo não possui dependências internas mapeadas.</p>
        ) : (
          <>
            {imports.length > 0 && (
              <div className="cmp-dep-group">
                <span className="cmp-dep-label">Importa</span>
                <div className="cmp-dep-chips">
                  {imports.map((dep) => (
                    <button
                      key={dep.id}
                      className="cmp-dep-chip"
                      onClick={() => onNavigateToFile(dep.id)}
                      title={dep.relativePath}
                    >
                      {getFileName(dep.relativePath)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {importedBy.length > 0 && (
              <div className="cmp-dep-group">
                <span className="cmp-dep-label">Importado por</span>
                <div className="cmp-dep-chips">
                  {importedBy.map((dep) => (
                    <button
                      key={dep.id}
                      className="cmp-dep-chip"
                      onClick={() => onNavigateToFile(dep.id)}
                      title={dep.relativePath}
                    >
                      {getFileName(dep.relativePath)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ─── Grafo de Relacionamentos ───────────────────────────────── */}
      <div className="cmp-section">
        <h4 className="cmp-section-title">Grafo de Relacionamentos</h4>
        {hasDependencies ? (
          <>
            <RelationsGraph
              file={file}
              fileGraph={fileGraph}
              files={files}
              onNavigateToFile={onNavigateToFile}
            />
            <div className="cmp-scope-actions">
              <ActionMenu
                variant="ghost"
                icon={generatingScopeMode === 'full' ? <Loader2 size={15} className="cmp-spin" /> : <FileText size={15} />}
                label={generatingScopeMode === 'full' ? 'Gerando escopo...' : 'Obter escopo completo desse gráfico'}
                disabled={generatingScopeMode !== null}
              >
                <ActionMenuItem
                  icon={<Copy size={15} />}
                  onClick={() => handleGenerateScope('full', 'copy')}
                  disabled={generatingScopeMode !== null}
                >
                  Copiar para área de transferência
                </ActionMenuItem>
                <ActionMenuItem
                  icon={<Download size={15} />}
                  onClick={() => handleGenerateScope('full', 'export')}
                  disabled={generatingScopeMode !== null}
                >
                  Exportar Markdown para Downloads
                </ActionMenuItem>
              </ActionMenu>

              <ActionMenu
                variant="ghost"
                icon={generatingScopeMode === 'compressed' ? <Loader2 size={15} className="cmp-spin" /> : <Package size={15} />}
                label={generatingScopeMode === 'compressed' ? 'Gerando escopo comprimido...' : 'Obter escopo comprimido desse gráfico'}
                disabled={generatingScopeMode !== null}
              >
                <ActionMenuItem
                  icon={<Copy size={15} />}
                  onClick={() => handleGenerateScope('compressed', 'copy')}
                  disabled={generatingScopeMode !== null}
                >
                  Copiar para área de transferência
                </ActionMenuItem>
                <ActionMenuItem
                  icon={<Download size={15} />}
                  onClick={() => handleGenerateScope('compressed', 'export')}
                  disabled={generatingScopeMode !== null}
                >
                  Exportar Markdown para Downloads
                </ActionMenuItem>
              </ActionMenu>
            </div>
          </>
        ) : (
          <p className="cmp-empty-text">Este arquivo não possui dependências internas mapeadas.</p>
        )}
      </div>

      {/* ─── Informação Estrutural ──────────────────────────────────── */}
      <div className="cmp-section">
        <h4 className="cmp-section-title">Informação Estrutural</h4>
        {groupedElements.length === 0 ? (
          <p className="cmp-empty-text">
            Este arquivo não possui informação estrutural. O código completo está disponível na coluna de código.
          </p>
        ) : (
          groupedElements.map(([kind, kindElements]) => (
            <div key={kind} className="cmp-element-group">
              <div className="cmp-element-group-header">
                <i
                  className={`${getElementIconClass(kind as CodeMapElement['kind'])} cmp-element-icon--${kind}`}
                  style={{ color: ELEMENT_ICON_COLORS[kind] }}
                />
                <span className="cmp-element-group-label">{ELEMENT_GROUP_LABELS[kind] ?? kind}</span>
                <span className="cmp-element-group-count">({kindElements.length})</span>
              </div>
              {kindElements.map((element) => {
                const isFocused = element.id === focusedElementId
                return (
                  <div key={element.id} className="cmp-element">
                    <div
                      className={`cmp-element-row${isFocused ? ' cmp-element-row--focused' : ''}`}
                      onClick={() => handleToggleElement(element.id)}
                    >
                      <span className="cmp-element-micro">{ELEMENT_MICRO_LABELS[element.kind] ?? element.kind}</span>
                      <span className="cmp-element-name">{element.name}</span>
                    </div>
                    {isFocused && (
                      <div className="cmp-element-detail">
                        <div className="cmp-element-signature">{buildSignature(element)}</div>
                        {element.hasDocumentation && (
                          <div className="cmp-element-doc">Possui documentação</div>
                        )}

                        {/* Relacionamentos de classe (somente quando existirem) */}
                        {classRelationships && (
                          <div className="cmp-class-rels">
                            {classRelationships.map((rel) => {
                              const targetName = elementsById.get(rel.targetId)?.name ?? rel.targetId.slice(0, 12)
                              return (
                                <span key={rel.id} className="cmp-class-rel">
                                  {rel.type === 'extends' ? 'estende' : 'implementa'} {targetName}
                                </span>
                              )
                            })}
                          </div>
                        )}

                        <div className="cmp-element-actions">
                          <button
                            className="cmp-action-btn"
                            onClick={handleCopySnippet}
                            disabled={!snippet || snippetLoading}
                          >
                            {copied ? '✓ Copiado' : 'Copiar trecho'}
                          </button>
                          <button
                            className="cmp-action-btn"
                            onClick={handleOpenInVSCode}
                            disabled={openingVscode}
                          >
                            <i className={getVsCodeIconClass()} />
                            {openingVscode ? 'Abrindo...' : 'Abrir no VS Code'}
                          </button>
                        </div>

                        {snippetLoading && <div className="cmp-snippet-loading">Carregando trecho...</div>}
                        {snippetError && <div className="cmp-snippet-error">{snippetError}</div>}
                        {snippet && !snippetLoading && (
                          <CodeSnippetBlock
                            code={snippet.content}
                            language={file.language}
                            fileName={getFileName(file.relativePath)}
                            truncated={snippet.truncated}
                          />
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>
    </div>
  )
}