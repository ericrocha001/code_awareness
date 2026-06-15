// Responsabilidades do Script
//
// 1. Orquestrar o estado global da aplicação (status de instalação, configurações do vault, progresso de análise, markdown gerado).
// 2. Coordenar o fluxo de inicialização carregando configurações e testando a presença da CLI externa do Codefetch.
// 3. Gerenciar o fluxo principal de arrastar pasta, acionar análise externa e tratar erros/sucessos do processo.

import React, { useEffect, useState } from 'react'
import { AppSettings } from '../../shared/types'
import { SetupBanner } from './components/SetupBanner/SetupBanner'
import { DropZone } from './components/DropZone/DropZone'
import { ActionsBar } from './components/ActionsBar/ActionsBar'
import { OutputPanel } from './components/OutputPanel/OutputPanel'
import './App.css'

export const App: React.FC = () => {
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
      const timer = setTimeout(() => {
        setStatusMessage(null)
      }, 5000)
      return () => clearTimeout(timer)
    }
    return undefined
  }

  // Fluxo Principal (Main Flow)
  const handleFolderDrop = async (folderPath: string, folderName: string) => {
    if (!isCodefetchInstalled) {
      handleStatusMessage('Codefetch não está instalado. Não é possível rodar a análise.', true)
      return
    }

    setIsProcessing(true)
    setError('')
    setMarkdown('')
    setRepoName(folderName)
    setStatusMessage(null)

    try {
      const result = await window.codeAwareness.runCodefetch(folderPath)

      if (result.success && result.markdown) {
        setMarkdown(result.markdown)
        handleStatusMessage(`Análise concluída com sucesso para o repositório "${folderName}"!`, false)
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
          <span className="logo-icon">🧠</span>
          <div>
            <h1 className="app-title">Code Awareness</h1>
            <p className="app-subtitle">Converta repositórios locais em Markdown unificado</p>
          </div>
        </div>
      </header>

      <main className="app-main">
        {!isCodefetchInstalled && <SetupBanner />}

        <DropZone
          onFolderDrop={handleFolderDrop}
          isProcessing={isProcessing}
          disabled={!isCodefetchInstalled}
        />

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
      </main>
    </div>
  )
}
