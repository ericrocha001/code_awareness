// Responsabilidades do Script
//
// 1. Apresentar o conteúdo Markdown gerado de forma estruturada.
// 2. Garantir a renderização monoespaçada com quebras de linha e espaçamentos originais preservados.
// 3. Prover rolagem vertical e horizontal adequadas para códigos de qualquer extensão.

import React from 'react'
import './OutputPanel.css'

interface OutputPanelProps {
  markdown: string
}

export const OutputPanel: React.FC<OutputPanelProps> = ({ markdown }) => {
  if (!markdown) return null

  return (
    <div className="output-panel" id="output-panel">
      <div className="output-panel-header">
        <span className="output-panel-title">Código Markdown Gerado</span>
        <span className="output-panel-meta">{markdown.length} caracteres</span>
      </div>
      <div className="output-panel-container">
        <pre className="output-panel-content"><code>{markdown}</code></pre>
      </div>
    </div>
  )
}
