// Responsabilidades do Script
//
// 1. Orquestrar o estado global da aplicação (status de instalação, configurações do vault, progresso de análise, markdown gerado).
// 2. Coordenar o fluxo de inicialização carregando configurações e testando a presença da CLI externa do Codefetch.
// 3. Gerenciar o fluxo principal de arrastar pasta, acionar análise externa e tratar erros/sucessos do processo.

import React, { useEffect, useState } from 'react'
import { AppSettings } from '../../shared/types'
import { CodeDiffView } from './components/CodeDiffView/CodeDiffView'
import { CodeCompressionView } from './components/CodeCompressionView/CodeCompressionView'
import { CodeSourceView } from './components/CodeSourceView/CodeSourceView'
import { HomeView } from './components/HomeView/HomeView'
import './App.css'

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'home' | 'codebase' | 'compression' | 'diff'>('home')
  const [activeProject, setActiveProject] = useState<{ path: string; name: string } | null>(null)
  const [settings, setSettings] = useState<AppSettings>({ obsidianVaultPath: null })
  const [statusMessage, setStatusMessage] = useState<{ text: string; isError: boolean } | null>(null)

  // Fluxo de Inicialização (Startup Flow)
  useEffect(() => {
    const init = async () => {
      try {
        const loadedSettings = await window.codeAwareness.loadSettings()
        setSettings(loadedSettings)
      } catch (err) {
        console.error('Falha na inicialização do aplicativo:', err)
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
            className={`tab-btn ${activeTab === 'compression' ? 'active' : ''}`}
            onClick={() => setActiveTab('compression')}
          >
            Code Compression
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
          <HomeView activeProject={activeProject} onSelectProject={setActiveProject} onStatusMessage={handleStatusMessage} />
        )}
        {activeTab === 'codebase' && (
          <CodeSourceView activeProject={activeProject} onStatusMessage={handleStatusMessage} />
        )}
        {activeTab === 'compression' && (
          <CodeCompressionView activeProject={activeProject} onStatusMessage={handleStatusMessage} />
        )}
        {activeTab === 'diff' && (
          <CodeDiffView activeProject={activeProject} onStatusMessage={handleStatusMessage} />
        )}
      </main>
    </div>
  )
}
