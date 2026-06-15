// Responsabilidades do Script
//
// 1. Apresentar as opções de Copy, Save e Save to Obsidian para o Markdown gerado.
// 2. Controlar o estado de carregamento e desabilitação dos botões baseando-se no conteúdo disponível.
// 3. Orquestrar a cópia do conteúdo para o clipboard e disparar chamadas de IPC para exportação de arquivos.
// 4. Gerenciar o fluxo de seleção e salvamento de configurações do Vault do Obsidian quando ausente.

import React, { useState } from 'react'
import { AppSettings } from '../../../shared/types'
import './ActionsBar.css'

interface ActionsBarProps {
  markdown: string
  repoName: string
  settings: AppSettings
  onSettingsUpdate: (settings: AppSettings) => void
  onStatusMessage: (message: string, isError?: boolean) => void
}

export const ActionsBar: React.FC<ActionsBarProps> = ({
  markdown,
  repoName,
  settings,
  onSettingsUpdate,
  onStatusMessage
}) => {
  const [copied, setCopied] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  const isDisabled = !markdown || isSaving

  const handleCopy = async () => {
    if (isDisabled) return
    try {
      await navigator.clipboard.writeText(markdown)
      setCopied(true)
      onStatusMessage('Markdown copiado para a área de transferência!', false)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      onStatusMessage('Falha ao copiar markdown.', true)
    }
  }

  const handleSave = async () => {
    if (isDisabled) return
    setIsSaving(true)
    try {
      const res = await window.codeAwareness.saveMarkdown(markdown, repoName)
      if (res.success) {
        onStatusMessage('Markdown salvo com sucesso!', false)
      } else if (res.error !== 'Cancelled') {
        onStatusMessage(`Falha ao salvar: ${res.error}`, true)
      }
    } catch (err) {
      onStatusMessage('Falha ao acionar salvamento local.', true)
    } finally {
      setIsSaving(false)
    }
  }

  const handleSaveToObsidian = async () => {
    if (isDisabled) return
    setIsSaving(true)

    try {
      let vaultPath = settings.obsidianVaultPath

      if (!vaultPath) {
        // Fluxo de configuração do Vault pela primeira vez
        onStatusMessage('Selecione a pasta do seu Vault do Obsidian...', false)
        const selectedPath = await window.codeAwareness.selectVaultFolder()
        if (!selectedPath) {
          onStatusMessage('Seleção de Vault cancelada.', false)
          setIsSaving(false)
          return
        }

        const newSettings: AppSettings = { ...settings, obsidianVaultPath: selectedPath }
        await window.codeAwareness.saveSettings(newSettings)
        onSettingsUpdate(newSettings)
        vaultPath = selectedPath
      }

      onStatusMessage('Salvando no Obsidian Vault...', false)
      const res = await window.codeAwareness.saveToObsidian(markdown, repoName, vaultPath)

      if (res.success) {
        onStatusMessage(`Markdown salvo no Obsidian Vault: ${vaultPath}`, false)
      } else {
        onStatusMessage(`Erro ao salvar no Obsidian: ${res.error}`, true)
      }
    } catch (err) {
      onStatusMessage('Falha ao acionar salvamento no Obsidian.', true)
    } finally {
      setIsSaving(false)
    }
  }

  const handleConfigureVault = async () => {
    try {
      const selectedPath = await window.codeAwareness.selectVaultFolder()
      if (selectedPath) {
        const newSettings: AppSettings = { ...settings, obsidianVaultPath: selectedPath }
        await window.codeAwareness.saveSettings(newSettings)
        onSettingsUpdate(newSettings)
        onStatusMessage(`Vault configurado: ${selectedPath}`, false)
      }
    } catch (err) {
      onStatusMessage('Erro ao configurar Vault.', true)
    }
  }

  return (
    <div className="actions-bar" id="actions-bar">
      <div className="actions-group">
        <button
          className="action-btn copy-btn"
          onClick={handleCopy}
          disabled={isDisabled}
        >
          {copied ? 'Copiado!' : 'Copiar Markdown'}
        </button>
        <button
          className="action-btn save-btn"
          onClick={handleSave}
          disabled={isDisabled}
        >
          Salvar como arquivo
        </button>
        <button
          className="action-btn obsidian-btn"
          onClick={handleSaveToObsidian}
          disabled={isDisabled}
        >
          Salvar no Obsidian
        </button>
      </div>

      <div className="vault-config-info">
        {settings.obsidianVaultPath ? (
          <span className="vault-path-text" title={settings.obsidianVaultPath}>
            Obsidian: <code>{settings.obsidianVaultPath}</code>
            <button className="change-vault-btn" onClick={handleConfigureVault}>Alterar</button>
          </span>
        ) : (
          <span className="vault-not-configured">Obsidian Vault não configurado</span>
        )}
      </div>
    </div>
  )
}
