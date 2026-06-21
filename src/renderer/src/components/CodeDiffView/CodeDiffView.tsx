// Responsabilidades do Script
//
// 1. Gerenciar o ciclo de vida do WatcherService (iniciar, parar e escutar eventos de arquivo modificado).
// 2. Renderizar a interface dividida em lista de arquivos alterados e painel de diff semântico em tempo real.

import React, { useState, useEffect } from 'react'
import Markdown from 'markdown-to-jsx'
import { DiffFileStatus } from '../../../../shared/types'
import './CodeDiffView.css'

const CHANGE_TYPE_LABEL: Record<DiffFileStatus['changeType'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D'
}

const DEFAULT_PROMPT = `Analise as alterações de código abaixo como um Engenheiro de Software Staff extremamente rigoroso.

Seu papel é auditar o trabalho realizado pelo agente de implementação e validar se a tarefa foi cumprida de forma íntegra, segura e profissional.

Instruções da sua auditoria:
1. Avalie se os requisitos parecem ter sido completamente atendidos com base nas modificações apresentadas.
2. Identifique mentiras ou omissões (se o agente disse que fez algo, mas o diff mostra que ele não alterou as linhas necessárias).
3. Procure por bugs ocultos, problemas de lógica, quebras de arquitetura ou caminhos inacabados.
4. Identifique "code smells" ou soluções provisórias de baixa qualidade (gambiarras).
5. Forneça um veredito direto: "APROVADO" ou "REPROVADO COM AJUSTES" acompanhado de uma lista clara e numerada do que precisa ser corrigido (caso necessário).

Abaixo está o mapeamento semântico das funções alteradas:
--------------------------------------------------`

