// Responsabilidades do Script
//
// 1. Orquestrar o estado global da aplicação (status de instalação, configurações do vault, progresso de análise, markdown gerado).
// 2. Coordenar o fluxo de inicialização carregando configurações e testando a presença da CLI externa do Codefetch.
// 3. Gerenciar o fluxo principal de arrastar pasta, acionar análise externa e tratar erros/sucessos do processo.

import React, { useEffect, useState } from 'react'
import { AppSettings } from '../../shared/types'
import { SetupBanner } from './components/SetupBanner/SetupBanner'
import { ActionsBar } from './components/ActionsBar/ActionsBar'
import { OutputPanel } from './components/OutputPanel/OutputPanel'
import { CodeDiffView } from './components/CodeDiffView/CodeDiffView'
import { HomeView } from './components/HomeView/HomeView'
import './App.css'

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'home' | 'codebase' | 'diff'>('home')
  const [activeProject, setActiveProject] = useState<{ path: string; name: string } | null>(null)
  const [isCodefetchInstalled, setIsCodefetchInstalled] = useState<boolean>(true)
  const [settings, setSettings] = useState<AppSettings>({ obsidianVaultPath: null })
  const [markdown, setMarkdown] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [isProcessing, setIsProcessing] = useState<boolean>(false)
  const [repoName, setRepoName] = useState<string>('')
  const [statusMessage, setStatusMessage] = useState<{ text: string; isError: boolean } | null>(null)

  // Fluxo de Inicialização (Startup Flow)
  useEffect(() => {
    const init = async () => {
      try {
        const installed = await window.codeAwareness.checkCodefetch()
        setIsCodefetchInstalled(installed)

        const loadedSettings = await window.codeAwareness.loadSettings()
        setSettings(loadedSettings)
      } catch (err) {
        console.error('Falha na inicialização do aplicativo:', err)
        setError('Ocorreu um erro ao carregar as configurações do sistema.')
      }
    }
    init()
  }, [])

  // Gerenciamento de mensagens temporárias de status
  const handleStatusMessage = (text: string, isError = false) => {
    setStatusMessage({ text, isError })
    if (!isError) {
      setTimeout(() => {
        setStatusMessage(null)
      }, 5000)
    }
  }

  // Fluxo Principal (Main Flow)
  const handleRunAnalysis = async () => {
    if (!isCodefetchInstalled) {
      handleStatusMessage('Codefetch não está instalado. Não é possível rodar a análise.', true)
      return
    }
    
    if (!activeProject) {
      handleStatusMessage('Nenhum projeto selecionado.', true)
      return
    }

    setIsProcessing(true)
    setError('')
    setMarkdown('')
    setRepoName(activeProject.name)
    setStatusMessage(null)

    try {
      const result = await window.codeAwareness.runCodefetch(activeProject.path)

      if (result.success && result.markdown) {
        setMarkdown(result.markdown)
        handleStatusMessage(`Análise concluída com sucesso para o repositório "${activeProject.name}"!`, false)
      } else {
        setError(result.error || 'Erro desconhecido durante a execução do Codefetch.')
        handleStatusMessage('A análise falhou.', true)
      }
    } catch (err: any) {
      setError(err.message || 'Falha na comunicação com o processo principal.')
      handleStatusMessage('Ocorreu um erro técnico ao executar a análise.', true)
    } finally {
      setIsProcessing(false)
    }
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo-section">
          <span className="logo-icon">{"</>"}</span>
          <h1 className="app-title">Code Awareness</h1>
        </div>
        
        <div className="tabs-container">
          <button 
            className={`tab-btn ${activeTab === 'home' ? 'active' : ''}`}
            onClick={() => setActiveTab('home')}
          >
            Projetos
          </button>
          <button 
            className={`tab-btn ${activeTab === 'codebase' ? 'active' : ''}`}
            onClick={() => setActiveTab('codebase')}
          >
            Code Source
          </button>
          <button 
            className={`tab-btn ${activeTab === 'diff' ? 'active' : ''}`}
            onClick={() => setActiveTab('diff')}
          >
            Code Diff <span className="tab-badge">Live</span>
          </button>
        </div>
      </header>

      <main className="app-main">
        {activeTab === 'home' && (
          <HomeView activeProject={activeProject} onSelectProject={setActiveProject} />
        )}
        {activeTab === 'codebase' && (
          <>
            {!isCodefetchInstalled && <SetupBanner />}

            {!activeProject ? (
              <div className="empty-selection-banner">
                <h3>Nenhum projeto selecionado</h3>
                <p>Volte para a aba <strong>Projetos</strong> e ative um repositório para gerar o código fonte.</p>
              </div>
            ) : (
              <div className="active-project-card">
                <div className="active-project-info">
                  <h3>{activeProject.name}</h3>
                  <span className="path-text">{activeProject.path}</span>
                </div>
                <button 
                  className="app-pill-btn" 
                  onClick={handleRunAnalysis}
                  disabled={isProcessing || !isCodefetchInstalled}
                >
                  {isProcessing ? 'Processando...' : 'Gerar Código Fonte'}
                </button>
              </div>
            )}

        {error && (
          <div className="error-banner">
            <span className="error-icon">❌</span>
            <div className="error-text">
              <strong>Erro na análise:</strong> {error}
            </div>
          </div>
        )}

        {statusMessage && (
          <div className={`status-toast ${statusMessage.isError ? 'error' : 'success'}`}>
            {statusMessage.text}
          </div>
        )}

        {markdown && (
          <>
            <ActionsBar
              markdown={markdown}
              repoName={repoName}
              settings={settings}
              onSettingsUpdate={setSettings}
              onStatusMessage={handleStatusMessage}
            />
            <OutputPanel markdown={markdown} />
          </>
        )}
          </>
        )}
        {activeTab === 'diff' && (
          <CodeDiffView activeProject={activeProject} />
        )}
      </main>
    </div>
  )
}
