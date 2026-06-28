/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Orquestrar o estado global da aplicação (aba ativa, projeto ativo, configurações e mensagens de status).
2. Gerenciar o fluxo de inicialização carregando configurações salvas.
3. Renderizar o layout principal com header de abas, conteúdo da aba ativa e toast de status.

Mapa de Relacionamentos do Script

1. HomeView.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza a tela inicial de seleção de projetos.
   - Criticidade: Alta

2. CodeSourceView.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza a aba Code Source quando ativa.
   - Criticidade: Alta

3. CodeCompressionView.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza a aba Code Compression quando ativa.
   - Criticidade: Alta

4. CodeDiffView.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza a aba Code Diff quando ativa.
   - Criticidade: Alta

5. App.css
   - Tipo: Relação de UI
   - Relação: Consome estilos CSS globais, incluindo o toast de status.
   - Criticidade: Alta

Invariantes do Script

1. Apenas uma aba deve estar ativa por vez.
2. Mensagens de erro devem persistir até descarte manual; mensagens de sucesso devem desaparecer após 5 segundos.
3. O estado statusMessage nunca deve referenciar memória liberada após o timeout.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useEffect, useState } from 'react'
import { CodeDiffView } from './components/CodeDiffView/CodeDiffView'
import { CodeCompressionView } from './components/CodeCompressionView/CodeCompressionView'
import { CodeSourceView } from './components/CodeSourceView/CodeSourceView'
import { HomeView } from './components/HomeView/HomeView'
import './App.css'

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'home' | 'codebase' | 'compression' | 'diff'>('home')
  const [activeProject, setActiveProject] = useState<{ path: string; name: string } | null>(null)
  const [statusMessage, setStatusMessage] = useState<{ text: string; isError: boolean } | null>(null)


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

      {/* Toast de status */}
      {statusMessage && (
        <div className={`status-toast ${statusMessage.isError ? 'error' : 'success'}`}>
          {statusMessage.text}
        </div>
      )}
    </div>
  )
}