export const CodeDiffView: React.FC<{ activeProject: { path: string; name: string } | null }> = ({ activeProject }) => {
  const [isWatching, setIsWatching] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null)
  const [modifiedFiles, setModifiedFiles] = useState<DiffFileStatus[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [diffMarkdown, setDiffMarkdown] = useState<string>('')
  const [auditPromptTemplate, setAuditPromptTemplate] = useState('')
  const [isCopied, setIsCopied] = useState(false)
  const [isCopyMarkdown, setIsCopyMarkdown] = useState(false)
  const [isExporting, setIsExporting] = useState(false)

  // Inicializa o template do localStorage ou default
  useEffect(() => {
    const saved = localStorage.getItem('code_diff_prompt_template')
    if (saved) {
      setAuditPromptTemplate(saved)
    } else {
      setAuditPromptTemplate(DEFAULT_PROMPT)
      localStorage.setItem('code_diff_prompt_template', DEFAULT_PROMPT)
    }
  }, [])

  // Gerencia o watcher baseado no projeto selecionado na Home
  useEffect(() => {
    let isMounted = true

    const bootstrapProject = async () => {
      if (!activeProject) {
        if (isMounted) {
          setModifiedFiles([])
          setDiffMarkdown('')
          setIsGitRepo(null)
          setIsWatching(false)
          setSelectedFile(null)
        }
        await window.codeAwareness.stopWatcher()
        return
      }

      setIsLoading(true)
      try {
        const isGit = await window.codeAwareness.checkRepository(activeProject.path)
        if (!isMounted) return
        setIsGitRepo(isGit)

        if (!isGit) {
          setIsWatching(false)
          return
        }

        const [, files, markdown] = await Promise.all([
          window.codeAwareness.startWatcher(activeProject.path),
          window.codeAwareness.getModifiedFiles(activeProject.path),
          window.codeAwareness.generateSemanticDiff(activeProject.path)
        ])

        if (!isMounted) return
        setModifiedFiles(files)
        setDiffMarkdown(markdown)
        setIsWatching(true)
      } finally {
        if (isMounted) setIsLoading(false)
      }
    }

    bootstrapProject()

    const unsubscribe = window.codeAwareness.onFileChanged(async () => {
      if (!activeProject || !isMounted) return
      const [files, markdown] = await Promise.all([
        window.codeAwareness.getModifiedFiles(activeProject.path),
        window.codeAwareness.generateSemanticDiff(activeProject.path)
      ])
      if (!isMounted) return
      setModifiedFiles(files)
      setDiffMarkdown(markdown)
    })

    return () => {
      isMounted = false
      unsubscribe()
      window.codeAwareness.stopWatcher() // Stop na troca de aba ou na troca de projeto
    }
  }, [activeProject])

  const handlePromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newVal = e.target.value
    setAuditPromptTemplate(newVal)
    localStorage.setItem('code_diff_prompt_template', newVal)
  }

  const handleCopyPrompt = () => {
    const finalPrompt = `${auditPromptTemplate}\n\n${diffMarkdown}`
    navigator.clipboard.writeText(finalPrompt)
    setIsCopied(true)
    setTimeout(() => setIsCopied(false), 2000)
  }

  const handleCopyMarkdown = () => {
    navigator.clipboard.writeText(diffMarkdown)
    setIsCopyMarkdown(true)
    setTimeout(() => setIsCopyMarkdown(false), 2000)
  }

  const handleFileClick = (relativePath: string) => {
    setSelectedFile(relativePath)
    setTimeout(() => {
      const headings = document.querySelectorAll('.cdf-diff-code-rendered h2')
      for (const heading of headings) {
        if (heading.textContent?.includes(relativePath)) {
          heading.scrollIntoView({ behavior: 'smooth', block: 'start' })
          break
        }
      }
    }, 50)
  }

  const handleExportObsidian = async () => {
    if (!activeProject) return
    setIsExporting(true)
    try {
      const fixedPath = "C:\\Users\\ericr\\Documents\\Projetos de Softwares"
      const name = activeProject.name + "-diff"
      await window.codeAwareness.saveToObsidian(diffMarkdown, name, fixedPath)
    } catch (err) {
      console.error("Falha ao exportar:", err)
    } finally {
      setIsExporting(false)
    }
  }

  if (!activeProject) {
    return (
      <div className="cdf-dropzone-wrapper">
        <div className="empty-selection-banner" style={{ border: 'none', background: 'transparent' }}>
          <h3>Nenhum projeto selecionado</h3>
          <p>Volte para a aba <strong>Projetos</strong> e ative um repositório para inspecionar e monitorar alterações de código.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="cdf-container">
      <div className="cdf-topbar">
        <div className="cdf-repo-info">
          <span className="cdf-repo-name">{activeProject.name}</span>
          {isLoading && <span className="cdf-status-badge loading">carregando...</span>}
          {!isLoading && isWatching && <span className="cdf-status-badge watching">● Monitorando</span>}
          {!isLoading && isGitRepo === false && (
            <span className="cdf-status-badge error">Não é um repositório Git</span>
          )}
        </div>
      </div>

      <div className="cdf-split">
        <aside className="cdf-sidebar">
          <div className="cdf-sidebar-header">
            <span>Arquivos alterados</span>
            <span className="cdf-count-badge">{modifiedFiles.length}</span>
          </div>

          {modifiedFiles.length === 0 ? (
            <p className="cdf-empty-state">
              {isGitRepo === false
                ? 'O diretório não é um repositório Git.'
                : 'Nenhuma alteração detectada ainda.'}
            </p>
          ) : (
            <ul className="cdf-file-list">
              {modifiedFiles.map((file) => (
                <li
                  key={file.relativePath}
                  className={`cdf-file-card ${selectedFile === file.relativePath ? 'selected' : ''}`}
                  onClick={() => handleFileClick(file.relativePath)}
                >
                  <span className={`cdf-type-badge ${file.changeType}`}>
                    {CHANGE_TYPE_LABEL[file.changeType]}
                  </span>
                  <span className="cdf-file-name" title={file.relativePath}>
                    {file.name}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {modifiedFiles.length === 0 ? (
          <main className="cdf-diff-panel empty-state">
            <div className="cdf-empty-hero">
              <span className="cdf-empty-icon">👀</span>
              <h3>Aguardando modificações...</h3>
              <p>A pasta ativa está sendo monitorada. Salve alterações no repositório para inspecionar os blocos semânticos e realizar a auditoria.</p>
            </div>
          </main>
        ) : (
          <main className="cdf-diff-panel">
            <div className="cdf-diff-actions">
              <details className="cdf-prompt-details">
                <summary>Personalizar Instruções do Prompt (Opcional)</summary>
                <textarea
                  className="cdf-prompt-textarea"
                  value={auditPromptTemplate}
                  onChange={handlePromptChange}
                  rows={8}
                />
              </details>
            </div>

            <div className="cdf-diff-code-rendered">
              <Markdown>{diffMarkdown}</Markdown>
            </div>
          </main>
        )}
      </div>

      <div className="cdf-diff-actions-bottom">
              <button className="app-pill-btn" onClick={handleCopyPrompt}>
                {isCopied ? 'Copiado!' : 'Copiar Prompt de Auditoria'}
              </button>
              <button className="app-pill-btn" onClick={handleCopyMarkdown}>
                {isCopyMarkdown ? 'Markdown Copiado!' : 'Copiar Markdown de Diff'}
              </button>
              <button 
                className="app-pill-btn"
                onClick={handleExportObsidian}
                disabled={isExporting}
              >
                {isExporting ? 'Exportando...' : 'Exportar para Obsidian'}
              </button>
      </div>
    </div>
  )
}
