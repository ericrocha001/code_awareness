// Responsabilidades do Script
//
// 1. Renderizar um banner informativo quando a ferramenta Codefetch CLI não for detectada no sistema.
// 2. Permitir a cópia rápida do comando de instalação para a área de transferência do usuário.

import React, { useState } from 'react'
import './SetupBanner.css'

export const SetupBanner: React.FC = () => {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText('npm install -g codefetch')
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy command', err)
    }
  }

  return (
    <div className="setup-banner" id="setup-banner">
      <div className="setup-banner-content">
        <span className="setup-banner-warning-icon">⚠️</span>
        <div className="setup-banner-text">
          <strong>Codefetch CLI não detectado no sistema.</strong> Instale globalmente antes de prosseguir:
          <code className="setup-banner-code">npm install -g codefetch</code>
        </div>
      </div>
      <button className="setup-banner-copy-btn" onClick={handleCopy}>
        {copied ? 'Copiado!' : 'Copiar comando'}
      </button>
    </div>
  )
}
